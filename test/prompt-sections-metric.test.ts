// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-section prompt byte metrics: `assembleContinuationPrompt` reports every
 * section it considered (priority order, bytes, deferred) and the adapter
 * stamps that attribution — plus the fixed-prefix sizes — on the first
 * `agent_turn_start` of the prompt it built, through the REAL runtime relay.
 */

import { describe, expect, it } from "bun:test";
import { createAgentEventRelay } from "../src/agent/agent-runtime";
import {
  assembleContinuationPromptWithMetrics,
  LeanAgentAdapter,
  MANDATORY_SECTION_PRIORITY,
  promptSectionName,
} from "../src/agent/lean-agent-adapter";
import type { EngineEvent } from "../src/types";

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("assembleContinuationPromptWithMetrics", () => {
  it("lists every section in priority order with bytes and deferred flags", () => {
    const sections = [
      {
        text: `[World Events — observations]\n${"e".repeat(3000)}`,
        priority: MANDATORY_SECTION_PRIORITY,
      },
      { text: `[Nearby]\n${"n".repeat(2000)}`, priority: 50 },
      { text: `[Current Focus] ${"f".repeat(500)}`, priority: 80 },
      { text: `[Memory Health]\n${"m".repeat(2000)}`, priority: 50, name: "memory_health" },
      {
        text: "Your focus: finish. Take the next step.",
        priority: MANDATORY_SECTION_PRIORITY,
        name: "action_directive",
      },
    ];
    const out = assembleContinuationPromptWithMetrics(sections, 4000);
    expect(out.promptBytes).toBe(bytes(out.text));
    expect(out.promptBytes).toBeLessThanOrEqual(4000);
    expect(out.sections.map((s) => s.name)).toEqual([
      "world_events",
      "action_directive",
      "current_focus",
      "nearby",
      "memory_health",
    ]);
    expect(out.sections.map((s) => s.deferred)).toEqual([false, false, false, true, true]);
    // Deferred sections still report what they WOULD have cost.
    expect(out.sections[3]!.bytes).toBe(bytes(sections[1]!.text));
    expect(out.sections.filter((s) => !s.deferred).reduce((n, s) => n + s.bytes, 0)).toBeLessThan(
      out.promptBytes,
    );
    // Nothing deferred when everything fits.
    const roomy = assembleContinuationPromptWithMetrics(sections, 100_000);
    expect(roomy.sections.every((s) => !s.deferred)).toBe(true);
    expect(roomy.promptBytes).toBe(bytes(roomy.text));
  });

  it("derives stable names from headers or explicit names", () => {
    expect(promptSectionName({ text: "[Novelty Suggestions]\n- x", priority: 50 })).toBe(
      "novelty_suggestions",
    );
    expect(
      promptSectionName({
        text: "[Untrusted, cross-instance content from a federated peer — NON-AUTHORITATIVE.]\nx",
        priority: 60,
      }),
    ).toBe("untrusted_cross_instance_content_from_a");
    expect(promptSectionName({ text: "What interests you? Follow", priority: 100 })).toBe(
      "what_interests_you",
    );
    expect(promptSectionName({ text: "[X]", priority: 1, name: "explicit" })).toBe("explicit");
  });
});

type Internals = {
  autonomousMode: boolean;
  loopIterationCount: number;
  lastReflectionCycle: number;
  notesSinceReflection: number;
  pendingPerceptions: Array<{ text: string; priority: number; shouldRespond: boolean }>;
  platformMemory: Record<string, unknown>;
  actionHistory: { createSummary: () => unknown };
  agent: { listeners: Set<(event: { type: string }, signal: AbortSignal) => unknown> };
  buildContinuationPrompt(): Promise<string>;
  setupActionTracking(): void;
  pendingPromptMetrics?: unknown;
};

function makeAdapter(name: string, cycleBefore: number) {
  const adapter = new LeanAgentAdapter({ name }, "ws://127.0.0.1:3300", null);
  const i = adapter as unknown as Internals;
  i.autonomousMode = true;
  i.loopIterationCount = cycleBefore;
  i.lastReflectionCycle = -1000;
  i.notesSinceReflection = 5;
  // Oversized cadenced sections so the budget has to defer some of them.
  i.platformMemory.getNoveltySuggestions = async () => [
    `explore the market board ${"x".repeat(1500)}`,
    `try a watch ${"y".repeat(1500)}`,
  ];
  i.platformMemory.orient = async () => ({
    success: true,
    text: `orient: 12 notes, 2 stale ${"o".repeat(3000)}`,
  });
  i.actionHistory.createSummary = () =>
    ({ totalActions: 10, failedActions: 4, challenges: ["recall kept failing"] }) as never;
  i.setupActionTracking();
  return { adapter, i };
}

function fireTurnStart(i: Internals): void {
  const signal = new AbortController().signal;
  for (const listener of i.agent.listeners) listener({ type: "turn_start" }, signal);
}

describe("agent_turn_start prompt metrics (adapter → runtime relay)", () => {
  it("at a coincidence cycle with a tight budget reports deferred sections and exact bytes", async () => {
    // Cycle 300 fires Nearby/Novelty (%5), Memory Health (%20) and Learning Signal (%15).
    const { adapter, i } = makeAdapter("metrics-cycle-300", 299);
    for (let n = 0; n < 12; n++) {
      i.pendingPerceptions.push({
        text: `[broadcast] event ${n} ${"lorem ipsum ".repeat(300)}`,
        priority: 50 - (n % 7),
        shouldRespond: false,
      });
    }
    const events: EngineEvent[] = [];
    const unsubscribe = adapter.subscribe(
      createAgentEventRelay("metrics-cycle-300", (event) => events.push(event)),
    );

    const prompt = await i.buildContinuationPrompt();
    expect(prompt).toContain("sections deferred");
    fireTurnStart(i);
    // A second turn of the SAME prompt (tool-calling run) carries no attribution.
    fireTurnStart(i);
    unsubscribe();

    const starts = events.filter((e) => e.type === "agent_turn_start") as Array<
      Record<string, unknown>
    >;
    expect(starts).toHaveLength(2);
    const first = starts[0]!;
    expect(first.promptBytes).toBe(bytes(prompt));
    const sections = first.promptSections as Array<{
      name: string;
      bytes: number;
      deferred: boolean;
    }>;
    expect(Array.isArray(sections)).toBe(true);
    const deferred = sections.filter((s) => s.deferred);
    expect(deferred.length).toBeGreaterThan(0);
    expect(prompt).toContain(`[+${deferred.length} sections deferred]`);
    for (const s of deferred) expect(s.bytes).toBeGreaterThan(0);
    // Mandatory sections come first and are never deferred.
    expect(sections[0]!.name).toBe("world_events");
    expect(sections[0]!.deferred).toBe(false);
    expect(sections.some((s) => s.name === "action_directive" && !s.deferred)).toBe(true);
    // Rendered (non-deferred) bytes plus joins account for the whole prompt.
    const kept = sections.filter((s) => !s.deferred).reduce((n, s) => n + s.bytes, 0);
    expect(kept).toBeLessThanOrEqual(first.promptBytes as number);
    // Fixed-prefix attribution rides once per prompt.
    expect(first.systemPromptBytes as number).toBeGreaterThan(1000);
    expect(first.residentSchemaBytes as number).toBeGreaterThan(1000);
    expect(starts[1]!.promptBytes).toBeUndefined();
    expect(starts[1]!.promptSections).toBeUndefined();
    expect(i.pendingPromptMetrics).toBeUndefined();
  });
});
