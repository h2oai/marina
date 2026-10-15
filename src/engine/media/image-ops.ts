// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Image facts and preparation shared by assets, vision and decisions.
 *
 * `probeImage` reads format, dimensions, EXIF orientation and animation from
 * the file header in pure TypeScript — always available. Pixel work (rotate,
 * resize, re-encode, thumbnails) uses the optional `sharp` package, loaded on
 * first use; without it, an image that already meets the limits passes
 * through unchanged and anything else is refused with a reason that names the
 * missing package, never silently sent out of spec.
 */

import { getErrorMessage } from "../errors";
import { Logger } from "../logger";

export type RasterMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface ImageInfo {
  mime: RasterMime;
  width: number;
  height: number;
  /** EXIF orientation 1–8 (JPEG only); absent = upright. */
  orientation?: number;
  /** Animated PNG / WebP / multi-frame GIF. */
  animated?: boolean;
}

export interface ImageLimits {
  minSide?: number;
  maxSide?: number;
  minPixels?: number;
  maxPixels?: number;
  /** Accepted output formats, preferred first. Default: PNG, JPEG, WebP. */
  formats?: readonly RasterMime[];
  /** Encoded size ceiling in bytes. */
  maxBytes?: number;
  /** Refuse animated input (a still frame would misrepresent it). Default true. */
  refuseAnimated?: boolean;
}

/** Jev 1.14 image input (OpenRouter multimodal decisions guide, 2026-10). */
export const JEV_IMAGE_LIMITS: ImageLimits = {
  minSide: 256,
  maxSide: 1568,
  minPixels: 78_400,
  maxPixels: 2_458_624,
  formats: ["image/png", "image/jpeg", "image/webp"],
  maxBytes: 16 * 1024 * 1024,
  refuseAnimated: true,
};

export type PreparedImage =
  | {
      ok: true;
      bytes: Uint8Array;
      mime: RasterMime;
      width: number;
      height: number;
      /** False when the input already met every limit and is returned as-is. */
      changed: boolean;
    }
  | { ok: false; reason: string };

const log = new Logger();
const DEFAULT_FORMATS: readonly RasterMime[] = ["image/png", "image/jpeg", "image/webp"];

// ─── Header probe (pure) ─────────────────────────────────────────────────────

const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const be32 = (b: Uint8Array, i: number) =>
  ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const le24 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

function probePng(b: Uint8Array): ImageInfo | undefined {
  if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return undefined;
  let animated = false;
  for (let i = 8; i + 8 <= b.length; ) {
    const len = be32(b, i);
    const type = ascii(b, i + 4, 4);
    if (type === "acTL") animated = true;
    if (type === "IDAT" || type === "IEND") break;
    i += 12 + len;
  }
  return { mime: "image/png", width: be32(b, 16), height: be32(b, 20), animated };
}

function probeGif(b: Uint8Array): ImageInfo | undefined {
  if (b.length < 10) return undefined;
  return { mime: "image/gif", width: le16(b, 6), height: le16(b, 8) };
}

function probeWebp(b: Uint8Array): ImageInfo | undefined {
  if (b.length < 30) return undefined;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    return {
      mime: "image/webp",
      width: le16(b, 26) & 0x3fff,
      height: le16(b, 28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    const [b0, b1, b2, b3] = [b[21]!, b[22]!, b[23]!, b[24]!];
    return {
      mime: "image/webp",
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (chunk === "VP8X") {
    return {
      mime: "image/webp",
      width: 1 + le24(b, 24),
      height: 1 + le24(b, 27),
      animated: (b[20]! & 0x02) !== 0,
    };
  }
  return undefined;
}

/** EXIF orientation from an APP1 segment payload starting at "Exif\0\0". */
function exifOrientation(b: Uint8Array, start: number, end: number): number | undefined {
  const tiff = start + 6;
  if (tiff + 8 > end) return undefined;
  const little = ascii(b, tiff, 2) === "II";
  const u16 = (i: number) => (little ? le16(b, i) : be16(b, i));
  const u32 = (i: number) => (little ? (le16(b, i) | (le16(b, i + 2) << 16)) >>> 0 : be32(b, i));
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return undefined;
  const count = u16(ifd);
  for (let n = 0; n < count; n++) {
    const entry = ifd + 2 + n * 12;
    if (entry + 12 > end) return undefined;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : undefined;
    }
  }
  return undefined;
}

function probeJpeg(b: Uint8Array): ImageInfo | undefined {
  let orientation: number | undefined;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = be16(b, i + 2);
    if (marker === 0xe1 && ascii(b, i + 4, 6) === "Exif\0\0") {
      orientation = exifOrientation(b, i + 4, Math.min(b.length, i + 2 + len));
    }
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && i + 9 <= b.length) {
      return {
        mime: "image/jpeg",
        width: be16(b, i + 7),
        height: be16(b, i + 5),
        ...(orientation && orientation !== 1 ? { orientation } : {}),
      };
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    i += 2 + len;
  }
  return undefined;
}

/** Format, dimensions, orientation and animation from the header; undefined if unrecognised. */
export function probeImage(bytes: Uint8Array): ImageInfo | undefined {
  const b = bytes;
  let info: ImageInfo | undefined;
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG") info = probePng(b);
  else if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) info = probeJpeg(b);
  else if (b.length >= 6 && ascii(b, 0, 4) === "GIF8") info = probeGif(b);
  else if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP")
    info = probeWebp(b);
  return info && info.width > 0 && info.height > 0 ? info : undefined;
}

