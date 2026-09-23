// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { Engine } from "../src/engine/engine";
import {
  assetResponseHeaders,
  handleAssetApi,
  handleAssetServing,
  isInlineMime,
  normalizeAssetMime,
  OCTET_STREAM,
} from "../src/net/asset-api";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import { MarinaDB } from "../src/persistence/database";
import { LocalStorageProvider } from "../src/storage/local-provider";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_asset_api.db";
const ASSET_DIR = `/tmp/marina-asset-api-test-${process.pid}`;

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const HTML_PAYLOAD = new TextEncoder().encode("<script>alert(document.cookie)</script>");

describe("asset API — MIME policy", () => {
  it("keeps allowlisted media types and verifies raster images by magic bytes", () => {
    expect(normalizeAssetMime("image/png", PNG_MAGIC)).toBe("image/png");
    expect(normalizeAssetMime("IMAGE/PNG; charset=binary", PNG_MAGIC)).toBe("image/png");
    expect(normalizeAssetMime("audio/mpeg", new Uint8Array([1, 2, 3]))).toBe("audio/mpeg");
    expect(normalizeAssetMime("application/pdf", new Uint8Array([1]))).toBe("application/pdf");
  });

  it("downgrades a disguised image and any off-list type to application/octet-stream", () => {
    // Declared PNG, bytes are HTML — a classic stored-XSS smuggle.
    expect(normalizeAssetMime("image/png", HTML_PAYLOAD)).toBe(OCTET_STREAM);
    expect(normalizeAssetMime("text/html", HTML_PAYLOAD)).toBe(OCTET_STREAM);
    expect(normalizeAssetMime("application/javascript", HTML_PAYLOAD)).toBe(OCTET_STREAM);
    expect(normalizeAssetMime(undefined, HTML_PAYLOAD)).toBe(OCTET_STREAM);
    // Undeclared bytes that ARE a PNG are recognised.
    expect(normalizeAssetMime(OCTET_STREAM, PNG_MAGIC)).toBe("image/png");
  });

  it("serves every asset with nosniff + a no-script CSP, and non-media as attachment", () => {
    const html = assetResponseHeaders(OCTET_STREAM, "evil.html");
    expect(html["X-Content-Type-Options"]).toBe("nosniff");
    expect(html["Content-Security-Policy"]).toBe("default-src 'none'; sandbox");
    expect(html["Content-Disposition"]).toBe('attachment; filename="evil.html"');

    const png = assetResponseHeaders("image/png", "a.png");
    expect(png["X-Content-Type-Options"]).toBe("nosniff");
    expect(png["Content-Security-Policy"]).toBe("default-src 'none'; sandbox");
    expect(png["Content-Disposition"]).toBeUndefined();

    // SVG can carry script: never inline. PDF renders in the dashboard iframe: inline.
    expect(isInlineMime("image/svg+xml")).toBe(false);
    expect(isInlineMime("application/pdf")).toBe(true);
    expect(assetResponseHeaders("application/pdf")["Content-Security-Policy"]).toBe(
      "default-src 'none'",
    );
    // Header-injection characters in the filename are neutralised.
    expect(assetResponseHeaders("text/plain", 'a";x\r\nSet-Cookie: b')["Content-Disposition"]).toBe(
      'attachment; filename="a__x__Set-Cookie: b"',
    );
  });
});

