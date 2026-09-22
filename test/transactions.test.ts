// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TaskManager } from "../src/coordination/task-manager";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

describe("multi-statement writes are atomic", () => {
  const path = `/tmp/marina-tx-${crypto.randomUUID()}.db`;
  let db: MarinaDB;
  let raw: Database;

  beforeEach(() => {
    db = new MarinaDB(path);
    raw = new Database(path);
  });

  afterEach(() => {
    raw.exec("DROP TRIGGER IF EXISTS inject_failure");
    raw.close();
    db.close();
    cleanupDb(path);
  });

  it("deleteNote rolls back link cleanup when the final delete fails", () => {
    const a = db.createNote("Alice", "original fact", undefined, { skipDedup: true });
    const b = db.createNote("Alice", "refined fact", undefined, {
      supersedesId: a,
      skipDedup: true,
    });
    db.createNoteLink(a, b, "related_to");
    expect(db.getNoteLinks(a)).toHaveLength(1);
    expect(db.getNote(b)?.supersedes_id).toBe(a);

    // Fail the LAST statement of deleteNote (the row delete itself).
    raw.exec(
      "CREATE TRIGGER inject_failure BEFORE DELETE ON notes BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    expect(() => db.deleteNote(a, "Alice")).toThrow("injected");

    // Nothing from the earlier statements survived the rollback.
    expect(db.getNote(a)).toBeDefined();
    expect(db.getNoteLinks(a)).toHaveLength(1);
    expect(db.getNote(b)?.supersedes_id).toBe(a);

    raw.exec("DROP TRIGGER inject_failure");
    expect(db.deleteNote(a, "Alice")).toBe(true);
    expect(db.getNote(a)).toBeUndefined();
    expect(db.getNoteLinks(b)).toHaveLength(0);
    expect(db.getNote(b)?.supersedes_id).toBeNull();
  });

  it("approveSubmission rolls back approval + completion when the standing write fails", () => {
    const tasks = new TaskManager(db);
    const task = tasks.create({
      title: "bounty",
      creatorId: "e_creator",
      creatorName: "Creator",
      validationMode: "bounty",
      standing: 5,
    });
    expect(tasks.claim(task.id, "e_alice", "Alice")).not.toBeNull();
    expect(tasks.claim(task.id, "e_bob", "Bob")).not.toBeNull();
    expect(tasks.submit(task.id, "e_alice", "done")).toBe(true);
    const statusBefore = tasks.get(task.id)?.status;

    // Fail the LAST write (standing credit). Monkey-patching the delegate keeps
    // the failure inside the transaction the manager opened.
    const original = db.recordStandingEarned.bind(db);
    db.recordStandingEarned = () => {
      throw new Error("injected standing failure");
    };
    expect(() => tasks.approveSubmission(task.id, "e_alice", "e_creator")).toThrow(
      "injected standing failure",
    );

    // Claim still submitted, task status untouched, Bob's claim not rejected.
    expect(tasks.getClaim(task.id, "e_alice")?.status).toBe("submitted");
    expect(tasks.getClaim(task.id, "e_bob")?.status).toBe("claimed");
    expect(tasks.get(task.id)?.status).toBe(statusBefore);
    expect((raw.query("SELECT COUNT(*) AS n FROM entity_standing").get() as { n: number }).n).toBe(
      0,
    );

    db.recordStandingEarned = original;
    expect(tasks.approveSubmission(task.id, "e_alice", "e_creator")).toBe(true);
    expect(tasks.getClaim(task.id, "e_alice")?.status).toBe("approved");
    expect(tasks.getClaim(task.id, "e_bob")?.status).toBe("rejected");
    expect(tasks.get(task.id)?.status).toBe("completed");
    expect((raw.query("SELECT COUNT(*) AS n FROM entity_standing").get() as { n: number }).n).toBe(
      1,
    );
  });

  it("MarinaDB.transaction rolls back every write when the callback throws", () => {
    expect(() =>
      db.transaction(() => {
        db.createNote("Alice", "one", undefined, { skipDedup: true });
        db.createNote("Alice", "two", undefined, { skipDedup: true });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.getNotesByEntity("Alice")).toHaveLength(0);
    expect(
      db.transaction(() => {
        db.createNote("Alice", "three", undefined, { skipDedup: true });
        return 42;
      }),
    ).toBe(42);
    expect(db.getNotesByEntity("Alice")).toHaveLength(1);
  });
});
