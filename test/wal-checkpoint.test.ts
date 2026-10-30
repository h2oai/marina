// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WAL_CHECKPOINT_INTERVAL, WAL_CHECKPOINT_PHASE } from "../src/engine/tick-jobs";
import { MarinaDB, WAL_AUTOCHECKPOINT_PAGES } from "../src/persistence/database";
import { createTestEngine } from "./engine-fixture";

describe("WAL checkpoints", () => {
  test("a write never pays for a checkpoint before 64 MiB of WAL; PASSIVE moves the frames", () => {
    const dir = mkdtempSync(join(tmpdir(), "marina-wal-"));
    const path = join(dir, "world.db");
    const db = new MarinaDB(path);
    try {
      const raw = db.memoryRepository().raw;
      expect(
        raw.query("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number },
      ).toEqual({
        wal_autocheckpoint: WAL_AUTOCHECKPOINT_PAGES,
      });
      // 24 MiB of captures: past SQLite's default 4 MB autocheckpoint, under the backstop.
      db.createUser({ id: "o1", name: "Owner1" });
      const owner = { key: "o1", name: "Owner1" };
      const attempt = db.createInvestigation(
        owner,
        { kind: "prediction", question: "q" },
        "k",
      ).attempt;
      const generation = db.claimInvestigation(attempt.id)!;
      const payload = "x".repeat(2 * 1024 * 1024 - 2);
      for (let i = 0; i < 12; i++)
        db.storeInvestigationContent(attempt.id, generation, "quota", payload);
      expect(statSync(`${path}-wal`).size).toBeGreaterThan(20 * 1024 * 1024);
      const first = db.walCheckpoint();
      expect(first.busy).toBe(false);
      expect(first.log).toBeGreaterThan(0);
      expect(first.checkpointed).toBe(first.log);
      // Idempotent: the counts are cumulative for the current WAL, so a second pass
      // reports the same frames already moved, and nothing waits.
      expect(db.walCheckpoint()).toEqual(first);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the engine checkpoints from its own tick job, on a phase of its own", async () => {
    const world = createTestEngine();
    try {
      const job = world.engine.describeTickSchedule().find((j) => j.name === "wal-checkpoint");
      expect(job).toMatchObject({ every: WAL_CHECKPOINT_INTERVAL, phase: WAL_CHECKPOINT_PHASE });
    } finally {
      await world.dispose();
    }
  });
});
