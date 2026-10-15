// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The desktop bridge against the real asset API: every library, viewer and
 * upload path the dashboard uses goes through the native proxy to the embedded
 * server, so the server's authorization, dedupe, signing rule and events hold.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { derivativesIdle } from "../../src/engine/media/asset-library";
import { handleAssetApi, handleAssetServing } from "../../src/net/api/asset-api";
import { resetHttpRateLimitersForTests } from "../../src/net/http-utils";
import { LocalStorageProvider } from "../../src/storage/local-provider";
import type { EngineEvent } from "../../src/types";
import { createTestEngine } from "../../test/engine-fixture";
import { MockConnection } from "../../test/helpers";
import { scopeProcessState } from "../../test/process-state";
import type { EngineHost } from "../src/bun/engine-host";
import { loadPreferences } from "../src/bun/preferences";
import { createRpcHandlers } from "../src/bun/rpc-handlers";

// 1×1 PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

let dir: string;
let storage: LocalStorageProvider;
let world: ReturnType<typeof createTestEngine>;
let server: ReturnType<typeof Bun.serve>;
let rpc: ReturnType<typeof createRpcHandlers>;
let events: EngineEvent[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "desktop-asset-bridge-"));
  storage = new LocalStorageProvider(dir);
  await storage.init();
  world = createTestEngine({ assetStorage: storage });
  resetHttpRateLimitersForTests();
  events = [];
  world.engine.addEventListener((e) => {
    if (e.type.startsWith("asset_")) events.push(e);
  });
  // The embedded server's asset routes, exactly as websocket-server.ts dispatches them.
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req, srv) => {
      const url = new URL(req.url);
      const peerIp = srv.requestIP(req)?.address;
      if (url.pathname.startsWith("/assets/")) {
        return handleAssetServing(url, storage, world.db, { engine: world.engine, req, peerIp });
      }
      return handleAssetApi(url, req.method, req, world.db, storage, world.engine, peerIp);
    },
  });
  rpc = createRpcHandlers(
    () =>
      ({
        isRunning: true,
        getEngine: () => world.engine,
        getDb: () => world.db,
        getStorage: () => storage,
      }) as unknown as EngineHost,
    {
      getPreferences: () => ({
        ...loadPreferences("/nonexistent-marina-preferences.json"),
        wsPort: server.port!,
      }),
      setPreferences: () => {},
      switchToRemote: async () => {},
      switchToLocal: async () => {},
    },
    () => {},
    () => {},
  );
});

