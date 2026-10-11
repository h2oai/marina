// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { noteWork, pendingWorkPatterns, type WorkSignal } from "../src/learning/work";
import { createTestEngine } from "./engine-fixture";
import { scopeProcessState } from "./process-state";

const signal: WorkSignal = {
  source: "tool-recovery",
  tool: "marina_command",
  errorClass: "not-found",
  succeeded: true,
  scope: { kind: "shared" },
  at: Date.parse("2026-10-01T00:00:00Z"),
};

describe("engine shutdown flushes lessons from work", () => {
  it("a short-lived process does not lose the patterns its work collected", async () => {
    using _state = scopeProcessState({ env: { MARINA_LESSONS_FROM_WORK: "observe" } });
    const world = createTestEngine();
    try {
      noteWork(world.db, signal);
      noteWork(world.db, signal);
      expect(pendingWorkPatterns(world.db)).toBe(1);
      await world.engine.shutdown();
      expect(pendingWorkPatterns(world.db)).toBe(0);
    } finally {
      await world.dispose();
    }
  });
});
