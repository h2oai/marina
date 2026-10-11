// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  claimParkedCarry,
  flushWorkLessons,
  noteWork,
  parkWorkCarry,
  pendingWorkPatterns,
  resetWorkLearner,
  WORK_CARRY_OWNER,
  type WorkSignal,
} from "../src/learning/work";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

const OBSERVE = { MARINA_LESSONS_FROM_WORK: "observe" } as NodeJS.ProcessEnv;

const signal = (over: Partial<WorkSignal> = {}): WorkSignal => ({
  source: "tool-recovery",
  tool: "marina_command",
  errorClass: "not-found",
  succeeded: true,
  scope: { kind: "shared" },
  at: Date.now(),
  ...over,
});

describe("engine shutdown flushes lessons from work", () => {
  it("a short-lived process does not lose the patterns its work collected", async () => {
    using _state = scopeProcessState({ env: { MARINA_LESSONS_FROM_WORK: "observe" } });
    const world = createTestEngine();
    try {
      // Old enough that the carry window has passed: learned or dropped, never parked.
      const old = signal({ at: Date.parse("2026-10-01T00:00:00Z") });
      noteWork(world.db, old);
      noteWork(world.db, old);
      expect(pendingWorkPatterns(world.db)).toBe(1);
      await world.engine.shutdown();
      expect(pendingWorkPatterns(world.db)).toBe(0);
      expect(world.db.getCoreMemory(WORK_CARRY_OWNER, "carry")).toBeUndefined();
    } finally {
      await world.dispose();
    }
  });

  it("a pattern below its floor is parked at shutdown and keeps counting in the next process", async () => {
    using _state = scopeProcessState({ env: { MARINA_LESSONS_FROM_WORK: "observe" } });
    const world = createTestEngine();
    try {
      noteWork(world.db, signal({ privateText: "case text that must never be stored" }));
      await world.engine.shutdown();
      const row = world.db.getCoreMemory(WORK_CARRY_OWNER, "carry");
      expect(row?.value).toContain("marina_command");
      expect(row?.value).not.toContain("case text");
      // The next process: a fresh learner claims the parked pattern, and one
      // more occurrence lifts it to its floor.
      resetWorkLearner(world.db);
      noteWork(world.db, signal());
      expect(world.db.getCoreMemory(WORK_CARRY_OWNER, "carry")).toBeUndefined();
      const report = await flushWorkLessons(world.db, { env: OBSERVE });
      expect(report?.candidates).toEqual({ "tool-recovery": 1 });
    } finally {
      resetWorkLearner(world.db);
      await world.dispose();
    }
  });

  it("parking merges with what another process parked; claiming takes it once", () => {
    const world = createTestEngine();
    try {
      noteWork(world.db, signal(), OBSERVE);
      expect(parkWorkCarry(world.db)).toBe(1);
      resetWorkLearner(world.db);
      // The next process's learner claims the parked row when it starts, so the
      // patterns are its own and parking again counts each occurrence once.
      noteWork(world.db, signal({ errorClass: "timeout" }), OBSERVE);
      noteWork(world.db, signal(), OBSERVE);
      expect(world.db.getCoreMemory(WORK_CARRY_OWNER, "carry")).toBeUndefined();
      expect(parkWorkCarry(world.db)).toBe(2);
      const claimed = claimParkedCarry(world.db);
      expect(claimed.map((p) => [p.errorClass, p.count]).sort()).toEqual([
        ["not-found", 2],
        ["timeout", 1],
      ]);
      expect(claimParkedCarry(world.db)).toEqual([]);
    } finally {
      resetWorkLearner(world.db);
    }
    return world.dispose();
  });
});
