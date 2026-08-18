// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Google Veo video generation (Gemini long-running predict + poll).
 * Models: `google/veo-3.0-generate-preview`, etc. Key: GEMINI_API_KEY (reused).
 *
 * Veo is async: `:predictLongRunning` returns an operation name; we poll that
 * operation until `done`, then download the produced video. Response shapes have
 * shifted across Veo revisions, so extraction is defensive (uri or inline bytes).
 */

import { Buffer } from "node:buffer";
import { bareModel, type GeneratedAsset } from "./image-util";
import type { VideoPollOptions, VideoResult, VideoStartOptions } from "./video-util";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const ASPECTS = new Set(["16:9", "9:16"]);

function aspect(aspectRatio?: string): string {
  return aspectRatio && ASPECTS.has(aspectRatio) ? aspectRatio : "16:9";
}

export async function startVeoVideoJob(opts: VideoStartOptions): Promise<VideoResult> {
  try {
    const model = bareModel(opts.model);
    const url = `${BASE}/models/${encodeURIComponent(model)}:predictLongRunning?key=${encodeURIComponent(opts.apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt: opts.prompt }],
        parameters: { aspectRatio: aspect(opts.aspectRatio) },
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
    const url = `${BASE}/${opts.providerJobId}?key=${encodeURIComponent(opts.apiKey)}`;
    const res = await fetch(url, { signal: opts.signal });
    const json = (await res.json()) as {
      done?: boolean;
      error?: { message?: string };
      response?: Record<string, unknown>;
    };
    if (!res.ok) {
      return { status: "failed", error: json.error?.message ?? `Veo poll failed (${res.status})` };
    }
    if (!json.done) return { status: "running" };
    if (json.error)
      return { status: "failed", error: json.error.message ?? "Veo reported failure." };

    const asset = await extractVeoAsset(json.response, opts.apiKey, opts.signal);
    if (!asset) return { status: "failed", error: "Veo completed without a downloadable video." };
    return { status: "succeeded", asset };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
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
    const dl = await fetch(dlUrl, { headers: { "x-goog-api-key": apiKey }, signal });
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
