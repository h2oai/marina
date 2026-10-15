// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runway video generation over Runway's public developer API
 * (https://docs.dev.runwayml.com/api/). Models: `runway/gen4.5` (text or image
 * to video), `runway/gen4_turbo` (image to video only), and the other models
 * Runway hosts (`runway/veo3.1`, …) by their Runway id. Key: RUNWAY_API_KEY.
 *
 * Async: `POST /v1/text_to_video` or `/v1/image_to_video` returns a task id;
 * `GET /v1/tasks/{id}` reports PENDING / THROTTLED / RUNNING / SUCCEEDED /
 * FAILED / CANCELLED, and a succeeded task lists output URLs (valid 24–48 h)
 * plus its final `cost.credits` (one credit = $0.01). Every call carries the
 * required `X-Runway-Version` header and goes through the SSRF guard.
 *
 * Runway takes `ratio` as an output resolution (`1280:720`), not an aspect
 * ratio, and has no frame-rate parameter — a requested `fps` is not sent.
 */

import { Buffer } from "node:buffer";
import { guardedFetch } from "../../../net/url-guard";
import { bareModel, type GeneratedAsset, nearestAspectRatio } from "./image-util";
import type { VideoPollOptions, VideoResult, VideoStartOptions } from "./video-util";

export const RUNWAY_API_BASE = "https://api.dev.runwayml.com/v1";
/** The API version every request must name (the only version the API accepts today). */
export const RUNWAY_API_VERSION = "2024-11-06";
/** Runway's model when a request names only the provider. */
export const RUNWAY_DEFAULT_MODEL = "gen4.5";
/** USD per Runway credit (Runway's published developer price). */
export const RUNWAY_USD_PER_CREDIT = 0.01;

const GEN4_IMAGE_RATIOS = ["1280:720", "720:1280", "1104:832", "960:960", "832:1104", "1584:672"];
const VEO_RATIOS = ["1280:720", "720:1280", "1080:1920", "1920:1080"];

interface RunwayModelSpec {
  /** Output resolutions for text-to-video (absent: the model is image-to-video only). */
  textRatios?: string[];
  imageRatios: string[];
  /** Integer seconds range, or a fixed set of allowed durations. */
  duration: { min: number; max: number } | { oneOf: number[] };
  defaultDuration: number;
}

/** The Runway models whose parameters Marina knows; others pass through with gen4.5's shape. */
const MODELS: Record<string, RunwayModelSpec> = {
  "gen4.5": {
    textRatios: ["1280:720", "720:1280"],
    imageRatios: GEN4_IMAGE_RATIOS,
    duration: { min: 2, max: 10 },
    defaultDuration: 5,
  },
  gen4_turbo: {
    imageRatios: GEN4_IMAGE_RATIOS,
    duration: { min: 2, max: 10 },
    defaultDuration: 5,
  },
  "veo3.1": {
    textRatios: VEO_RATIOS,
    imageRatios: VEO_RATIOS,
    duration: { oneOf: [4, 6, 8] },
    defaultDuration: 8,
  },
  "veo3.1_fast": {
    textRatios: VEO_RATIOS,
    imageRatios: VEO_RATIOS,
    duration: { oneOf: [4, 6, 8] },
    defaultDuration: 8,
  },
};

/** Credits per second of output (Runway's published price list) for the cost estimate. */
const CREDITS_PER_SECOND: Record<string, number> = {
  "gen4.5": 12,
  gen4_turbo: 5,
};

/** The bare Runway model id for a `runway/<id>` (or bare) model string. */
export function runwayModelId(model: string): string {
  const id = bareModel(model).trim();
  return !id || id === "runway" ? RUNWAY_DEFAULT_MODEL : id;
}

/** Estimated USD for `seconds` of output from `model` (gen4.5's price for unknown ids). */
export function runwayCostEstimate(model: string, seconds: number | undefined): number {
  const id = runwayModelId(model);
  const spec = MODELS[id];
  const secs = runwayDuration(spec, seconds) ?? spec?.defaultDuration ?? 5;
  const perSecond = CREDITS_PER_SECOND[id] ?? CREDITS_PER_SECOND["gen4.5"]!;
  return Number((perSecond * secs * RUNWAY_USD_PER_CREDIT).toFixed(3));
}

function runwayDuration(spec: RunwayModelSpec | undefined, seconds?: number): number | undefined {
  if (!spec) return seconds && seconds > 0 ? Math.round(seconds) : undefined;
  const want = seconds && Number.isFinite(seconds) && seconds > 0 ? seconds : spec.defaultDuration;
  if ("oneOf" in spec.duration) {
    return spec.duration.oneOf.reduce((best, d) =>
      Math.abs(d - want) < Math.abs(best - want) ? d : best,
    );
  }
  return Math.min(spec.duration.max, Math.max(spec.duration.min, Math.round(want)));
}

/** Snap `16:9`-style aspect ratios (or a resolution) to one of the model's output resolutions. */
export function runwayRatio(aspectRatio: string | undefined, allowed: string[]): string {
  if (aspectRatio && allowed.includes(aspectRatio)) return aspectRatio;
  const [w, h] = (aspectRatio ?? "16:9").split(":").map(Number);
  // nearestAspectRatio prefers 1:1 on bad input; Runway's landscape default is the first entry.
  if (!w || !h) return allowed[0]!;
  return nearestAspectRatio(w, h, allowed);
}

function headers(apiKey: string, json: boolean): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "X-Runway-Version": RUNWAY_API_VERSION,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

