// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Engine } from "../engine/engine";
import type { MarinaDB } from "../persistence/database";
import type { StorageProvider } from "../storage/provider";
import { authenticateRequest, refuseOpenApiWrite } from "./auth-middleware";
import { corsHeaders } from "./cors";
import {
  consumeHttpRate,
  maxUploadBytes,
  PDF_CSP,
  rateLimitedResponse,
  securityHeaders,
} from "./http-utils";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: corsHeaders(null) });
}

// ─── MIME policy ─────────────────────────────────────────────────────────────
//
// The upload MIME is CLIENT-SUPPLIED. Echoing it verbatim from `/assets/:key`
// would let any logged-in entity store `text/html` (or `image/svg+xml`) and get
// a same-origin document that runs script — stored XSS against every dashboard
// viewer. So: only allowlisted types are kept, raster images are checked against
// their magic bytes, and everything else is stored as `application/octet-stream`.
// Serving adds nosniff + a no-op CSP, and non-media types are `attachment`.

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
 *  - declared raster image whose bytes disagree → `application/octet-stream`
 *    (a disguised payload never gets an image content type);
 *  - undeclared / off-list type whose bytes ARE a known raster image → sniffed
 *    type (clients that send `application/octet-stream` for a PNG still work);
 *  - anything else → `application/octet-stream`.
 */
export function normalizeAssetMime(declared: string | null | undefined, data: Uint8Array): string {
  const mime = (declared ?? "").split(";")[0]!.trim().toLowerCase();
  const sniffed = sniffImageMime(data);
  if (mime && ALLOWED_ASSET_MIMES.has(mime)) {
    if (MAGIC_VERIFIED_IMAGES.has(mime)) return sniffed === mime ? mime : OCTET_STREAM;
    return mime;
  }
  return sniffed ?? OCTET_STREAM;
}

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

