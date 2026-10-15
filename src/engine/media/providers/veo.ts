// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Google Veo video generation (Gemini API long-running predict + poll;
 * https://ai.google.dev/gemini-api/docs/veo). Models:
 * `google/veo-3.1-generate-preview`, `google/veo-3.1-fast-generate-preview`,
 * `google/veo-3.1-lite-generate-preview`. Key: GEMINI_API_KEY (reused).
 *
 * Veo is async: `:predictLongRunning` returns an operation name; we poll that
 * operation until `done`, then download the produced video. Response shapes have
 * shifted across Veo revisions, so extraction is defensive (uri or inline bytes).
 *
 * Limits passed through honestly: `durationSeconds` is one of 4 / 6 / 8 (a
 * request snaps to the nearest; Veo requires 8 with a reference image), the
 * aspect ratio is 16:9 or 9:16, and the frame rate is fixed at 24 fps by Veo —
 * a requested `fps` is not sent. A reference image is sent inline as the first
 * frame (`instances[0].image.inlineData`).
 */

import { Buffer } from "node:buffer";
import { guardedFetch } from "../../../net/url-guard";
import { bareModel, type GeneratedAsset } from "./image-util";
import type { VideoPollOptions, VideoResult, VideoStartOptions } from "./video-util";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const ASPECTS = new Set(["16:9", "9:16"]);
const DURATIONS = [4, 6, 8];
/** Largest reference image fetched from a URL to send inline (bytes). */
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;

function aspect(aspectRatio?: string): string {
  return aspectRatio && ASPECTS.has(aspectRatio) ? aspectRatio : "16:9";
}

/** Veo's `durationSeconds` (a string): 8 with a reference image, else the nearest of 4/6/8. */
export function veoDurationSeconds(duration: number | undefined, withImage: boolean): string {
  if (withImage) return "8";
  const want = duration && Number.isFinite(duration) && duration > 0 ? duration : 8;
  return String(DURATIONS.reduce((b, d) => (Math.abs(d - want) < Math.abs(b - want) ? d : b)));
}

/** A resolved reference (image data URI or https URL) as Veo's inline image. */
async function inlineImage(
  ref: string,
  signal?: AbortSignal,
): Promise<{ mimeType: string; data: string }> {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(ref);
  if (m) return { mimeType: m[1]!, data: m[2]! };
  if (!/^https:\/\//i.test(ref)) {
    throw new Error("Veo needs the reference image as an https URL or an image data URI.");
  }
  const res = await guardedFetch(ref, { signal });
  if (!res.ok) throw new Error(`Reference image fetch failed (${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_REFERENCE_BYTES) throw new Error("Reference image is too large.");
  const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  if (!mimeType.startsWith("image/")) throw new Error("Reference URL is not an image.");
  return { mimeType, data: Buffer.from(bytes).toString("base64") };
}

export async function startVeoVideoJob(opts: VideoStartOptions): Promise<VideoResult> {
  try {
    const model = bareModel(opts.model);
    const instance: Record<string, unknown> = { prompt: opts.prompt };
    if (opts.referenceImage) {
      instance.image = { inlineData: await inlineImage(opts.referenceImage, opts.signal) };
    }
    const url = `${BASE}/models/${encodeURIComponent(model)}:predictLongRunning`;
    const res = await guardedFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": opts.apiKey },
      body: JSON.stringify({
        instances: [instance],
        parameters: {
          aspectRatio: aspect(opts.aspectRatio),
          durationSeconds: veoDurationSeconds(opts.duration, Boolean(opts.referenceImage)),
        },
      }),
      signal: opts.signal,
    });
    const json = (await res.json()) as { name?: string; error?: { message?: string } };
    if (!res.ok) {
      return { status: "failed", error: json.error?.message ?? `Veo start failed (${res.status})` };
    }
    if (!json.name) {
      return { status: "failed", error: "Veo did not return an operation name." };
    }
    return { status: "running", providerJobId: json.name, progress: 0 };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function pollVeoVideoJob(opts: VideoPollOptions): Promise<VideoResult> {
  try {
    // The operation name is provider-issued (`models/<m>/operations/<id>`); refuse anything else.
    if (!/^[A-Za-z0-9._/-]+$/.test(opts.providerJobId) || opts.providerJobId.includes("..")) {
      return { status: "failed", error: "Invalid Veo operation name." };
    }
    const res = await guardedFetch(`${BASE}/${opts.providerJobId}`, {
      headers: { "x-goog-api-key": opts.apiKey },
      signal: opts.signal,
    });
    const json = (await res.json()) as {
      done?: boolean;
      error?: { message?: string };
      response?: Record<string, unknown>;
    };
    if (!res.ok) {
      const error = json.error?.message ?? `Veo poll failed (${res.status})`;
      return res.status === 429 || res.status >= 500
        ? { status: "running", retryable: true, error }
        : { status: "failed", error };
    }
    if (!json.done) return { status: "running" };
    if (json.error)
      return { status: "failed", error: json.error.message ?? "Veo reported failure." };

    const asset = await extractVeoAsset(json.response, opts.apiKey, opts.signal);
    if (!asset) return { status: "failed", error: "Veo completed without a downloadable video." };
    return { status: "succeeded", asset };
  } catch (error) {
    // Network failure: keep the job and poll again; the job deadline bounds it.
    return {
      status: "running",
      retryable: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Pull a video out of a Veo operation response across its known shapes. */
async function extractVeoAsset(
  response: Record<string, unknown> | undefined,
  apiKey: string,
  signal?: AbortSignal,
): Promise<GeneratedAsset | null> {
  if (!response) return null;
  // Walk the common nesting variants for a sample's `{ uri }` or base64 bytes.
  const samples =
    ((response.generateVideoResponse as Record<string, unknown> | undefined)?.generatedSamples as
      | Array<Record<string, unknown>>
      | undefined) ??
    (response.generatedVideos as Array<Record<string, unknown>> | undefined) ??
    (response.predictions as Array<Record<string, unknown>> | undefined) ??
    [];
  const first = samples[0];
  if (!first) return null;

  const video = (first.video as Record<string, unknown> | undefined) ?? first;
  const uri = (video.uri as string | undefined) ?? (first.uri as string | undefined);
  const b64 =
    (video.bytesBase64Encoded as string | undefined) ??
    (first.bytesBase64Encoded as string | undefined);

  if (b64) {
    return {
      data: new Uint8Array(Buffer.from(b64, "base64")),
      mimeType: "video/mp4",
      filename: `video-${Date.now()}.mp4`,
    };
  }
  if (uri) {
    // The file lives behind the Files API and needs the key.
    const dlUrl = uri.includes("key=")
      ? uri
      : `${uri}${uri.includes("?") ? "&" : "?"}key=${encodeURIComponent(apiKey)}`;
    // Provider-returned Files-API URL — route through the SSRF guard, not bare fetch.
    const dl = await guardedFetch(dlUrl, { headers: { "x-goog-api-key": apiKey }, signal });
    if (!dl.ok) return null;
    const mimeType = dl.headers.get("content-type") ?? "video/mp4";
    return {
      data: new Uint8Array(await dl.arrayBuffer()),
      mimeType,
      filename: `video-${Date.now()}.mp4`,
    };
  }
  return null;
}
