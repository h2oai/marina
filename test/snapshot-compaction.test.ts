// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

describe("snapshotCompacted", () => {
  let dbPath: string;
  let db: MarinaDB;
  const targetPath = `/tmp/test-compact-target-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;

  beforeEach(() => {
    dbPath = `/tmp/test-compact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
    db = new MarinaDB(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
    if (existsSync(targetPath)) rmSync(targetPath);
  });

  it("drops compaction-summary notes by default", () => {
    // Populate: 3 real notes + 5 compaction summaries (each "long")
    for (let i = 0; i < 3; i++) {
      db.createNote("alice", `real note ${i}`, undefined, { importance: 6, noteType: "insight" });
    }
    for (let i = 0; i < 5; i++) {
      db.createNote("alice", `[compaction] summary ${i} `.repeat(200), undefined, {
        importance: 3,
        noteType: "insight",
      });
    }

    const stats = db.snapshotCompacted(targetPath);
    expect(stats.before.notes).toBe(8);
    expect(stats.after.notes).toBe(3);
    expect(stats.dropped.compactionSummaries).toBe(5);
  });

  it("preserves skills, reflections, high-importance notes, and pool notes even if [compaction]-prefixed", () => {
    // Defense in depth — if something weird ends up with a [compaction] prefix
    // but is actually a skill/reflection/high-imp/pool note, KEEP it.
    db.createNote("alice", "[compaction] normal summary", undefined, {
      importance: 3,
      noteType: "insight",
    });
    db.createNote("alice", "[compaction] looks-like-summary-but-is-a-skill", undefined, {
      importance: 3,
      noteType: "skill",
    });
    db.createNote("alice", "[compaction] looks-like-summary-but-is-a-reflection", undefined, {
      importance: 3,
      noteType: "reflection",
    });
    db.createNote("alice", "[compaction] looks-like-summary-but-high-importance", undefined, {
      importance: 9,
      noteType: "insight",
    });
    // Pool note — pool_id set via addPoolNote which creates a note with pool_id column set
    const poolId = "pool-coord";
    db.createMemoryPool(poolId, "coord", "alice");
    db.addPoolNote(poolId, "alice", "[compaction] looks-like-summary-but-in-pool", 3, "insight");

    const stats = db.snapshotCompacted(targetPath);
    expect(stats.before.notes).toBe(5);
    // Only the first "normal summary" should be dropped — all four others protected.
    expect(stats.dropped.compactionSummaries).toBe(1);
    expect(stats.after.notes).toBe(4);
  });

  it("drops orphaned note_links after pruning", () => {
    const id1 = db.createNote("alice", "[compaction] going away", undefined, {
      importance: 3,
      noteType: "insight",
    });
    const id2 = db.createNote("alice", "real note", undefined, {
      importance: 5,
      noteType: "insight",
    });
    const id3 = db.createNote("alice", "another real note", undefined, {
      importance: 5,
      noteType: "insight",
    });
    db.createNoteLink(id1, id2, "related_to"); // will be orphaned when id1 is dropped
    db.createNoteLink(id2, id3, "related_to"); // will survive

    const stats = db.snapshotCompacted(targetPath);
    expect(stats.before.links).toBe(2);
    expect(stats.after.links).toBe(1);
    expect(stats.dropped.orphanedLinks).toBe(1);
  });

  it("preserves recent activity (within age cutoff)", () => {
    db.trackActivity("alice", "command", "look");
    db.trackActivity("alice", "command", "brief");
    // Default 30d cutoff — just-inserted activity is well within it.
    const stats = db.snapshotCompacted(targetPath);
    expect(stats.before.activity).toBe(2);
    expect(stats.after.activity).toBe(2);
    expect(stats.dropped.staleActivity).toBe(0);
  });

  it("activityOlderThanDays=0 disables activity pruning entirely", () => {
    db.trackActivity("alice", "command", "look");
    // Integration with real Gen-1 data (separately verified) exercises the
    // date-based delete path. Here we just confirm the disable-switch works.
    const stats = db.snapshotCompacted(targetPath, { activityOlderThanDays: 0 });
    expect(stats.after.activity).toBe(1);
    expect(stats.dropped.staleActivity).toBe(0);
  });

  it("reclaims disk via VACUUM", () => {
    // Make the DB big enough for VACUUM to matter
    for (let i = 0; i < 50; i++) {
      db.createNote("alice", `[compaction] ${"x".repeat(5000)}`, undefined, {
        importance: 3,
        noteType: "insight",
      });
    }
    // Include a tiny real note so the DB isn't empty after prune
    db.createNote("alice", "keeper", undefined, { importance: 8, noteType: "skill" });

    const stats = db.snapshotCompacted(targetPath);
    expect(stats.after.bytes).toBeLessThan(stats.before.bytes);
  });

  it("compactionOlderThanDays=0 means 'drop all compaction notes'", () => {
    db.createNote("alice", "[compaction] fresh one", undefined, {
      importance: 3,
      noteType: "insight",
    });
    const stats = db.snapshotCompacted(targetPath, { compactionOlderThanDays: 0 });
    expect(stats.dropped.compactionSummaries).toBe(1);
  });

  it("does not mutate the live DB — live state is untouched", () => {
    db.createNote("alice", "[compaction] should-persist-in-live-db", undefined, {
      importance: 3,
      noteType: "insight",
    });
    const liveBefore = db.getNotesByEntity("alice", 100).length;

    db.snapshotCompacted(targetPath);

    const liveAfter = db.getNotesByEntity("alice", 100).length;
    expect(liveAfter).toBe(liveBefore); // compaction only affected the snapshot
  });

  it("refuses to overwrite an existing target file", () => {
    db.createNote("alice", "first", undefined, { importance: 5, noteType: "insight" });
    db.snapshotCompacted(targetPath);
    expect(() => db.snapshotCompacted(targetPath)).toThrow();
  });

  it("opts.dropCompactionSummaries=false preserves them", () => {
    db.createNote("alice", "[compaction] should-stay", undefined, {
      importance: 3,
      noteType: "insight",
    });
    const stats = db.snapshotCompacted(targetPath, { dropCompactionSummaries: false });
    expect(stats.dropped.compactionSummaries).toBe(0);
    expect(stats.after.notes).toBe(1);
  });
});
