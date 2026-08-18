// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MarinaDB, MediaJobRow, MediaJobType } from "../../persistence/database";
import type { StorageProvider } from "../../storage/provider";
import type { EngineEvent, EntityId } from "../../types";
import type { Engine } from "../engine";
import {
  getImageProvider,
  imageProviderRequiresKey,
  knownImageProviders,
} from "./providers/image-registry";
import type { ImageGenerator } from "./providers/image-util";
import { moderateOpenAIText } from "./providers/openai";
import { getVideoProvider, knownVideoProviders } from "./providers/video-registry";
import type { VideoResult } from "./providers/video-util";
import { publishGeneratedAsset, storeGeneratedAsset } from "./publish";

const POLL_INTERVAL_MS = 5_000;
const MAX_IMAGE_JOBS_PER_DAY = Number(process.env.MAX_IMAGE_JOBS_PER_DAY ?? "0");
const MAX_VIDEO_JOBS_PER_DAY = Number(process.env.MAX_VIDEO_JOBS_PER_DAY ?? "0");

interface BaseJobParams {
  entityId: EntityId;
  entityName: string;
  prompt: string;
  model: string;
  canvasId?: string;
  costHint?: number | null;
  metadata?: Record<string, unknown>;
}

export interface ImageJobParams extends BaseJobParams {
  type: "image";
  width?: number;
  height?: number;
  style?: string;
}

export interface VideoJobParams extends BaseJobParams {
  type: "video";
  duration?: number;
  fps?: number;
  referenceImage?: string;
  aspectRatio?: string;
}

type StartJobParams = ImageJobParams | VideoJobParams;

type ProviderKeyResolver = (provider: string, keyName?: string) => string | undefined;

interface MediaManagerDeps {
  engine: Engine;
  db: MarinaDB;
  storage: StorageProvider;
  resolveApiKey: ProviderKeyResolver;
  logEvent: (event: EngineEvent) => void;
}

interface ActivePoll {
  provider: string;
  timer: ReturnType<typeof setInterval>;
}

export class MediaManager {
  private engine: Engine;
  private db: MarinaDB;
  private storage: StorageProvider;
  private resolveApiKey: ProviderKeyResolver;
  private logEvent: (event: EngineEvent) => void;
  private polls = new Map<string, ActivePoll>();

  constructor(deps: MediaManagerDeps) {
    this.engine = deps.engine;
    this.db = deps.db;
    this.storage = deps.storage;
    this.resolveApiKey = deps.resolveApiKey;
    this.logEvent = deps.logEvent;
  }

