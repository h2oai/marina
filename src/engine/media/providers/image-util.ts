/**
 * Shared contract + helpers for image-generation providers. Kept dependency-free
 * so providers and the registry can import it without a cycle.
 */

export interface GeneratedAsset {
  data: Uint8Array;
  mimeType: string;
  filename: string;
}

export interface ImageGenOptions {
  apiKey: string;
  /** Full "provider/model" string — providers strip the prefix via bareModel(). */
  model: string;
  prompt: string;
  width?: number;
  height?: number;
  style?: string;
  signal?: AbortSignal;
}

export interface ImageGenResult {
  status: "succeeded" | "failed";
  asset: GeneratedAsset | null;
  error?: string;
}

export type ImageGenerator = (opts: ImageGenOptions) => Promise<ImageGenResult>;

/** Strip a leading `provider/` so the upstream gets the bare model id it expects. */
export function bareModel(model: string): string {
  const slash = model.indexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

/**
 * Pick the closest aspect ratio the provider supports for the requested
 * width/height. Providers expose fixed ratio enums (not arbitrary sizes), so we
 * snap to the nearest. Defaults to "1:1" when dimensions are absent/invalid.
 */
export function nearestAspectRatio(
  width: number | undefined,
  height: number | undefined,
  allowed: readonly string[],
): string {
  const fallback = allowed.includes("1:1") ? "1:1" : (allowed[0] ?? "1:1");
  if (!width || !height || width <= 0 || height <= 0) return fallback;
  const target = width / height;
  let best = fallback;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const ar of allowed) {
    const [w, h] = ar.split(":").map(Number);
    if (!w || !h) continue;
    const diff = Math.abs(w / h - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = ar;
    }
  }
  return best;
}
