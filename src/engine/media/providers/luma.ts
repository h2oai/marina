/**
 * Luma Dream Machine video generation. Models: `luma/ray-2`, `luma/ray-1-6`, …
 * Key: LUMA_API_KEY (Bearer). Async: create a generation, poll until `completed`.
 */

import { Buffer } from "node:buffer";
import { bareModel, type GeneratedAsset } from "./image-util";
import type { VideoPollOptions, VideoResult, VideoStartOptions } from "./video-util";

const BASE = "https://api.lumalabs.ai/dream-machine/v1";

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    accept: "application/json",
  };
}

export async function startLumaVideoJob(opts: VideoStartOptions): Promise<VideoResult> {
  try {
    const model = bareModel(opts.model);
    const body: Record<string, unknown> = {
      prompt: opts.prompt,
      model: model && model !== "luma" ? model : "ray-2",
    };
    if (opts.aspectRatio) body.aspect_ratio = opts.aspectRatio;
    if (opts.duration) body.duration = `${opts.duration}s`;
    if (opts.referenceImage) {
      body.keyframes = { frame0: { type: "image", url: opts.referenceImage } };
    }
    const res = await fetch(`${BASE}/generations`, {
      method: "POST",
      headers: headers(opts.apiKey),
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    const json = (await res.json()) as { id?: string; detail?: string };
    if (!res.ok || !json.id) {
      return { status: "failed", error: json.detail ?? `Luma start failed (${res.status})` };
    }
    return { status: "running", providerJobId: json.id, progress: 0 };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function pollLumaVideoJob(opts: VideoPollOptions): Promise<VideoResult> {
  try {
    const res = await fetch(`${BASE}/generations/${encodeURIComponent(opts.providerJobId)}`, {
      headers: headers(opts.apiKey),
      signal: opts.signal,
    });
    const json = (await res.json()) as {
      state?: string;
      failure_reason?: string;
      assets?: { video?: string };
    };
    if (!res.ok) {
      return { status: "failed", error: `Luma poll failed (${res.status})` };
    }
    if (json.state === "failed") {
      return { status: "failed", error: json.failure_reason ?? "Luma reported failure." };
    }
    if (json.state !== "completed") return { status: "running" };

    const url = json.assets?.video;
    if (!url) return { status: "failed", error: "Luma completed without a video url." };
    const asset = await download(url, opts.signal);
    if (!asset) return { status: "failed", error: "Luma video download failed." };
    return { status: "succeeded", asset };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

async function download(url: string, signal?: AbortSignal): Promise<GeneratedAsset | null> {
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  return {
    data: new Uint8Array(Buffer.from(await res.arrayBuffer())),
    mimeType: res.headers.get("content-type") ?? "video/mp4",
    filename: `video-${Date.now()}.mp4`,
  };
}