  async startJob(params: StartJobParams): Promise<MediaJobRow> {
    this.enforceQuota(params.entityName, params.type);

    const jobId = crypto.randomUUID();
    const provider = this.extractProvider(params.model);
    const apiKey = this.resolveApiKey(provider);
    // Video always needs a key; image needs one only for built-in cloud
    // providers — local/operator-configured endpoints (Automatic1111, any
    // `<PROVIDER>_IMAGE_BASE_URL`) are key-optional.
    const keyRequired = params.type === "video" || imageProviderRequiresKey(provider);
    if (keyRequired && !apiKey) {
      throw new Error(`No API key configured for provider "${provider}".`);
    }

    const baseOptions: Record<string, unknown> = {
      canvasId: params.canvasId ?? null,
      ...params.metadata,
    };
    if (params.type === "image") {
      Object.assign(baseOptions, {
        width: params.width ?? null,
        height: params.height ?? null,
        style: params.style ?? null,
      });
    } else {
      Object.assign(baseOptions, {
        duration: params.duration ?? null,
        fps: params.fps ?? null,
        referenceImage: params.referenceImage ?? null,
        aspectRatio: params.aspectRatio ?? null,
      });
    }

    this.db.createMediaJob({
      id: jobId,
      type: params.type,
      entityName: params.entityName,
      entityId: params.entityId,
      provider,
      model: params.model,
      prompt: params.prompt,
      options: baseOptions,
      costEstimate: params.costHint ?? estimateCost(params),
      metadata: params.metadata ?? null,
    });

    this.emitFeedEvent("media_pending", params, jobId, {
      status: "pending",
      message: `Requested ${params.type} generation using ${params.model}`,
    });

    try {
      if (params.type === "image") {
        const generate = getImageProvider(provider);
        if (!generate) {
          throw new Error(
            `Provider "${provider}" not yet supported for image generation. Supported: ${knownImageProviders().join(", ")}.`,
          );
        }
        await this.handleImageJob(jobId, apiKey ?? "", params, generate);
      } else {
        const vp = getVideoProvider(provider);
        if (!vp) {
          throw new Error(
            `Provider "${provider}" not yet supported for video generation. Supported: ${knownVideoProviders().join(", ")}.`,
          );
        }
        await this.handleVideoJob(jobId, apiKey ?? "", params);
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.db.updateMediaJob(jobId, { status: "failed", error: errMsg, completedAt: Date.now() });
      this.emitFeedEvent("media_failed", params, jobId, {
        status: "failed",
        message: `Generation failed: ${errMsg}`,
      });
      throw error;
    }

    return this.db.getMediaJob(jobId)!;
  }

  getJob(id: string): MediaJobRow | undefined {
    return this.db.getMediaJob(id);
  }

  stop(): void {
    for (const poll of this.polls.values()) {
      clearInterval(poll.timer);
    }
    this.polls.clear();
  }

  private async handleImageJob(
    jobId: string,
    apiKey: string,
    params: ImageJobParams,
    generate: ImageGenerator,
  ): Promise<void> {
    // Moderation runs against OpenAI regardless of the image provider — best
    // effort, only when an OpenAI key is available (a non-OpenAI provider key
    // can't call it). A failed/absent moderation never blocks generation.
    const moderationKey = this.resolveApiKey("openai");
    if (moderationKey) {
      const moderation = await moderateOpenAIText({
        apiKey: moderationKey,
        prompt: params.prompt,
        signal: AbortSignal.timeout(10_000),
      });
      if (moderation?.blocked) {
        this.db.updateMediaJob(jobId, {
          status: "blocked",
          error: moderation.reason ?? "Prompt flagged by moderation.",
          completedAt: Date.now(),
        });
        this.emitFeedEvent("media_blocked", params, jobId, {
          status: "blocked",
          message: "Prompt was blocked by provider moderation.",
        });
        return;
      }
    }

    const result = await generate({
      apiKey,
      model: params.model,
      prompt: params.prompt,
      width: params.width,
      height: params.height,
      style: params.style,
      signal: AbortSignal.timeout(60_000),
    });

    if (result.status === "failed") {
      this.db.updateMediaJob(jobId, {
        status: "failed",
        error: result.error ?? "Image generation failed",
        completedAt: Date.now(),
      });
      this.emitFeedEvent("media_failed", params, jobId, {
        status: "failed",
        message: result.error ?? "Image generation failed.",
      });
      return;
    }

    if (!result.asset) {
      this.db.updateMediaJob(jobId, {
        status: "failed",
        error: "Generation succeeded but returned no asset.",
        completedAt: Date.now(),
      });
      this.emitFeedEvent("media_failed", params, jobId, {
        status: "failed",
        message: "Generation succeeded but returned no asset.",
      });
      return;
    }

    const { data, mimeType, filename } = result.asset;
    const stored = await storeGeneratedAsset({
      engine: this.engine,
      entityName: params.entityName,
      filename,
      mimeType,
      data,
      prompt: params.prompt,
      model: params.model,
      metadata: { provider: this.extractProvider(params.model) },
      id: crypto.randomUUID(),
    });

    const canvasId =
      (params.canvasId && this.engine.db?.getCanvas(params.canvasId)?.id) ??
      this.engine.db?.ensureEntityCanvas(params.entityId, params.entityName, params.entityName)
        .id ??
      null;

    if (canvasId) {
      publishGeneratedAsset({
        engine: this.engine,
        entityId: params.entityId,
        entityName: params.entityName,
        assetId: stored.id,
        nodeType: "image",
        prompt: params.prompt,
        model: params.model,
        canvasId,
        summary: `${params.entityName} generated an image.`,
      });
    }

    this.db.updateMediaJob(jobId, {
      status: "succeeded",
      assetId: stored.id,
      completedAt: Date.now(),
    });

    this.emitFeedEvent("media_complete", params, jobId, {
      status: "succeeded",
      message: `Image ready (${filename})`,
      assetId: stored.id,
    });
  }

  private async handleVideoJob(
    jobId: string,
    apiKey: string,
    params: VideoJobParams,
  ): Promise<void> {
    const provider = this.extractProvider(params.model);
    const vp = getVideoProvider(provider);
    if (!vp) {
      throw new Error(`Provider "${provider}" not yet supported for video generation.`);
    }
    const start: VideoResult = await vp.start({
      apiKey,
      model: params.model,
      prompt: params.prompt,
      duration: params.duration,
      fps: params.fps,
      referenceImage: params.referenceImage,
      aspectRatio: params.aspectRatio,
    });

    if (start.status === "failed") {
      this.db.updateMediaJob(jobId, {
        status: "failed",
        error: start.error ?? "Video job creation failed",
        completedAt: Date.now(),
      });
      this.emitFeedEvent("media_failed", params, jobId, {
        status: "failed",
        message: start.error ?? "Video generation failed to start.",
      });
      return;
    }

    if (start.status === "succeeded" && start.asset) {
      await this.completeVideoJob(
        jobId,
        params,
        start.asset.data,
        start.asset.mimeType,
        start.asset.filename,
      );
      return;
    }

    this.db.updateMediaJob(jobId, {
      status: "running",
      providerJobId: start.providerJobId ?? null,
      metadata: { progress: start.progress ?? 0 },
    });

    this.emitFeedEvent("media_rendering", params, jobId, {
      status: "running",
      message: "Video render started.",
      providerJobId: start.providerJobId ?? undefined,
    });

    if (!start.providerJobId) {
      return;
    }

    this.schedulePoll(jobId, start.providerJobId, params);
  }

  private schedulePoll(jobId: string, providerJobId: string, params: VideoJobParams): void {
    if (this.polls.has(jobId)) {
      clearInterval(this.polls.get(jobId)!.timer);
    }

    const provider = this.extractProvider(params.model);
    const timer = setInterval(async () => {
      try {
        const apiKey = this.resolveApiKey(provider);
        if (!apiKey) throw new Error("Missing provider key during polling.");
        const vp = getVideoProvider(provider);
        if (!vp) throw new Error(`Provider "${provider}" no longer supported.`);
        const poll: VideoResult = await vp.poll({ apiKey, providerJobId });

        if (poll.status === "running") {
          this.db.updateMediaJob(jobId, {
            metadata: { progress: poll.progress ?? null },
          });
          if (poll.progress !== undefined) {
            this.emitFeedEvent("media_rendering", params, jobId, {
              status: "running",
              progress: poll.progress,
            });
          }
          return;
        }

        clearInterval(timer);
        this.polls.delete(jobId);

        if (poll.status === "failed") {
          this.db.updateMediaJob(jobId, {
            status: "failed",
            error: poll.error ?? "Video generation failed",
            completedAt: Date.now(),
          });
          this.emitFeedEvent("media_failed", params, jobId, {
            status: "failed",
            message: poll.error ?? "Video generation failed.",
          });
          return;
        }

        if (poll.status === "succeeded" && poll.asset) {
          await this.completeVideoJob(
            jobId,
            params,
            poll.asset.data,
            poll.asset.mimeType,
            poll.asset.filename,
          );
        }
      } catch (err) {
        clearInterval(timer);
        this.polls.delete(jobId);
        const msg = err instanceof Error ? err.message : String(err);
        this.db.updateMediaJob(jobId, {
          status: "failed",
          error: msg,
          completedAt: Date.now(),
        });
        this.emitFeedEvent("media_failed", params, jobId, {
          status: "failed",
          message: msg,
        });
      }
    }, POLL_INTERVAL_MS);

    this.polls.set(jobId, { provider, timer });
  }

  private async completeVideoJob(
    jobId: string,
    params: VideoJobParams,
    data: Uint8Array,
    mimeType: string,
    filename: string,
  ): Promise<void> {
    const stored = await storeGeneratedAsset({
      engine: this.engine,
      entityName: params.entityName,
      filename,
      mimeType,
      data,
      prompt: params.prompt,
      model: params.model,
      metadata: { provider: this.extractProvider(params.model) },
      id: crypto.randomUUID(),
    });

    const canvasId =
      (params.canvasId && this.engine.db?.getCanvas(params.canvasId)?.id) ??
      this.engine.db?.ensureEntityCanvas(params.entityId, params.entityName, params.entityName)
        .id ??
      null;

    if (canvasId) {
      publishGeneratedAsset({
        engine: this.engine,
        entityId: params.entityId,
        entityName: params.entityName,
        assetId: stored.id,
        nodeType: "video",
        prompt: params.prompt,
        model: params.model,
        canvasId,
        summary: `${params.entityName} generated a video.`,
      });
    }

    this.db.updateMediaJob(jobId, {
      status: "succeeded",
      assetId: stored.id,
      completedAt: Date.now(),
    });

    this.emitFeedEvent("media_complete", params, jobId, {
      status: "succeeded",
      message: `Video ready (${filename})`,
      assetId: stored.id,
    });
  }

  private enforceQuota(entityName: string, type: MediaJobType): void {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const count = this.db.countMediaJobsSince({ entityName, since, type });
    const cap = type === "image" ? MAX_IMAGE_JOBS_PER_DAY : MAX_VIDEO_JOBS_PER_DAY;
    if (cap > 0 && count >= cap) {
      throw new Error(
        `Daily ${type} quota reached (${count}/${cap}). Try again tomorrow or request additional credits.`,
      );
    }
  }

  private emitFeedEvent(
    kind: string,
    params: StartJobParams,
    jobId: string,
    payload: Record<string, unknown>,
  ): void {
    this.logEvent({
      type: "feed_event",
      kind,
      entity: params.entityId,
      ref: jobId,
      summary: summarizeFeed(kind, params, payload),
      payload: { jobId, ...payload, canvasId: params.canvasId ?? null },
      timestamp: Date.now(),
    });
  }

  private extractProvider(model: string): string {
    const at = model.indexOf("@");
    const head = at >= 0 ? model.slice(0, at) : model;
    const slash = head.indexOf("/");
    return slash >= 0 ? head.slice(0, slash) : head;
  }
}

function summarizeFeed(
  kind: string,
  params: StartJobParams,
  payload: Record<string, unknown>,
): string {
  const base = `${params.entityName} ${params.type} (${params.model})`;
  switch (kind) {
    case "media_pending":
      return `${base}: queued`;
    case "media_rendering":
      return `${base}: rendering${payload.progress != null ? ` (${Math.round((payload.progress as number) * 100)}%)` : ""}`;
    case "media_complete":
      return `${base}: complete`;
    case "media_blocked":
      return `${base}: blocked`;
    case "media_failed":
      return `${base}: failed`;
    default:
      return `${base}: ${kind}`;
  }
}

function estimateCost(params: StartJobParams): number | null {
  const provider = params.model.split(/[:/]/)[0] ?? "";
  if (params.type === "image") {
    if (provider === "openai") {
      const width = (params as ImageJobParams).width ?? 1024;
      const height = (params as ImageJobParams).height ?? 1024;
      const megapixels = (width * height) / 1_000_000;
      return Number((0.04 * megapixels).toFixed(3));
    }
    if (provider === "stability") {
      return 0.04;
    }
    if (provider === "google") {
      return 0.04;
    }
    if (provider === "flux") {
      return 0.05;
    }
  }
  if (params.type === "video") {
    const duration = (params as VideoJobParams).duration ?? 10;
    if (provider === "runway") {
      return Number((0.015 * duration).toFixed(3));
    }
    if (provider === "google") {
      // Veo is priced per second; rough order-of-magnitude estimate.
      return Number((0.4 * duration).toFixed(2));
    }
    if (provider === "luma") {
      return Number((0.35 * duration).toFixed(2));
    }
  }
  return null;
}
