// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { isGatedAssetBytes, mayReadAsset } from "../../engine/canvas-access";
import { isOperatorPrincipal as isOperatorPerson } from "../../engine/challenges";
import type { Engine } from "../../engine/engine";
import {
  AssetBytesError,
  type AssetEdit,
  type AssetLibraryHost,
  checkAssetEdit,
  editAsset,
  ingestAsset,
  normalizeTag,
  removeAsset,
} from "../../engine/media/asset-library";
import type { MarinaDB } from "../../persistence/database";
import { isInlineMime, normalizeAssetMime, OCTET_STREAM } from "../../storage/asset-mime";
import type { StorageProvider } from "../../storage/provider";
import type { EntityId } from "../../types";
import {
  authenticateRequest,
  isOperatorPrincipal,
  OPEN_API_ENTITY_ID,
  refuseOpenApiWrite,
} from "../auth-middleware";
import { buildCanvasPrincipal, resolveCanvasHttpPrincipal } from "../canvas/canvas-principal";
import { corsHeaders } from "../cors";
import {
  consumeHttpRate,
  maxUploadBytes,
  PDF_CSP,
  rateLimitedResponse,
  securityHeaders,
} from "../http-utils";
import { resolveMediaScope } from "../media-scope";
import { authorizeOwnerOrPrivileged } from "../owner-authorization";
import {
  type LibraryContext,
  libraryDetail,
  libraryFacets,
  libraryItems,
  libraryPage,
  parseLibraryQuery,
} from "./asset-library-view";
import {
  assetIdFromKey,
  assetKeyFromPath,
  MAX_SIGN_BATCH,
  maySignFor,
  signedAssetUrl,
  verifyAssetSignature,
} from "./asset-signing";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: corsHeaders(null) });
}

// ─── MIME policy ─────────────────────────────────────────────────────────────
//
// The pure policy lives in src/storage/asset-mime.ts so every write path (this
// endpoint, `canvas asset upload`, `exec publish`, generated media) stores
// assets under the same rules; re-exported here for existing importers.

