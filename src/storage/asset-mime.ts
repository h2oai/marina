// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// ─── MIME policy ─────────────────────────────────────────────────────────────
//
// The upload MIME is CLIENT-SUPPLIED. Echoing it verbatim from `/assets/:key`
// would let any logged-in entity store `text/html` (or `image/svg+xml`) and get
// a same-origin document that runs script — stored XSS against every dashboard
// viewer. So: only allowlisted types are kept, raster images are checked against
// their magic bytes, and everything else is stored as `application/octet-stream`.
// Serving (src/net/api/asset-api.ts) adds nosniff + a no-op CSP, and non-media types are `attachment`.

/** Fallback for anything not on the allowlist (or failing its magic check). */
export const OCTET_STREAM = "application/octet-stream";

/** Allowlisted upload MIME types (lower-cased, no parameters). */
export const ALLOWED_ASSET_MIMES: ReadonlySet<string> = new Set([
  // raster images (magic-byte verified)
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
  // vector image — kept as a type, but never served inline (see isInlineMime)
  "image/svg+xml",
  // audio
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/flac",
  "audio/aac",
  // video
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  // documents & data
  "application/pdf",
  "application/json",
  "text/csv",
  "text/markdown",
  "text/plain",
  // fonts
  "font/woff",
  "font/woff2",
  "font/ttf",
  "font/otf",
  // wasm
  "application/wasm",
]);

/** Image types whose magic bytes we can verify cheaply. */
const IMAGE_MAGIC: ReadonlyArray<{ mime: string; test: (b: Uint8Array) => boolean }> = [
  {
    mime: "image/png",
    test: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    mime: "image/jpeg",
    test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: "image/gif",
    test: (b) =>
      b.length >= 6 &&
      b[0] === 0x47 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) &&
      b[5] === 0x61,
  },
  {
    mime: "image/webp",
    test: (b) =>
      b.length >= 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
  { mime: "image/bmp", test: (b) => b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d },
  {
    // ISO BMFF: size(4) + "ftyp" + brand "avif"/"avis"
    mime: "image/avif",
    test: (b) =>
      b.length >= 12 &&
      b[4] === 0x66 &&
      b[5] === 0x74 &&
      b[6] === 0x79 &&
      b[7] === 0x70 &&
      b[8] === 0x61 &&
      b[9] === 0x76 &&
      b[10] === 0x69 &&
      (b[11] === 0x66 || b[11] === 0x73),
  },
];

const MAGIC_VERIFIED_IMAGES: ReadonlySet<string> = new Set(IMAGE_MAGIC.map((m) => m.mime));

/** Detect a raster image type from its leading bytes, or `null`. */
export function sniffImageMime(data: Uint8Array): string | null {
  for (const { mime, test } of IMAGE_MAGIC) if (test(data)) return mime;
  return null;
}

/**
 * Decide the MIME type an upload is STORED and SERVED as.
 *
 *  - declared type on the allowlist and (for raster images) matching its magic
 *    bytes → kept;
 *  - declared raster image whose bytes are a DIFFERENT known raster → the
 *    sniffed type (a provider that labels a JPEG as PNG still renders);
 *  - declared raster image whose bytes are no known raster →
 *    `application/octet-stream` (a disguised payload never gets an image type);
 *  - undeclared / off-list type whose bytes ARE a known raster image → sniffed
 *    type (clients that send `application/octet-stream` for a PNG still work);
 *  - anything else → `application/octet-stream`.
 */
export function normalizeAssetMime(declared: string | null | undefined, data: Uint8Array): string {
  const mime = (declared ?? "").split(";")[0]!.trim().toLowerCase();
  const sniffed = sniffImageMime(data);
  if (mime && ALLOWED_ASSET_MIMES.has(mime)) {
    if (MAGIC_VERIFIED_IMAGES.has(mime)) return sniffed ?? OCTET_STREAM;
    return mime;
  }
  return sniffed ?? OCTET_STREAM;
}

/**
 * The type a file EXTENSION suggests, for write paths with no declared type
 * (`canvas asset upload`, `exec publish`). Only a hint: the result still goes
 * through {@link normalizeAssetMime}, so an off-list type such as `.html`
 * is stored as `application/octet-stream` and a misnamed image is caught by
 * its magic bytes.
 */
export function mimeFromExtension(ext: string): string {
  return EXTENSION_MIMES[ext.toLowerCase()] ?? OCTET_STREAM;
}

/** Normalized type for bytes whose only hint is a file extension. */
export function assetMimeForFile(ext: string, data: Uint8Array): string {
  return normalizeAssetMime(mimeFromExtension(ext), data);
}

const EXTENSION_MIMES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  // Source files are stored as plain text (never as an executable type).
  ".sh": "text/plain",
  ".py": "text/plain",
  ".ts": "text/plain",
  ".js": "text/plain",
};

/**
 * Types a browser may render INLINE from `/assets/:key`. Raster images, audio,
 * video and PDF (the dashboard shows PDFs in an iframe — `attachment` would turn
 * that into a download). SVG, text, JSON, fonts, wasm and octet-stream are
 * always downloaded.
 */
export function isInlineMime(mime: string): boolean {
  const m = mime.toLowerCase();
  if (m === "image/svg+xml") return false;
  return (
    m.startsWith("image/") ||
    m.startsWith("audio/") ||
    m.startsWith("video/") ||
    m === "application/pdf"
  );
}
