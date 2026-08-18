// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Engine } from "../engine/engine";
import type { MarinaDB } from "../persistence/database";
import type { StorageProvider } from "../storage/provider";
import { authenticateRequest } from "./auth-middleware";
import { corsHeaders } from "./cors";

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50 MB

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: corsHeaders(null) });
}

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
  // the open dashboard broadcast. Mutations (POST upload, DELETE) still require
  // a valid session token.
  if (method !== "GET") {
    const auth = authenticateRequest(req, engine);
    if ("error" in auth) return auth.error;
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
    return handleUpload(req, db, storage);
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

async function handleUpload(
  req: Request,
  db: MarinaDB,
  storage: StorageProvider,
): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";

  let filename: string;
  let mime: string;
  let data: Uint8Array;
  let entityName = "system";

  if (contentType.includes("multipart/form-data")) {
    const formData = await req.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return json({ error: "Missing file field in multipart upload." }, 400);
    }
    filename = file.name;
    mime = file.type || "application/octet-stream";
    data = new Uint8Array(await file.arrayBuffer());
    entityName = (formData.get("entity") as string) ?? "system";
  } else {
    // Raw body upload — use Content-Type header and query params
    filename = new URL(req.url).searchParams.get("filename") ?? "upload";
    mime = contentType || "application/octet-stream";
    data = new Uint8Array(await req.arrayBuffer());
    entityName = new URL(req.url).searchParams.get("entity") ?? "system";
  }

  if (data.byteLength > MAX_UPLOAD_SIZE) {
    return json({ error: `File too large. Maximum ${MAX_UPLOAD_SIZE / 1024 / 1024}MB.` }, 413);
  }

  if (data.byteLength === 0) {
    return json({ error: "Empty file." }, 400);
  }

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

/** Serve binary asset files from storage. GET /assets/:key */
export async function handleAssetServing(url: URL, storage: StorageProvider): Promise<Response> {
  const key = url.pathname.replace(/^\/assets\//, "");
  if (!key) {
    return new Response("Not found", { status: 404 });
  }

  const result = await storage.get(key);
  if (!result) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(result.data.buffer as ArrayBuffer, {
    headers: {
      "Content-Type": result.mime,
      "Cache-Control": "public, max-age=31536000, immutable",
      ...corsHeaders(null),
    },
  });
}
