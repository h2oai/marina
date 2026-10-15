// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAI Images (`POST /v1/images/generations`) for the GPT Image models, and
 * prompt moderation. Per OpenAI's current Images API
 * (https://developers.openai.com/api/docs/guides/image-generation):
 *
 * - GPT Image models always return base64 and REJECT the legacy
 *   `response_format` and `style` parameters — neither is sent; a requested
 *   style is written into the prompt instead.
 * - `gpt-image-2*` (incl. dated snapshots and `gpt-image-2.5-*`) take any
 *   `WIDTHxHEIGHT` with both edges multiples of 16, aspect between 1:3 and 3:1,
 *   no edge above 3840 and 655,360–8,294,400 pixels; a request is mapped into
 *   that space ({@link flexibleImageSize}).
 * - Earlier GPT Image models (`gpt-image-1`, `gpt-image-1.5`,
 *   `gpt-image-1-mini`, `chatgpt-image-latest`) take only 1024x1024,
 *   1536x1024 or 1024x1536 — a request snaps to the nearest aspect.
 * - `dall-e-2` / `dall-e-3` were retired on 2026-05-12 and are refused locally.
 */

import { Buffer } from "node:buffer";
import { guardedFetch } from "../../../net/url-guard";
import { bareModel } from "./image-util";

const OPENAI_IMAGE_URL = "https://api.openai.com/v1/images/generations";
const OPENAI_MODERATION_URL = "https://api.openai.com/v1/moderations";

interface OpenAIImageOptions {
  apiKey: string;
  prompt: string;
  model: string;
  width?: number;
  height?: number;
  style?: string;
  signal?: AbortSignal;
}

interface ModerationOptions {
  apiKey: string;
  prompt: string;
  signal?: AbortSignal;
}

export interface ModerationResult {
  blocked: boolean;
  reason?: string;
}

export interface GeneratedAsset {
  data: Uint8Array;
  mimeType: string;
  filename: string;
}

export interface OpenAIImageResult {
  status: "succeeded" | "failed";
  asset: GeneratedAsset | null;
  error?: string;
}

export async function moderateOpenAIText(
  opts: ModerationOptions,
): Promise<ModerationResult | null> {
  try {
    const res = await guardedFetch(OPENAI_MODERATION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: "omni-moderation-latest",
        input: opts.prompt,
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      return null;
    }
    const json = (await res.json()) as {
      results?: Array<{ flagged?: boolean; categories?: Record<string, boolean> }>;
    };
    const flagged = json.results?.[0]?.flagged ?? false;
    if (!flagged) return { blocked: false };
    const categories = Object.entries(json.results?.[0]?.categories ?? {})
      .filter(([, val]) => val)
      .map(([cat]) => cat);
    return {
      blocked: true,
      reason: categories.length > 0 ? `Flagged categories: ${categories.join(", ")}` : undefined,
    };
  } catch {
    return null;
  }
}

/** Fixed sizes of the earlier GPT Image models (`gpt-image-1`, `-1.5`, `-1-mini`, `chatgpt-image-latest`). */
export const FIXED_GPT_IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
const FLEX_MIN_PIXELS = 655_360;
const FLEX_MAX_PIXELS = 8_294_400;
const FLEX_MAX_EDGE = 3840;
const FLEX_MAX_RATIO = 3;

/** How a bare OpenAI image model id is sized, or why it is refused. */
export function openAIImageModelKind(model: string): "flexible" | "fixed" | "retired" {
  const id = model.toLowerCase();
  if (id.startsWith("dall-e")) return "retired";
  // gpt-image-2, its dated snapshots, and the gpt-image-2.5 family take arbitrary sizes.
  if (/^gpt-image-2([.-]|$)/.test(id)) return "flexible";
  return "fixed";
}

/**
 * The `size` to request, or undefined to let the model choose (`auto`, its
 * default) when the caller named no dimensions.
 */
export function openAIImageSize(
  model: string,
  width?: number,
  height?: number,
): string | undefined {
  const w = width && Number.isFinite(width) && width > 0 ? width : undefined;
  const h = height && Number.isFinite(height) && height > 0 ? height : undefined;
  if (!w && !h) return undefined;
  const ww = w ?? h!;
  const hh = h ?? w!;
  if (openAIImageModelKind(model) === "flexible") return flexibleImageSize(ww, hh);
  const target = ww / hh;
  let best: string = FIXED_GPT_IMAGE_SIZES[0];
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const size of FIXED_GPT_IMAGE_SIZES) {
    const [sw, sh] = size.split("x").map(Number) as [number, number];
    const diff = Math.abs(Math.log(sw / sh) - Math.log(target));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = size;
    }
  }
  return best;
}

/**
 * Map any requested width/height into gpt-image-2's size space: keep the
 * aspect (clamped to 1:3–3:1) and roughly the pixel count (clamped to
 * 655,360–8,294,400), both edges multiples of 16, neither above 3840.
 */
export function flexibleImageSize(width: number, height: number): string {
  const landscape = width >= height;
  const ratio = Math.min(FLEX_MAX_RATIO, Math.max(width, height) / Math.min(width, height));
  const pixels = Math.min(FLEX_MAX_PIXELS, Math.max(FLEX_MIN_PIXELS, width * height));
  const ceil16 = (n: number) => Math.ceil(n / 16) * 16;
  const floor16 = (n: number) => Math.floor(n / 16) * 16;
  // Work on the short edge; the long edge follows the ratio (floored, so the
  // aspect never exceeds the clamp).
  const longFor = (s: number) => Math.max(s, floor16(ratio * s));
  let short = ceil16(Math.sqrt(pixels / ratio));
  while (short * longFor(short) < FLEX_MIN_PIXELS) short += 16;
  while (
    short > 16 &&
    (short * longFor(short) > FLEX_MAX_PIXELS || longFor(short) > FLEX_MAX_EDGE)
  ) {
    short -= 16;
  }
  const long = longFor(short);
  return landscape ? `${long}x${short}` : `${short}x${long}`;
}

export async function generateOpenAIImage(opts: OpenAIImageOptions): Promise<OpenAIImageResult> {
  const model = bareModel(opts.model);
  if (openAIImageModelKind(model) === "retired") {
    return {
      status: "failed",
      asset: null,
      error: `OpenAI retired ${model} on 2026-05-12; use a GPT Image model such as openai/gpt-image-2.`,
    };
  }
  const size = openAIImageSize(model, opts.width, opts.height);
  // GPT Image models reject `style`; describe it in the prompt instead (OpenAI's guidance).
  const style = opts.style?.trim();
  const body: Record<string, unknown> = {
    model,
    prompt: style ? `${opts.prompt}\n\nStyle: ${style}` : opts.prompt,
  };
  if (size) body.size = size;
  try {
    const res = await guardedFetch(OPENAI_IMAGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      return {
        status: "failed",
        asset: null,
        error: `OpenAI image request failed: ${res.status} ${text}`,
      };
    }
    const json = (await res.json()) as {
      data?: Array<{ b64_json?: string }>;
      output_format?: string;
    };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) {
      return { status: "failed", asset: null, error: "No image data returned." };
    }
    const format =
      json.output_format === "jpeg" || json.output_format === "webp" ? json.output_format : "png";
    return {
      status: "succeeded",
      asset: {
        data: new Uint8Array(Buffer.from(b64, "base64")),
        mimeType: `image/${format}`,
        filename: `image-${Date.now()}.${format === "jpeg" ? "jpg" : format}`,
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { status: "failed", asset: null, error: msg };
  }
}
