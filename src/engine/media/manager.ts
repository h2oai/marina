// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import type { MarinaDB, MediaJobRow, MediaJobType } from "../../persistence/database";
import type { StorageProvider } from "../../storage/provider";
import type { EngineEvent, EntityId } from "../../types";
import { canvasReaderFor } from "../canvas-access";
import type { Engine } from "../engine";
import { getErrorMessage } from "../errors";
import { dailyCapRefusal, recordSpend } from "../spend-ledger";
import { startMediaVerify } from "./image-decisions";
import {
  getImageProvider,
  imageProviderRequiresKey,
  knownImageProviders,
} from "./providers/image-registry";
import type { GeneratedAsset, ImageGenerator } from "./providers/image-util";
import { moderateOpenAIText } from "./providers/openai";
import { runwayCostEstimate } from "./providers/runway";
import { getVideoProvider, knownVideoProviders } from "./providers/video-registry";
import type { VideoResult } from "./providers/video-util";
import { publishGeneratedAsset, storeGeneratedAsset } from "./publish";
import { loadVisualSource, sniffRaster } from "./vision";

/** Per-entity rolling-24h job caps when `MAX_{IMAGE,VIDEO}_JOBS_PER_DAY` is unset. */
export const DEFAULT_MAX_IMAGE_JOBS_PER_DAY = 50;
export const DEFAULT_MAX_VIDEO_JOBS_PER_DAY = 5;
/** Minutes a video job may render before it fails, when `MARINA_VIDEO_JOB_TIMEOUT_MIN` is unset. */
export const DEFAULT_VIDEO_JOB_TIMEOUT_MIN = 30;
/** Bound on one provider call (start, poll + download) so a hung request never holds the poller. */
const PROVIDER_CALL_TIMEOUT_MS = 60_000;
/** Running video jobs examined per poll pass (oldest first). */
const POLL_BATCH = 50;
/**
 * Largest stored image sent inline as a reference: Runway caps a data URI at
 * 5 MiB of text, and base64 adds a third.
 */
const REFERENCE_INLINE_MAX_BYTES = 3_900_000;

/**
 * The overall deadline for a video job in ms: a positive number of minutes
 * from `MARINA_VIDEO_JOB_TIMEOUT_MIN`, else the default — a typo or `0` never
 * makes a render unbounded.
 */
export function videoJobTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MARINA_VIDEO_JOB_TIMEOUT_MIN?.trim();
  const n = raw ? Number(raw) : Number.NaN;
  const minutes = Number.isFinite(n) && n > 0 ? n : DEFAULT_VIDEO_JOB_TIMEOUT_MIN;
  return Math.round(minutes * 60_000);
}

/**
 * One entity's rolling-24h cap for a media type: a positive integer is the
 * cap, `0` is explicitly unlimited, unset/blank/junk is the default (a typo
 * never lifts the cap).
 */
