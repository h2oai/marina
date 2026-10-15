// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deleting a canvas node never deletes the asset it shows: the asset library
 * owns asset lifetime (one asset may sit on many nodes and canvases, and the
 * node's deleter need not own it). Deleting the asset itself is the library's
 * path — owner or operator, derivatives removed, `asset_deleted` emitted.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { derivativesIdle, ingestAsset } from "../src/engine/media/asset-library";
import { handleAssetApi } from "../src/net/api/asset-api";
import { handleCanvasApi } from "../src/net/canvas/canvas-api";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import { LocalStorageProvider } from "../src/storage/local-provider";
import type { EngineEvent, EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { MockConnection } from "./helpers";
import { scopeProcessState } from "./process-state";

let dir: string;
let storage: LocalStorageProvider;
let world: ReturnType<typeof createTestEngine>;
let events: EngineEvent[];
let alice: { id: EntityId; token: string };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "node-asset-lifetime-"));
  storage = new LocalStorageProvider(dir);
  await storage.init();
  world = createTestEngine({ assetStorage: storage });
  resetHttpRateLimitersForTests();
  events = [];
  world.engine.addEventListener((e) => {
    if (e.type.startsWith("asset_")) events.push(e);
  });
  const conn = new MockConnection("c-alice");
  world.engine.addConnection(conn);
  const login = world.engine.login(conn.id, "Alice");
  if (!("token" in login)) throw new Error("login failed");
  alice = { id: login.entityId, token: login.token };
});

afterEach(async () => {
  await derivativesIdle();
  await world.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function request(path: string, method: string) {
  const url = new URL(`http://localhost:3300${path}`);
  const req = new Request(url.toString(), {
    method,
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  return { url, req };
}

const canvasApi = (path: string, method: string) => {
  const { url, req } = request(path, method);
  return handleCanvasApi(url, method, req, world.db, storage, undefined, world.engine);
};

test("deleting nodes that share an asset keeps the asset, its bytes and thumbnails; the library deletes it", async () => {
  using _state = scopeProcessState({ env: { MARINA_ASSET_DERIVATIVES: "sync" } });
  const png = new Uint8Array(
    await sharp({ create: { width: 400, height: 300, channels: 3, background: "#204080" } })
      .png()
      .toBuffer(),
  );
  const { asset } = await ingestAsset(world.engine, {
    owner: "Alice",
    filename: "shared.png",
    mime: "image/png",
    data: png,
    origin: "upload",
    actor: alice.id,
  });
  await derivativesIdle();
  const thumbs = world.db.listDerivatives([asset.id]);
  expect(thumbs.length).toBeGreaterThan(0);

  // "Add to canvas" twice: two canvases, one node each, both showing the asset.
  for (const canvas of ["board-a", "board-b"]) {
    world.db.createCanvas({ id: canvas, name: canvas, creatorName: "Alice" });
    world.db.createNode({
      id: `node-${canvas}`,
      canvasId: canvas,
      type: "image",
      assetId: asset.id,
      creatorName: "Alice",
    });
  }

  const first = await canvasApi("/api/canvases/board-a/nodes/node-board-a", "DELETE");
  expect(first.status).toBe(200);
  expect(world.db.getNode("node-board-a")).toBeUndefined();
  // The asset, its bytes and its thumbnails remain; the other node still renders it.
  expect(world.db.getAsset(asset.id)).toBeDefined();
  expect(await storage.get(asset.storage_key)).not.toBeNull();
  for (const t of thumbs) expect(await storage.get(t.storage_key)).not.toBeNull();
  const other = await canvasApi("/api/canvases/board-b/nodes/node-board-b", "GET");
  expect(other.status).toBe(200);
  expect(((await other.json()) as { data: { url?: string } }).data.url).toBe(
    storage.resolve(asset.storage_key),
  );

  // Deleting the last node showing it still leaves it in the library.
  expect((await canvasApi("/api/canvases/board-b/nodes/node-board-b", "DELETE")).status).toBe(200);
  expect(world.db.getAsset(asset.id)).toBeDefined();
  expect(await storage.get(asset.storage_key)).not.toBeNull();
  expect(events.some((e) => e.type === "asset_deleted")).toBe(false);

  // The library path deletes it: bytes, derivatives and the event.
  const { url, req } = request(`/api/assets/${asset.id}`, "DELETE");
  const removed = await handleAssetApi(url, "DELETE", req, world.db, storage, world.engine);
  expect(removed.status).toBe(200);
  expect(world.db.getAsset(asset.id)).toBeUndefined();
  expect(await storage.get(asset.storage_key)).toBeNull();
  for (const t of thumbs) {
    expect(world.db.getAsset(t.id)).toBeUndefined();
    expect(await storage.get(t.storage_key)).toBeNull();
  }
  expect(events.filter((e) => e.type === "asset_deleted")).toHaveLength(1);
});