/** Strip characters that could break the `Content-Disposition` header. */
function safeFilename(name: string): string {
  const cleaned = name.replace(/[\r\n"\\;]/g, "_").replace(/[^\x20-\x7e]/g, "_");
  return cleaned.slice(0, 120) || "download";
}

/** Every hardening header a served asset carries (exported for tests). */
export function assetResponseHeaders(mime: string, filename?: string): Record<string, string> {
  const headers: Record<string, string> = {
    ...securityHeaders("asset"),
    "Content-Type": mime,
    "Cache-Control": "public, max-age=31536000, immutable",
    ...corsHeaders(null),
  };
  if (mime.toLowerCase() === "application/pdf") headers["Content-Security-Policy"] = PDF_CSP;
  if (!isInlineMime(mime)) {
    headers["Content-Disposition"] =
      `attachment; filename="${safeFilename(filename ?? "download")}"`;
  }
  return headers;
}

// ─── REST API ────────────────────────────────────────────────────────────────

/** Handle REST API requests for /api/assets. */
export async function handleAssetApi(
  url: URL,
  method: string,
  req: Request,
  db: MarinaDB,
  storage: StorageProvider,
  engine: Engine,
): Promise<Response> {
  // Reads are public so canvas assets (image metadata/listing) render for a
  // fresh, not-yet-logged-in visitor — consistent with public canvas reads and
  // the open dashboard broadcast. Mutations (POST upload, DELETE) require a
  // valid session token: the dev-open sentinel is read-only, and each principal
  // is rate-limited so an authenticated client cannot flood storage.
  let writerName: string | undefined;
  if (method !== "GET") {
    const auth = authenticateRequest(req, engine);
    if ("error" in auth) return auth.error;
    const origin = req.headers.get("Origin");
    const refused = refuseOpenApiWrite(auth.entityId, origin);
    if (refused) return refused;
    if (!consumeHttpRate("mutation", auth.entityId)) return rateLimitedResponse(origin);
    writerName = engine.entities.get(auth.entityId)?.name;
  }
  // DELETE /api/assets/:id
  const idMatch = url.pathname.match(/^\/api\/assets\/(.+)$/);
  if (idMatch && method === "DELETE") {
    const id = decodeURIComponent(idMatch[1]!);
    const asset = db.getAsset(id);
    if (!asset) return json({ error: "Asset not found" }, 404);
    await storage.delete(asset.storage_key);
    db.deleteAsset(id);
    return json({ ok: true, id });
  }

  // GET /api/assets/:id (metadata)
  if (idMatch && method === "GET") {
    const id = decodeURIComponent(idMatch[1]!);
    const asset = db.getAsset(id);
    if (!asset) return json({ error: "Asset not found" }, 404);
    return json({
      ...asset,
      metadata: JSON.parse(asset.metadata),
      url: storage.resolve(asset.storage_key),
    });
  }

  // POST /api/assets (multipart upload)
  if (url.pathname === "/api/assets" && method === "POST") {
    return handleUpload(req, db, storage, writerName);
  }

  // GET /api/assets (list)
  if (url.pathname === "/api/assets" && method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
    const mime = url.searchParams.get("mime") ?? undefined;
    const assets = db.listAssets({ limit, mime });
    return json(
      assets.map((a) => ({
        ...a,
        metadata: JSON.parse(a.metadata),
        url: storage.resolve(a.storage_key),
      })),
    );
  }

  return json({ error: "Not found" }, 404);
}

function tooLarge(cap: number): Response {
  return json({ error: `File too large. Maximum ${Math.floor(cap / 1024 / 1024)}MB.` }, 413);
}

async function handleUpload(
  req: Request,
  db: MarinaDB,
  storage: StorageProvider,
  writerName: string | undefined,
): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";
  const cap = maxUploadBytes();

  // Explicit upload cap, checked BEFORE buffering when the client declares a
  // length (the server-wide `maxRequestBodySize` is the backstop).
  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > cap) return tooLarge(cap);

  let filename: string;
  let declaredMime: string;
  let data: Uint8Array;
  let entityName = writerName ?? "system";

  if (contentType.includes("multipart/form-data")) {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return json({ error: "Malformed multipart upload." }, 400);
    }
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return json({ error: "Missing file field in multipart upload." }, 400);
    }
    filename = file.name;
    declaredMime = file.type || OCTET_STREAM;
    data = new Uint8Array(await file.arrayBuffer());
    const declaredEntity = formData.get("entity");
    if (typeof declaredEntity === "string" && declaredEntity) entityName = declaredEntity;
  } else {
    // Raw body upload — use Content-Type header and query params
    filename = new URL(req.url).searchParams.get("filename") ?? "upload";
    declaredMime = contentType || OCTET_STREAM;
    data = new Uint8Array(await req.arrayBuffer());
    entityName = new URL(req.url).searchParams.get("entity") ?? entityName;
  }

  if (data.byteLength > cap) return tooLarge(cap);

  if (data.byteLength === 0) {
    return json({ error: "Empty file." }, 400);
  }

  const mime = normalizeAssetMime(declaredMime, data);

  const id = crypto.randomUUID();
  const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
  const storageKey = `${id}${ext}`;

  await storage.put(storageKey, data, mime);

  db.createAsset({
    id,
    entityName,
    filename,
    mimeType: mime,
    size: data.byteLength,
    storageKey,
  });

  const asset = db.getAsset(id)!;
  return json(
    {
      ...asset,
      metadata: JSON.parse(asset.metadata),
      url: storage.resolve(asset.storage_key),
    },
    201,
  );
}

/**
 * Serve binary asset files from storage. GET /assets/:key
 *
 * The served type is the STORED (normalized) type, never the storage layer's
 * extension guess; with `db` available the asset row is authoritative and its
 * filename feeds `Content-Disposition`.
 */
export async function handleAssetServing(
  url: URL,
  storage: StorageProvider,
  db?: MarinaDB,
): Promise<Response> {
  const key = url.pathname.replace(/^\/assets\//, "");
  if (!key) {
    return new Response("Not found", { status: 404 });
  }

  const result = await storage.get(key);
  if (!result) {
    return new Response("Not found", { status: 404 });
  }

  // Storage keys are `<asset id><ext>` (see handleUpload), so the row is
  // addressable without a new DB accessor.
  const row = db?.getAsset(key.replace(/\.[^./]*$/, ""));
  // Re-normalize on the way out so a row written before the allowlist existed
  // can never hand a browser an executable content type.
  const mime = normalizeAssetMime(row?.mime_type ?? result.mime, result.data);

  return new Response(result.data.buffer as ArrayBuffer, {
    headers: assetResponseHeaders(mime, row?.filename),
  });
}