describe("asset API — writes, sentinel, limits", () => {
  let db: MarinaDB;
  let engine: Engine;
  let storage: LocalStorageProvider;
  const prevOpenApi = process.env.MARINA_OPEN_API;
  const prevUploadCap = process.env.MARINA_MAX_UPLOAD_BYTES;
  let connCounter = 0;

  beforeEach(async () => {
    delete process.env.MARINA_OPEN_API;
    delete process.env.MARINA_MAX_UPLOAD_BYTES;
    resetHttpRateLimitersForTests();
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    storage = new LocalStorageProvider(ASSET_DIR);
    await storage.init();
  });

  afterEach(() => {
    if (prevOpenApi === undefined) delete process.env.MARINA_OPEN_API;
    else process.env.MARINA_OPEN_API = prevOpenApi;
    if (prevUploadCap === undefined) delete process.env.MARINA_MAX_UPLOAD_BYTES;
    else process.env.MARINA_MAX_UPLOAD_BYTES = prevUploadCap;
    db.close();
    cleanupDb(TEST_DB);
    rmSync(ASSET_DIR, { recursive: true, force: true });
    resetHttpRateLimitersForTests();
  });

  function loginToken(name: string): string {
    const conn = new MockConnection(`asset-${connCounter++}`);
    engine.addConnection(conn);
    const login = engine.login(conn.id, name);
    if ("error" in login) throw new Error(login.error);
    return login.token;
  }

  function upload(
    token: string | undefined,
    data: Uint8Array,
    mime: string,
    filename = "upload.bin",
  ) {
    const url = new URL(`http://localhost:3300/api/assets?filename=${filename}`);
    const req = new Request(url.toString(), {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": mime,
      },
      body: new Blob([data.slice()]),
    });
    return handleAssetApi(url, "POST", req, db, storage, engine);
  }

  it("stores a smuggled HTML 'image' as octet-stream and serves it non-executable", async () => {
    const token = loginToken("Uploader");
    const resp = await upload(token, HTML_PAYLOAD, "image/png", "cute.png");
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as {
      mime_type: string;
      storage_key: string;
      entity_name: string;
    };
    expect(body.mime_type).toBe(OCTET_STREAM);
    // Attribution is the authenticated writer, never a client-chosen name.
    expect(body.entity_name).toBe("Uploader");

    const served = await handleAssetServing(
      new URL(`http://localhost:3300/assets/${body.storage_key}`),
      storage,
      db,
    );
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toBe(OCTET_STREAM);
    expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(served.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(served.headers.get("Content-Disposition")).toStartWith("attachment;");
  });

  it("serves a genuine PNG inline with its image type", async () => {
    const token = loginToken("PngUploader");
    const resp = await upload(token, PNG_MAGIC, "image/png", "real.png");
    const body = (await resp.json()) as { mime_type: string; storage_key: string };
    expect(body.mime_type).toBe("image/png");
    const served = await handleAssetServing(
      new URL(`http://localhost:3300/assets/${body.storage_key}`),
      storage,
      db,
    );
    expect(served.headers.get("Content-Type")).toBe("image/png");
    expect(served.headers.get("Content-Disposition")).toBeNull();
    expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("refuses writes from the MARINA_OPEN_API sentinel (read-only) with 403", async () => {
    process.env.MARINA_OPEN_API = "true";
    const resp = await upload(undefined, PNG_MAGIC, "image/png");
    expect(resp.status).toBe(403);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("MARINA_OPEN_API");
    expect(body.error).toContain("read-only");

    const del = await handleAssetApi(
      new URL("http://localhost:3300/api/assets/whatever"),
      "DELETE",
      new Request("http://localhost:3300/api/assets/whatever", { method: "DELETE" }),
      db,
      storage,
      engine,
    );
    expect(del.status).toBe(403);

    // Reads stay open under the sentinel.
    const list = await handleAssetApi(
      new URL("http://localhost:3300/api/assets"),
      "GET",
      new Request("http://localhost:3300/api/assets"),
      db,
      storage,
      engine,
    );
    expect(list.status).toBe(200);
  });

  it("rate-limits mutations per principal (30 / 10 s)", async () => {
    const token = loginToken("Flooder");
    let limited: Response | undefined;
    for (let i = 0; i < 31; i++) {
      const resp = await handleAssetApi(
        new URL("http://localhost:3300/api/assets/nope"),
        "DELETE",
        new Request("http://localhost:3300/api/assets/nope", {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        }),
        db,
        storage,
        engine,
      );
      if (resp.status === 429) {
        limited = resp;
        break;
      }
      expect(resp.status).toBe(404);
    }
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("Retry-After")).toBe("10");
  });

  it("enforces MARINA_MAX_UPLOAD_BYTES before buffering when Content-Length is declared", async () => {
    process.env.MARINA_MAX_UPLOAD_BYTES = "16";
    const token = loginToken("BigUploader");
    const big = new Uint8Array(64);
    const resp = await upload(token, big, "application/pdf", "big.pdf");
    expect(resp.status).toBe(413);
    // Under the cap still works.
    const ok = await upload(token, PNG_MAGIC, "image/png", "small.png");
    expect(ok.status).toBe(201);
  });
});