/**
 * The request a start sends: endpoint + JSON body. `referenceImage` must
 * already be an `https://` URL or a `data:image/…` URI (the manager resolves
 * asset ids before calling a provider).
 */
export function buildRunwayStartRequest(
  opts: VideoStartOptions,
): { path: string; body: Record<string, unknown> } | { error: string } {
  const model = runwayModelId(opts.model);
  const spec = MODELS[model];
  const image = opts.referenceImage;
  if (image && !/^(https:\/\/|data:image\/)/i.test(image)) {
    return { error: "Runway needs the reference image as an https URL or an image data URI." };
  }
  if (!image && spec && !spec.textRatios) {
    return { error: `Runway model "${model}" is image-to-video only — give a reference image.` };
  }
  const ratios = (image ? spec?.imageRatios : spec?.textRatios) ?? ["1280:720", "720:1280"];
  const body: Record<string, unknown> = {
    model,
    promptText: opts.prompt,
    ratio: runwayRatio(opts.aspectRatio, ratios),
  };
  const duration = runwayDuration(spec, opts.duration);
  if (duration !== undefined) body.duration = duration;
  if (image) body.promptImage = image;
  return { path: image ? "/image_to_video" : "/text_to_video", body };
}

/** Runway's 4xx body: `{ error: string, issues?: [...] }`. */
async function errorText(res: Response, fallback: string): Promise<string> {
  try {
    const json = (await res.json()) as { error?: unknown; issues?: unknown };
    const base = typeof json.error === "string" && json.error ? json.error : fallback;
    return Array.isArray(json.issues) && json.issues.length > 0
      ? `${base} ${JSON.stringify(json.issues).slice(0, 500)}`
      : base;
  } catch {
    return fallback;
  }
}

/** A transport failure, throttle or server error — the poll should be retried, not failed. */
function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function startRunwayVideoJob(opts: VideoStartOptions): Promise<VideoResult> {
  const req = buildRunwayStartRequest(opts);
  if ("error" in req) return { status: "failed", error: req.error };
  try {
    const res = await guardedFetch(`${RUNWAY_API_BASE}${req.path}`, {
      method: "POST",
      headers: headers(opts.apiKey, true),
      body: JSON.stringify(req.body),
      signal: opts.signal,
    });
    if (!res.ok) {
      return {
        status: "failed",
        error: await errorText(res, `Runway start failed (${res.status})`),
      };
    }
    const json = (await res.json()) as { id?: string };
    if (!json.id) return { status: "failed", error: "Runway did not return a task id." };
    return { status: "running", providerJobId: json.id, progress: 0 };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

interface RunwayTask {
  id?: string;
  status?: "PENDING" | "THROTTLED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  progress?: number;
  output?: string[];
  failure?: string;
  failureCode?: string;
  cost?: { credits?: number };
}

export async function pollRunwayVideoJob(opts: VideoPollOptions): Promise<VideoResult> {
  try {
    const res = await guardedFetch(
      `${RUNWAY_API_BASE}/tasks/${encodeURIComponent(opts.providerJobId)}`,
      { method: "GET", headers: headers(opts.apiKey, false), signal: opts.signal },
    );
    if (res.status === 404) {
      return { status: "failed", error: "Runway task does not exist, or was deleted or canceled." };
    }
    if (!res.ok) {
      const error = await errorText(res, `Runway poll failed (${res.status})`);
      return retryableStatus(res.status)
        ? { status: "running", error, retryable: true }
        : { status: "failed", error };
    }
    const task = (await res.json()) as RunwayTask;
    switch (task.status) {
      case "PENDING":
      case "THROTTLED":
        return { status: "running", progress: 0 };
      case "RUNNING":
        return { status: "running", progress: task.progress ?? 0 };
      case "FAILED":
        return {
          status: "failed",
          error: task.failure
            ? `${task.failure}${task.failureCode ? ` (${task.failureCode})` : ""}`
            : "Runway reported failure.",
        };
      case "CANCELLED":
        return { status: "failed", error: "Runway task was cancelled." };
      case "SUCCEEDED": {
        const costUsd =
          typeof task.cost?.credits === "number"
            ? Number((task.cost.credits * RUNWAY_USD_PER_CREDIT).toFixed(4))
            : undefined;
        if (!task.output?.[0]) {
          return {
            status: "failed",
            error: "Runway returned success without an output URL.",
            ...(costUsd === undefined ? {} : { costUsd }),
          };
        }
        const asset = await download(task.output[0], opts.signal);
        if (!asset) {
          // The render is paid for and its URL lives 24–48 h: retry the
          // download on the next poll (each poll returns fresh URLs).
          return { status: "running", retryable: true, error: "Runway video download failed." };
        }
        return { status: "succeeded", asset, ...(costUsd === undefined ? {} : { costUsd }) };
      }
      default:
        return { status: "failed", error: `Runway returned an unknown task status.` };
    }
  } catch (error) {
    // Network failure: keep the job and poll again; the job deadline bounds it.
    return {
      status: "running",
      retryable: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function download(url: string, signal?: AbortSignal): Promise<GeneratedAsset | null> {
  // Provider-returned asset URL — route through the SSRF guard, not bare fetch.
  const res = await guardedFetch(url, { signal });
  if (!res.ok) return null;
  const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || "video/mp4";
  return {
    data: new Uint8Array(Buffer.from(await res.arrayBuffer())),
    mimeType,
    filename: `video-${Date.now()}.${mimeType === "video/quicktime" ? "mov" : "mp4"}`,
  };
}
