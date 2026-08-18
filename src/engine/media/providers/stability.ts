// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stability AI image generation (Stable Image v2beta).
 * Models: `stability/ultra`, `stability/core`, `stability/sd3` (sdxl /
 * stable-diffusion fall back to core). Key: STABILITY_API_KEY.
 */

import {
  bareModel,
  type ImageGenOptions,
  type ImageGenResult,
  nearestAspectRatio,
} from "./image-util";

const BASE = "https://api.stability.ai/v2beta/stable-image/generate";

// Stable Image accepts a fixed set of aspect ratios, not arbitrary sizes.
const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "21:9", "9:21", "2:3", "3:2", "4:5", "5:4"] as const;

// style_preset is an enum — only forward a caller's style when it matches, so a
// free-form style string can't 400 the request.
const STYLE_PRESETS = new Set([
  "3d-model",
  "analog-film",
  "anime",
  "cinematic",
  "comic-book",
  "digital-art",
  "enhance",
  "fantasy-art",
  "isometric",
  "line-art",
  "low-poly",
  "modeling-compound",
  "neon-punk",
  "origami",
  "photographic",
  "pixel-art",
  "tile-texture",
]);

function endpointFor(variant: string): string {
  const v = variant.toLowerCase();
  if (v.includes("ultra")) return `${BASE}/ultra`;
  if (v.includes("sd3")) return `${BASE}/sd3`;
  return `${BASE}/core`;
}

export async function generateStabilityImage(opts: ImageGenOptions): Promise<ImageGenResult> {
  try {
    const form = new FormData();
    form.set("prompt", opts.prompt);
    form.set("output_format", "png");
    form.set("aspect_ratio", nearestAspectRatio(opts.width, opts.height, ASPECT_RATIOS));
    if (opts.style && STYLE_PRESETS.has(opts.style.toLowerCase())) {
      form.set("style_preset", opts.style.toLowerCase());
    }
    const res = await fetch(endpointFor(bareModel(opts.model)), {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}`, Accept: "image/*" },
      body: form,
      signal: opts.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      return {
        status: "failed",
        asset: null,
        error: `Stability image request failed: ${res.status} ${text}`,
      };
    }
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength === 0) {
      return { status: "failed", asset: null, error: "Stability returned no image data." };
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
