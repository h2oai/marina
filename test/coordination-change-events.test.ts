// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import type { EngineEvent } from "../src/types";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_coordination_change.db";

/**
 * The dashboard's Coordination panel refreshes its lists live off a single
 * generic `coordination_change` event (resource + action). These tests pin the
 * emission contract for every resource so a missing emit can't silently regress
 * a panel back to the 30s poll.
 */
describe("coordination_change events", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let events: EngineEvent[];

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Alice");
    conn.clear();
    events = [];
    engine.addEventListener((e) => events.push(e));
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  const changes = (resource: string, action?: string) =>
    events.filter(
      (e) =>
        e.type === "coordination_change" &&
        e.resource === resource &&
        (action === undefined || e.action === action),
    );

  it("emits group create / update / delete", () => {
    engine.processCommand(conn.entity!, "group create explorers Explorers");
    expect(changes("group", "create").length).toBe(1);

    const conn2 = new MockConnection("c2");
    engine.addConnection(conn2);
    engine.spawnEntity("c2", "Bob");
    engine.processCommand(conn.entity!, "group invite Bob Explorers");
    expect(changes("group", "update").length).toBeGreaterThanOrEqual(1);

    engine.processCommand(conn.entity!, "group disband Explorers");
    expect(changes("group", "delete").length).toBe(1);
  });

  it("emits channel create", () => {
    engine.processCommand(conn.entity!, "channel create war-room");
    const ev = changes("channel", "create");
    expect(ev.length).toBe(1);
    expect(ev[0]).toMatchObject({ name: "war-room" });
  });

  it("emits board create", () => {
    engine.processCommand(conn.entity!, "board create ideas");
    expect(changes("board", "create").length).toBe(1);
  });

  it("emits pool create", () => {
    engine.processCommand(conn.entity!, "pool create findings");
    expect(changes("pool", "create").length).toBe(1);
  });

  it("emits project create", () => {
    engine.processCommand(conn.entity!, "project create Alpha | Investigate");
    expect(changes("project", "create").length).toBe(1);
  });
});
