// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Split from integration.test.ts (Persistence Integration + Session Manager
// describes). Assertions are unchanged.

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId } from "../src/types";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

const TEST_DB = "test_integration_persist.db";

// ─── Persistence Integration Tests ────────────────────────────────────────────

describe("Persistence Integration", () => {
  afterEach(() => {
    cleanupDb(TEST_DB);
  });

  it("should save and restore world state across engine restarts", () => {
    // Create first engine instance, spawn entity, save
    const db1 = new MarinaDB(TEST_DB);
    const engine1 = new Engine({
      startRoom: roomId("test/start"),
      tickInterval: 60_000,
      db: db1,
    });
    engine1.registerRoom(
      roomId("test/start"),
      makeTestRoom({ short: "Start", long: "Start room." }),
    );

    // Manually create and restore an NPC entity via DB
    const testEntity = {
      id: "e_100" as EntityId,
      kind: "npc" as const,
      name: "PersistBot",
      short: "PersistBot stands here.",
      long: "A persistent bot.",
      room: roomId("test/start"),
      properties: { test: true },
      inventory: [],
      createdAt: Date.now(),
    };
    db1.saveEntity(testEntity);
    db1.setRoomStoreValue(roomId("test/start"), "counter", 42);

    // Load world state into engine
    engine1.loadWorldState();

    // Verify entity was restored
    const restored = engine1.entities.get("e_100" as EntityId);
    expect(restored).toBeDefined();
    expect(restored!.name).toBe("PersistBot");

    // Verify room store was restored
    const room = engine1.rooms.get(roomId("test/start"));
    expect(room).toBeDefined();
    expect(room!.store.get<number>("counter")).toBe(42);

    // Save world state
    engine1.saveWorldState();
    db1.close();

    // Create second engine instance and verify state persisted
    const db2 = new MarinaDB(TEST_DB);
    const engine2 = new Engine({
      startRoom: roomId("test/start"),
      tickInterval: 60_000,
      db: db2,
    });
    engine2.registerRoom(
      roomId("test/start"),
      makeTestRoom({ short: "Start", long: "Start room." }),
    );

    engine2.loadWorldState();

    const restored2 = engine2.entities.get("e_100" as EntityId);
    expect(restored2).toBeDefined();
    expect(restored2!.name).toBe("PersistBot");

    const room2 = engine2.rooms.get(roomId("test/start"));
    expect(room2!.store.get<number>("counter")).toBe(42);

    db2.close();
  });

  it("should persist events to database", () => {
    const db = new MarinaDB(TEST_DB);
    const engine = new Engine({
      startRoom: roomId("test/start"),
      tickInterval: 60_000,
      db,
    });
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({ short: "Start", long: "Start room." }),
    );

    // Process a command to generate events
    const conn = {
      id: "test_conn",
      protocol: "websocket" as const,
      entity: null as EntityId | null,
      connectedAt: Date.now(),
      send() {},
      close() {},
    };
    engine.addConnection(conn);
    engine.spawnEntity("test_conn", "EventBot");

    // Check that events were logged to DB
    const events = db.getRecentEvents(100);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "connect")).toBe(true);

    db.close();
  });
});

// ─── Session Manager Tests ────────────────────────────────────────────────────

describe("Session Manager", () => {
  // Imported inline to test
  let SessionManager: typeof import("../src/auth/session-manager").SessionManager;

  beforeAll(async () => {
    const mod = await import("../src/auth/session-manager");
    SessionManager = mod.SessionManager;
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
  });

  it("should create and validate sessions", () => {
    const mgr = new SessionManager();
    const session = mgr.create("e_1" as EntityId, "TestAgent");
    expect(session.token).toBeDefined();
    expect(session.entityId).toBe("e_1" as EntityId);
    expect(session.name).toBe("TestAgent");

    const validated = mgr.validate(session.token);
    expect(validated).toBeDefined();
    expect(validated!.entityId).toBe("e_1" as EntityId);
  });

  it("should revoke sessions", () => {
    const mgr = new SessionManager();
    const session = mgr.create("e_1" as EntityId, "TestAgent");
    expect(mgr.revoke(session.token)).toBe(true);
    expect(mgr.validate(session.token)).toBeUndefined();
  });

  it("should revoke by entity", () => {
    const mgr = new SessionManager();
    mgr.create("e_1" as EntityId, "TestAgent");
    mgr.revokeByEntity("e_1" as EntityId);
    expect(mgr.getByEntity("e_1" as EntityId)).toBeUndefined();
  });

  it("should persist sessions to database", () => {
    const db = new MarinaDB(TEST_DB);
    const mgr = new SessionManager(db);
    const session = mgr.create("e_1" as EntityId, "TestAgent");

    // Tokens are stored hashed at rest: a raw-token lookup MUST miss (that's the
    // security property), while a lookup by the SHA-256 hash resolves the record.
    expect(db.loadSession(session.token)).toBeUndefined();
    const hash = createHash("sha256").update(session.token).digest("hex");
    const loaded = db.loadSession(hash);
    expect(loaded).toBeDefined();
    expect(loaded!.entityId).toBe("e_1" as EntityId);

    db.close();
  });

  it("should clean up expired sessions", async () => {
    // create() returns a value copy (it swaps in the raw token), so the returned
    // object can't be mutated to force expiry. Drive real expiry via a 1ms TTL.
    const mgr = new SessionManager(undefined, { sessionTtlMs: 1 });
    mgr.create("e_1" as EntityId, "TestAgent");
    await Bun.sleep(10);

    const removed = mgr.cleanup();
    expect(removed).toBe(1);
  });
});
