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
} from "../src/net/api/asset-api";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import { MarinaDB } from "../src/persistence/database";
import { assetMimeForFile, mimeFromExtension } from "../src/storage/asset-mime";
import { LocalStorageProvider } from "../src/storage/local-provider";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, tempDbPath } from "./helpers";
import { scopeProcessState } from "./process-state";

const TEST_DB = tempDbPath("test_asset_api.db");
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
    // A mislabelled but genuine raster image gets its real type.
    expect(normalizeAssetMime("image/jpeg", PNG_MAGIC)).toBe("image/png");
  });

  it("extension hints go through the same policy (command and generated write paths)", () => {
    expect(mimeFromExtension(".HTML")).toBe(OCTET_STREAM);
    expect(assetMimeForFile(".html", HTML_PAYLOAD)).toBe(OCTET_STREAM);
    expect(assetMimeForFile(".svg", HTML_PAYLOAD)).toBe("image/svg+xml");
    expect(assetMimeForFile(".png", HTML_PAYLOAD)).toBe(OCTET_STREAM);
    expect(assetMimeForFile(".png", PNG_MAGIC)).toBe("image/png");
    expect(assetMimeForFile(".py", HTML_PAYLOAD)).toBe("text/plain");
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

  function multipartUpload(token: string, entity?: string) {
    const form = new FormData();
    form.append("file", new File([PNG_MAGIC.slice()], "pic.png", { type: "image/png" }));
    if (entity !== undefined) form.append("entity", entity);
    const url = new URL("http://localhost:3300/api/assets");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    return handleAssetApi(url, "POST", req, db, storage, engine);
  }

  it("refuses a client-chosen owner (multipart `entity` / `?entity=`) naming someone else", async () => {
    loginToken("Victim");
    const token = loginToken("Spoofer");

    const viaForm = await multipartUpload(token, "Victim");
    expect(viaForm.status).toBe(403);
    expect(((await viaForm.json()) as { code: string }).code).toBe("asset_owner_mismatch");

    const url = new URL("http://localhost:3300/api/assets?filename=x.png&entity=Victim");
    const viaQuery = await handleAssetApi(
      url,
      "POST",
      new Request(url.toString(), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/png" },
        body: new Blob([PNG_MAGIC.slice()]),
      }),
      db,
      storage,
      engine,
    );
    expect(viaQuery.status).toBe(403);
    expect(db.listAssets({ limit: 50 })).toHaveLength(0);
  });

  it("attributes an upload to the authenticated writer (own name restated or omitted)", async () => {
    const token = loginToken("Owner");
    const restated = await multipartUpload(token, "owner");
    expect(restated.status).toBe(201);
    expect(((await restated.json()) as { entity_name: string }).entity_name).toBe("Owner");
    // The same bytes again are the owner's existing asset (dedupe), not a copy.
    const omitted = await multipartUpload(token);
    expect(omitted.status).toBe(200);
    const body = (await omitted.json()) as {
      entity_name: string;
      id: string;
      deduplicated?: boolean;
    };
    expect(body.entity_name).toBe("Owner");
    expect(body.deduplicated).toBe(true);

    // The owner deletes its own upload.
    const del = await handleAssetApi(
      new URL(`http://localhost:3300/api/assets/${body.id}`),
      "DELETE",
      new Request(`http://localhost:3300/api/assets/${body.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }),
      db,
      storage,
      engine,
    );
    expect(del.status).toBe(200);
  });
});

describe("asset API — reads and stored rows", () => {
  let db: MarinaDB;
  let engine: Engine;
  let storage: LocalStorageProvider;
  const DIR = `${ASSET_DIR}-reads`;
  const DB = `${TEST_DB}.reads`;

  beforeEach(async () => {
    delete process.env.MARINA_OPEN_API;
    resetHttpRateLimitersForTests();
    db = new MarinaDB(DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    storage = new LocalStorageProvider(DIR);
    await storage.init();
  });

  afterEach(() => {
    db.close();
    cleanupDb(DB);
    rmSync(DIR, { recursive: true, force: true });
    resetHttpRateLimitersForTests();
  });

  const get = (path: string, peerIp: string, headers: Record<string, string> = {}) => {
    const url = new URL(`http://localhost:3300${path}`);
    return handleAssetApi(
      url,
      "GET",
      new Request(url.toString(), { headers }),
      db,
      storage,
      engine,
      peerIp,
    );
  };

  async function uploadAs(name: string, filename: string): Promise<{ id: string; key: string }> {
    const conn = new MockConnection(`asset-read-${name}`);
    engine.addConnection(conn);
    const login = engine.login(conn.id, name);
    if ("error" in login) throw new Error(login.error);
    const url = new URL(
      `http://localhost:3300/api/assets?filename=${encodeURIComponent(filename)}`,
    );
    const resp = await handleAssetApi(
      url,
      "POST",
      new Request(url.toString(), {
        method: "POST",
        headers: { Authorization: `Bearer ${login.token}`, "Content-Type": "image/png" },
        body: new Blob([PNG_MAGIC.slice()]),
      }),
      db,
      storage,
      engine,
    );
    const body = (await resp.json()) as { id: string; storage_key: string };
    return { id: body.id, key: body.storage_key };
  }

  it("limits anonymous asset detail and list reads per client IP", async () => {
    const { id } = await uploadAs("Reader", "a.png");
    for (const path of [`/api/assets/${id}`, "/api/assets"]) {
      resetHttpRateLimitersForTests();
      let limited = false;
      for (let i = 0; i < 31; i++) {
        if ((await get(path, "203.0.113.40")).status === 429) {
          limited = true;
          break;
        }
      }
      expect(limited).toBe(true);
      expect((await get(path, "203.0.113.41")).status).toBe(200);
    }
  });

  it("keys the anonymous library-view budget on the resolved client IP", async () => {
    // Behind a trusted proxy every client shares the proxy's socket address;
    // each forwarded client gets its own budget.
    using _state = scopeProcessState({ env: { MARINA_TRUST_PROXY: "true" } });
    const proxy = "10.0.0.5";
    let limited = false;
    for (let i = 0; i < 31; i++) {
      const resp = await get("/api/assets?view=library", proxy, {
        "X-Forwarded-For": "198.51.100.1",
      });
      if (resp.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
    const other = await get("/api/assets?view=library", proxy, {
      "X-Forwarded-For": "198.51.100.2",
    });
    expect(other.status).toBe(200);
  });

  it("stores an upload under a plain extension taken from the filename", async () => {
    const { key } = await uploadAs("Ext", "evil.p/../../ng");
    expect(key).toMatch(/^[0-9a-f-]+$/);
    const ok = await uploadAs("Ext2", "photo.PNG");
    expect(ok.key).toMatch(/^[0-9a-f-]+\.PNG$/);
  });

  it("lists assets when one row's stored metadata is damaged", async () => {
    const { id } = await uploadAs("Lister", "b.png");
    const raw = (db as unknown as { db: { run(sql: string): unknown } }).db;
    raw.run(`UPDATE assets SET metadata = '{broken' WHERE id = '${id}'`);
    const resp = await get("/api/assets", "203.0.113.60");
    expect(resp.status).toBe(200);
    const list = (await resp.json()) as Array<{ id: string; metadata: unknown }>;
    expect(list.find((a) => a.id === id)?.metadata).toEqual({});
  });
});