afterEach(async () => {
  server.stop(true);
  await derivativesIdle();
  await world.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** A multipart body the way the webview serializes it (rpc-shim `serializeBody`). */
async function multipart(file: File) {
  const form = new FormData();
  form.append("file", file, file.name);
  const request = new Request("http://marina.desktop.invalid/", { method: "POST", body: form });
  return {
    contentType: request.headers.get("content-type")!,
    bytes: new Uint8Array(await request.arrayBuffer()),
  };
}

async function upload(file: File, headers: Record<string, string> = {}) {
  const body = await multipart(file);
  const begin = rpc.proxyUploadBegin({
    path: "/api/assets",
    method: "POST",
    headers: { ...headers, "content-type": body.contentType },
    size: body.bytes.byteLength,
  });
  if (!("id" in begin)) throw new Error(`refused: ${begin.error.body}`);
  // Two chunks, as a large file would arrive.
  const half = Math.floor(body.bytes.byteLength / 2);
  for (const [offset, part] of [
    [0, body.bytes.subarray(0, half)],
    [half, body.bytes.subarray(half)],
  ] as const) {
    const sent = rpc.proxyUploadChunk({
      id: begin.id,
      offset,
      dataBase64: Buffer.from(part).toString("base64"),
    });
    if ("error" in sent) throw new Error(sent.error);
  }
  const result = await rpc.proxyUploadFinish(begin.id);
  return { status: result.status, body: JSON.parse(result.body) };
}

const api = async (method: string, path: string, body?: unknown, auth?: string) => {
  const result = await rpc.proxyApi({
    path,
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: result.status, body: JSON.parse(result.body) };
};

test("library, detail, edit, sign, bytes, dedupe and delete reach the server as the desktop operator", async () => {
  using _state = scopeProcessState({
    env: { MARINA_DESKTOP_API_TOKEN: "desktop-bridge-secret".repeat(3), MARINA_OPEN_API: "false" },
  });
  const first = await upload(new File([PNG], "dot.png", { type: "image/png" }));
  expect(first.status).toBe(201);
  expect(first.body.deduplicated).toBeUndefined();
  const id = first.body.id as string;

  // Same bytes again: the server's dedupe answer passes through unchanged.
  const again = await upload(new File([PNG], "copy.png", { type: "image/png" }));
  expect(again.status).toBe(200);
  expect(again.body).toMatchObject({ id, deduplicated: true });

  // The library view keeps its query: filters, limit and facets.
  const library = await api("GET", "/api/assets?view=library&type=image&limit=10&facets=1");
  expect(library.status).toBe(200);
  expect(library.body.items.map((i: { id: string }) => i.id)).toEqual([id]);
  expect(library.body.facets).toBeDefined();
  expect(library.body).toHaveProperty("nextCursor");
  const none = await api("GET", "/api/assets?view=library&type=audio");
  expect(none.body.items).toEqual([]);

  const detail = await api("GET", `/api/assets/${id}`);
  expect(detail.status).toBe(200);
  expect(detail.body).toMatchObject({ id, url: first.body.url });

  const edited = await api("PATCH", `/api/assets/${id}`, {
    caption: "a dot",
    addTags: ["desk"],
  });
  expect(edited.status).toBe(200);
  expect(edited.body.caption).toBe("a dot");
  expect(edited.body.tags).toContain("desk");

  // The operator sentinel is never signed for: plain URLs.
  const signed = await api("POST", "/api/assets/sign", { urls: [first.body.url] });
  expect(signed.body.urls[first.body.url]).toEqual({ url: first.body.url, expiresAt: null });

  // Element bytes come back through the download transfer.
  const bytes = await rpc.proxyDownloadBegin({ path: first.body.url });
  expect(bytes.status).toBe(200);
  expect(bytes.contentType).toBe("image/png");
  expect(Buffer.from(bytes.bodyBase64!, "base64").equals(Buffer.from(PNG))).toBe(true);

  const deleted = await api("DELETE", `/api/assets/${id}`);
  expect(deleted).toEqual({ status: 200, body: { ok: true, id } });
  expect((await api("GET", `/api/assets/${id}`)).status).toBe(404);

  // Live invalidation: the server path emits the asset events the webview relays.
  const kinds = events.map((e) => e.type);
  expect(kinds).toContain("asset_created");
  expect(kinds).toContain("asset_updated");
  expect(kinds).toContain("asset_deleted");
});

test("a signed-in resident keeps its own identity and authority through the bridge", async () => {
  using _state = scopeProcessState({
    env: { MARINA_DESKTOP_API_TOKEN: "desktop-bridge-secret".repeat(3), MARINA_OPEN_API: "false" },
  });
  const conn = new MockConnection("c-resident");
  world.engine.addConnection(conn);
  const login = world.engine.login(conn.id, "Resident");
  if (!("token" in login)) throw new Error("login failed");

  // The operator's asset: the resident cannot edit or delete it.
  const operatorAsset = await upload(new File([PNG], "op.png", { type: "image/png" }));
  expect(operatorAsset.status).toBe(201);
  const opId = operatorAsset.body.id as string;
  expect(
    (await api("PATCH", `/api/assets/${opId}`, { caption: "x" }, login.token)).status,
  ).toBeGreaterThanOrEqual(400);
  expect((await api("DELETE", `/api/assets/${opId}`, undefined, login.token)).status).toBe(403);

  // The resident's own upload is attributed to it, and it may edit it.
  const own = await upload(new File([new Uint8Array([...PNG, 0])], "mine.png"), {
    authorization: `Bearer ${login.token}`,
  });
  expect(own.status).toBe(201);
  expect(own.body.entity_name).toBe("Resident");
  const ownEdit = await api(
    "PATCH",
    `/api/assets/${own.body.id}`,
    { caption: "mine" },
    login.token,
  );
  expect(ownEdit.status).toBe(200);

  // An expired credential is refused, never upgraded to the operator.
  expect((await api("DELETE", `/api/assets/${own.body.id}`, undefined, "expired")).status).toBe(
    401,
  );
});
