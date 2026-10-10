// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "bun:test";
import { codingTaskCompletionMatcher, terminalCodeLifecycle } from "../scripts/code";
import type { Perception } from "../src/sdk/client";

const lifecycle = (sessionId: string, runId: string, phase: string, metadata = {}): Perception =>
  ({
    kind: "message",
    data: { code: { event: "code_lifecycle", sessionId, phase, metadata: { runId, ...metadata } } },
    timestamp: Date.now(),
  }) as Perception;

it("ties headless completion to the received attempt and preserves verification and blocker details", () => {
  const match = codingTaskCompletionMatcher("session");
  expect(match(lifecycle("other", "foreign", "received"))).toBe(false);
  expect(match(lifecycle("other", "foreign", "completed"))).toBe(false);
  expect(match(lifecycle("session", "old", "completed"))).toBe(false);
  expect(match(lifecycle("session", "current", "received"))).toBe(false);
  expect(match(lifecycle("session", "old", "completed"))).toBe(false);
  expect(match(lifecycle("session", "current", "failed"))).toBe(false);
  const blocked = lifecycle("session", "current", "failed", { terminal: true, reason: "blocked" });
  expect(match(blocked)).toBe(true);
  expect(terminalCodeLifecycle(blocked)?.reason).toBe("blocked");
  const done = lifecycle("session", "current", "completed", {
    verification: "stale",
    summary: "Unverified work",
  });
  expect(match(done)).toBe(true);
  expect(terminalCodeLifecycle(done)).toMatchObject({
    phase: "completed",
    verification: "stale",
    summary: "Unverified work",
  });
});
