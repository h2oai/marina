// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_guide_command.db";

describe("guide command", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Alice");
    // Seed a guide pool with a couple of orientation notes.
    engine.processCommand(conn.entity!, "pool create guide");
    const pool = db.getMemoryPool("guide")!;
    db.addPoolNote(pool.id, "Guide", "recall searches shared knowledge across pools.", 8, "fact");
    db.addPoolNote(pool.id, "Guide", "Use `pool guide read` to inspect notes.", 5, "fact");
    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("shows an overview for bare `guide`", () => {
    engine.processCommand(conn.entity!, "guide");
    const text = stripAnsi(conn.lastText());
    expect(text).toContain("Guide");
    expect(text).toContain("2 orientation note(s)");
  });

  it("lists guide notes", () => {
    engine.processCommand(conn.entity!, "guide list");
    const text = stripAnsi(conn.lastText());
    expect(text).toContain("recall searches shared knowledge");
    expect(text).toContain("2 note(s) total");
  });

  it("recalls by topic (voice-friendly bare form)", () => {
    engine.processCommand(conn.entity!, "guide recall");
    expect(db.getMemoryPool("guide")).toBeDefined();

    engine.processCommand(conn.entity!, "guide recall searches");
    const text = stripAnsi(conn.lastText());
    expect(text).toContain('Guide: "searches"');
    expect(text).toContain("recall searches shared knowledge");
  });

  it("audits the guide pool (alias lint), surfacing the stale command ref", () => {
    engine.processCommand(conn.entity!, "guide audit");
    const auditText = stripAnsi(conn.lastText());
    expect(auditText).toContain("Guide pool hygiene audit");
    expect(auditText).toContain("Stale command refs: 1");
    expect(auditText).toContain('unknown pool action "read"');

    conn.clear();
    engine.processCommand(conn.entity!, "guide lint");
    expect(stripAnsi(conn.lastText())).toContain("Guide pool hygiene audit");
  });

  it("reports gracefully when there is no guide pool", () => {
    db.close();
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    const e2 = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    e2.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    const c2 = new MockConnection("c2");
    e2.addConnection(c2);
    e2.spawnEntity("c2", "Bob");
    c2.clear();
    e2.processCommand(c2.entity!, "guide");
    expect(stripAnsi(c2.lastText())).toContain("No guide pool in this world.");
  });
});
