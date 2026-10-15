// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { handleMediaApi } from "../src/net/api/media-api";
import { handleModelApi } from "../src/net/model/model-api";
import type { MediaJobRow } from "../src/persistence/database";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_media_api_auth.db";

/** A fake server exposing the real socket peer IP (like Bun's `server.requestIP`). */
function peerServer(ip: string | undefined): { requestIP?: (req: Request) => { address: string } } {
  return ip === undefined ? {} : { requestIP: () => ({ address: ip }) };
}

function mediaRequest(body: unknown, token?: string): [URL, string, Request] {
  const url = new URL("http://localhost:3300/v1/media");
  const r = new Request(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return [url, "POST", r];
}

describe("media API canvas-write authorization", () => {
  let db: MarinaDB;
  let engine: Engine;
  let startJobCalls: Array<{ canvasId?: string; prompt: string }>;

  beforeEach(() => {
    // No dev bypass — the whole point is enforcing scope on an exposed instance.
    delete process.env.MARINA_OPEN_API;
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom());

    // Stub the media pipeline: record every startJob so we can prove the
    // authorization denial happens BEFORE the (async) canvas append is enqueued.
    startJobCalls = [];
    const now = Date.now();
    const fakeJob = (params: { canvasId?: string; prompt: string }): MediaJobRow => ({
      id: "job-1",
      type: "image",
      status: "succeeded",
      entity_name: "caller",
      entity_id: null,
      provider: "openai",
      model: "openai/gpt-image-1",
      prompt: params.prompt,
      options: JSON.stringify({ canvasId: params.canvasId ?? null }),
      error: null,
      asset_id: null,
      cost_estimate: null,
      provider_job_id: null,
      metadata: null,
      created_at: now,
      updated_at: now,
      completed_at: now,
    });
    (engine as unknown as { mediaManager: unknown }).mediaManager = {
      startJob: async (params: { canvasId?: string; prompt: string }) => {
        startJobCalls.push(params);
        return fakeJob(params);
      },
      getJob: () => undefined,
    };
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  const loginEntity = (connId: string, name: string): { entityId: string; token: string } => {
    const conn = new MockConnection(connId);
    engine.addConnection(conn);
    const login = engine.login(conn.id, name);
    if (!("token" in login)) throw new Error(`login failed for ${name}`);
    return { entityId: login.entityId as string, token: login.token };
  };

  it("denies an anonymous remote caller appending to another entity's PRIVATE canvas (404, no job)", async () => {
    const alice = loginEntity("c-alice", "Alice");
    db.createCanvas({
      id: "priv-alice",
      name: "alice private",
      scope: "entity",
      scopeId: alice.entityId,
      creatorName: "Alice",
    });
    const [url, method, r] = mediaRequest({
      type: "image",
      prompt: "sneak a node in",
      canvasId: "priv-alice",
      entityName: "Alice", // spoofed body identity — must NOT grant access
    });
    const resp = await handleMediaApi(url, method, r, engine, peerServer("203.0.113.9"));
    expect(resp.status).toBe(404);
    // The async pipeline must never have been reached.
    expect(startJobCalls).toHaveLength(0);
  });

  it("denies a non-owner authenticated caller appending to a PRIVATE canvas (404, no job)", async () => {
    const alice = loginEntity("c-alice", "Alice");
    const bob = loginEntity("c-bob", "Bob");
    db.createCanvas({
      id: "priv-alice",
      name: "alice private",
      scope: "entity",
      scopeId: alice.entityId,
      creatorName: "Alice",
    });
    const [url, method, r] = mediaRequest(
      { type: "image", prompt: "hijack", canvasId: "priv-alice" },
      bob.token,
    );
    const resp = await handleMediaApi(url, method, r, engine, peerServer("203.0.113.9"));
    expect(resp.status).toBe(404);
    expect(startJobCalls).toHaveLength(0);
  });

  it("allows the OWNER to append to their own private canvas", async () => {
    const alice = loginEntity("c-alice", "Alice");
    db.createCanvas({
      id: "priv-alice",
      name: "alice private",
      scope: "entity",
      scopeId: alice.entityId,
      creatorName: "Alice",
    });
    const [url, method, r] = mediaRequest(
      { type: "image", prompt: "my own art", canvasId: "priv-alice" },
      alice.token,
    );
    const resp = await handleMediaApi(url, method, r, engine, peerServer("203.0.113.9"));
    expect(resp.status).toBe(200);
    expect(startJobCalls).toHaveLength(1);
    expect(startJobCalls[0]!.canvasId).toBe("priv-alice");
  });

  it("allows the zero-config LOOPBACK desktop caller to append to a private canvas (desktop flow preserved)", async () => {
    const alice = loginEntity("c-alice", "Alice");
    db.createCanvas({
      id: "priv-alice",
      name: "alice private",
      scope: "entity",
      scopeId: alice.entityId,
      creatorName: "Alice",
    });
    const [url, method, r] = mediaRequest({
      type: "image",
      prompt: "local desktop render",
      canvasId: "priv-alice",
    });
    const resp = await handleMediaApi(url, method, r, engine, peerServer("127.0.0.1"));
    expect(resp.status).toBe(200);
    expect(startJobCalls).toHaveLength(1);
  });

  it("allows an anonymous remote caller to append to a PUBLIC/shared canvas", async () => {
    db.createCanvas({ id: "pub", name: "public", scope: "global", creatorName: "system" });
    const [url, method, r] = mediaRequest({
      type: "image",
      prompt: "shared art",
      canvasId: "pub",
    });
    const resp = await handleMediaApi(url, method, r, engine, peerServer("203.0.113.9"));
    expect(resp.status).toBe(200);
    expect(startJobCalls).toHaveLength(1);
    expect(startJobCalls[0]!.canvasId).toBe("pub");
  });

  it("preserves existing behavior when canvasId is omitted (defaults to caller's own canvas downstream)", async () => {
    const [url, method, r] = mediaRequest({ type: "image", prompt: "no canvas specified" });
    const resp = await handleMediaApi(url, method, r, engine, peerServer("203.0.113.9"));
    expect(resp.status).toBe(200);
    expect(startJobCalls).toHaveLength(1);
    expect(startJobCalls[0]!.canvasId).toBeUndefined();
  });

  it("allows appending to a nonexistent canvasId (broadcasts nothing — nothing to leak)", async () => {
    const [url, method, r] = mediaRequest({
      type: "image",
      prompt: "ghost canvas",
      canvasId: "does-not-exist",
    });
    const resp = await handleMediaApi(url, method, r, engine, peerServer("203.0.113.9"));
    expect(resp.status).toBe(200);
    expect(startJobCalls).toHaveLength(1);
  });

  it("rejects an unauthenticated model-API caller with 401 before any media handling (fail-closed)", async () => {
    const prevKeys = process.env.MODEL_API_KEYS;
    delete process.env.MODEL_API_KEYS;
    delete process.env.MARINA_OPEN_API;
    try {
      const [url, method, r] = mediaRequest({
        type: "image",
        prompt: "no auth",
        canvasId: "pub",
      });
      const resp = await handleModelApi(
        url,
        method,
        r,
        engine,
        undefined,
        peerServer("203.0.113.9"),
      );
      expect(resp?.status).toBe(401);
      expect(startJobCalls).toHaveLength(0);
    } finally {
      if (prevKeys === undefined) delete process.env.MODEL_API_KEYS;
      else process.env.MODEL_API_KEYS = prevKeys;
    }
  });
});

describe("media API — acting identity is the authenticated caller", () => {
  let db: MarinaDB;
  let engine: Engine;
  let started: Array<{ entityId: string; entityName: string }>;
  let jobs: Map<string, MediaJobRow>;
  const prevKeys = process.env.MODEL_API_KEYS;

  beforeEach(() => {
    delete process.env.MARINA_OPEN_API;
    delete process.env.MODEL_API_KEYS;
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    started = [];
    jobs = new Map();
    let n = 0;
    (engine as unknown as { mediaManager: unknown }).mediaManager = {
      startJob: async (params: { entityId: string; entityName: string; prompt: string }) => {
        started.push({ entityId: params.entityId, entityName: params.entityName });
        const now = Date.now();
        const job: MediaJobRow = {
          id: `job-${++n}`,
          type: "image",
          status: "pending",
          entity_name: params.entityName,
          entity_id: params.entityId,
          provider: "openai",
          model: "openai/gpt-image-1",
          prompt: params.prompt,
          options: "{}",
          error: null,
          asset_id: null,
          cost_estimate: null,
          provider_job_id: null,
          metadata: null,
          created_at: now,
          updated_at: now,
          completed_at: null,
        };
        jobs.set(job.id, job);
        return job;
      },
      getJob: (id: string) => jobs.get(id),
    };
  });

  afterEach(() => {
    if (prevKeys === undefined) delete process.env.MODEL_API_KEYS;
    else process.env.MODEL_API_KEYS = prevKeys;
    db.close();
    cleanupDb(TEST_DB);
  });

  const login = (connId: string, name: string): { entityId: string; token: string } => {
    const conn = new MockConnection(connId);
    engine.addConnection(conn);
    const result = engine.login(conn.id, name);
    if (!("token" in result)) throw new Error(`login failed for ${name}`);
    return { entityId: result.entityId as string, token: result.token };
  };

  type MediaAuth = Parameters<typeof handleMediaApi>[5];
  const bound = (name: string): MediaAuth => ({
    internal: false,
    openMode: false,
    canNameMap: false,
    boundEntityName: name,
  });
  const INTERNAL: MediaAuth = { internal: true, openMode: false, canNameMap: true };

  const getJob = (id: string, auth?: MediaAuth, token?: string) => {
    const url = new URL(`http://localhost:3300/v1/media/${id}`);
    const r = new Request(url.toString(), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return handleMediaApi(url, "GET", r, engine, peerServer("203.0.113.9"), auth);
  };

  it("a bound key runs the job as its entity and refuses a body naming someone else (403)", async () => {
    const alice = login("c-alice", "Alice");
    login("c-bob", "Bob");
    process.env.MODEL_API_KEYS = "sk-alice-test:Alice";
    const peer = peerServer("198.51.100.4");

    const [url, method, spoof] = mediaRequest(
      { type: "image", prompt: "bill Bob", entityName: "Bob" },
      "sk-alice-test",
    );
    expect((await handleModelApi(url, method, spoof, engine, undefined, peer))?.status).toBe(403);
    const [, , byId] = mediaRequest(
      { type: "image", prompt: "bill someone", entityId: "e_someone_else" },
      "sk-alice-test",
    );
    expect((await handleModelApi(url, method, byId, engine, undefined, peer))?.status).toBe(403);
    expect(started).toHaveLength(0);

    const [, , own] = mediaRequest({ type: "image", prompt: "mine" }, "sk-alice-test");
    expect((await handleModelApi(url, method, own, engine, undefined, peer))?.status).toBe(202);
    expect(started).toEqual([{ entityId: alice.entityId, entityName: "Alice" }]);

    // Restating one's own name (any case) is accepted.
    const [, , restated] = mediaRequest(
      { type: "image", prompt: "mine again", entityName: "alice" },
      "sk-alice-test",
    );
    expect((await handleModelApi(url, method, restated, engine, undefined, peer))?.status).toBe(
      202,
    );
    expect(started[1]).toEqual({ entityId: alice.entityId, entityName: "Alice" });
  });

  it("an anonymous caller is `system` and cannot claim an entity in the body", async () => {
    login("c-alice", "Alice");
    const peer = peerServer("203.0.113.9");
    const [url, method, r] = mediaRequest({ type: "image", prompt: "x", entityName: "Alice" });
    expect((await handleMediaApi(url, method, r, engine, peer)).status).toBe(403);
    const [, , plain] = mediaRequest({ type: "image", prompt: "x" });
    expect((await handleMediaApi(url, method, plain, engine, peer)).status).toBe(202);
    expect(started).toEqual([{ entityId: "system", entityName: "system" }]);
  });

  it("a session bearer token acts as its entity", async () => {
    const bob = login("c-bob", "Bob");
    const [url, method, r] = mediaRequest({ type: "image", prompt: "x" }, bob.token);
    expect((await handleMediaApi(url, method, r, engine, peerServer("203.0.113.9"))).status).toBe(
      202,
    );
    expect(started).toEqual([{ entityId: bob.entityId, entityName: "Bob" }]);
  });

  it("the internal token may still act for a named entity", async () => {
    const alice = login("c-alice", "Alice");
    const [url, method, r] = mediaRequest({ type: "image", prompt: "x", entityName: "Alice" });
    const resp = await handleMediaApi(url, method, r, engine, peerServer("127.0.0.1"), INTERNAL);
    expect(resp.status).toBe(202);
    expect(started).toEqual([{ entityId: alice.entityId, entityName: "Alice" }]);
  });

  it("GET /v1/media/:id is visible to the owner and trusted callers only (404 otherwise)", async () => {
    login("c-alice", "Alice");
    const bob = login("c-bob", "Bob");
    const [url, method, r] = mediaRequest({ type: "image", prompt: "private" });
    const created = await handleMediaApi(
      url,
      method,
      r,
      engine,
      peerServer("198.51.100.4"),
      bound("Alice"),
    );
    const { id } = (await created.json()) as { id: string };

    expect((await getJob(id, bound("Alice"))).status).toBe(200);
    expect((await getJob(id, bound("Bob"))).status).toBe(404);
    expect((await getJob(id, undefined, bob.token)).status).toBe(404);
    expect((await getJob(id)).status).toBe(404);
    expect((await getJob(id, INTERNAL)).status).toBe(200);
    // Same body as a nonexistent id — no existence leak.
    const hidden = (await (await getJob(id, bound("Bob"))).json()) as { error: unknown };
    const missing = (await (await getJob("nope", bound("Bob"))).json()) as { error: unknown };
    expect(hidden.error).toEqual(missing.error);
  });
});