export {
  ALLOWED_ASSET_MIMES,
  isInlineMime,
  normalizeAssetMime,
  OCTET_STREAM,
  sniffImageMime,
} from "../../storage/asset-mime";

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
  peerIp?: string,
): Promise<Response> {
  // Reads are public so canvas assets (image metadata/listing) render for a
  // fresh, not-yet-logged-in visitor — consistent with public canvas reads and
  // the open dashboard broadcast — EXCEPT private assets (shown only on
  // private canvases, or staged request images): those follow the shared
  // canvas read check (src/engine/canvas-access.ts) and are "not found" to
  // anyone else. Mutations (POST upload, DELETE) require a
  // valid session token: the dev-open sentinel is read-only, and each principal
  // is rate-limited so an authenticated client cannot flood storage.
  if (url.pathname === "/api/assets/sign" && method === "POST") {
    return handleSign(req, db, storage, engine);
  }
  const readerPrincipal =
    method === "GET" ? resolveCanvasHttpPrincipal(req, engine, peerIp) : undefined;
  const reader = method === "GET" ? buildCanvasPrincipal(readerPrincipal, engine, db) : undefined;
  const host = { db, entities: engine.entities, canvasGrants: engine.canvasGrants };
  const library: AssetLibraryHost = {
    db,
    storage,
    logEvent: (event) => engine.logEvent(event),
    trackBackground: (work) => engine.trackBackground(work),
  };
  let writerName: string | undefined;
  let writerId: EntityId | undefined;
  let writerIsOperator = false;
  if (method !== "GET") {
    const auth = authenticateRequest(req, engine);
    if ("error" in auth) return auth.error;
    const origin = req.headers.get("Origin");
    const refused = refuseOpenApiWrite(auth.entityId, origin);
    if (refused) return refused;
    if (!consumeHttpRate("mutation", auth.entityId)) return rateLimitedResponse(origin);
    const writer = engine.entities.get(auth.entityId);
    writerName = writer?.name;
    writerId = auth.entityId;
    // The desktop capability token, a rank-9 person, or (local profile only —
    // `refuseOpenApiWrite` passed it) the loopback dev sentinel.
    writerIsOperator =
      isOperatorPrincipal(auth.entityId) ||
      auth.entityId === OPEN_API_ENTITY_ID ||
      isOperatorPerson(writer);
  }
  // DELETE /api/assets/:id
  const idMatch = url.pathname.match(/^\/api\/assets\/(.+)$/);
  if (idMatch && method === "DELETE") {
    const id = decodeURIComponent(idMatch[1]!);
    const asset = db.getAsset(id);
    if (!asset) return json({ error: "Asset not found" }, 404);
    // The uploader (or an operator/admin) deletes an asset.
    if (writerId) {
      const denied = authorizeOwnerOrPrivileged(engine, db, writerId, [asset.entity_name]);
      if (denied) return denied;
    }
    // Bytes of the asset and its derivatives, then the row (derivatives cascade).
    try {
      await removeAsset(library, asset, writerId);
    } catch (err) {
      if (!(err instanceof AssetBytesError)) throw err;
      // Storage refused; the asset is kept rather than orphaning its bytes.
      return json({ error: "asset_storage_error", message: err.message, id }, 503);
    }
    return json({ ok: true, id });
  }

  // PATCH /api/assets/:id — { caption?, alt?, tags?, addTags?, removeTags? }
  if (idMatch && method === "PATCH") {
    const id = decodeURIComponent(idMatch[1]!);
    const asset = db.getAsset(id);
    const patchReader = writerId ? buildCanvasPrincipal(writerId, engine, db) : undefined;
    // A private asset the writer cannot read is "not found", never "forbidden".
    if (
      !asset ||
      asset.derived_from ||
      !mayReadAsset(host, asset, patchReader, "http PATCH asset")
    ) {
      return json({ error: "Asset not found" }, 404);
    }
    if (writerId) {
      const denied = authorizeOwnerOrPrivileged(engine, db, writerId, [asset.entity_name]);
      if (denied) return denied;
    }
    const current = db.getAssetTags(id);
    const edit = await parseAssetPatch(req, current);
    if (typeof edit === "string") return json({ error: edit, code: "invalid_asset_patch" }, 400);
    const problem = checkAssetEdit(edit, current);
    if (problem) return json({ error: problem, code: "invalid_asset_patch" }, 400);
    const updated = editAsset(library, asset, edit, writerId);
    const ctx = libraryContext(db, storage, host, writerId, patchReader, writerName);
    return json(libraryDetail(ctx, updated.asset));
  }

  // GET /api/assets/:id (metadata + library detail)
  if (idMatch && method === "GET") {
    const id = decodeURIComponent(idMatch[1]!);
    const asset = db.getAsset(id);
    if (!asset || !mayReadAsset(host, asset, reader, "http GET asset")) {
      return json({ error: "Asset not found" }, 404);
    }
    const viewerName = readerName(engine, readerPrincipal);
    const ctx = libraryContext(db, storage, host, readerPrincipal, reader, viewerName);
    // The raw row (legacy fields, parsed metadata, plain `url`) plus the library detail.
    return json({
      ...asset,
      ...libraryDetail(ctx, asset),
      url: storage.resolve(asset.storage_key),
    });
  }

  // POST /api/assets (multipart upload)
  if (url.pathname === "/api/assets" && method === "POST") {
    return handleUpload(req, library, storage, writerName, writerId, writerIsOperator);
  }

  // GET /api/assets?view=library — { items, nextCursor, facets? }: filters,
  // keyset pages, thumbnails, per-viewer read checks (asset-library-view.ts).
  if (
    url.pathname === "/api/assets" &&
    method === "GET" &&
    url.searchParams.get("view") === "library"
  ) {
    const rateKey = readerPrincipal ?? `ip:${peerIp ?? "unknown"}`;
    if (!consumeHttpRate(readerPrincipal ? "dashboard" : "publicRead", rateKey)) {
      return rateLimitedResponse(req.headers.get("Origin"));
    }
    const viewerName = readerName(engine, readerPrincipal);
    const ctx = libraryContext(db, storage, host, readerPrincipal, reader, viewerName, engine);
    const q = parseLibraryQuery(url.searchParams, ctx.viewer);
    if (typeof q === "string") return json({ error: q, code: "invalid_asset_query" }, 400);
    const page = q.empty ? { rows: [], nextCursor: null } : libraryPage(ctx, q);
    const wantFacets = ["1", "true"].includes(url.searchParams.get("facets") ?? "");
    return json({
      items: libraryItems(ctx, page.rows),
      nextCursor: page.nextCursor,
      ...(wantFacets ? { facets: libraryFacets(ctx, q) } : {}),
    });
  }

  // GET /api/assets (legacy list: a plain array)
  if (url.pathname === "/api/assets" && method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
    const mime = url.searchParams.get("mime") ?? undefined;
    const assets = db
      .listAssets({ limit, mime })
      .filter((a) => mayReadAsset(host, a, reader, "http list assets", { log: false }));
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

function readerName(engine: Engine, principal: string | undefined): string | undefined {
  return principal ? engine.entities.get(principal as EntityId)?.name : undefined;
}

function libraryContext(
  db: MarinaDB,
  storage: StorageProvider,
  host: LibraryContext["host"],
  principal: string | undefined,
  reader: LibraryContext["viewer"]["reader"],
  name: string | undefined,
  engine?: Engine,
): LibraryContext {
  return {
    db,
    storage,
    host,
    viewer: {
      ...(principal ? { principal } : {}),
      ...(reader ? { reader } : {}),
      ...(name ? { name } : {}),
      ...(principal && engine
        ? {
            scopeOwners: (scope: "owned" | "chat") =>
              resolveMediaScope(engine, db, principal as EntityId, scope).names,
          }
        : {}),
    },
  };
}

/**
 * The body of `PATCH /api/assets/:id`. `tags` replaces the set; `addTags` /
 * `removeTags` edit it; `caption` / `alt` set it (empty or null clears).
 * A string is the 400 reason.
 */
async function parseAssetPatch(
  req: Request,
  current: readonly string[],
): Promise<AssetEdit | string> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return "Expected a JSON body.";
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Expected a JSON object.";
  const b = body as Record<string, unknown>;
  const edit: AssetEdit = {};
  for (const key of ["caption", "alt"] as const) {
    if (!(key in b)) continue;
    const v = b[key];
    if (v !== null && typeof v !== "string") return `${key} must be a string or null.`;
    edit[key] = v as string | null;
  }
  const tagList = (key: string): string[] | string | undefined => {
    if (!(key in b)) return undefined;
    const v = b[key];
    if (!Array.isArray(v) || !v.every((t) => typeof t === "string"))
      return `${key} must be an array of strings.`;
    return v.map((t: string) => normalizeTag(t)).filter((t): t is string => !!t);
  };
  const tags = tagList("tags");
  const add = tagList("addTags");
  const remove = tagList("removeTags");
  for (const v of [tags, add, remove]) if (typeof v === "string") return v;
  if (Array.isArray(tags)) {
    edit.addTags = tags;
    edit.removeTags = current.filter((t) => !tags.includes(t));
  }
  if (Array.isArray(add)) edit.addTags = [...(edit.addTags ?? []), ...add];
  if (Array.isArray(remove)) edit.removeTags = [...(edit.removeTags ?? []), ...remove];
  if (Object.keys(edit).length === 0)
    return "Nothing to change: send caption, alt, tags, addTags or removeTags.";
  return edit;
}

/**
 * POST /api/assets/sign `{ urls: string[] }` → `{ urls: { [input]: { url, expiresAt } } }`.
 *
 * For each `/assets/<key>` path the caller may read, the URL an element without
 * an `Authorization` header can load: the plain URL (`expiresAt: null`) when
 * anyone may read the asset or the caller reads without a header anyway (a
 * sentinel principal), else a signed URL for the caller (see asset-signing.ts).
 * Inputs the caller may not read, or that are not asset paths, are omitted —
 * the same "not found" as a direct read.
 */
async function handleSign(
  req: Request,
  db: MarinaDB,
  storage: StorageProvider,
  engine: Engine,
): Promise<Response> {
  const auth = authenticateRequest(req, engine);
  if ("error" in auth) return auth.error;
  if (!consumeHttpRate("dashboard", auth.entityId)) {
    return rateLimitedResponse(req.headers.get("Origin"));
  }
  const bad = () => json({ error: "Expected a JSON body { urls: string[] }." }, 400);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad();
  }
  const urls = (body as { urls?: unknown } | null)?.urls;
  if (!Array.isArray(urls) || !urls.every((u): u is string => typeof u === "string")) {
    return bad();
  }
  if (urls.length > MAX_SIGN_BATCH) {
    return json({ error: `At most ${MAX_SIGN_BATCH} URLs per request.` }, 400);
  }
  const principal = auth.entityId as string;
  const reader = buildCanvasPrincipal(principal, engine, db);
  const host = { db, entities: engine.entities, canvasGrants: engine.canvasGrants };
  const out: Record<string, { url: string; expiresAt: number | null }> = {};
  for (const raw of new Set(urls)) {
    const key = assetKeyFromPath(raw);
    if (!key) continue;
    const row = db.getAsset(assetIdFromKey(key));
    if (!row || !mayReadAsset(host, row, reader, "http sign asset url")) continue;
    const plain = storage.resolve(row.storage_key);
    const open =
      !plain.startsWith("/assets/") ||
      !maySignFor(principal) ||
      mayReadAsset(host, row, undefined, "http sign asset url", { log: false });
    out[raw] = open ? { url: plain, expiresAt: null } : signedAssetUrl(plain, row.id, principal);
  }
  return json({ urls: out });
}

