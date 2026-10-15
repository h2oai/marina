// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Images in decision requests. A caller puts OpenAI-style image parts
 * (`{ type: "image_url", image_url: { url: "data:image/png;base64,…" } }`) in
 * the `state`, beside text. Before a request leaves Marina every image is
 * decoded and prepared to the decision model's input limits
 * (`prepareImage(…, DECISION_IMAGE_LIMITS)`: rotated upright, scaled into
 * range, re-encoded as PNG/JPEG) — or the request is refused with the reason.
 * Remote URLs are never fetched.
 *
 * Which backend may receive images:
 *   decisions-api / typesafe  — Jev reads image parts anywhere in `state`
 *                               (verified live on 1.13 and 1.14). `box`
 *                               questions need Jev ≥ 1.14.
 *   chat classifiers          — only a model the bundled catalog says reads
 *                               images; any other is refused, never sent text
 *                               with the pictures silently dropped.
 */

import { availableModels } from "../agent/available-models";
import { piModels } from "../agent/pi-models";
import {
  type ImageLimits,
  JEV_IMAGE_LIMITS,
  prepareImage,
  toDataUrl,
} from "../engine/media/image-ops";
import {
  DecisionError,
  type DecisionImagePart,
  type DecisionQuestions,
  type DecisionRequest,
} from "./types";

/**
 * Jev's limits, PNG and JPEG only: the live Decisions API refuses WebP ("accepts
 * only base64 data URL images in PNG or JPEG format"), so WebP is re-encoded.
 */
export const DECISION_IMAGE_LIMITS: ImageLimits = {
  ...JEV_IMAGE_LIMITS,
  formats: ["image/png", "image/jpeg"],
};

/** Jev caps the request body at 32 MiB; leave room for the text and JSON framing. */
export const DECISION_MAX_REQUEST_IMAGE_BYTES = 30 * 1024 * 1024;
/** Default images per request (`MARINA_DECISION_MAX_IMAGES`). */
export const DEFAULT_DECISION_MAX_IMAGES = 8;
const HARD_MAX_IMAGES = 32;
const MAX_DEPTH = 32;

/** `MARINA_DECISION_MAX_IMAGES` (1–32, default 8): images one decision request may carry. */
export function decisionMaxImages(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MARINA_DECISION_MAX_IMAGES);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, HARD_MAX_IMAGES) : DEFAULT_DECISION_MAX_IMAGES;
}

export function isImagePart(value: unknown): value is DecisionImagePart {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as { type?: unknown; image_url?: unknown };
  return (
    v.type === "image_url" &&
    !!v.image_url &&
    typeof (v.image_url as { url?: unknown }).url === "string"
  );
}

/** Rebuild `value` with every image part replaced by `replace(part, index)`. */
function mapImages(
  value: unknown,
  replace: (part: DecisionImagePart, index: number) => unknown,
): { value: unknown; count: number } {
  let count = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (isImagePart(v)) return replace(v, count++);
    if (depth >= MAX_DEPTH || !v || typeof v !== "object") return v;
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((item) => {
        const next = walk(item, depth + 1);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? out : v;
    }
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
      const next = walk(item, depth + 1);
      if (next !== item) changed = true;
      out[k] = next;
    }
    return changed ? out : v;
  };
  const value2 = walk(value, 0);
  return { value: value2, count };
}

/** The image parts in a state, in order (Jev reads them at any depth). */
export function stateImages(state: unknown): DecisionImagePart[] {
  const parts: DecisionImagePart[] = [];
  mapImages(state, (part) => {
    parts.push(part);
    return part;
  });
  return parts;
}

export function requestHasImages(request: Pick<DecisionRequest, "state">): boolean {
  return stateImages(request.state).length > 0;
}

export function hasBoxQuestion(questions: DecisionQuestions): boolean {
  return Object.values(questions).some((q) => q.type === "box");
}

/**
 * The state with each image replaced by an `[image N]` marker, and the image
 * URLs in the same order — how a chat classifier sees it (text in the prompt,
 * pictures as content parts after it). A state without images is returned as is.
 */
export function splitStateImages(state: unknown): { text: unknown; images: string[] } {
  const images: string[] = [];
  const { value } = mapImages(state, (part, i) => {
    images.push(part.image_url.url);
    return `[image ${i + 1}]`;
  });
  return { text: value, images };
}

/** The serialized size of the state's text, images counted as their `[image N]` markers. */
export function stateTextBytes(state: unknown): number {
  return new TextEncoder().encode(JSON.stringify(splitStateImages(state).text) ?? "").length;
}

const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]*)$/i;

/** Decoded size of a base64 data URL without decoding it; undefined if it is not one. */
export function dataUrlDecodedBytes(url: string): number | undefined {
  const comma = url.indexOf(",");
  if (!/^data:[^,]*;base64,/i.test(url) || comma < 0) return undefined;
  const b64 = url.length - comma - 1;
  const pad = url.endsWith("==") ? 2 : url.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64 * 3) / 4) - pad);
}

