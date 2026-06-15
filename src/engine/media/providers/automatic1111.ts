/**
 * Automatic1111 / SD.Next local Stable Diffusion (`/sdapi/v1/txt2img`).
 * Provider `automatic1111` (aliases a1111/sd/sdnext). Keyless by default; base
 * URL from A1111_BASE_URL. A model id after the slash selects a checkpoint.
 */

import { Buffer } from "node:buffer";
import { imageEndpointBaseUrl, imageEndpointKey } from "./image-endpoints";
import { bareModel, type ImageGenOptions, type ImageGenResult } from "./image-util";

function providerOf(model: string): string {
  const slash = model.indexOf("/");
  return slash >= 0 ? model.slice(0, slash) : model;
}

function clampDimension(dim?: number): number {
  if (!dim || !Number.isFinite(dim)) return 1024;
  return Math.min(Math.max(Math.round(dim), 256), 2048);
}

export async function generateAutomatic1111Image(opts: ImageGenOptions): Promise<ImageGenResult> {
  const provider = providerOf(opts.model);
  const base = imageEndpointBaseUrl(provider) ?? "http://localhost:7860";
  const checkpoint = bareModel(opts.model);
  const body: Record<string, unknown> = {
    prompt: opts.prompt,
    width: clampDimension(opts.width),
    height: clampDimension(opts.height),
    steps: 25,
  };
  // A bare provider id ("automatic1111", "a1111", …) means "use the loaded
  // checkpoint"; anything else selects a specific checkpoint.
  if (checkpoint && !["automatic1111", "a1111", "sd", "sdnext", "default"].includes(checkpoint)) {
    body.override_settings = { sd_model_checkpoint: checkpoint };
  }
  const key = imageEndpointKey(provider);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const res = await fetch(`${base}/sdapi/v1/txt2img`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      return {
        status: "failed",
        asset: null,
        error: `Automatic1111 request failed: ${res.status} ${await res.text()}`,
      };
    }
    const json = (await res.json()) as { images?: string[] };
    const b64 = json.images?.[0];
    if (!b64) return { status: "failed", asset: null, error: "No image data returned." };
    const data = new Uint8Array(Buffer.from(b64, "base64"));
    return {
      status: "succeeded",
      asset: { data, mimeType: "image/png", filename: `image-${Date.now()}.png` },
    };
  } catch (error) {
    return {
      status: "failed",
      asset: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
