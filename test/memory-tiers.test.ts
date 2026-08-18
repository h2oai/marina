// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PROCESS_TIER_QUOTA } from "../src/engine/constants";
import { MarinaDB } from "../src/persistence/database";
import { inferTier } from "../src/persistence/db-notes";
import { cleanupDb } from "./helpers";

describe("memory tiers", () => {
  let dbPath: string;
  let db: MarinaDB;

  beforeEach(() => {
    dbPath = `/tmp/test-tiers-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
    db = new MarinaDB(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  describe("inferTier", () => {
    it("[compaction]-prefixed content goes to process regardless of noteType", () => {
      expect(inferTier("[compaction] something", "insight")).toBe("process");
      expect(inferTier("[compaction] something", "skill")).toBe("process");
      expect(inferTier("[compaction] something")).toBe("process");
    });

    it("skill noteType goes to skill tier", () => {
      expect(inferTier("how to think", "skill")).toBe("skill");
    });

    it("reflection noteType goes to reflection tier", () => {
      expect(inferTier("I noticed X", "reflection")).toBe("reflection");
    });

    it("default is fact", () => {
      expect(inferTier("something happened")).toBe("fact");
      expect(inferTier("something happened", "observation")).toBe("fact");
      expect(inferTier("something happened", "insight")).toBe("fact");
    });
  });

  describe("tier assignment on createNote", () => {
    it("[compaction] notes land in process tier", () => {
      const id = db.createNote("alice", "[compaction] turn summary", undefined, {
        importance: 3,
        noteType: "insight",
      });
      const note = db.getNote(id);
      expect(note?.tier).toBe("process");
    });

    it("reflection notes land in reflection tier", () => {
      const id = db.createNote("alice", "I learned X", undefined, { noteType: "reflection" });
      expect(db.getNote(id)?.tier).toBe("reflection");
    });

    it("skill notes land in skill tier", () => {
      const id = db.createNote("alice", "how to answer", undefined, { noteType: "skill" });
      expect(db.getNote(id)?.tier).toBe("skill");
    });

    it("explicit tier in opts overrides inference", () => {
      const id = db.createNote("alice", "[compaction] but pinned", undefined, { tier: "core" });
      expect(db.getNote(id)?.tier).toBe("core");
    });
  });

  describe("recall excludes process tier by default", () => {
    it("process notes are not returned by recall", () => {
      db.createNote("alice", "fact about cats", undefined, { importance: 5 });
      db.createNote("alice", "[compaction] cats were mentioned", undefined, {
        importance: 5,
        noteType: "insight",
      });

      const results = db.recallNotes("alice", "cats");
      expect(results.length).toBe(1);
      expect(results[0]?.content).toBe("fact about cats");
      expect(results[0]?.tier).toBe("fact");
    });

    it("recall can opt-in to include process tier", () => {
      db.createNote("alice", "fact about dogs", undefined, { importance: 5 });
      db.createNote("alice", "[compaction] dogs came up", undefined, {
        importance: 5,
        noteType: "insight",
      });

      const results = db.recallNotes("alice", "dogs", { includeProcess: true });
      expect(results.length).toBe(2);
    });
  });

  describe("write-path dedup", () => {
    it("exact same content + note_type returns existing id", () => {
      const first = db.createNote("alice", "the sky is blue", undefined, { noteType: "insight" });
      const second = db.createNote("alice", "the sky is blue", undefined, { noteType: "insight" });
      expect(second).toBe(first);
    });

    it("different note_type creates a distinct note", () => {
      const first = db.createNote("alice", "practice every day", undefined, {
        noteType: "observation",
      });
      const second = db.createNote("alice", "practice every day", undefined, { noteType: "skill" });
      expect(second).not.toBe(first);
    });

    it("different entity creates a distinct note", () => {
      const first = db.createNote("alice", "same content", undefined, { noteType: "insight" });
      const second = db.createNote("bob", "same content", undefined, { noteType: "insight" });
      expect(second).not.toBe(first);
    });

    it("pool notes skip dedup (coordination artifacts can repeat)", () => {
      db.createMemoryPool("pool-x", "x", "alice");
      const first = db.addPoolNote("pool-x", "alice", "heads up", 5, "insight");
      const second = db.addPoolNote("pool-x", "alice", "heads up", 5, "insight");
      expect(second).not.toBe(first);
    });

    it("process notes skip dedup (each [compaction] is a distinct window)", () => {
      const first = db.createNote("alice", "[compaction] same text", undefined, {
        noteType: "insight",
      });
      const second = db.createNote("alice", "[compaction] same text", undefined, {
        noteType: "insight",
      });
      expect(second).not.toBe(first);
    });

    it("skipDedup opt forces a new insert", () => {
      const first = db.createNote("alice", "fact", undefined, { noteType: "insight" });
      const second = db.createNote("alice", "fact", undefined, {
        noteType: "insight",
        skipDedup: true,
      });
      expect(second).not.toBe(first);
    });
  });

  describe("process tier quota", () => {
    it(`caps process-tier notes at ${PROCESS_TIER_QUOTA} per entity`, () => {
      // Bypass dedup by giving each note unique content.
      for (let i = 0; i < PROCESS_TIER_QUOTA + 25; i++) {
        db.createNote("alice", `[compaction] window ${i}`, undefined, { noteType: "insight" });
      }
      const count = db
        .getNotesByEntity("alice", PROCESS_TIER_QUOTA + 100)
        .filter((n) => n.tier === "process").length;
      expect(count).toBeLessThanOrEqual(PROCESS_TIER_QUOTA);
    });

    it("quota does not touch fact-tier notes", () => {
      // Fill fact tier past process quota; should NOT be evicted.
      for (let i = 0; i < PROCESS_TIER_QUOTA + 25; i++) {
        db.createNote("alice", `real fact ${i}`, undefined, { noteType: "insight" });
      }
      const factCount = db
        .getNotesByEntity("alice", PROCESS_TIER_QUOTA + 100)
        .filter((n) => n.tier === "fact").length;
      expect(factCount).toBe(PROCESS_TIER_QUOTA + 25);
    });
  });
});
