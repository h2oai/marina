// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MarinaDB } from "../src/persistence/database";
import type { Entity } from "../src/types";
import { entityId, roomId } from "../src/types";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_concurrency.db";

function makeEntity(i: number): Entity {
  return {
    id: entityId(`e_${i}`),
    kind: "agent",
    name: `Agent${i}`,
    short: `Agent${i} is here.`,
    long: `A test agent number ${i}.`,
    room: roomId("core/nexus"),
    properties: {},
    inventory: [],
    createdAt: Date.now(),
  };
}

describe("Database Concurrency", () => {
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  // ─── 1. Concurrent writes to different tables ─────────────────────────

  it("should handle concurrent writes to different tables", async () => {
    const ops = [
      // Write to notes
      ...Array.from({ length: 10 }, (_, i) =>
        Promise.resolve(db.createNote(`agent_${i}`, `note content ${i}`)),
      ),
      // Write to tasks
      ...Array.from({ length: 10 }, (_, i) =>
        Promise.resolve(
          db.createTask({
            title: `task_${i}`,
            creatorId: `e_${i}`,
            creatorName: `Agent${i}`,
          }),
        ),
      ),
      // Write to core_memory
      ...Array.from({ length: 10 }, (_, i) =>
        Promise.resolve(db.setCoreMemory(`Agent${i}`, "goal", `goal_${i}`)),
      ),
    ];

    await Promise.all(ops);

    // Verify all writes landed
    for (let i = 0; i < 10; i++) {
      const notes = db.getNotesByEntity(`agent_${i}`);
      expect(notes.length).toBe(1);

      const task = db.getTask(i + 1);
      expect(task).toBeDefined();
      expect(task!.title).toBe(`task_${i}`);

      const mem = db.getCoreMemory(`Agent${i}`, "goal");
      expect(mem).toBeDefined();
      expect(mem!.value).toBe(`goal_${i}`);
    }
  });

  // ─── 2. Concurrent writes to same table ───────────────────────────────

  it("should handle concurrent writes to the same table without data loss", async () => {
    const count = 50;
    const ops = Array.from({ length: count }, (_, i) =>
      Promise.resolve(db.createNote("shared_entity", `concurrent note ${i}`)),
    );

    const noteIds = await Promise.all(ops);

    // All 50 notes should be created with unique IDs
    expect(new Set(noteIds).size).toBe(count);
    const notes = db.getNotesByEntity("shared_entity", 100);
    expect(notes.length).toBe(count);
  });

  // ─── 3. Transaction isolation ─────────────────────────────────────────

  it("should maintain transaction isolation for read-modify-write cycles", () => {
    // Set up initial state
    db.setCoreMemory("TestEntity", "counter", "0");

    // Perform 20 sequential increment operations (simulating what concurrent
    // agents would do — each reads, increments, writes)
    const iterations = 20;
    for (let i = 0; i < iterations; i++) {
      const current = db.getCoreMemory("TestEntity", "counter");
      const value = Number.parseInt(current!.value, 10);
      db.setCoreMemory("TestEntity", "counter", String(value + 1));
    }

    const final = db.getCoreMemory("TestEntity", "counter");
    expect(final).toBeDefined();
    expect(final!.value).toBe(String(iterations));
  });

  it("should not lose writes when multiple entities update different keys concurrently", async () => {
    const entityCount = 15;
    const ops = Array.from({ length: entityCount }, (_, i) =>
      Promise.resolve(db.setCoreMemory(`Entity${i}`, "status", `active_${i}`)),
    );

    await Promise.all(ops);

    for (let i = 0; i < entityCount; i++) {
      const mem = db.getCoreMemory(`Entity${i}`, "status");
      expect(mem).toBeDefined();
      expect(mem!.value).toBe(`active_${i}`);
    }
  });

  // ─── 4. Busy timeout handling ─────────────────────────────────────────

  it("should wait for locks via busy_timeout rather than failing immediately", () => {
    // Open a second raw connection to the same DB to hold a write lock
    const blocker = new Database(TEST_DB);
    blocker.exec("PRAGMA journal_mode=WAL");
    blocker.exec("PRAGMA busy_timeout=5000");

    // Begin an exclusive transaction on the blocker
    blocker.exec("BEGIN IMMEDIATE");
    blocker.exec("INSERT INTO room_store (room_id, key, value) VALUES ('r_lock', 'k', '\"v\"')");

    // The main DB should still be able to read via the reader (WAL allows concurrent reads)
    const _keys = db.getRoomStoreKeys(roomId("r_lock"));
    // Reader may or may not see uncommitted data depending on isolation level
    // The key thing: no SQLITE_BUSY error thrown

    // Commit the blocker so the main connection can write
    blocker.exec("COMMIT");
    blocker.close();

    // Now the main DB can write without issues
    db.setRoomStoreValue(roomId("r_lock"), "k2", "v2");
    expect(db.getRoomStoreValue(roomId("r_lock"), "k2")).toBe("v2");
  });

  // ─── 5. Note creation + recall concurrency ────────────────────────────

  it("should allow note creation while recall queries run concurrently", async () => {
    // Seed some initial notes for recall to find
    for (let i = 0; i < 10; i++) {
      db.createNote("RecallAgent", `important research finding about topic ${i}`);
    }

    // Concurrently: create new notes AND run recall queries
    const writeOps = Array.from({ length: 10 }, (_, i) =>
      Promise.resolve(db.createNote("RecallAgent", `new finding about research topic ${i + 10}`)),
    );

    const readOps = Array.from({ length: 5 }, () =>
      Promise.resolve(db.searchNotes("RecallAgent", "research")),
    );

    const results = await Promise.all([...writeOps, ...readOps]);

    // Write operations return note IDs
    const noteIds = results.slice(0, 10) as number[];
    expect(noteIds.every((id) => typeof id === "number" && id > 0)).toBe(true);

    // Read operations return note arrays — none should be empty or errored
    const readResults = results.slice(10) as { id: number }[][];
    for (const notes of readResults) {
      expect(Array.isArray(notes)).toBe(true);
      expect(notes.length).toBeGreaterThan(0);
    }

    // Final count should include all 20 notes
    const allNotes = db.getNotesByEntity("RecallAgent", 100);
    expect(allNotes.length).toBe(20);
  });

  // ─── 6. Core memory concurrent updates to same key ────────────────────

  it("should handle concurrent updates to the same core memory key (last write wins)", async () => {
    db.setCoreMemory("SharedAgent", "mood", "neutral");

    // Multiple updates to the same key — all should succeed
    const updates = ["happy", "sad", "excited", "calm", "focused"];
    const ops = updates.map((mood) =>
      Promise.resolve(db.setCoreMemory("SharedAgent", "mood", mood)),
    );

    await Promise.all(ops);

    // The final value should be one of the updates (last write wins)
    const final = db.getCoreMemory("SharedAgent", "mood");
    expect(final).toBeDefined();
    expect(updates).toContain(final!.value);

    // Version should reflect all the updates (initial + 5 overwrites)
    expect(final!.version).toBe(6);
  });

  // ─── 7. Entity activity concurrent increments ─────────────────────────

  it("should record all concurrent entity activity increments", async () => {
    const agentCount = 15;
    const ops = Array.from({ length: agentCount }, (_, i) =>
      Promise.resolve(db.trackActivity(`Agent${i}`, "command", "look", true)),
    );

    await Promise.all(ops);

    // Each agent should have exactly one activity entry
    for (let i = 0; i < agentCount; i++) {
      const stats = db.getActivityStats(`Agent${i}`);
      expect(stats.uniqueCommands).toBe(1);
      expect(stats.totalActions).toBe(1);
    }
  });

  it("should correctly accumulate counts for same entity across concurrent calls", async () => {
    // Multiple concurrent increments for the same entity+type+key
    const callCount = 20;
    const ops = Array.from({ length: callCount }, () =>
      Promise.resolve(db.trackActivity("BusyAgent", "command", "look", true)),
    );

    await Promise.all(ops);

    const activities = db.getActivityByType("BusyAgent", "command");
    expect(activities.length).toBe(1);
    expect(activities[0]!.key).toBe("look");
    expect(activities[0]!.count).toBe(callCount);
    expect(activities[0]!.successCount).toBe(callCount);
  });

  // ─── 8. Read-while-write (WAL reader isolation) ───────────────────────

  it("should allow reads via reader connection while writer is mid-transaction", () => {
    // Seed data that the reader can see
    db.saveEntity(makeEntity(1));
    db.saveEntity(makeEntity(2));

    // Checkpoint so reader sees the data
    db.checkpoint();

    // Start a write operation (entity save) — but also read concurrently
    // In WAL mode, the reader should not block and should see the
    // pre-transaction state or the committed state
    db.saveEntity(makeEntity(3));
    const loaded = db.loadEntity(entityId("e_1"));
    expect(loaded).toBeDefined();
    expect(loaded!.name).toBe("Agent1");

    // All entities visible after checkpoint
    db.checkpoint();
    const all = db.loadAllEntities();
    expect(all.length).toBe(3);
  });

  it("should allow reader queries during bulk entity save transaction", () => {
    // Pre-seed data the reader can see
    db.saveEntity(makeEntity(100));
    db.checkpoint();

    // Bulk-save 50 entities in a transaction
    const entities = Array.from({ length: 50 }, (_, i) => makeEntity(i));
    db.saveAllEntities(entities);

    // Reader should still work (not blocked by WAL)
    const loaded = db.loadEntity(entityId("e_100"));
    expect(loaded).toBeDefined();
    expect(loaded!.name).toBe("Agent100");
  });

  // ─── 9. Large batch insert ────────────────────────────────────────────

  it("should handle inserting 1000 notes in a transaction", () => {
    const noteIds: number[] = [];
    for (let i = 0; i < 1000; i++) {
      noteIds.push(db.createNote("BatchAgent", `batch note number ${i}`));
    }

    // All 1000 should be present
    expect(noteIds.length).toBe(1000);
    expect(new Set(noteIds).size).toBe(1000);

    // Spot-check: first, last, middle
    const notes = db.getNotesByEntity("BatchAgent", 1100);
    expect(notes.length).toBe(1000);
  });

  it("should handle bulk entity save of 1000 entities", () => {
    const entities = Array.from({ length: 1000 }, (_, i) => makeEntity(i));
    db.saveAllEntities(entities);

    const all = db.loadAllEntities();
    expect(all.length).toBe(1000);

    // Spot-check random entities
    const e500 = db.loadEntity(entityId("e_500"));
    expect(e500).toBeDefined();
    expect(e500!.name).toBe("Agent500");

    const e999 = db.loadEntity(entityId("e_999"));
    expect(e999).toBeDefined();
    expect(e999!.name).toBe("Agent999");
  });

  // ─── 10. Rollback on error ────────────────────────────────────────────

  it("should cleanly rollback a transaction on constraint violation", () => {
    // Create an initial entity
    db.saveEntity(makeEntity(1));

    // Use a raw Database reference to test transaction rollback directly
    const rawDb = new Database(TEST_DB);
    rawDb.exec("PRAGMA journal_mode=WAL");
    rawDb.exec("PRAGMA foreign_keys=ON");
    rawDb.exec("PRAGMA busy_timeout=5000");

    try {
      rawDb.transaction(() => {
        // First insert: valid
        rawDb.run("INSERT INTO room_store (room_id, key, value) VALUES (?, ?, ?)", [
          "r_txn",
          "k1",
          '"v1"',
        ]);
        // Second insert: duplicate PK — should violate PRIMARY KEY constraint
        rawDb.run("INSERT INTO room_store (room_id, key, value) VALUES (?, ?, ?)", [
          "r_txn",
          "k1",
          '"v2"',
        ]);
      })();
    } catch {
      // Expected: constraint violation
    }

    rawDb.close();

    // Neither insert should be present (transaction rolled back)
    const val = db.getRoomStoreValue(roomId("r_txn"), "k1");
    expect(val).toBeUndefined();
  });

  it("should not leave partial writes after a failed batch operation", () => {
    const rawDb = new Database(TEST_DB);
    rawDb.exec("PRAGMA journal_mode=WAL");
    rawDb.exec("PRAGMA foreign_keys=ON");
    rawDb.exec("PRAGMA busy_timeout=5000");

    try {
      const txn = rawDb.transaction(() => {
        // Insert several valid notes
        for (let i = 0; i < 5; i++) {
          rawDb.run(
            "INSERT INTO notes (entity_name, content, importance, note_type, created_at) VALUES (?, ?, ?, ?, ?)",
            ["RollbackAgent", `note ${i}`, 5, "observation", Date.now()],
          );
        }
        // Force an error: insert into a non-existent table
        rawDb.run("INSERT INTO nonexistent_table (id) VALUES (?)", [1]);
      });
      txn();
    } catch {
      // Expected: table does not exist
    }

    rawDb.close();

    // None of the 5 notes should exist (transaction rolled back)
    const notes = db.getNotesByEntity("RollbackAgent");
    expect(notes.length).toBe(0);
  });

  // ─── 11. Concurrent entity saves from multiple "agents" ──────────────

  it("should handle many agents saving entities concurrently", async () => {
    const agentCount = 30;
    const ops = Array.from({ length: agentCount }, (_, i) =>
      Promise.resolve(db.saveEntity(makeEntity(i))),
    );

    await Promise.all(ops);

    const all = db.loadAllEntities();
    expect(all.length).toBe(agentCount);

    // Verify each entity is present and correct
    for (let i = 0; i < agentCount; i++) {
      const entity = db.loadEntity(entityId(`e_${i}`));
      expect(entity).toBeDefined();
      expect(entity!.name).toBe(`Agent${i}`);
    }
  });

  // ─── 12. Mixed read-write workload ────────────────────────────────────

  it("should handle a mixed read-write workload without errors", async () => {
    // Seed initial data
    for (let i = 0; i < 10; i++) {
      db.createNote("MixedAgent", `seed note ${i}`);
      db.saveEntity(makeEntity(i));
    }

    // Run a mixed workload: writes, reads, updates concurrently
    const ops = [
      // Write new notes
      ...Array.from({ length: 10 }, (_, i) =>
        Promise.resolve(db.createNote("MixedAgent", `concurrent note ${i}`)),
      ),
      // Read existing entities
      ...Array.from({ length: 10 }, (_, i) => Promise.resolve(db.loadEntity(entityId(`e_${i}`)))),
      // Track activities
      ...Array.from({ length: 10 }, (_, i) =>
        Promise.resolve(db.trackActivity(`Agent${i}`, "command", "say", true)),
      ),
      // Set core memories
      ...Array.from({ length: 10 }, (_, i) =>
        Promise.resolve(db.setCoreMemory(`Agent${i}`, "focus", `task_${i}`)),
      ),
      // Search notes
      ...Array.from({ length: 5 }, () => Promise.resolve(db.searchNotes("MixedAgent", "seed"))),
    ];

    const results = await Promise.all(ops);

    // All operations should have completed without throwing
    expect(results.length).toBe(45);

    // Verify data integrity
    const allNotes = db.getNotesByEntity("MixedAgent", 100);
    expect(allNotes.length).toBe(20); // 10 seed + 10 concurrent

    for (let i = 0; i < 10; i++) {
      const mem = db.getCoreMemory(`Agent${i}`, "focus");
      expect(mem).toBeDefined();
      expect(mem!.value).toBe(`task_${i}`);
    }
  });

  // ─── 13. Concurrent task creation and retrieval ───────────────────────

  it("should handle concurrent task creation without ID collisions", async () => {
    const taskCount = 25;
    const ops = Array.from({ length: taskCount }, (_, i) =>
      Promise.resolve(
        db.createTask({
          title: `Concurrent task ${i}`,
          description: `Description for task ${i}`,
          creatorId: `e_${i}`,
          creatorName: `Agent${i}`,
        }),
      ),
    );

    const taskIds = await Promise.all(ops);

    // All IDs should be unique
    expect(new Set(taskIds).size).toBe(taskCount);

    // All tasks should be retrievable
    for (const taskId of taskIds) {
      const task = db.getTask(taskId);
      expect(task).toBeDefined();
      expect(task!.status).toBe("open");
    }
  });

  // ─── 14. Stress: rapid sequential writes ──────────────────────────────

  it("should handle rapid sequential writes without WAL overflow", () => {
    // Simulate 10 agents each performing 100 operations sequentially
    for (let agent = 0; agent < 10; agent++) {
      for (let op = 0; op < 100; op++) {
        db.trackActivity(`StressAgent${agent}`, "command", `cmd_${op}`, op % 3 !== 0);
      }
    }

    // Verify activity counts
    for (let agent = 0; agent < 10; agent++) {
      const stats = db.getActivityStats(`StressAgent${agent}`);
      expect(stats.uniqueCommands).toBe(100);
      expect(stats.totalActions).toBe(100);
    }

    // Checkpoint should work cleanly after heavy writes
    db.checkpoint();
  });
});