// ─── Optional pixel backend ──────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: sharp is an optional dependency without types at compile time
type SharpFactory = (input: Uint8Array, opts?: Record<string, unknown>) => any;
type SharpLoader = () => Promise<SharpFactory | undefined>;

const defaultLoader: SharpLoader = async () => {
  try {
    const mod = await import("sharp");
    return (mod.default ?? mod) as unknown as SharpFactory;
  } catch (error) {
    log.info("media", "Image processing unavailable (optional `sharp` not installed)", {
      error: getErrorMessage(error),
    });
    return undefined;
  }
};

let loader: SharpLoader = defaultLoader;
let loaded: Promise<SharpFactory | undefined> | undefined;

function sharp(): Promise<SharpFactory | undefined> {
  loaded ??= loader();
  return loaded;
}

/** Test seam: replace (or restore with no argument) the pixel backend loader. */
export function setImageBackendForTests(next?: SharpLoader): void {
  loader = next ?? defaultLoader;
  loaded = undefined;
}

/** Whether rotate/resize/re-encode/thumbnails are available in this process. */
export async function imageProcessingAvailable(): Promise<boolean> {
  return (await sharp()) !== undefined;
}

// ─── Preparation ─────────────────────────────────────────────────────────────

function violations(info: ImageInfo, limits: ImageLimits, byteLength: number): string[] {
  const out: string[] = [];
  const formats = limits.formats ?? DEFAULT_FORMATS;
  const short = Math.min(info.width, info.height);
  const long = Math.max(info.width, info.height);
  const pixels = info.width * info.height;
  if (!formats.includes(info.mime)) out.push(`format ${info.mime}`);
  if (info.orientation && info.orientation !== 1) out.push(`EXIF orientation ${info.orientation}`);
  if (limits.minSide && short < limits.minSide) out.push(`side ${short} < ${limits.minSide}`);
  if (limits.maxSide && long > limits.maxSide) out.push(`side ${long} > ${limits.maxSide}`);
  if (limits.minPixels && pixels < limits.minPixels) out.push(`${pixels} px < ${limits.minPixels}`);
  if (limits.maxPixels && pixels > limits.maxPixels) out.push(`${pixels} px > ${limits.maxPixels}`);
  if (limits.maxBytes && byteLength > limits.maxBytes) out.push(`${byteLength} bytes`);
  return out;
}

/** Target dimensions within the limits, keeping the aspect ratio; undefined if impossible. */
function fitDimensions(
  width: number,
  height: number,
  limits: ImageLimits,
): { width: number; height: number } | undefined {
  let scale = 1;
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (limits.maxSide) scale = Math.min(scale, limits.maxSide / long);
  if (limits.maxPixels) scale = Math.min(scale, Math.sqrt(limits.maxPixels / (width * height)));
  if (limits.minSide && short * scale < limits.minSide) scale = limits.minSide / short;
  if (limits.minPixels && width * height * scale * scale < limits.minPixels)
    scale = Math.max(scale, Math.sqrt(limits.minPixels / (width * height)));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const fits =
    (!limits.maxSide || Math.max(w, h) <= limits.maxSide) &&
    (!limits.minSide || Math.min(w, h) >= limits.minSide) &&
    (!limits.maxPixels || w * h <= limits.maxPixels) &&
    (!limits.minPixels || w * h >= limits.minPixels);
  return fits ? { width: w, height: h } : undefined;
}

