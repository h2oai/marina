// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Coding-task mode in the lean agent adapter's continuation prompt.
 *
 * A session-bound coder (code do / CodeSessionDriver.assignAgent) must not
 * drown its assigned task in the cognitive-loop sections — novelty, memory
 * health, learning signal, ACE reflection, idle consolidation. While
 * setActiveCodingTask is set, those sections are suppressed and a compact
 * [Active Coding Task] section is injected EVERY cycle. Unlike crewResponder,
 * the loop still cycles without fresh perceptions (that behavior lives in
 * runAutonomousLoop and is untouched by task mode).
 *
 * The adapter constructor is I/O-free (MarinaClient connects only in start()),
 * so we can drive buildContinuationPrompt directly with stubbed platform
 * memory — same technique as the sendAttention pickup test in
 * agent-modules.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";

type AdapterInternals = {
  buildContinuationPrompt(): Promise<string>;
  loopIterationCount: number;
  lastReflectionCycle: number;
  notesSinceReflection: number;
  idleCycles: number;
  platformMemory: unknown;
  actionHistory: { createSummary: () => unknown };
};

/**
 * Adapter whose next buildContinuationPrompt runs at cycle 60 — divisible by
 * 5 (novelty), 20 (memory health), and 15 (learning signal) — with reflection
 * counters forced due and platform-memory calls stubbed to succeed. Without
 * task mode all four cognitive sections fire; with it, none may.
 */
function makeAdapterAtBusyCycle(name: string): {
  adapter: LeanAgentAdapter;
  internals: AdapterInternals;
} {
  const adapter = new LeanAgentAdapter({ name }, "ws://127.0.0.1:3300", null);
  const internals = adapter as unknown as AdapterInternals;
  internals.loopIterationCount = 59; // next prompt build = cycle 60
  internals.lastReflectionCycle = -100;
  internals.notesSinceReflection = 5;
  const platformMemory = internals.platformMemory as {
    getNoveltySuggestions: () => Promise<string[]>;
    orient: () => Promise<{ success: boolean; text: string }>;
  };
  platformMemory.getNoveltySuggestions = async () => ["explore the market board"];
  platformMemory.orient = async () => ({
    success: true,
    text: "orient snapshot: 12 notes, 2 stale",
  });
  internals.actionHistory.createSummary = () =>
    ({ totalActions: 10, failedActions: 4, challenges: ["recall kept failing"] }) as never;
  return { adapter, internals };
}

describe("coding-task mode — continuation prompt assembly", () => {
  it("baseline (no task): the cognitive sections all fire at a busy cycle", async () => {
    const { internals } = makeAdapterAtBusyCycle("coding-task-baseline");
    const prompt = await internals.buildContinuationPrompt();
    expect(prompt).toContain("[Novelty Suggestions]");
    expect(prompt).toContain("[Memory Health]");
    expect(prompt).toContain("[Learning Signal]");
    expect(prompt).toContain("[Reflection Due]");
    expect(prompt).not.toContain("[Active Coding Task]");
  });

  it("task mode suppresses novelty/memory-health/learning/reflection and injects the task", async () => {
    const { adapter, internals } = makeAdapterAtBusyCycle("coding-task-suppression");
    adapter.setActiveCodingTask("fix the off-by-one in the tokenizer");
    const prompt = await internals.buildContinuationPrompt();
    expect(prompt).not.toContain("[Novelty Suggestions]");
    expect(prompt).not.toContain("[Memory Health]");
    expect(prompt).not.toContain("[Learning Signal]");
    expect(prompt).not.toContain("[Reflection Due]");
    expect(prompt).toContain("[Active Coding Task]");
    expect(prompt).toContain("fix the off-by-one in the tokenizer");
    // The directive keeps the coder on marina_code and off the memory tools.
    expect(prompt).toContain("marina_code");
    expect(prompt).toContain("Do not use memory/pool/focus tools until this task is done.");
  });

  it("injects the task section EVERY cycle — no dedup, no TTL", async () => {
    const { adapter, internals } = makeAdapterAtBusyCycle("coding-task-every-cycle");
    adapter.setActiveCodingTask("add a health endpoint");
    const first = await internals.buildContinuationPrompt();
    const second = await internals.buildContinuationPrompt();
    const third = await internals.buildContinuationPrompt();
    for (const prompt of [first, second, third]) {
      expect(prompt).toContain("[Active Coding Task]");
      expect(prompt).toContain("add a health endpoint");
    }
  });

  it("suppresses idle consolidation while the task is active (loop keeps working, not tidying)", async () => {
    const baseline = new LeanAgentAdapter(
      { name: "coding-task-idle-baseline" },
      "ws://127.0.0.1:3300",
      null,
    );
    const baselineInternals = baseline as unknown as AdapterInternals;
    baselineInternals.idleCycles = 3; // increments to 4 in the build → consolidation path
    const quiet = await baselineInternals.buildContinuationPrompt();
    expect(quiet).toContain("[Quiet — nothing needs your attention]");

    const tasked = new LeanAgentAdapter(
      { name: "coding-task-idle-tasked" },
      "ws://127.0.0.1:3300",
      null,
    );
    tasked.setActiveCodingTask("refactor the parser");
    const taskedInternals = tasked as unknown as AdapterInternals;
    taskedInternals.idleCycles = 3;
    const prompt = await taskedInternals.buildContinuationPrompt();
    expect(prompt).not.toContain("[Quiet — nothing needs your attention]");
    expect(prompt).toContain("[Active Coding Task]");
    expect(prompt).toContain("refactor the parser");
  });

  it("clearing the task (null) restores the normal cognitive loop", async () => {
    const { adapter, internals } = makeAdapterAtBusyCycle("coding-task-clear");
    adapter.setActiveCodingTask("fix the tokenizer");
    internals.loopIterationCount = 58; // burn cycle 59 with the task set
    await internals.buildContinuationPrompt();
    adapter.setActiveCodingTask(null);
    const prompt = await internals.buildContinuationPrompt(); // cycle 60
    expect(prompt).not.toContain("[Active Coding Task]");
    expect(prompt).toContain("[Novelty Suggestions]");
    expect(prompt).toContain("[Memory Health]");
  });

  it("does NOT set crewResponder semantics — an empty/whitespace task is treated as cleared", () => {
    const adapter = new LeanAgentAdapter(
      { name: "coding-task-empty" },
      "ws://127.0.0.1:3300",
      null,
    );
    adapter.setActiveCodingTask("   ");
    const internals = adapter as unknown as { activeCodingTask: string | null };
    expect(internals.activeCodingTask).toBeNull();
  });
});
