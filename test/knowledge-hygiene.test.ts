import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_knowledge_hygiene.db";

describe("knowledge hygiene audit commands", () => {
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

  it("audits a pool without changing its notes", () => {
    engine.processCommand(conn.entity!, "pool create guide");
    const pool = db.getMemoryPool("guide");
    expect(pool).toBeDefined();
    db.addPoolNote(pool!.id, "Guide", "Repeat this lesson", 5, "fact");
    db.addPoolNote(pool!.id, "Guide", "Repeat this lesson", 5, "fact");
    db.addPoolNote(pool!.id, "Guide", "Use `pool guide read` to inspect it.", 5, "fact");
    db.addPoolNote(pool!.id, "Guide", "x".repeat(725), 5, "fact");
    const before = db.getPoolNotes(pool!.id, 500).length;

    conn.clear();
    engine.processCommand(conn.entity!, "pool guide audit");
    const text = stripAnsi(conn.lastText());

    expect(text).toContain('Pool "guide" hygiene audit');
    expect(text).toContain("Duplicate groups: 1");
    expect(text).toContain("Overlong notes: 1");
    expect(text).toContain("Stale command refs: 1");
    expect(text).toContain('unknown pool action "read"');
    expect(db.getPoolNotes(pool!.id, 500).length).toBe(before);
  });

  it("audits personal skill notes", () => {
    db.createNote("Alice", "[Skill: repeat] Same || Actions: look", undefined, {
      noteType: "skill",
      skipDedup: true,
    });
    db.createNote("Alice", "[Skill: repeat] Same || Actions: look", undefined, {
      noteType: "skill",
      skipDedup: true,
    });
    engine.processCommand(
      conn.entity!,
      "skill store stale | Uses an old command | note the hit ; project Alpha orchestrate swarm ; fooble thing ; pool guide read",
    );

    conn.clear();
    engine.processCommand(conn.entity!, "skill audit");
    const text = stripAnsi(conn.lastText());

    expect(text).toContain("Skill library hygiene audit");
    expect(text).toContain("Duplicate groups: 1");
    expect(text).toContain("Stale command refs: 2");
    expect(text).toContain('unknown command "fooble"');
    expect(text).toContain('unknown pool action "read"');
  });

  it("does not flag current build command forms as stale", () => {
    engine.processCommand(conn.entity!, "pool create builders");
    const pool = db.getMemoryPool("builders");
    expect(pool).toBeDefined();
    db.addPoolNote(
      pool!.id,
      "Guide",
      "Use `build room lab short A lab`, `build template list`, and `build command create meditate`.",
      5,
      "fact",
    );

    conn.clear();
    engine.processCommand(conn.entity!, "pool builders audit");
    const text = stripAnsi(conn.lastText());

    expect(text).toContain('Pool "builders" hygiene audit');
    expect(text).toContain("Stale command refs: 0");
  });
});