function tooLarge(cap: number): Response {
  return json({ error: `File too large. Maximum ${Math.floor(cap / 1024 / 1024)}MB.` }, 413);
}

async function handleUpload(
  req: Request,
  library: AssetLibraryHost,
  storage: StorageProvider,
  writerName: string | undefined,
  writerId: EntityId | undefined,
  writerIsOperator: boolean,
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
  // The owner is the AUTHENTICATED writer — the name DELETE authorizes by. The
  // legacy client-supplied `entity` field / `?entity=` may only restate it;
  // naming anyone else is refused (an operator may still attribute).
  const entityName = writerName ?? "system";
  let declaredEntity: string | undefined;

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
    const field = formData.get("entity");
    if (typeof field === "string" && field) declaredEntity = field;
  } else {
    // Raw body upload — use Content-Type header and query params
    filename = new URL(req.url).searchParams.get("filename") ?? "upload";
    declaredMime = contentType || OCTET_STREAM;
    data = new Uint8Array(await req.arrayBuffer());
    declaredEntity = new URL(req.url).searchParams.get("entity") || undefined;
  }

  const owner = uploadOwner(entityName, declaredEntity, writerIsOperator);
  if ("error" in owner) return owner.error;

  if (data.byteLength > cap) return tooLarge(cap);

  if (data.byteLength === 0) {
    return json({ error: "Empty file." }, 400);
  }

  const mime = normalizeAssetMime(declaredMime, data);

  // The same owner uploading the same bytes again gets the existing asset
  // back (200, `deduplicated: true`) instead of a second copy.
  const { asset, deduplicated } = await ingestAsset(library, {
    owner: owner.name,
    filename,
    mime,
    data,
    origin: "upload",
    dedupe: true,
    ext: filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "",
    ...(writerId ? { actor: writerId } : {}),
  });
  return json(
    {
      ...asset,
      metadata: JSON.parse(asset.metadata),
      url: storage.resolve(asset.storage_key),
      ...(deduplicated ? { deduplicated: true } : {}),
    },
    deduplicated ? 200 : 201,
  );
}