/**
 * An image that meets `limits`: returned unchanged when it already does,
 * otherwise rotated upright (EXIF), scaled into range keeping its aspect ratio
 * and re-encoded in an accepted format. Refuses (never distorts or crops) when
 * the aspect ratio cannot satisfy the limits, the input is animated, or pixel
 * work is needed but unavailable.
 */
export async function prepareImage(
  bytes: Uint8Array,
  limits: ImageLimits = {},
): Promise<PreparedImage> {
  const info = probeImage(bytes);
  if (!info) return { ok: false, reason: "not a recognised PNG, JPEG, WebP or GIF image" };
  if (info.animated && limits.refuseAnimated !== false) {
    return { ok: false, reason: "animated images are not accepted" };
  }
  const problems = violations(info, limits, bytes.byteLength);
  if (problems.length === 0) {
    return {
      ok: true,
      bytes,
      mime: info.mime,
      width: info.width,
      height: info.height,
      changed: false,
    };
  }
  const rotated = info.orientation !== undefined && info.orientation >= 5;
  const [w0, h0] = rotated ? [info.height, info.width] : [info.width, info.height];
  const target = fitDimensions(w0, h0, limits);
  if (!target) {
    return {
      ok: false,
      reason: `a ${w0}×${h0} image cannot be scaled into the accepted range without cropping`,
    };
  }
  const factory = await sharp();
  if (!factory) {
    return {
      ok: false,
      reason: `image needs processing (${problems.join(", ")}) and the optional \`sharp\` package is not installed`,
    };
  }
  const formats = limits.formats ?? DEFAULT_FORMATS;
  try {
    const pipeline = () =>
      factory(bytes, { failOn: "error" })
        .rotate()
        .resize({ width: target.width, height: target.height, fit: "fill" });
    // Lossless sources (PNG, GIF: alpha, line art) stay PNG; lossy ones (JPEG, WebP) become
    // JPEG; then any other accepted format. Never GIF (palette loss for photos).
    const lossless = info.mime === "image/png" || info.mime === "image/gif";
    const preferred: RasterMime = lossless ? "image/png" : "image/jpeg";
    const order: RasterMime[] = [
      ...(formats.includes(preferred) ? [preferred] : []),
      ...formats.filter((f) => f !== "image/gif"),
    ];
    for (const mime of [...new Set(order)]) {
      for (const quality of mime === "image/png" ? [undefined] : [88, 75, 60]) {
        const p = pipeline();
        const encoded: Buffer =
          mime === "image/png"
            ? await p.png({ compressionLevel: 9 }).toBuffer()
            : mime === "image/jpeg"
              ? await p
                  .flatten({ background: "#ffffff" })
                  .jpeg({ quality, mozjpeg: true })
                  .toBuffer()
              : await p.webp({ quality }).toBuffer();
        if (!limits.maxBytes || encoded.byteLength <= limits.maxBytes) {
          return {
            ok: true,
            bytes: new Uint8Array(encoded),
            mime,
            width: target.width,
            height: target.height,
            changed: true,
          };
        }
      }
    }
    return { ok: false, reason: `could not encode under ${limits.maxBytes} bytes` };
  } catch (error) {
    return { ok: false, reason: `image processing failed: ${getErrorMessage(error)}` };
  }
}

/**
 * A WebP thumbnail fitting inside `size`×`size` (never upscaled), upright.
 * Undefined when pixel work is unavailable or the input is not an image.
 */
export async function thumbnail(
  bytes: Uint8Array,
  size: number,
): Promise<{ bytes: Uint8Array; mime: "image/webp"; width: number; height: number } | undefined> {
  if (!probeImage(bytes)) return undefined;
  const factory = await sharp();
  if (!factory) return undefined;
  try {
    const { data, info } = await factory(bytes, { failOn: "error" })
      .rotate()
      .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    return {
      bytes: new Uint8Array(data),
      mime: "image/webp",
      width: info.width,
      height: info.height,
    };
  } catch (error) {
    log.warn("media", "Thumbnail failed", { error: getErrorMessage(error) });
    return undefined;
  }
}

/** `data:<mime>;base64,…` for prepared bytes (model and decision image parts). */
export function toDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}