function decodeImage(url: string, index: number, maxBytes: number): Uint8Array {
  const n = index + 1;
  if (/^https?:\/\//i.test(url)) {
    throw new DecisionError(
      `image ${n}: remote URLs are not fetched; send a base64 data URL (data:image/png;base64,…)`,
      "unsupported_input",
      400,
    );
  }
  const size = dataUrlDecodedBytes(url);
  if (size === undefined) {
    throw new DecisionError(
      `image ${n}: not a base64 data URL (data:image/png;base64,…)`,
      "unsupported_input",
      400,
    );
  }
  if (size > maxBytes) {
    throw new DecisionError(
      `image ${n}: ${size} bytes decoded exceeds ${maxBytes}`,
      "unsupported_input",
      400,
    );
  }
  const m = DATA_URL.exec(url);
  if (!m) {
    throw new DecisionError(`image ${n}: malformed data URL`, "unsupported_input", 400);
  }
  return new Uint8Array(Buffer.from(m[2]!.replace(/\s+/g, ""), "base64"));
}

/**
 * The state with every image decoded, checked and prepared to `limits`
 * (returned unchanged — same object — when it has no images). Refuses with
 * `unsupported_input` and the reason: too many images, a remote or malformed
 * URL, an image that cannot be prepared (`prepareImage`'s reason), or images
 * that together exceed the request budget.
 */
export async function prepareStateImages(
  state: unknown,
  opts: { limits?: ImageLimits; maxImages?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ state: unknown; images: number }> {
  const parts = stateImages(state);
  if (parts.length === 0) return { state, images: 0 };
  const limits = opts.limits ?? DECISION_IMAGE_LIMITS;
  const maxImages = opts.maxImages ?? decisionMaxImages(opts.env);
  if (parts.length > maxImages) {
    throw new DecisionError(
      `${parts.length} images exceed the limit of ${maxImages} per decision`,
      "unsupported_input",
      400,
    );
  }
  // Inputs larger than the output limit are accepted only up to a sane bound
  // (they are scaled down); the bound keeps one request from holding 100s of MB.
  const maxInput = Math.max(limits.maxBytes ?? 0, 16 * 1024 * 1024) * 2;
  const prepared: string[] = [];
  let total = 0;
  for (const [i, part] of parts.entries()) {
    const bytes = decodeImage(part.image_url.url, i, maxInput);
    const ready = await prepareImage(bytes, limits);
    if (!ready.ok) {
      throw new DecisionError(`image ${i + 1}: ${ready.reason}`, "unsupported_input", 400);
    }
    total += ready.bytes.byteLength;
    if (total > DECISION_MAX_REQUEST_IMAGE_BYTES) {
      throw new DecisionError(
        `images exceed ${DECISION_MAX_REQUEST_IMAGE_BYTES} bytes per decision`,
        "unsupported_input",
        400,
      );
    }
    prepared.push(toDataUrl(ready.bytes, ready.mime));
  }
  const { value } = mapImages(state, (_, i) => ({
    type: "image_url",
    image_url: { url: prepared[i]! },
  }));
  return { state: value, images: parts.length };
}

// ─── Which models can take what ──────────────────────────────────────────────

/** Jev version `[major, minor]`; `latest` is newest; undefined for a non-Jev id. */
export function jevVersion(model: string): [number, number] | "latest" | undefined {
  const m = /(?:^|\/|~)jev-(latest|(\d+)\.(\d+))\b/i.exec(model);
  if (!m) return undefined;
  if (m[1]!.toLowerCase() === "latest") return "latest";
  return [Number(m[2]), Number(m[3])];
}

/**
 * Whether a decisions-api model answers `box` questions: Jev ≥ 1.14 or
 * `jev-latest`. A non-Jev id (an OpenJev deployment) is the server's to judge.
 */
export function modelAnswersBox(model: string): boolean {
  const v = jevVersion(model);
  if (v === undefined || v === "latest") return true;
  return v[0] > 1 || (v[0] === 1 && v[1] >= 14);
}

/** The Jev model to answer box questions with when the configured one is older. */
export const JEV_BOX_MODEL = "typesafe/jev-1.14";

const SELF_ALIASES = new Set(["marina", "marina/default", "default"]);

/**
 * Whether a chat model reads images, from pi-ai's bundled catalog (`input`
 * includes `image`). `marina/default` is this world's first configured model.
 * Unknown models (local runtimes, ids the catalog lacks) are false: the
 * classifier refuses images rather than answer without seeing them.
 */
export function classifierReadsImages(
  model: string,
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  let id = model.trim();
  if (SELF_ALIASES.has(id.toLowerCase())) id = availableModels(env)[0]?.spec ?? "";
  if (!id) return false;
  const reads = (provider: string, modelId: string) =>
    !!piModels.getProvider(provider) &&
    piModels
      .getModels(provider)
      .some((m) => m.id === modelId && (m.input as readonly string[]).includes("image"));
  if (/^https:\/\/openrouter\.ai\//.test(baseUrl)) {
    return reads("openrouter", id.replace(/^openrouter\//, ""));
  }
  if (/^https:\/\/router\.huggingface\.co(\/|$)/.test(baseUrl) && reads("huggingface", id)) {
    return true;
  }
  const slash = id.indexOf("/");
  if (slash > 0 && reads(id.slice(0, slash), id.slice(slash + 1))) return true;
  // A `vendor/model` id is OpenRouter's convention.
  return reads("openrouter", id);
}
