// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

const DB_PATH = `/tmp/test-note-dedup-index-${process.pid}.db`;

describe("write-path note dedup (migration 122)", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(DB_PATH);
  });
  afterEach(() => {
    db.close();
    cleanupDb(DB_PATH);
  });

  it("dedups an exact twin but not a note that only shares the indexed prefix", () => {
    const prefix = "x".repeat(64);
    const first = db.createNote("ada", `${prefix} tail one`);
    expect(db.createNote("ada", `${prefix} tail one`)).toBe(first);
    expect(db.createNote("ada", `${prefix} tail two`)).not.toBe(first);
    // Different note type or entity is never a twin.
    expect(db.createNote("ada", `${prefix} tail one`, undefined, { noteType: "insight" })).not.toBe(
      first,
    );
    expect(db.createNote("bob", `${prefix} tail one`)).not.toBe(first);
  });

  it("the dedup lookup is served by idx_notes_dedup, not an entity scan", () => {
    const raw = new Database(DB_PATH);
    try {
      const plan = raw
        .query(
          `EXPLAIN QUERY PLAN SELECT * FROM notes WHERE entity_name = ? AND pool_id IS NULL
             AND note_type = ? AND notes.tier IN ('fact') AND substr(content, 1, 64) = substr(?, 1, 64)
             AND content = ? AND verification_status != 'superseded' LIMIT 1`,
        )
        .all("ada", "observation", "c", "c") as { detail: string }[];
      expect(plan.map((row) => row.detail).join(" ")).toContain("idx_notes_dedup");
    } finally {
      raw.close();
    }
  });
});
