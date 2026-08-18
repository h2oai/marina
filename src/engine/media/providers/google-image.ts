// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Google Imagen image generation (Gemini API `:predict`).
 * Models: `google/imagen-3.0-generate-002`, etc. Key: GEMINI_API_KEY (reuses the
 * key Marina already uses for Gemini text).
 */

import { Buffer } from "node:buffer";
import {
  bareModel,
  type ImageGenOptions,
  type ImageGenResult,
  nearestAspectRatio,
} from "./image-util";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Imagen supports a small fixed set of aspect ratios.
const ASPECT_RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9"] as const;

export async function generateGoogleImage(opts: ImageGenOptions): Promise<ImageGenResult> {
  try {
    const model = bareModel(opts.model);
    const url = `${BASE}/${encodeURIComponent(model)}:predict?key=${encodeURIComponent(opts.apiKey)}`;
    const body = {
      instances: [{ prompt: opts.prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio: nearestAspectRatio(opts.width, opts.height, ASPECT_RATIOS),
      },
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      return {
        status: "failed",
        asset: null,
        error: `Google Imagen request failed: ${res.status} ${text}`,
      };
    }
    const json = (await res.json()) as {
      predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>;
    };
    const pred = json.predictions?.[0];
    if (!pred?.bytesBase64Encoded) {
      return { status: "failed", asset: null, error: "No image data returned." };
    }
    const data = new Uint8Array(Buffer.from(pred.bytesBase64Encoded, "base64"));
    const mimeType = pred.mimeType ?? "image/png";
    const ext = mimeType.includes("jpeg") ? "jpg" : "png";
    return {
      status: "succeeded",
      asset: { data, mimeType, filename: `image-${Date.now()}.${ext}` },
    };
  } catch (error) {
    return {
      status: "failed",
      asset: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
