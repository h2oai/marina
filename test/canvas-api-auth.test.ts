// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { handleCanvasApi } from "../src/net/canvas-api";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_canvas_api_auth.db";

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
    process.env.MARINA_OPEN_API = undefined;
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
    expect(JSON.parse(db.getNode("node-intent-1")!.data).intent.claimedBy).toBe("Worker");

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
});
