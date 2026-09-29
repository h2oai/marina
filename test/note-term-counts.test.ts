// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { distinctiveTerms } from "../src/memory/unified-context";
import { MarinaDB } from "../src/persistence/database";

describe("noteTermCounts (distinctiveTerms through the store)", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
  });
  afterEach(() => db.close());

  it("counts per term over the entity's private fact-like notes, case-insensitively", () => {
    db.createNote("Ada", "The river Thames floods");
    db.createNote("Ada", "Another river note");
    db.createNote("ada", "Mountains are tall");
    db.createNote("Bob", "river river river");
    expect(db.noteTermCounts("Ada", ["River", "mountain", "100%_"])).toEqual({
      total: 3,
      counts: [2, 1, 0],
    });
    expect(db.noteTermCounts("Nobody", ["river"])).toEqual({ total: 0, counts: [0] });
  });

  it("serves repeat reads from the cache and invalidates on the next write", () => {
    db.createNote("Ada", "river one");
    const raw = db.memoryRepository().raw;
    const original = raw.query.bind(raw);
    let scans = 0;
    raw.query = ((sql: string) => {
      if (sql.includes("LIKE ? ESCAPE")) scans++;
      return original(sql);
    }) as typeof raw.query;
    try {
      expect(db.noteTermCounts("Ada", ["river"]).counts).toEqual([1]);
      expect(db.noteTermCounts("Ada", ["river"]).counts).toEqual([1]);
      expect(scans).toBe(1);
      db.createNote("Ada", "river two");
      expect(db.noteTermCounts("Ada", ["river"]).counts).toEqual([2]);
      expect(scans).toBe(2);
    } finally {
      raw.query = original;
    }
  });

  it("keeps distinctiveTerms semantics: rare terms are distinctive, an empty corpus counts all", () => {
    for (let i = 0; i < 20; i++) db.createNote("Ada", `common note ${i}`);
    db.createNote("Ada", "zanzibar trip");
    expect([...distinctiveTerms(db, "Ada", ["common", "zanzibar"])]).toEqual(["zanzibar"]);
    expect([...distinctiveTerms(db, "Nobody", ["common"])]).toEqual(["common"]);
  });
});

describe("getMemoryQualitySummary", () => {
  it("counts open contradiction cases in SQL globally", () => {
    const db = new MarinaDB(":memory:");
    try {
      const a = db.createNote("Ada", "The bridge is open on Sundays");
      const b = db.createNote("Ada", "The bridge is closed on Sundays");
      db.createNote("Bob", "Unrelated fact");
      const raw = db.memoryRepository().raw;
      const insert = (key: string, status: string) =>
        raw.run(
          `INSERT INTO contradiction_cases
             (case_key, claim_key, scope_type, left_note_id, right_note_id, status, created_at, updated_at)
           VALUES (?, 'bridge', 'global', ?, ?, ?, 1, 1)`,
          [key, a, b, status],
        );
      insert("k1", "open");
      insert("k2", "resolved");
      const global = db.getMemoryQualitySummary();
      expect(global.total).toBe(3);
      expect(global.contradictions).toBe(1);
      expect(db.getMemoryQualitySummary("Ada").total).toBe(2);
    } finally {
      db.close();
    }
  });
});
