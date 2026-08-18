// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId, RoomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const DB_PATH = "test-quit.db";

describe("Quit / Exit command", () => {
  let engine: Engine;
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(DB_PATH);
    engine = new Engine({
      startRoom: "test/start" as RoomId,
      db,
    });
    engine.registerRoom("test/start" as RoomId, makeTestRoom());
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(DB_PATH);
  });

  test("quit command sends goodbye and closes connection", () => {
    let closed = false;
    const conn = new MockConnection("c1");
    conn.close = () => {
      closed = true;
      engine.removeConnection("c1");
    };

    engine.addConnection(conn);
    const result = engine.login("c1", "TestUser");
    expect("entityId" in result).toBe(true);

    conn.clear();
    engine.processCommand((result as { entityId: EntityId }).entityId, "quit");

    // Should have sent goodbye
    const texts = conn.allText();
    expect(texts.some((t) => t.includes("Goodbye"))).toBe(true);

    // Connection should be closed
    expect(closed).toBe(true);

    // Entity should be removed
    expect(engine.getOnlineAgents().length).toBe(0);
    expect(engine.entities.size).toBe(0);
  });

  test("exit alias works like quit", () => {
    let closed = false;
    const conn = new MockConnection("c2");
    conn.close = () => {
      closed = true;
      engine.removeConnection("c2");
    };

    engine.addConnection(conn);
    const result = engine.login("c2", "ExitUser");
    expect("entityId" in result).toBe(true);

    conn.clear();
    engine.processCommand((result as { entityId: EntityId }).entityId, "exit");

    expect(conn.allText().some((t) => t.includes("Goodbye"))).toBe(true);
    expect(closed).toBe(true);
    expect(engine.entities.size).toBe(0);
  });

  test("logout alias works like quit", () => {
    let closed = false;
    const conn = new MockConnection("c3");
    conn.close = () => {
      closed = true;
      engine.removeConnection("c3");
    };

    engine.addConnection(conn);
    const result = engine.login("c3", "LogoutUser");
    expect("entityId" in result).toBe(true);

    conn.clear();
    engine.processCommand((result as { entityId: EntityId }).entityId, "logout");
    expect(closed).toBe(true);
  });

  test("disconnect alias works like quit", () => {
    let closed = false;
    const conn = new MockConnection("c4");
    conn.close = () => {
      closed = true;
      engine.removeConnection("c4");
    };

    engine.addConnection(conn);
    const result = engine.login("c4", "DisconnectUser");
    expect("entityId" in result).toBe(true);

    conn.clear();
    engine.processCommand((result as { entityId: EntityId }).entityId, "disconnect");
    expect(closed).toBe(true);
  });
});

describe("getOnlineAgents filtering", () => {
  let engine: Engine;
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(DB_PATH);
    engine = new Engine({
      startRoom: "test/start" as RoomId,
      db,
    });
    engine.registerRoom("test/start" as RoomId, makeTestRoom());
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(DB_PATH);
  });

  test("getOnlineAgents only returns agents with active connections", () => {
    // Connect two agents
    const conn1 = new MockConnection("c1");
    const conn2 = new MockConnection("c2");
    engine.addConnection(conn1);
    engine.addConnection(conn2);

    const r1 = engine.login("c1", "Agent1");
    const r2 = engine.login("c2", "Agent2");
    expect("entityId" in r1).toBe(true);
    expect("entityId" in r2).toBe(true);

    expect(engine.getOnlineAgents().length).toBe(2);

    // Disconnect one agent
    engine.removeConnection("c1");

    // Should only show one online agent
    expect(engine.getOnlineAgents().length).toBe(1);
    expect(engine.getOnlineAgents()[0]!.name).toBe("Agent2");
  });

  test("getConnectionForEntity returns correct connection", () => {
    const conn = new MockConnection("c1");
    engine.addConnection(conn);
    const result = engine.login("c1", "TestUser");
    expect("entityId" in result).toBe(true);

    const entityId = (result as { entityId: EntityId }).entityId;
    const found = engine.getConnectionForEntity(entityId);
    expect(found).toBeDefined();
    expect(found!.id).toBe("c1");
  });

  test("getConnectionForEntity returns undefined for unknown entity", () => {
    const found = engine.getConnectionForEntity("e_999" as EntityId);
    expect(found).toBeUndefined();
  });
});

describe("Orphaned agent cleanup", () => {
  let engine: Engine;
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(DB_PATH);
    engine = new Engine({
      startRoom: "test/start" as RoomId,
      db,
      tickInterval: 100000, // don't auto-tick
    });
    engine.registerRoom("test/start" as RoomId, makeTestRoom());
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(DB_PATH);
  });

  test("orphaned agents are not included in getOnlineAgents", () => {
    // Create a connected agent
    const conn = new MockConnection("c1");
    engine.addConnection(conn);
    const result = engine.login("c1", "OrphanTest");
    expect("entityId" in result).toBe(true);

    // Simulate orphaning: delete the connection directly from the map
    // without going through removeConnection (simulates a transport crash)
    // biome-ignore lint/suspicious/noExplicitAny: testing internals requires private access
    (engine as any).connections.delete("c1");

    // Entity still exists in EntityManager
    expect(engine.entities.size).toBeGreaterThan(0);

    // But getOnlineAgents should NOT include it
    expect(engine.getOnlineAgents().length).toBe(0);
  });
});
