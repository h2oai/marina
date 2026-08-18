// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Generic OpenAI-compatible image generation (`/v1/images/generations`) against
 * an operator-configured endpoint — covers hosted providers (Together,
 * Fireworks, DeepInfra, …) and self-hosted servers (LocalAI, vLLM image). The
 * provider id maps to `<PROVIDER>_IMAGE_BASE_URL` (+ optional `<PROVIDER>_API_KEY`).
 */

import { Buffer } from "node:buffer";
import { imageEndpointBaseUrl, imageEndpointKey } from "./image-endpoints";
import { bareModel, type ImageGenOptions, type ImageGenResult } from "./image-util";

function providerOf(model: string): string {
  const slash = model.indexOf("/");
  return slash >= 0 ? model.slice(0, slash) : model;
}

function size(width?: number, height?: number): string {
  const clamp = (d?: number) =>
    !d || !Number.isFinite(d) ? 1024 : Math.min(Math.max(Math.round(d), 256), 2048);
  return `${clamp(width)}x${clamp(height)}`;
}

export async function generateOpenAICompatibleImage(
  opts: ImageGenOptions,
): Promise<ImageGenResult> {
  const provider = providerOf(opts.model);
  const base = imageEndpointBaseUrl(provider);
  if (!base) {
    return {
      status: "failed",
      asset: null,
      error: `No image endpoint for "${provider}" — set ${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_IMAGE_BASE_URL.`,
    };
  }
  const key = imageEndpointKey(provider) ?? opts.apiKey;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const res = await fetch(`${base}/images/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: bareModel(opts.model),
        prompt: opts.prompt,
        size: size(opts.width, opts.height),
        response_format: "b64_json",
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      return {
        status: "failed",
        asset: null,
        error: `Image request to ${provider} failed: ${res.status} ${await res.text()}`,
      };
    }
    const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
    const entry = json.data?.[0];
    let data: Uint8Array | null = null;
    if (entry?.b64_json) {
      data = new Uint8Array(Buffer.from(entry.b64_json, "base64"));
    } else if (entry?.url) {
      // Some servers return a URL instead of inline bytes — fetch it.
      const imgRes = await fetch(entry.url, { signal: opts.signal });
      if (imgRes.ok) data = new Uint8Array(await imgRes.arrayBuffer());
    }
    if (!data || data.byteLength === 0) {
      return { status: "failed", asset: null, error: "No image data returned." };
    }
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
