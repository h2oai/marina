// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { Engine } from "../src/engine/engine";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { DashboardBroadcaster, type DashboardWSData } from "../src/net/dashboard-ws";
import { FeedPublisher } from "../src/net/feed-publisher";
import { MarinaDB } from "../src/persistence/database";
import { type EngineEvent, type EntityId, roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

let directory: string;
let db: MarinaDB;
let engine: Engine;
let alice: ReturnType<Engine["login"]> & { entityId: string; token: string };
let bob: typeof alice;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "marina-observer-"));
  db = new MarinaDB(join(directory, "test.db"));
  engine = new Engine({ db, startRoom: roomId("test/start") });
  engine.registerRoom(roomId("test/start"), makeTestRoom());
  const login = (name: string) => {
    const connection = new MockConnection(name);
    engine.addConnection(connection);
    const session = engine.login(connection.id, name);
    if ("error" in session) throw new Error(session.error);
    return session;
  };
  alice = login("Alice");
  bob = login("Bob");
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true });
});
async function get(path: string, actor = bob, method = "GET", body?: unknown) {
  const url = new URL(path, "http://test.invalid");
  const response = await handleDashboardApi(
    new Request(url, {
      method,
      headers: { Authorization: `Bearer ${actor.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    url,
    method,
    engine,
    db,
  );
  if (!response) throw new Error("Unhandled route");
  return { status: response.status, data: await response.json() };
}

it("filters graph, hydrated links and sources before returning another resident's memory", async () => {
  const secret = db.createNote("Alice", "PRIVATE_SENTINEL");
  const own = db.createNote("Bob", "owned note");
  db.createNoteLink(own, secret, "related_to");
  db.addNoteSource(own, {
    url: `note:${secret}`,
    sourceNoteId: secret,
    excerpt: "PRIVATE_SENTINEL",
  });
  expect(JSON.stringify((await get("/api/graph")).data)).not.toContain("PRIVATE_SENTINEL");
  const detail = await get(`/api/notes/${own}`);
  expect(detail.data.links).toEqual([]);
  expect(detail.data.sources).toEqual([]);
  expect((await get(`/api/notes/${secret}`)).status).toBe(403);
});

it("revokes group notes on direct, owner-list, graph and pool-list routes", async () => {
  db.createGroup({ id: "team", name: "team", leaderId: alice.entityId });
  db.addGroupMember("team", bob.entityId);
  db.createMemoryPool("restricted", "restricted", "Alice", "team");
  const id = db.addPoolNote("restricted", "Bob", "REVOKED_SENTINEL");
  expect((await get(`/api/notes/${id}`)).status).toBe(200);
  db.removeGroupMember("team", bob.entityId);
  expect((await get(`/api/notes/${id}`)).status).toBe(403);
  for (const path of [
    "/api/memory/notes/Bob",
    "/api/memory/graph/Bob",
    "/api/graph",
    "/api/entities/Bob",
  ]) {
    expect(JSON.stringify((await get(path)).data)).not.toContain("REVOKED_SENTINEL");
  }
  expect((await get("/api/memory/pools")).data).toEqual([]);
});

it("filters live memory events per reader and stops automatic public copying", () => {
  const broadcaster = new DashboardBroadcaster();
  const ownMessages: string[] = [];
  const otherMessages: string[] = [];
  for (const [principal, sink] of [
    [alice.entityId, ownMessages],
    [bob.entityId, otherMessages],
  ] as const) {
    broadcaster.addClient(
      {
        data: { connId: principal, isDashboard: true, principal },
        send: (message: string) => sink.push(message),
      } as unknown as ServerWebSocket<DashboardWSData>,
      engine,
    );
  }
  const id = db.createNote("Alice", "PRIVATE_LIVE_SENTINEL", undefined, { importance: 9 });
  const event: EngineEvent = {
    type: "note_created",
    entity: alice.entityId as EntityId,
    authorName: "Alice",
    noteId: id,
    content: "PRIVATE_LIVE_SENTINEL",
    importance: 9,
    noteType: "fact",
    timestamp: 1,
  };
  broadcaster.broadcastEvent(event);
  expect(ownMessages.join("")).toContain("PRIVATE_LIVE_SENTINEL");
  expect(otherMessages.join("")).not.toContain("PRIVATE_LIVE_SENTINEL");
  const publisher = new FeedPublisher({ db, resolveEntity: () => "Alice" });
  publisher.handleEvent(event);
  expect(db.queryFeedEvents()).toEqual([]);
  db.insertFeedEvent({ kind: "note_created", ref: `note:${id}`, summary: "PRIVATE_LIVE_SENTINEL" });
  expect(db.queryFeedEvents()).toEqual([]);
});

it("keeps raw operational bodies and cross-author adjudication behind their authority", async () => {
  for (const path of ["/api/traces", "/api/logs", "/api/evidence/receipts"])
    expect((await get(path)).status).toBe(403);
  db.createMemoryPool("public", "public", "Alice");
  const a = db.addPoolNote("public", "Alice", "approval is required");
  db.addPoolNote("public", "Bob", "approval is not required");
  db.refreshContradictionCases();
  const conflict = db.listContradictionCases("open")[0]!;
  expect(
    (
      await get(`/api/memory/contradictions/${conflict.id}/resolve`, bob, "POST", {
        resolution: "right",
        rationale: "unsupported claim",
      })
    ).status,
  ).toBe(404);
  expect(db.getNote(a)?.verification_status).toBe("unverified");
});
