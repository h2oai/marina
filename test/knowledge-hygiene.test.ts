// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { auditKnowledgeNotes } from "../src/engine/commands/knowledge-hygiene";
import { Engine } from "../src/engine/engine";
import { MarinaDB, type NoteRow } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_knowledge_hygiene.db";

let noteSeq = 0;
function note(content: string, over: Partial<NoteRow> = {}): NoteRow {
  noteSeq += 1;
  return {
    id: noteSeq,
    entity_name: "Guide",
    room_id: null,
    content,
    importance: 5,
    last_accessed: null,
    note_type: "fact",
    pool_id: "p",
    supersedes_id: null,
    tier: "fact",
    created_at: 0,
    ...over,
  };
}

describe("auditKnowledgeNotes — claim + staleness detection", () => {
  it("flags an empirical claim that has no citation", () => {
    const report = auditKnowledgeNotes([note("This approach is 80% faster than the baseline.")]);
    expect(report.unsupportedClaims).toHaveLength(1);
  });

  it("does not flag the same claim when a source is cited", () => {
    expect(
      auditKnowledgeNotes([note("This approach is 80% faster (source: https://example.com/x).")])
        .unsupportedClaims,
    ).toHaveLength(0);
    expect(
      auditKnowledgeNotes([note("Research shows X improves recall [arxiv:1234].")])
        .unsupportedClaims,
    ).toHaveLength(0);
  });

  it("does not flag instructional how-to notes (no false positives)", () => {
    const report = auditKnowledgeNotes([
      note("recall searches the pool; always cite where you learned things and never overclaim."),
      note("Use `pool guide recall <topic>` to find orientation notes."),
    ]);
    expect(report.unsupportedClaims).toHaveLength(0);
  });

  it("flags notes untouched past maxAgeMs only when opted in", () => {
    const now = 10_000_000_000; // ~115 days past epoch
    const maxAgeMs = 90 * 86_400_000; // ~7.78e9 ms
    const old = note("ancient orientation note", { created_at: 0, last_accessed: null });
    const fresh = note("recent note", { created_at: 0, last_accessed: now - 1_000_000 });

    // opt-out (no maxAgeMs): nothing stale
    expect(auditKnowledgeNotes([old, fresh], { now }).stale).toHaveLength(0);
    // opt-in: the untouched note is stale, the freshly-accessed one is not
    const report = auditKnowledgeNotes([old, fresh], { now, maxAgeMs });
    expect(report.stale).toHaveLength(1);
    expect(report.stale[0]!.noteIds).toEqual([old.id]);
  });
});

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
    expect(text).toContain("Unsupported claims:");
    expect(text).toContain("Stale notes:");
    expect(db.getPoolNotes(pool!.id, 500).length).toBe(before);
  });

  it("reports unsupported claims through pool audit", () => {
    engine.processCommand(conn.entity!, "pool create claims");
    const pool = db.getMemoryPool("claims");
    db.addPoolNote(pool!.id, "Guide", "Our model is 95% accurate on every benchmark.", 6, "fact");

    conn.clear();
    engine.processCommand(conn.entity!, "pool claims audit");
    const text = stripAnsi(conn.lastText());
    expect(text).toContain("Unsupported claims: 1");
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
