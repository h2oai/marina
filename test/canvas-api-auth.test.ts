// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { listRaisedBy, resetChallengesForTests } from "../src/engine/challenges";
import { Engine } from "../src/engine/engine";
import { grant } from "../src/engine/safety-gates";
import { handleCanvasApi } from "../src/net/canvas/canvas-api";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, tempDbPath } from "./helpers";
import { scopeProcessState } from "./process-state";

const TEST_DB = tempDbPath("test_canvas_api_auth.db");

function req(path: string, method: string, token?: string, body?: unknown): [URL, string, Request] {
  const url = new URL(`http://localhost:3300${path}`);
  const r = new Request(url.toString(), {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return [url, method, r];
}

describe("canvas API auth contract", () => {
  let db: MarinaDB;
  let engine: Engine;

  beforeEach(() => {
    // MARINA_OPEN_API must be off — the whole point is fresh, unauthenticated
    // viewing without the dev bypass.
    delete process.env.MARINA_OPEN_API;
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("allows GET reads without a session token (fresh open must not 401)", async () => {
    const [url, method, r] = req("/api/canvases", "GET");
    const resp = await handleCanvasApi(url, method, r, db, undefined, undefined, engine);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  it("still requires a token for mutations (POST create)", async () => {
    const [url, method, r] = req("/api/canvases", "POST");
    const resp = await handleCanvasApi(url, method, r, db, undefined, undefined, engine);
    expect(resp.status).toBe(401);
  });

  it("attributes authenticated writes to the session identity, not spoofed names", async () => {
    const connection = new MockConnection("canvas-writer");
    engine.addConnection(connection);
    const login = engine.login(connection.id, "Alice");
    if (!("token" in login)) throw new Error("login failed");
    db.createCanvas({ id: "canvas-auth", name: "auth", creatorName: "system" });

    const [nodeUrl, nodeMethod, nodeReq] = req(
      "/api/canvases/canvas-auth/nodes",
      "POST",
      login.token,
      { type: "text", creator_name: "Mallory", data: { content: "owned" } },
    );
    const nodeResp = await handleCanvasApi(
      nodeUrl,
      nodeMethod,
      nodeReq,
      db,
      undefined,
      undefined,
      engine,
    );
    expect(nodeResp.status).toBe(201);
    const created = (await nodeResp.json()) as { id: string; creator_name: string };
    expect(created.creator_name).toBe("Alice");

    db.createNode({
      id: "intent-auth",
      canvasId: "canvas-auth",
      type: "text",
      creatorName: "Requester",
      data: { intent: { status: "pending", prompt: "Do it" } },
    });
    const [claimUrl, claimMethod, claimReq] = req(
      "/api/canvases/canvas-auth/nodes/intent-auth/intent/claim",
      "POST",
      login.token,
      { actorName: "Mallory" },
    );
    const claimResp = await handleCanvasApi(
      claimUrl,
      claimMethod,
      claimReq,
      db,
      undefined,
      undefined,
      engine,
    );
    expect(claimResp.status).toBe(200);
    expect(JSON.parse(db.getNode("intent-auth")!.data).intent.claimedBy).toBe("Alice");
  });

  it("accepts pre-stringified node data on PATCH without double encoding", async () => {
    db.createCanvas({ id: "canvas-1", name: "requests", creatorName: "Tester" });
    db.createNode({
      id: "node-1",
      canvasId: "canvas-1",
      type: "text",
      creatorName: "Tester",
      data: { content: "old" },
    });

    const data = JSON.stringify({
      content: "new",
      intent: { status: "pending", prompt: "Handle this." },
    });
    const [url, method, r] = req("/api/canvases/canvas-1/nodes/node-1", "PATCH", undefined, {
      data,
    });
    const resp = await handleCanvasApi(url, method, r, db);

    expect(resp.status).toBe(200);
    const stored = JSON.parse(db.getNode("node-1")!.data);
    expect(stored.content).toBe("new");
    expect(stored.intent.prompt).toBe("Handle this.");
  });

  it("refuses cross-canvas node mutation and deletion", async () => {
    db.createCanvas({ id: "canvas-a", name: "a", creatorName: "Tester" });
    db.createCanvas({ id: "canvas-b", name: "b", creatorName: "Tester" });
    db.createNode({
      id: "node-b",
      canvasId: "canvas-b",
      type: "text",
      creatorName: "Tester",
      data: { content: "protected" },
    });

    const [patchUrl, patchMethod, patchReq] = req(
      "/api/canvases/canvas-a/nodes/node-b",
      "PATCH",
      undefined,
      { data: { content: "wrong canvas" } },
    );
    const patchResp = await handleCanvasApi(patchUrl, patchMethod, patchReq, db);
    expect(patchResp.status).toBe(404);
    expect(JSON.parse(db.getNode("node-b")!.data).content).toBe("protected");

    const [deleteUrl, deleteMethod, deleteReq] = req(
      "/api/canvases/canvas-a/nodes/node-b",
      "DELETE",
    );
    const deleteResp = await handleCanvasApi(deleteUrl, deleteMethod, deleteReq, db);
    expect(deleteResp.status).toBe(404);
    expect(db.getNode("node-b")).toBeDefined();
  });

  it("rejects unsupported render types and cross-canvas reply parents", async () => {
    db.createCanvas({ id: "canvas-a", name: "a", creatorName: "Tester" });
    db.createCanvas({ id: "canvas-b", name: "b", creatorName: "Tester" });
    db.createNode({
      id: "parent-b",
      canvasId: "canvas-b",
      type: "text",
      creatorName: "Tester",
    });

    const [typeUrl, typeMethod, typeReq] = req("/api/canvases/canvas-a/nodes", "POST", undefined, {
      type: "nonexistent-widget",
      data: { content: "invisible" },
    });
    const typeResp = await handleCanvasApi(typeUrl, typeMethod, typeReq, db);
    expect(typeResp.status).toBe(400);

    const [parentUrl, parentMethod, parentReq] = req(
      "/api/canvases/canvas-a/nodes",
      "POST",
      undefined,
      { type: "text", parent_node_id: "parent-b", data: { content: "orphan" } },
    );
    const parentResp = await handleCanvasApi(parentUrl, parentMethod, parentReq, db);
    expect(parentResp.status).toBe(400);
    expect(db.getNodesByCanvas("canvas-a")).toHaveLength(0);
  });

  it("claims and completes intents through first-class action endpoints", async () => {
    db.createCanvas({ id: "canvas-1", name: "requests", creatorName: "Requester" });
    db.createNode({
      id: "node-intent-1",
      canvasId: "canvas-1",
      type: "text",
      creatorName: "Requester",
      data: {
        intent: { status: "pending", prompt: "Handle this." },
      },
    });

    const [claimUrl, claimMethod, claimReq] = req(
      "/api/canvases/canvas-1/nodes/node-intent-1/intent/claim",
      "POST",
      undefined,
      { actorName: "Worker" },
    );
    const claimResp = await handleCanvasApi(claimUrl, claimMethod, claimReq, db);
    expect(claimResp.status).toBe(200);
    // With no authenticated identity the action is "api"; a body name never decides it.
    expect(JSON.parse(db.getNode("node-intent-1")!.data).intent.claimedBy).toBe("api");

    const [_claimUrl2, _claimMethod2, claimReq2] = req(
      "/api/canvases/canvas-1/nodes/node-intent-1/intent/claim",
      "POST",
      undefined,
      { actorName: "Other" },
    );
    const claimResp2 = await handleCanvasApi(claimUrl, claimMethod, claimReq2, db);
    expect(claimResp2.status).toBe(409);

    const [completeUrl, completeMethod, completeReq] = req(
      "/api/canvases/canvas-1/nodes/node-intent-1/intent/complete",
      "POST",
      undefined,
      { actorName: "Worker", result: "Done", type: "text" },
    );
    const completeResp = await handleCanvasApi(completeUrl, completeMethod, completeReq, db);
    expect(completeResp.status).toBe(200);
    const body = (await completeResp.json()) as { resultNode: { id: string } };
    const stored = JSON.parse(db.getNode("node-intent-1")!.data);
    expect(stored.intent.status).toBe("done");
    expect(stored.intent.resultNodeId).toBe(body.resultNode.id);
    expect(db.getNode(body.resultNode.id)?.parent_node_id).toBe("node-intent-1");
  });

  // ─── Private per-entity canvas HTTP read scoping (Finding: unauth GET leak) ──
  describe("private per-entity canvas read scoping over HTTP GET", () => {
    const loginEntity = (connId: string, name: string): { entityId: string; token: string } => {
      const conn = new MockConnection(connId);
      engine.addConnection(conn);
      const login = engine.login(conn.id, name);
      if (!("token" in login)) throw new Error(`login failed for ${name}`);
      return { entityId: login.entityId as string, token: login.token };
    };

    // handleCanvasApi's last arg is the REAL socket peer IP (loopback trust anchor).
    const call = (
      path: string,
      method: string,
      token?: string,
      peerIp?: string,
    ): Promise<Response> => {
      const [url, m, r] = req(path, method, token);
      return handleCanvasApi(url, m, r, db, undefined, undefined, engine, undefined, peerIp);
    };

    it("denies anonymous remote GET of a private per-entity canvas (404, no leak)", async () => {
      const alice = loginEntity("c-alice", "Alice");
      db.createCanvas({
        id: "priv-alice",
        name: "alice private",
        scope: "entity",
        scopeId: alice.entityId,
        creatorName: "Alice",
      });
      // No token, remote peer → private canvas invisible.
      const resp = await call("/api/canvases/priv-alice", "GET", undefined, "203.0.113.9");
      expect(resp.status).toBe(404);
    });

    it("denies a non-owner authenticated GET of a private canvas (404)", async () => {
      const alice = loginEntity("c-alice", "Alice");
      const bob = loginEntity("c-bob", "Bob");
      db.createCanvas({
        id: "priv-alice",
        name: "alice private",
        scope: "entity",
        scopeId: alice.entityId,
        creatorName: "Alice",
      });
      const resp = await call("/api/canvases/priv-alice", "GET", bob.token, "203.0.113.9");
      expect(resp.status).toBe(404);
    });

    it("allows the owner to GET their own private canvas", async () => {
      const alice = loginEntity("c-alice", "Alice");
      db.createCanvas({
        id: "priv-alice",
        name: "alice private",
        scope: "entity",
        scopeId: alice.entityId,
        creatorName: "Alice",
      });
      const resp = await call("/api/canvases/priv-alice", "GET", alice.token, "203.0.113.9");
      expect(resp.status).toBe(200);
    });

    it("allows the zero-config LOOPBACK desktop reader to GET a private canvas", async () => {
      const alice = loginEntity("c-alice", "Alice");
      db.createCanvas({
        id: "priv-alice",
        name: "alice private",
        scope: "entity",
        scopeId: alice.entityId,
        creatorName: "Alice",
      });
      // No token, but a genuine loopback peer → operator-equivalent local reader.
      const resp = await call("/api/canvases/priv-alice", "GET", undefined, "127.0.0.1");
      expect(resp.status).toBe(200);
    });

    it("keeps PUBLIC/shared canvases readable by an anonymous remote reader", async () => {
      db.createCanvas({ id: "pub", name: "public", scope: "global", creatorName: "system" });
      const resp = await call("/api/canvases/pub", "GET", undefined, "203.0.113.9");
      expect(resp.status).toBe(200);
    });

    it("filters ?scope=entity list to the caller's own private canvases", async () => {
      const alice = loginEntity("c-alice", "Alice");
      const bob = loginEntity("c-bob", "Bob");
      db.createCanvas({
        id: "priv-alice",
        name: "alice private",
        scope: "entity",
        scopeId: alice.entityId,
        creatorName: "Alice",
      });
      db.createCanvas({
        id: "priv-bob",
        name: "bob private",
        scope: "entity",
        scopeId: bob.entityId,
        creatorName: "Bob",
      });

      // Anonymous remote: sees no private canvases.
      const anon = await call("/api/canvases?scope=entity", "GET", undefined, "203.0.113.9");
      expect(((await anon.json()) as unknown[]).length).toBe(0);

      // Alice: sees only her own.
      const aliceResp = await call("/api/canvases?scope=entity", "GET", alice.token, "203.0.113.9");
      const aliceList = (await aliceResp.json()) as Array<{ id: string }>;
      expect(aliceList.map((c) => c.id)).toEqual(["priv-alice"]);

      // Loopback desktop: operator-equivalent, sees all private canvases.
      const local = await call("/api/canvases?scope=entity", "GET", undefined, "127.0.0.1");
      const localList = (await local.json()) as Array<{ id: string }>;
      expect(localList.map((c) => c.id).sort()).toEqual(["priv-alice", "priv-bob"]);
    });

    it("denies anonymous GET of a node on a private canvas (404)", async () => {
      const alice = loginEntity("c-alice", "Alice");
      db.createCanvas({
        id: "priv-alice",
        name: "alice private",
        scope: "entity",
        scopeId: alice.entityId,
        creatorName: "Alice",
      });
      db.createNode({
        id: "secret-node",
        canvasId: "priv-alice",
        type: "text",
        creatorName: "Alice",
        data: { content: "secret" },
      });
      const resp = await call(
        "/api/canvases/priv-alice/nodes/secret-node",
        "GET",
        undefined,
        "203.0.113.9",
      );
      expect(resp.status).toBe(404);
    });
  });

  // ─── Private per-entity canvas HTTP MUTATION scoping (Finding: non-owner
  //     mutate/delete + intent lifecycle on a private canvas) ────────────────
  describe("private per-entity canvas mutation scoping over HTTP", () => {
    const loginEntity = (connId: string, name: string): { entityId: string; token: string } => {
      const conn = new MockConnection(connId);
      engine.addConnection(conn);
      const login = engine.login(conn.id, name);
      if (!("token" in login)) throw new Error(`login failed for ${name}`);
      return { entityId: login.entityId as string, token: login.token };
    };

    // Last arg is the REAL socket peer IP (loopback trust anchor).
    const call = (
      path: string,
      method: string,
      opts: { token?: string; peerIp?: string; body?: unknown } = {},
    ): Promise<Response> => {
      const [url, m, r] = req(path, method, opts.token, opts.body);
      return handleCanvasApi(url, m, r, db, undefined, undefined, engine, undefined, opts.peerIp);
    };

    const seedPrivate = (ownerEntityId: string): void => {
      db.createCanvas({
        id: "priv-alice",
        name: "alice private",
        scope: "entity",
        scopeId: ownerEntityId,
        creatorName: "Alice",
      });
      db.createNode({
        id: "priv-node",
        canvasId: "priv-alice",
        type: "text",
        creatorName: "Alice",
        data: { content: "secret", intent: { status: "pending", prompt: "do it" } },
      });
    };

    it("denies a non-owner authenticated PATCH of a private-canvas node (404, no mutation)", async () => {
      const alice = loginEntity("c-alice", "Alice");
      const bob = loginEntity("c-bob", "Bob");
      seedPrivate(alice.entityId);
      const resp = await call("/api/canvases/priv-alice/nodes/priv-node", "PATCH", {
        token: bob.token,
        peerIp: "203.0.113.9",
        body: { data: { content: "hijacked" } },
      });
      expect(resp.status).toBe(404);
      expect(JSON.parse(db.getNode("priv-node")!.data).content).toBe("secret");
    });

    it("denies a non-owner authenticated DELETE of a private-canvas node (404, node survives)", async () => {
      const alice = loginEntity("c-alice", "Alice");
      const bob = loginEntity("c-bob", "Bob");
      seedPrivate(alice.entityId);
      const resp = await call("/api/canvases/priv-alice/nodes/priv-node", "DELETE", {
        token: bob.token,
        peerIp: "203.0.113.9",
      });
      expect(resp.status).toBe(404);
      expect(db.getNode("priv-node")).toBeDefined();
    });

    it("denies a non-owner authenticated POST create on a private canvas (404)", async () => {
      const alice = loginEntity("c-alice", "Alice");
      const bob = loginEntity("c-bob", "Bob");
      seedPrivate(alice.entityId);
      const resp = await call("/api/canvases/priv-alice/nodes", "POST", {
        token: bob.token,
        peerIp: "203.0.113.9",
        body: { type: "text", data: { content: "intruder" } },
      });
      expect(resp.status).toBe(404);
    });

    it("denies a non-owner authenticated DELETE of a private canvas (404, canvas survives)", async () => {
      const alice = loginEntity("c-alice", "Alice");
      const bob = loginEntity("c-bob", "Bob");
      seedPrivate(alice.entityId);
      const resp = await call("/api/canvases/priv-alice", "DELETE", {
        token: bob.token,
        peerIp: "203.0.113.9",
      });
      expect(resp.status).toBe(404);
      expect(db.getCanvas("priv-alice")).toBeDefined();
    });

    it("denies a non-owner authenticated intent claim on a private canvas (404, no state change)", async () => {
      const alice = loginEntity("c-alice", "Alice");
      const bob = loginEntity("c-bob", "Bob");
      seedPrivate(alice.entityId);
      const resp = await call("/api/canvases/priv-alice/nodes/priv-node/intent/claim", "POST", {
        token: bob.token,
        peerIp: "203.0.113.9",
        body: { actorName: "Bob" },
      });
      expect(resp.status).toBe(404);
      expect(JSON.parse(db.getNode("priv-node")!.data).intent.status).toBe("pending");
      expect(JSON.parse(db.getNode("priv-node")!.data).intent.claimedBy).toBeUndefined();
    });

    it("allows the owner to PATCH their own private-canvas node", async () => {
      const alice = loginEntity("c-alice", "Alice");
      seedPrivate(alice.entityId);
      const resp = await call("/api/canvases/priv-alice/nodes/priv-node", "PATCH", {
        token: alice.token,
        peerIp: "203.0.113.9",
        body: { data: { content: "owner-edit" } },
      });
      expect(resp.status).toBe(200);
      expect(JSON.parse(db.getNode("priv-node")!.data).content).toBe("owner-edit");
    });

    it("allows the desktop operator credential to mutate a private-canvas node", async () => {
      const alice = loginEntity("c-alice", "Alice");
      seedPrivate(alice.entityId);
      // Mutations require auth (a bearer or the desktop capability token) — the
      // read-only loopback trust anchor does not apply to writes. The desktop
      // operator presents its X-Marina-Desktop-Token → operator principal.
      const prev = process.env.MARINA_DESKTOP_API_TOKEN;
      process.env.MARINA_DESKTOP_API_TOKEN = "desktop-operator-token-0123456789abcdef";
      try {
        const url = new URL("http://localhost:3300/api/canvases/priv-alice/nodes/priv-node");
        const r = new Request(url.toString(), {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Marina-Desktop-Token": "desktop-operator-token-0123456789abcdef",
          },
          body: JSON.stringify({ data: { content: "desktop-edit" } }),
        });
        const resp = await handleCanvasApi(
          url,
          "PATCH",
          r,
          db,
          undefined,
          undefined,
          engine,
          undefined,
          "127.0.0.1",
        );
        expect(resp.status).toBe(200);
        expect(JSON.parse(db.getNode("priv-node")!.data).content).toBe("desktop-edit");
      } finally {
        if (prev === undefined) delete process.env.MARINA_DESKTOP_API_TOKEN;
        else process.env.MARINA_DESKTOP_API_TOKEN = prev;
      }
    });

    it("keeps creating nodes on a PUBLIC canvas open to an authenticated writer", async () => {
      const alice = loginEntity("c-alice", "Alice");
      db.createCanvas({ id: "pub", name: "public", scope: "global", creatorName: "system" });
      const resp = await call("/api/canvases/pub/nodes", "POST", {
        token: alice.token,
        peerIp: "203.0.113.9",
        body: { type: "text", data: { content: "hi" } },
      });
      expect(resp.status).toBe(201);
    });
  });

  // ─── Entity-scoped canvas creation must be owned by the caller (Finding:
  //     scope:"entity" + foreign scope_id lets a caller own a victim's canvas) ─
  describe("entity-scoped canvas creation ownership", () => {
    const loginEntity = (connId: string, name: string): { entityId: string; token: string } => {
      const conn = new MockConnection(connId);
      engine.addConnection(conn);
      const login = engine.login(conn.id, name);
      if (!("token" in login)) throw new Error(`login failed for ${name}`);
      return { entityId: login.entityId as string, token: login.token };
    };

    const post = (token: string | undefined, body: unknown): Promise<Response> => {
      const [url, m, r] = req("/api/canvases", "POST", token, body);
      return handleCanvasApi(url, m, r, db, undefined, undefined, engine, undefined, "203.0.113.9");
    };

    it("rejects a scope:'entity' canvas targeting ANOTHER entity's scope_id (403)", async () => {
      const alice = loginEntity("c-alice", "Alice");
      const bob = loginEntity("c-bob", "Bob");
      const resp = await post(bob.token, {
        name: "poison-alice",
        scope: "entity",
        scope_id: alice.entityId,
      });
      expect(resp.status).toBe(403);
      // Nothing was created for Alice on Bob's behalf.
      expect(db.getCanvasByName("poison-alice")).toBeUndefined();
      expect(db.getEntityCanvas(alice.entityId)).toBeUndefined();
    });

    it("forces scope_id to the caller when omitted on a scope:'entity' create", async () => {
      const bob = loginEntity("c-bob", "Bob");
      const resp = await post(bob.token, { name: "bob-space", scope: "entity" });
      expect(resp.status).toBe(201);
      const created = (await resp.json()) as { scope: string; scope_id: string };
      expect(created.scope).toBe("entity");
      expect(created.scope_id).toBe(bob.entityId);
    });

    it("normalizes a self-targeted scope:'entity' create to the caller (allowed)", async () => {
      const bob = loginEntity("c-bob", "Bob");
      const resp = await post(bob.token, {
        name: "bob-own",
        scope: "entity",
        scope_id: bob.entityId,
      });
      expect(resp.status).toBe(201);
      const created = (await resp.json()) as { scope_id: string };
      expect(created.scope_id).toBe(bob.entityId);
    });

    it("leaves global/shared canvas creation unaffected", async () => {
      const bob = loginEntity("c-bob", "Bob");
      const resp = await post(bob.token, { name: "shared-space", scope: "global" });
      expect(resp.status).toBe(201);
      const created = (await resp.json()) as { scope: string };
      expect(created.scope).toBe("global");
    });
  });

  describe("typed relationship mutations", () => {
    it("creates and deletes same-canvas relationships through the authenticated API", async () => {
      const connection = new MockConnection("edge-writer");
      engine.addConnection(connection);
      const login = engine.login(connection.id, "Alice");
      if (!("token" in login)) throw new Error("login failed");
      db.createCanvas({ id: "edge-canvas", name: "edges", creatorName: "system" });
      for (const id of ["source", "target"]) {
        db.createNode({ id, canvasId: "edge-canvas", type: "text", creatorName: "system" });
      }

      const [createUrl, createMethod, createReq] = req(
        "/api/canvases/edge-canvas/edges",
        "POST",
        login.token,
        { sourceId: "source", targetId: "target", relationship: "supports" },
      );
      const createdResponse = await handleCanvasApi(
        createUrl,
        createMethod,
        createReq,
        db,
        undefined,
        undefined,
        engine,
      );
      expect(createdResponse.status).toBe(201);
      const created = (await createdResponse.json()) as { id: string; creatorName: string };
      expect(created.creatorName).toBe("Alice");
      expect(db.getCanvasEdges("edge-canvas")).toHaveLength(1);

      const [deleteUrl, deleteMethod, deleteReq] = req(
        `/api/canvases/edge-canvas/edges/${created.id}`,
        "DELETE",
        login.token,
      );
      const deletedResponse = await handleCanvasApi(
        deleteUrl,
        deleteMethod,
        deleteReq,
        db,
        undefined,
        undefined,
        engine,
      );
      expect(deletedResponse.status).toBe(200);
      expect(db.getCanvasEdges("edge-canvas")).toHaveLength(0);
    });

    it("rejects self, unsupported, and cross-canvas relationships", async () => {
      db.createCanvas({ id: "edge-a", name: "edge-a", creatorName: "system" });
      db.createCanvas({ id: "edge-b", name: "edge-b", creatorName: "system" });
      db.createNode({ id: "node-a", canvasId: "edge-a", type: "text", creatorName: "system" });
      db.createNode({ id: "node-b", canvasId: "edge-b", type: "text", creatorName: "system" });

      for (const body of [
        { sourceId: "node-a", targetId: "node-a", relationship: "supports" },
        { sourceId: "node-a", targetId: "node-b", relationship: "supports" },
        { sourceId: "node-a", targetId: "node-b", relationship: "arbitrary" },
      ]) {
        const [url, method, request] = req("/api/canvases/edge-a/edges", "POST", undefined, body);
        const response = await handleCanvasApi(url, method, request, db);
        expect(response.status).toBe(400);
      }
      expect(db.getCanvasEdges("edge-a")).toHaveLength(0);
    });
  });
});

describe("canvas API — sentinel writes, malformed bodies, mutation throttle", () => {
  let db: MarinaDB;
  let engine: Engine;
  const prevOpenApi = process.env.MARINA_OPEN_API;
  let connCounter = 0;

  beforeEach(() => {
    delete process.env.MARINA_OPEN_API;
    resetHttpRateLimitersForTests();
    db = new MarinaDB(`${TEST_DB}.hardening`);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
  });

  afterEach(() => {
    if (prevOpenApi === undefined) delete process.env.MARINA_OPEN_API;
    else process.env.MARINA_OPEN_API = prevOpenApi;
    db.close();
    cleanupDb(`${TEST_DB}.hardening`);
    resetHttpRateLimitersForTests();
  });

  function loginToken(name: string): string {
    const conn = new MockConnection(`canvas-h-${connCounter++}`);
    engine.addConnection(conn);
    const login = engine.login(conn.id, name);
    if ("error" in login) throw new Error(login.error);
    return login.token;
  }

  it("refuses canvas mutations from the MARINA_OPEN_API sentinel with 403", async () => {
    process.env.MARINA_OPEN_API = "true";
    const [url, method, r] = req("/api/canvases", "POST", undefined, { name: "sentinel-made" });
    const resp = await handleCanvasApi(url, method, r, db, undefined, undefined, engine);
    expect(resp.status).toBe(403);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toContain("MARINA_OPEN_API");
    expect(db.getCanvasByName("sentinel-made")).toBeUndefined();

    // A real token on the same dev-open server still writes.
    const token = loginToken("RealWriter");
    const [u2, m2, r2] = req("/api/canvases", "POST", token, { name: "token-made" });
    expect((await handleCanvasApi(u2, m2, r2, db, undefined, undefined, engine)).status).toBe(201);
  });

  it("answers malformed JSON with 400 instead of throwing into the server", async () => {
    const token = loginToken("Malformed");
    const url = new URL("http://localhost:3300/api/canvases");
    const r = new Request(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{ not json",
    });
    const resp = await handleCanvasApi(url, "POST", r, db, undefined, undefined, engine);
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: string }).error).toContain("Invalid JSON");

    // An array body is not an object body either.
    const [u2, m2, r2] = req("/api/canvases", "POST", token, [1, 2]);
    expect((await handleCanvasApi(u2, m2, r2, db, undefined, undefined, engine)).status).toBe(400);
  });

  it("rate-limits mutations per principal (30 / 10 s)", async () => {
    const token = loginToken("CanvasFlood");
    let limited = false;
    for (let i = 0; i < 31; i++) {
      const [u, m, r] = req(`/api/canvases/nope-${i}`, "DELETE", token);
      const resp = await handleCanvasApi(u, m, r, db, undefined, undefined, engine);
      if (resp.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });
});

describe("canvas API — removals and edits follow the in-world ownership rule", () => {
  let db: MarinaDB;
  let engine: Engine;
  let connCounter = 0;
  const DB = `${TEST_DB}.ownership`;

  beforeEach(() => {
    delete process.env.MARINA_OPEN_API;
    resetHttpRateLimitersForTests();
    resetChallengesForTests();
    db = new MarinaDB(DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    // Bob's shared canvas: one node and one relationship, all authored by Bob.
    db.createCanvas({ id: "shared", name: "shared", scope: "global", creatorName: "Bob" });
    for (const id of ["n1", "n2"]) {
      db.createNode({
        id,
        canvasId: "shared",
        type: "text",
        creatorName: "Bob",
        data: { content: id },
      });
    }
    db.createCanvasEdge({
      id: "e1",
      canvasId: "shared",
      sourceId: "n1",
      targetId: "n2",
      relationship: "supports",
      creatorName: "Bob",
    });
  });

  afterEach(() => {
    resetChallengesForTests();
    db.close();
    cleanupDb(DB);
    resetHttpRateLimitersForTests();
  });

  function login(name: string): { entityId: EntityId; token: string } {
    const conn = new MockConnection(`canvas-own-${connCounter++}`);
    engine.addConnection(conn);
    const result = engine.login(conn.id, name);
    if ("error" in result) throw new Error(result.error);
    return { entityId: result.entityId as EntityId, token: result.token };
  }

  const call = (path: string, method: string, token: string, body?: unknown) => {
    const [url, m, r] = req(path, method, token, body);
    return handleCanvasApi(url, m, r, db, undefined, undefined, engine, undefined, "203.0.113.9");
  };

  const destructive: Array<[string, string, string, unknown?]> = [
    ["delete canvas", "/api/canvases/shared", "DELETE"],
    ["delete node", "/api/canvases/shared/nodes/n1", "DELETE"],
    ["edit node", "/api/canvases/shared/nodes/n1", "PATCH", { x: 500 }],
    ["delete relationship", "/api/canvases/shared/edges/e1", "DELETE"],
  ];

  const unchanged = () => {
    expect(db.getCanvas("shared")).toBeDefined();
    expect(db.getNode("n1")?.x).not.toBe(500);
    expect(db.getCanvasEdge("e1")).toBeDefined();
  };

  for (const [label, path, method, body] of destructive) {
    it(`refuses a non-owner (${label}) with 403 and the reason`, async () => {
      const mallory = login("Mallory");
      const resp = await call(path, method, mallory.token, body);
      expect(resp.status).toBe(403);
      const out = (await resp.json()) as { error: string; code: string };
      expect(out.code).toBe("not_owner");
      expect(out.error).toMatch(/Only the .*or an admin can/);
      unchanged();
    });

    it(`lets the owner act (${label})`, async () => {
      const bob = login("Bob");
      const resp = await call(path, method, bob.token, body);
      expect(resp.status).toBe(200);
    });

    it(`lets an admin act (${label})`, async () => {
      const admin = login("Admin");
      engine.entities.get(admin.entityId)!.properties.rank = 9;
      const resp = await call(path, method, admin.token, body);
      expect(resp.status).toBe(200);
    });

    it(`lets a holder of the operator gate act (${label})`, async () => {
      const op = login("Operator");
      grant(db, op.entityId, "admin.destructive");
      const resp = await call(path, method, op.token, body);
      expect(resp.status).toBe(200);
    });
  }

  it("lets the canvas owner remove another author's node and relationship", async () => {
    db.createNode({ id: "n3", canvasId: "shared", type: "text", creatorName: "Carol" });
    const bob = login("Bob");
    expect((await call("/api/canvases/shared/nodes/n3", "DELETE", bob.token)).status).toBe(200);
  });

  it("lets a node's author change it on someone else's canvas", async () => {
    db.createNode({ id: "n4", canvasId: "shared", type: "text", creatorName: "Carol" });
    const carol = login("Carol");
    const resp = await call("/api/canvases/shared/nodes/n4", "PATCH", carol.token, { x: 7 });
    expect(resp.status).toBe(200);
    expect(db.getNode("n4")?.x).toBe(7);
  });

  it("raises the same challenge as `canvas delete` when a non-owner deletes a canvas", async () => {
    const mallory = login("Mallory");
    const resp = await call("/api/canvases/shared", "DELETE", mallory.token);
    expect(resp.status).toBe(403);
    const held = listRaisedBy(mallory.entityId);
    expect(held.map((c) => c.command)).toContain("canvas delete shared");
    const edge = await call("/api/canvases/shared/edges/e1", "DELETE", mallory.token);
    expect(edge.status).toBe(403);
    expect(listRaisedBy(mallory.entityId).map((c) => c.command)).toContain("canvas disconnect e1");
  });

  it("keeps creating nodes on a shared canvas open to any signed-in writer", async () => {
    const mallory = login("Mallory");
    const resp = await call("/api/canvases/shared/nodes", "POST", mallory.token, {
      type: "text",
      data: { content: "hello" },
    });
    expect(resp.status).toBe(201);
  });

  it("lets anyone act where ownership is not enforced (local profile)", async () => {
    using _state = scopeProcessState({
      trustProfile: "local",
      env: { MARINA_AUTONOMY: undefined },
    });
    const mallory = login("Mallory");
    expect((await call("/api/canvases/shared/edges/e1", "DELETE", mallory.token)).status).toBe(200);
    expect((await call("/api/canvases/shared", "DELETE", mallory.token)).status).toBe(200);
  });

  it("keeps entity-scoped canvases private to their owner", async () => {
    const alice = login("Alice");
    const bob = login("Bob");
    db.createCanvas({
      id: "alice-own",
      name: "alice-own",
      scope: "entity",
      scopeId: alice.entityId,
      creatorName: "Alice",
    });
    expect((await call("/api/canvases/alice-own", "DELETE", bob.token)).status).toBe(404);
    expect((await call("/api/canvases/alice-own", "DELETE", alice.token)).status).toBe(200);
  });

  it("attributes intent actions and intent events to the signed-in caller, not the body", async () => {
    const bob = login("Bob");
    const events: Array<{ type: string; entity: string }> = [];
    engine.addEventListener((event) => events.push(event as { type: string; entity: string }));
    const resp = await call("/api/canvases/shared/nodes/n1", "PATCH", bob.token, {
      data: { intent: { prompt: "Draw", status: "active", claimedBy: "Mallory" } },
    });
    expect(resp.status).toBe(200);
    const intentEvent = events.find((e) => e.type === "canvas_intent");
    expect(intentEvent?.entity).toBe(bob.entityId);

    db.createNode({
      id: "pending",
      canvasId: "shared",
      type: "text",
      creatorName: "Bob",
      data: { intent: { prompt: "Do", status: "pending" } },
    });
    const carol = login("Carol");
    const claim = await call(
      "/api/canvases/shared/nodes/pending/intent/claim",
      "POST",
      carol.token,
      {
        actorName: "Mallory",
        claimantName: "Mallory",
      },
    );
    expect(claim.status).toBe(200);
    expect(JSON.parse(db.getNode("pending")!.data).intent.claimedBy).toBe("Carol");
  });
});

describe("canvas API — read budget", () => {
  let db: MarinaDB;
  let engine: Engine;
  const DB = `${TEST_DB}.reads`;

  beforeEach(() => {
    delete process.env.MARINA_OPEN_API;
    resetHttpRateLimitersForTests();
    db = new MarinaDB(DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
  });

  afterEach(() => {
    db.close();
    cleanupDb(DB);
    resetHttpRateLimitersForTests();
  });

  const anonymousGet = (path: string, peerIp: string) => {
    const [url, m, r] = req(path, "GET");
    return handleCanvasApi(url, m, r, db, undefined, undefined, engine, undefined, peerIp);
  };

  it("limits anonymous reads per client IP and leaves other clients unaffected", async () => {
    let limited = false;
    for (let i = 0; i < 31; i++) {
      const resp = await anonymousGet("/api/canvases", "203.0.113.20");
      if (resp.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
    expect((await anonymousGet("/api/canvases", "203.0.113.21")).status).toBe(200);
  });

  it("lists canvas detail when one stored row is damaged", async () => {
    db.createCanvas({ id: "c", name: "c", creatorName: "system" });
    db.createNode({ id: "a", canvasId: "c", type: "text", creatorName: "system" });
    db.createNode({ id: "b", canvasId: "c", type: "text", creatorName: "system" });
    db.createCanvasEdge({
      id: "e",
      canvasId: "c",
      sourceId: "a",
      targetId: "b",
      relationship: "supports",
      creatorName: "system",
      data: { note: "x" },
    });
    const raw = (db as unknown as { db: { run(sql: string): unknown } }).db;
    raw.run("UPDATE canvas_nodes SET data = '{broken' WHERE id = 'a'");
    raw.run("UPDATE canvas_edges SET data = '{broken' WHERE id = 'e'");
    const resp = await anonymousGet("/api/canvases/c", "203.0.113.30");
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { nodes: unknown[]; edges: Array<{ data: unknown }> };
    expect(body.nodes).toHaveLength(2);
    expect(body.edges[0]?.data).toBeNull();
  });
});