/**
 * The name an upload is attributed to: always the authenticated writer. A
 * legacy `entity` value that names the writer (case-insensitively) is
 * accepted; one that names anyone else is a 403 — attribution is what DELETE
 * authorizes by, so a client-chosen owner would hand out delete rights —
 * unless the writer is an operator, who may attribute on someone's behalf.
 */
function uploadOwner(
  writerName: string,
  declared: string | undefined,
  writerIsOperator: boolean,
): { name: string } | { error: Response } {
  const wanted = declared?.trim();
  if (!wanted || wanted.toLowerCase() === writerName.toLowerCase()) return { name: writerName };
  if (writerIsOperator) return { name: wanted };
  return {
    error: json(
      {
        error:
          `An upload is owned by the authenticated uploader (${writerName}); ` +
          `the "entity" field cannot name another entity. Omit it.`,
        code: "asset_owner_mismatch",
      },
      403,
    ),
  };
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
  access?: { engine: Engine; req: Request; peerIp?: string },
): Promise<Response> {
  const key = url.pathname.replace(/^\/assets\//, "");
  if (!key) {
    return new Response("Not found", { status: 404 });
  }

  // Storage keys are `<asset id><ext>` (see handleUpload), so the row is
  // addressable without a new DB accessor.
  const row = db?.getAsset(assetIdFromKey(key));
  // A staged request image's bytes follow the shared canvas read check (the
  // owner, operators, or a live grant on its node); without a caller to check,
  // they are refused. Other assets stay capability URLs, so `<img>` tags (which
  // cannot send a bearer token) keep rendering. A valid signature
  // (asset-signing.ts) names the reader for elements that cannot send a header;
  // the read check still runs as that principal, and a bad signature reads as
  // if it were absent.
  let privateCache: string | undefined;
  if (db && row && isGatedAssetBytes(db, row)) {
    const signed = access ? verifyAssetSignature(row.id, url.searchParams) : undefined;
    const reader = access
      ? buildCanvasPrincipal(
          signed?.principal ?? resolveCanvasHttpPrincipal(access.req, access.engine, access.peerIp),
          access.engine,
          db,
        )
      : undefined;
    const host = access
      ? { db, entities: access.engine.entities, canvasGrants: access.engine.canvasGrants }
      : { db, entities: { get: () => undefined } };
    if (!mayReadAsset(host, row, reader, "http GET asset bytes")) {
      return new Response("Not found", { status: 404 });
    }
    // A gated read is never kept by a shared cache; a signed one may be reused
    // by this browser until its signature expires.
    privateCache = signed
      ? `private, max-age=${Math.max(0, signed.exp - Math.floor(Date.now() / 1000))}`
      : "private, no-store";
  }

  const result = await storage.get(key);
  if (!result) {
    return new Response("Not found", { status: 404 });
  }
  // Re-normalize on the way out so a row written before the allowlist existed
  // can never hand a browser an executable content type.
  const mime = normalizeAssetMime(row?.mime_type ?? result.mime, result.data);

  const headers = assetResponseHeaders(mime, row?.filename);
  if (privateCache) headers["Cache-Control"] = privateCache;
  return new Response(result.data.buffer as ArrayBuffer, { headers });
}