export function mediaJobCap(type: MediaJobType, env: NodeJS.ProcessEnv = process.env): number {
  const raw = (type === "image" ? env.MAX_IMAGE_JOBS_PER_DAY : env.MAX_VIDEO_JOBS_PER_DAY)?.trim();
  const fallback =
    type === "image" ? DEFAULT_MAX_IMAGE_JOBS_PER_DAY : DEFAULT_MAX_VIDEO_JOBS_PER_DAY;
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

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

/** What a video job's events and completion need — rebuilt from the row on a resumed poll. */
interface VideoJobContext {
  type: "video";
  entityId: EntityId;
  entityName: string;
  prompt: string;
  model: string;
  canvasId?: string;
  duration?: number;
  costHint?: number | null;
}

/** The result of one durable poll pass (for tests and operators). */
export interface VideoPollPass {
  polled: number;
  succeeded: number;
  failed: number;
  timedOut: number;
}

export class MediaManager {
  private engine: Engine;
  private db: MarinaDB;
  private resolveApiKey: ProviderKeyResolver;
  private logEvent: (event: EngineEvent) => void;
  private stopped = false;

  constructor(deps: MediaManagerDeps) {
    this.engine = deps.engine;
    this.db = deps.db;
    this.resolveApiKey = deps.resolveApiKey;
    this.logEvent = deps.logEvent;
  }

  async startJob(params: StartJobParams): Promise<MediaJobRow> {
    this.enforceQuota(params.entityName, params.type);
    const costEstimate = params.costHint ?? estimateCost(params);
    // A priced (cloud) job counts against the world's daily spend cap; a
    // local endpoint with no known price is never refused by it.
    if (costEstimate) {
      const capped = dailyCapRefusal();
      if (capped) throw new Error(`${params.type} generation refused: ${capped}`);
    }

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
      costEstimate,
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

  /**
   * Stop starting new poll passes. Running jobs stay `running` in the
   * database; the next process's `media-video-poll` tick job resumes them.
   */
  stop(): void {
    this.stopped = true;
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

    this.recordMediaSpend(params);
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
    // MARINA_MEDIA_VERIFY (default off: no call, no change) — image-decisions.ts.
    startMediaVerify(
      this.engine,
      {
        db: this.db,
        logEvent: this.logEvent,
        regenerate: (metadata) =>
          this.startJob({ ...params, metadata: { ...params.metadata, ...metadata } }),
      },
      {
        jobId,
        entityName: params.entityName,
        prompt: params.prompt,
        data,
        metadata: params.metadata,
      },
    );
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
    const referenceImage = await this.resolveReferenceImage(params);
    const start: VideoResult = await vp.start({
      apiKey,
      model: params.model,
      prompt: params.prompt,
      duration: params.duration,
      fps: params.fps,
      referenceImage,
      aspectRatio: params.aspectRatio,
      signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS),
    });
    const ctx = videoContextFromParams(params);

    if (start.status === "succeeded" && start.asset) {
      await this.finishVideoJob(jobId, "pending", ctx, start.asset, start.costUsd);
      return;
    }
    if (start.status !== "running" || !start.providerJobId) {
      // A running start with no task id could never be polled to completion.
      const error =
        start.status === "running"
          ? "Video provider returned no task id to poll."
          : (start.error ?? "Video job creation failed");
      this.failVideoJob(jobId, "pending", ctx, error, start.costUsd);
      return;
    }

    // From here the job is durable: the `media-video-poll` tick job polls it
    // by its stored provider task id, across restarts, until its deadline.
    this.db.updateMediaJob(jobId, {
      status: "running",
      providerJobId: start.providerJobId,
      metadata: { progress: start.progress ?? 0 },
    });
    this.emitFeedEvent("media_rendering", ctx, jobId, {
      status: "running",
      message: "Video render started.",
      providerJobId: start.providerJobId,
    });
  }

  /**
   * A video job's reference image as the providers take it: an `https://`
   * URL or an image data URI pass through; anything else is a canvas node or
   * asset reference (`node:<id>`, `asset:<id>`, a bare id) or an http URL,
   * loaded as the requester — a private asset they may not read is "not
   * found" — checked to be a raster image, and inlined as a data URI.
   */
  private async resolveReferenceImage(params: VideoJobParams): Promise<string | undefined> {
    const ref = params.referenceImage?.trim();
    if (!ref) return undefined;
    if (/^https:\/\//i.test(ref) || /^data:image\//i.test(ref)) return ref;
    const src = await loadVisualSource(
      this.engine,
      ref,
      canvasReaderFor(this.engine, params.entityId, { inWorld: true }),
    );
    const mime = sniffRaster(src.data);
    if (!mime) throw new Error(`Reference "${ref}" is not a PNG, JPEG, GIF or WebP image.`);
    if (src.data.byteLength > REFERENCE_INLINE_MAX_BYTES) {
      throw new Error(
        `Reference image is too large to send (${src.data.byteLength} bytes; limit ${REFERENCE_INLINE_MAX_BYTES}).`,
      );
    }
    return `data:${mime};base64,${Buffer.from(src.data).toString("base64")}`;
  }

  /**
   * One durable poll pass over every `running` video job in the database —
   * the only video polling path (the `media-video-poll` tick job, so it also
   * resumes jobs a previous process left running). A job past its deadline
   * (`MARINA_VIDEO_JOB_TIMEOUT_MIN`) fails with a timeout reason; a transient
   * provider error keeps it running for the next pass.
   */
  async pollRunningVideoJobs(now = Date.now()): Promise<VideoPollPass> {
    const pass: VideoPollPass = { polled: 0, succeeded: 0, failed: 0, timedOut: 0 };
    if (this.stopped) return pass;
    const rows = this.db.listMediaJobsByStatus({
      status: "running",
      type: "video",
      limit: POLL_BATCH,
    });
    const timeoutMs = videoJobTimeoutMs();
    await Promise.all(
      rows.map(async (row) => {
        const outcome = await this.pollVideoJob(row, now, timeoutMs).catch((error: unknown) => {
          // A bug or storage failure in one job never stops the others.
          const ctx = videoContextFromRow(row);
          this.failVideoJob(row.id, "running", ctx, getErrorMessage(error));
          return "failed" as const;
        });
        pass.polled += 1;
        if (outcome === "succeeded") pass.succeeded += 1;
        else if (outcome === "failed") pass.failed += 1;
        else if (outcome === "timed-out") pass.timedOut += 1;
      }),
    );
    return pass;
  }

  private async pollVideoJob(
    row: MediaJobRow,
    now: number,
    timeoutMs: number,
  ): Promise<"running" | "succeeded" | "failed" | "timed-out"> {
    const ctx = videoContextFromRow(row);
    if (now - row.created_at > timeoutMs) {
      const minutes = Math.round(timeoutMs / 60_000);
      const task = row.provider_job_id ? ` (provider task ${row.provider_job_id})` : "";
      this.failVideoJob(
        row.id,
        "running",
        ctx,
        `Video job timed out: still rendering after ${minutes} min${task}. Raise MARINA_VIDEO_JOB_TIMEOUT_MIN to wait longer.`,
      );
      return "timed-out";
    }
    if (!row.provider_job_id) {
      this.failVideoJob(row.id, "running", ctx, "Video job has no provider task id to poll.");
      return "failed";
    }
    const vp = getVideoProvider(row.provider);
    if (!vp) {
      this.failVideoJob(row.id, "running", ctx, `Provider "${row.provider}" no longer supported.`);
      return "failed";
    }
    const apiKey = this.resolveApiKey(row.provider);
    if (!apiKey) {
      this.failVideoJob(row.id, "running", ctx, "Missing provider key during polling.");
      return "failed";
    }

    const poll = await vp.poll({
      apiKey,
      providerJobId: row.provider_job_id,
      signal: AbortSignal.timeout(PROVIDER_CALL_TIMEOUT_MS),
    });

    if (poll.status === "running") {
      const prior = parseJson(row.metadata);
      const progress = poll.progress ?? (prior.progress as number | null | undefined) ?? null;
      this.db.updateMediaJob(row.id, {
        metadata: {
          ...prior,
          progress,
          lastPolledAt: now,
          lastPollError: poll.retryable ? (poll.error ?? "transient provider error") : null,
        },
      });
      if (poll.progress !== undefined && poll.progress !== prior.progress) {
        this.emitFeedEvent("media_rendering", ctx, row.id, {
          status: "running",
          progress: poll.progress,
        });
      }
      return "running";
    }
    if (poll.status === "succeeded" && poll.asset) {
      return (await this.finishVideoJob(row.id, "running", ctx, poll.asset, poll.costUsd))
        ? "succeeded"
        : "running";
    }
    this.failVideoJob(
      row.id,
      "running",
      ctx,
      poll.error ??
        (poll.status === "succeeded"
          ? "Video provider returned no asset."
          : "Video generation failed."),
      poll.costUsd,
    );
    return "failed";
  }

  /**
   * Fail a video job if it is still in `from` (compare-and-set). A provider
   * that reports a charge for a failed task (`costUsd > 0`) has that charge
   * recorded once, by the caller that made the transition.
   */
  private failVideoJob(
    jobId: string,
    from: "pending" | "running",
    ctx: VideoJobContext,
    error: string,
    costUsd?: number,
  ): void {
    const claimed = this.db.transitionMediaJob(jobId, from, {
      status: "failed",
      error,
      completedAt: Date.now(),
    });
    if (!claimed) return;
    if (costUsd && costUsd > 0) recordSpend("media", costUsd);
    this.emitFeedEvent("media_failed", ctx, jobId, { status: "failed", message: error });
  }

  /**
   * Store the rendered video, then complete the job if it is still in `from`
   * (compare-and-set). Only the caller that wins the transition records the
   * spend (the provider's reported charge, else the job's estimate), publishes
   * the canvas node and emits completion — so a job is never charged or
   * published twice, even if two passes or two processes observe the same
   * finished task. Returns whether this call completed the job.
   */
  private async finishVideoJob(
    jobId: string,
    from: "pending" | "running",
    ctx: VideoJobContext,
    asset: GeneratedAsset,
    costUsd?: number,
  ): Promise<boolean> {
    const cost = costUsd ?? this.db.getMediaJob(jobId)?.cost_estimate ?? estimateCost(ctx);
    let stored: { id: string };
    try {
      stored = await storeGeneratedAsset({
        engine: this.engine,
        entityName: ctx.entityName,
        filename: asset.filename,
        mimeType: asset.mimeType,
        data: asset.data,
        prompt: ctx.prompt,
        model: ctx.model,
        metadata: { provider: this.extractProvider(ctx.model) },
        id: crypto.randomUUID(),
      });
    } catch (error) {
      // The render is done and paid for; only keeping it failed.
      this.failVideoJob(
        jobId,
        from,
        ctx,
        `Video rendered but storing it failed: ${getErrorMessage(error)}`,
        cost ?? undefined,
      );
      return false;
    }
    const claimed = this.db.transitionMediaJob(jobId, from, {
      status: "succeeded",
      assetId: stored.id,
      error: null,
      completedAt: Date.now(),
    });
    if (!claimed) return false;
    recordSpend("media", cost ?? undefined);

    const canvasId =
      (ctx.canvasId && this.engine.db?.getCanvas(ctx.canvasId)?.id) ??
      this.engine.db?.ensureEntityCanvas(ctx.entityId, ctx.entityName, ctx.entityName).id ??
      null;
    if (canvasId) {
      publishGeneratedAsset({
        engine: this.engine,
        entityId: ctx.entityId,
        entityName: ctx.entityName,
        assetId: stored.id,
        nodeType: "video",
        prompt: ctx.prompt,
        model: ctx.model,
        canvasId,
        summary: `${ctx.entityName} generated a video.`,
      });
    }
    this.emitFeedEvent("media_complete", ctx, jobId, {
      status: "succeeded",
      message: `Video ready (${asset.filename})`,
      assetId: stored.id,
    });
    return true;
  }

  private enforceQuota(entityName: string, type: MediaJobType): void {
    const cap = mediaJobCap(type);
    if (cap <= 0) return;
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const count = this.db.countMediaJobsSince({ entityName, since, type });
    if (count >= cap) {
      const envVar = type === "image" ? "MAX_IMAGE_JOBS_PER_DAY" : "MAX_VIDEO_JOBS_PER_DAY";
      throw new Error(
        `Daily ${type} quota reached (${count}/${cap} in the last 24 h). Try again later, or an operator can raise ${envVar} (0 = unlimited).`,
      );
    }
  }

  /** A completed job's estimated price goes into the daily spend ledger. */
  private recordMediaSpend(params: StartJobParams): void {
    recordSpend("media", params.costHint ?? estimateCost(params) ?? undefined);
  }

  private emitFeedEvent(
    kind: string,
    params: FeedSubject,
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

/** What a feed event names: who, which media type, which model, which canvas. */
type FeedSubject = Pick<BaseJobParams, "entityId" | "entityName" | "model" | "canvasId"> & {
  type: MediaJobType;
};

function parseJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    // allow-empty-catch: a malformed stored JSON column reads as empty.
    return {};
  }
}

function videoContextFromParams(params: VideoJobParams): VideoJobContext {
  return {
    type: "video",
    entityId: params.entityId,
    entityName: params.entityName,
    prompt: params.prompt,
    model: params.model,
    ...(params.canvasId ? { canvasId: params.canvasId } : {}),
    ...(params.duration !== undefined ? { duration: params.duration } : {}),
    costHint: params.costHint ?? null,
  };
}

/** Rebuild a video job's context from its durable row (a resumed poll has no request params). */
function videoContextFromRow(row: MediaJobRow): VideoJobContext {
  const options = parseJson(row.options);
  const canvasId = typeof options.canvasId === "string" ? options.canvasId : undefined;
  const duration = typeof options.duration === "number" ? options.duration : undefined;
  return {
    type: "video",
    entityId: (row.entity_id ?? row.entity_name) as EntityId,
    entityName: row.entity_name,
    prompt: row.prompt,
    model: row.model,
    ...(canvasId ? { canvasId } : {}),
    ...(duration !== undefined ? { duration } : {}),
    costHint: row.cost_estimate,
  };
}

function summarizeFeed(
  kind: string,
  params: FeedSubject,
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

type CostSubject = { type: MediaJobType; model: string; costHint?: number | null } & Partial<
  Pick<ImageJobParams, "width" | "height"> & Pick<VideoJobParams, "duration">
>;

function estimateCost(params: CostSubject): number | null {
  if (params.costHint != null) return params.costHint;
  const provider = params.model.split(/[:/]/)[0] ?? "";
  if (params.type === "image") {
    if (provider === "openai") {
      const width = params.width ?? 1024;
      const height = params.height ?? 1024;
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
    if (provider === "runway") {
      // Runway's published credit price per model (gen4.5: 12 credits/s at $0.01).
      return runwayCostEstimate(params.model, params.duration);
    }
    const duration = params.duration ?? 8;
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
