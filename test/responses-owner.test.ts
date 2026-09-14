// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ChannelManager } from "../src/coordination/channel-manager";
import { Engine } from "../src/engine/engine";
import { handleModelApi, pendingRequests, roundRobinCounters } from "../src/net/model-api";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_responses_owner.db";
const KEY_A = "sk-owner-a-key";
const KEY_B = "sk-owner-b-key";

function post(body: unknown, key: string): [URL, string, Request] {
  const url = new URL("http://localhost:3300/v1/responses");
  const req = new Request(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  return [url, "POST", req];
}

function get(path: string, key: string): [URL, string, Request] {
  const url = new URL(`http://localhost:3300${path}`);
  return [url, "GET", new Request(url.toString(), { headers: { Authorization: `Bearer ${key}` } })];
}

/** Agent that answers every model_request with a fixed line. */
function respondWith(cm: ChannelManager, entityId: string, name: string, text: string): void {
  cm.onMessage((channelId, senderId, _senderName, content) => {
    if (senderId !== "__model_api__") return;
    try {
      const parsed = JSON.parse(content);
      if (parsed.type === "model_request") {
        cm.send(
          channelId,
          entityId,
          name,
          JSON.stringify({ type: "model_response", id: parsed.id, content: text }),
        );
      }
    } catch {}
  });
}

/**
 * /v1/responses: an explicit `conversation_id` must belong to the caller, the
 * same way `previous_response_id` does. Caller B must not be able to read or
 * append to caller A's conversation by guessing/observing its id.
 */
describe("/v1/responses conversation_id ownership", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let cm: ChannelManager;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    delete process.env.MARINA_OPEN_API;
    process.env.MODEL_API_KEYS = `${KEY_A},${KEY_B}`;
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Agent1");
    cm = engine.channelManager!;
    engine.processCommand(conn.entity!, "channel join model");
    respondWith(cm, conn.entity!, "Agent1", "answer");
    roundRobinCounters.clear();
    pendingRequests.clear();
  });

  afterEach(() => {
    delete process.env.MODEL_API_KEYS;
    engine.shutdown();
    db.close();
    cleanupDb(TEST_DB);
  });

  it("caller B cannot append to or read caller A's conversation via conversation_id", async () => {
    const first = await handleModelApi(...post({ model: "marina", input: "hello" }, KEY_A), engine);
    expect(first!.status).toBe(200);
    const convA = first!.headers.get("X-Conversation-Id")!;
    const recA = await first!.json();
    expect(convA).toBeTruthy();

    // B tries to thread onto A's conversation by id → 404 (not-found === not-owned).
    const hijack = await handleModelApi(
      ...post({ model: "marina", input: "leak it", conversation_id: convA }, KEY_B),
      engine,
    );
    expect(hijack!.status).toBe(404);
    expect((await hijack!.json()).error.message).toContain("conversation_id not found");

    // A's channel history is untouched by B's attempt.
    const ch = cm.getChannelByName(`model-conv-${convA}`)!;
    const history = cm.getHistory(ch.id, 50).map((m) => m.content);
    expect(history.some((c) => c.includes("leak it"))).toBe(false);

    // B also cannot read A's response record.
    const read = await handleModelApi(...get(`/v1/responses/${recA.id}`, KEY_B), engine);
    expect(read!.status).toBe(404);

    // A can keep threading with the explicit id.
    const cont = await handleModelApi(
      ...post({ model: "marina", input: "follow up", conversation_id: convA }, KEY_A),
      engine,
    );
    expect(cont!.status).toBe(200);
    expect(cont!.headers.get("X-Conversation-Id")).toBe(convA);
  });

  it("a never-seen conversation_id can be claimed by any caller, then belongs to them", async () => {
    const fresh = `fresh-${crypto.randomUUID()}`;
    const claim = await handleModelApi(
      ...post({ model: "marina", input: "start", conversation_id: fresh }, KEY_B),
      engine,
    );
    expect(claim!.status).toBe(200);
    expect(claim!.headers.get("X-Conversation-Id")).toBe(fresh);

    const steal = await handleModelApi(
      ...post({ model: "marina", input: "mine now", conversation_id: fresh }, KEY_A),
      engine,
    );
    expect(steal!.status).toBe(404);
  });

  it("a conversation whose channel exists but has no owner record cannot be claimed", async () => {
    const orphan = `orphan-${crypto.randomUUID()}`;
    cm.createChannel({ type: "model", name: `model-conv-${orphan}`, retentionHours: 1 });
    const resp = await handleModelApi(
      ...post({ model: "marina", input: "hi", conversation_id: orphan }, KEY_B),
      engine,
    );
    expect(resp!.status).toBe(404);
  });

  it("store:false records still bind the conversation to its creator", async () => {
    // Even without a stored record, the channel exists → nobody else can claim it,
    // and the creator can no longer resume it either (owner binding was never stored).
    const first = await handleModelApi(
      ...post({ model: "marina", input: "hello", store: false }, KEY_A),
      engine,
    );
    expect(first!.status).toBe(200);
    const convA = first!.headers.get("X-Conversation-Id")!;
    const hijack = await handleModelApi(
      ...post({ model: "marina", input: "leak", conversation_id: convA }, KEY_B),
      engine,
    );
    expect(hijack!.status).toBe(404);
  });
});
