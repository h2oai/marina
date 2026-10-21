// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
/**
 * Write-path dedup finds a duplicate by its text through an index instead of
 * reading the entity's whole note history. These tests hold the indexed
 * lookup to the original full-scan query: the same duplicate (or none) for
 * every probe over a fixture with bound and legacy handles, revisions,
 * retired and superseded notes, other tiers, pools, other entities and
 * texts that share a 64-character prefix.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarinaDB } from "../src/persistence/database";
import { findDuplicateForWrite } from "../src/persistence/db-notes";

/** The dedup query before the text index (frozen: never edit to pass). */
const ORIGINAL_DEDUP = `SELECT * FROM numeric_notes
         WHERE entity_name = ?
           AND pool_id IS NULL
           AND note_type = ?
           AND numeric_notes.tier IN ('fact', 'reflection', 'skill', 'core')
           AND substr(content, 1, 64) = substr(?, 1, 64)
           AND content = ?
           AND verification_status != 'superseded'
         LIMIT 1`;

const PREFIX = "x".repeat(64);
const TEXTS = [
  "same text",
  "old text",
  "new text",
  "gone text",
  "disputed text",
  "superseded text",
  "legacy text",
  `${PREFIX} first`,
  `${PREFIX} second`,
  PREFIX,
  "nonexistent",
  "",
];
const ENTITIES = ["alice", "bob", "carol"];
const TYPES = ["observation", "plan", "reflection"];

let dir: string;
let path: string;
let db: MarinaDB;
let raw: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "marina-dedup-"));
  path = join(dir, "world.db");
  db = new MarinaDB(path);
  db.createUser({ id: "u1", name: "alice" });
  db.createUser({ id: "u2", name: "bob" });
  db.createMemoryPool("pool_shared", "shared", "alice");

  // Two rows with the same text (a dedup bypass) — the first must win.
  db.createNote("alice", "same text");
  db.createNote("alice", "same text", undefined, { skipDedup: true });
  db.createNote("alice", "same text", undefined, { tier: "reflection", skipDedup: true });
  db.createNote("alice", "same text", undefined, { tier: "process" });
  db.createNote("alice", "same text", undefined, { poolId: "pool_shared" });
  db.createNote("alice", "same text", undefined, { noteType: "plan" });
  db.createNote("bob", "same text");
  // A revision pins the old address to the old version.
  const old = db.createNote("alice", "old text");
  db.reviseNote("alice", old, "new text");
  // Retired, disputed and superseded notes.
  db.deleteNote(db.createNote("alice", "gone text"), "alice");
  db.updateNoteQuality(db.createNote("alice", "disputed text"), "alice", 0.2, "disputed");
  db.updateNoteQuality(db.createNote("alice", "superseded text"), "alice", 0.2, "superseded");
  // Texts that share their first 64 characters.
  db.createNote("alice", `${PREFIX} first`);
  db.createNote("alice", `${PREFIX} second`);
  db.createNote("alice", PREFIX);
  // An unbound legacy row (no canonical record): its own body is the text.
  db.createNote("carol", "legacy text", undefined, { tier: "process" });

  raw = new Database(path);
  // Carol's process note becomes a fact-tier legacy row with its own body.
  raw.run("UPDATE notes SET tier = 'fact' WHERE entity_name = 'carol'");
});

afterAll(() => {
  raw?.close();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("write-path dedup by text index", () => {
  test("finds the same duplicate as the full scan for every probe", () => {
    const original = raw.query(ORIGINAL_DEDUP);
    let matched = 0;
    for (const entity of ENTITIES)
      for (const type of TYPES)
        for (const text of TEXTS) {
          const expected = text
            ? ((original.get(entity, type, text, text) as Record<string, unknown> | null) ??
              undefined)
            : undefined;
          const actual = findDuplicateForWrite(raw, entity, text, type);
          expect({ entity, type, text, row: actual }).toEqual({
            entity,
            type,
            text,
            row: expected as never,
          });
          if (expected) matched++;
        }
    // The fixture exercises real matches, not only misses.
    expect(matched).toBeGreaterThanOrEqual(6);
  });

  test("the lookup reads by text, not the entity's history", () => {
    const plan = raw
      .query(
        `EXPLAIN QUERY PLAN SELECT id FROM notes
         WHERE substr(content, 1, 64) = substr(?1, 1, 64) AND content = ?1`,
      )
      .all("same text") as { detail: string }[];
    expect(plan.map((p) => p.detail).join("\n")).toContain("idx_notes_content_prefix");
  });

  test("createNote still returns the existing note for a verbatim rewrite", () => {
    const first = db.createNote("bob", "a fact bob repeats");
    expect(db.createNote("bob", "a fact bob repeats")).toBe(first);
    expect(db.createNote("bob", "a fact bob repeats", undefined, { noteType: "plan" })).not.toBe(
      first,
    );
  });
});
