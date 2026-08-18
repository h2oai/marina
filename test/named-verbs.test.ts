// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_named_verbs.db";

function lastFor(conn: MockConnection): string {
  return stripAnsi(conn.allTextJoined());
}

describe("recap", () => {
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
    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("rejects empty topic", () => {
    engine.processCommand(conn.entity!, "recap");
    expect(lastFor(conn)).toContain("Usage: recap <topic>");
  });

  it("returns 'nothing on file' when there are no matching sources", () => {
    engine.processCommand(conn.entity!, "recap obscure-thing-no-one-has-noted");
    const text = lastFor(conn);
    expect(text).toContain("Nothing on file");
  });

  it("surfaces personal notes that match the query", () => {
    engine.processCommand(conn.entity!, "note quantum computing breakthrough");
    conn.clear();
    engine.processCommand(conn.entity!, "recap quantum");
    const text = lastFor(conn);
    expect(text).toContain("Your Notes");
    expect(text).toContain("quantum computing breakthrough");
  });

  it("surfaces guide-pool notes when they match", () => {
    const poolId = "pool_guide_test";
    db.createMemoryPool(poolId, "guide", "system");
    db.addPoolNote(poolId, "system", "Federation requires gateway peer-keys", 7, "skill");
    conn.clear();
    engine.processCommand(conn.entity!, "recap federation");
    const text = lastFor(conn);
    expect(text).toContain("Guide");
    expect(text).toContain("gateway peer-keys");
  });
});

describe("debrief", () => {
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
    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("shows a no-notes message when the entity hasn't captured anything", () => {
    engine.processCommand(conn.entity!, "debrief");
    const text = lastFor(conn);
    expect(text).toContain("Debrief: Alice");
    expect(text).toContain("None yet");
  });

  it("shows recent notes and suggests reflect once there are 3+", () => {
    engine.processCommand(conn.entity!, "note observation one");
    engine.processCommand(conn.entity!, "note observation two");
    engine.processCommand(conn.entity!, "note observation three");
    conn.clear();
    engine.processCommand(conn.entity!, "debrief");
    const text = lastFor(conn);
    expect(text).toContain("Recent Notes");
    expect(text).toContain("observation one");
    expect(text).toContain("reflect");
  });

  it("includes a standing snapshot", () => {
    engine.processCommand(conn.entity!, "debrief");
    const text = lastFor(conn);
    expect(text).toContain("Standing");
    expect(text).toContain("blended");
  });
});

describe("share", () => {
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
    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("rejects missing args", () => {
    engine.processCommand(conn.entity!, "share");
    expect(lastFor(conn)).toContain("Usage: share <pool> <content>");
  });

  it("refuses to write to a pool that does not exist (pool create is separate)", () => {
    engine.processCommand(conn.entity!, "share ghost-pool a finding");
    expect(lastFor(conn)).toContain("not found");
  });

  it("writes to an existing pool and the note is recallable", () => {
    db.createMemoryPool("pool_research", "research", "system");
    conn.clear();
    engine.processCommand(conn.entity!, "share research kalshi spread tightens on close");
    const out = lastFor(conn);
    expect(out).toContain("Shared to research");
    expect(out).toContain("kalshi spread tightens");

    const pool = db.getMemoryPool("research")!;
    const notes = db.getPoolNotes(pool.id);
    expect(notes.length).toBe(1);
    expect(notes[0]?.content).toContain("kalshi spread tightens");
  });
});

describe("dig", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let prevAskModel: string | undefined;

  beforeEach(() => {
    // Disable the local-model HTTP path so dig doesn't try to hit
    // /v1/chat/completions on a port that isn't serving in unit tests.
    // The test asserts the *substrate* degrades, not the model layer.
    prevAskModel = process.env.MARINA_ASK_MODEL;
    process.env.MARINA_ASK_MODEL = "false";
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Alice");
    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
    process.env.MARINA_ASK_MODEL = prevAskModel;
  });

  it("rejects empty topic", () => {
    engine.processCommand(conn.entity!, "dig");
    expect(lastFor(conn)).toContain("Usage: dig <topic>");
  });

  it("degrades gracefully without a connector runtime — internal sources only", async () => {
    // engine constructed in beforeEach has no connectorRuntime (no
    // ConnectorRuntime is initialized without the env wiring), so the dig
    // path should produce the "Web search unavailable" hint rather than
    // throwing or hanging.
    engine.processCommand(conn.entity!, "note thermal runaway scaling note");
    conn.clear();
    await engine.processCommand(conn.entity!, "dig thermal runaway");
    const text = lastFor(conn);
    expect(text).toContain("Dig: thermal runaway");
    expect(text).toContain("Your Notes");
    expect(text).toContain("thermal runaway scaling note");
  });
});
