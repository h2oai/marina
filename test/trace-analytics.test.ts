// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  aggregatePromptSections,
  analyzeTraces,
  promptTurnSampleFromEvent,
  promptTurnSampleFromSpan,
} from "../src/engine/trace-analytics";
import type { TraceSpanView, TraceView } from "../src/engine/trace-projection";
import type { EngineEvent } from "../src/types";

function span(overrides: Partial<TraceSpanView> = {}): TraceSpanView {
  return {
    spanId: "span",
    kind: "model_request",
    name: "model-a",
    status: "completed",
    startedAt: 100,
    endedAt: 200,
    durationMs: 100,
    partial: false,
    attributes: {},
    ...overrides,
  };
}

function trace(id: string, spans: TraceSpanView[], partial = false): TraceView {
  return {
    traceId: id,
    runId: id,
    status: "completed",
    startedAt: 100,
    endedAt: 200,
    durationMs: 100,
    partial,
    spans,
  };
}

describe("analyzeTraces", () => {
  test("reports model mechanics with explicit denominators and nearest-rank latency", () => {
    const analytics = analyzeTraces([
      trace("a", [span({ spanId: "a", durationMs: 10 })]),
      trace("b", [span({ spanId: "b", status: "failed", durationMs: 20 })]),
      trace("c", [
        span({ spanId: "c", status: "running", endedAt: undefined, durationMs: undefined }),
      ]),
      trace("d", [span({ spanId: "d", durationMs: 40 })]),
    ]);

    expect(analytics.models[0]).toEqual({
      name: "model-a",
      observed: 4,
      eligible: 4,
      excludedPartial: 0,
      completed: 2,
      failed: 1,
      running: 1,
      terminalRate: 0.75,
      successRate: 2 / 3,
      latency: { samples: 3, p50Ms: 20, p95Ms: 40 },
      ttft: { samples: 0 },
      tokens: { samples: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: { samples: 0, totalUsd: 0 },
    });
  });

  test("excludes partial spans from rates and latency without hiding them", () => {
    const analytics = analyzeTraces([
      trace("partial", [span({ partial: true, status: "failed", durationMs: 999 })], true),
    ]);

    expect(analytics).toMatchObject({ tracesObserved: 1, partialTraces: 1 });
    expect(analytics.models[0]).toEqual({
      name: "model-a",
      observed: 1,
      eligible: 0,
      excludedPartial: 1,
      completed: 0,
      failed: 0,
      running: 0,
      latency: { samples: 0 },
      ttft: { samples: 0 },
      tokens: { samples: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: { samples: 0, totalUsd: 0 },
    });
  });

  test("summarizes autonomous model usage without estimating missing values", () => {
    const analytics = analyzeTraces([
      trace("agent", [
        span({
          kind: "agent_turn",
          name: "Ada",
          attributes: {
            model: "local/qwen",
            origin: "autonomous",
            ttftMs: 25,
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 10,
            costUsd: 0,
          },
        }),
      ]),
    ]);

    expect(analytics.agentModels[0]).toMatchObject({
      name: "local/qwen",
      ttft: { samples: 1, p50Ms: 25 },
      tokens: { samples: 1, input: 100, output: 20, cacheRead: 10 },
      cost: { samples: 1, totalUsd: 0, averageUsd: 0 },
    });
  });

  test("groups tool spans independently and sorts by observed sample size", () => {
    const analytics = analyzeTraces([
      trace("tools", [
        span({ spanId: "root" }),
        span({ spanId: "z", kind: "tool", name: "search" }),
        span({ spanId: "y", kind: "tool", name: "read" }),
        span({ spanId: "x", kind: "tool", name: "search", status: "failed" }),
      ]),
    ]);

    expect(analytics.tools.map((row) => row.name)).toEqual(["search", "read"]);
    expect(analytics.tools[0]).toMatchObject({ observed: 2, completed: 1, failed: 1 });
  });

  test("groups selected routes from request attributes without inventing unselected routes", () => {
    const analytics = analyzeTraces([
      trace("routed", [span({ attributes: { target: "Ada", routeStrategy: "round-robin" } })]),
      trace("unrouted", [span({ spanId: "other", name: "fast-path" })]),
    ]);

    expect(analytics.routes).toHaveLength(1);
    expect(analytics.routes[0]).toMatchObject({ name: "Ada", observed: 1, completed: 1 });
  });

  test("reports no prompt sections when no turn carried metrics", () => {
    const analytics = analyzeTraces([trace("a", [span()])]);
    expect(analytics.promptTurnsSampled).toBe(0);
    expect(analytics.promptSections).toEqual([]);
  });
});

describe("prompt sections", () => {
  const turnSpan = (
    spanId: string,
    promptBytes: number | undefined,
    sections: readonly { name: string; bytes: number; deferred: boolean }[],
  ): TraceSpanView =>
    span({
      spanId,
      kind: "agent_turn",
      name: "Ada",
      attributes: {
        ...(promptBytes === undefined ? {} : { promptBytes }),
        promptSections: JSON.stringify(sections),
      },
    });

  test("aggregates mean, p95, deferral rate and share per section; deferred bytes never reach the share", () => {
    const turns = [
      // Turn 1: 4000 B prompt; events 2000, notes 1000, reflection deferred (would-be 900).
      {
        promptBytes: 4000,
        sections: [
          { name: "events", bytes: 2000, deferred: false },
          { name: "notes", bytes: 1000, deferred: false },
          { name: "reflection", bytes: 900, deferred: true },
        ],
      },
      // Turn 2: 6000 B prompt; events 3000, notes deferred, reflection 500.
      {
        promptBytes: 6000,
        sections: [
          { name: "events", bytes: 3000, deferred: false },
          { name: "notes", bytes: 1200, deferred: true },
          { name: "reflection", bytes: 500, deferred: false },
        ],
      },
      // Turn 3: producer without promptBytes → its sent bytes join the denominator.
      {
        sections: [
          { name: "events", bytes: 1000, deferred: false },
          { name: "notes", bytes: 500, deferred: false },
        ],
      },
    ];
    const result = aggregatePromptSections(turns);
    expect(result.turnsSampled).toBe(3);
    expect(result.totalPromptBytes).toBe(4000 + 6000 + 1500);
    expect(result.sections.map((row) => row.name)).toEqual(["events", "notes", "reflection"]);
    expect(result.sections[0]).toEqual({
      name: "events",
      turns: 3,
      meanBytes: 2000,
      p95Bytes: 3000,
      deferralRate: 0,
      share: 6000 / 11500,
    });
    expect(result.sections[1]).toEqual({
      name: "notes",
      turns: 3,
      // Only the two sent appearances count toward bytes: (1000 + 500) / 2.
      meanBytes: 750,
      p95Bytes: 1000,
      deferralRate: 1 / 3,
      share: 1500 / 11500,
    });
    expect(result.sections[2]).toEqual({
      name: "reflection",
      turns: 2,
      meanBytes: 500,
      p95Bytes: 500,
      deferralRate: 0.5,
      share: 500 / 11500,
    });
    // Shares of one window never exceed 1 (framing bytes are the remainder).
    expect(result.sections.reduce((n, row) => n + row.share, 0)).toBeLessThanOrEqual(1);
  });

  test("a section that was always deferred has zero byte statistics and a 100 % deferral rate", () => {
    const result = aggregatePromptSections([
      { promptBytes: 100, sections: [{ name: "stuck", bytes: 5000, deferred: true }] },
      { promptBytes: 100, sections: [{ name: "stuck", bytes: 5000, deferred: true }] },
    ]);
    expect(result.sections).toEqual([
      { name: "stuck", turns: 2, meanBytes: 0, p95Bytes: 0, deferralRate: 1, share: 0 },
    ]);
    expect(aggregatePromptSections([])).toEqual({
      turnsSampled: 0,
      totalPromptBytes: 0,
      sections: [],
    });
  });

  test("analyzeTraces reads the JSON attribute off agent_turn spans only and skips malformed ones", () => {
    const analytics = analyzeTraces([
      trace("a", [
        span({ spanId: "req" }),
        turnSpan("t1", 3000, [
          { name: "events", bytes: 2000, deferred: false },
          { name: "notes", bytes: 800, deferred: false },
        ]),
        turnSpan("t2", 3000, [
          { name: "events", bytes: 1000, deferred: false },
          { name: "notes", bytes: 900, deferred: true },
        ]),
        span({ spanId: "bad", kind: "agent_turn", attributes: { promptSections: "{nope" } }),
        span({ spanId: "old", kind: "agent_turn", attributes: { model: "x" } }),
        // A model_request span never contributes, even with the attribute present.
        span({
          spanId: "req2",
          attributes: {
            promptSections: JSON.stringify([{ name: "events", bytes: 1, deferred: false }]),
          },
        }),
      ]),
    ]);
    expect(analytics.promptTurnsSampled).toBe(2);
    expect(analytics.promptSections).toEqual([
      { name: "events", turns: 2, meanBytes: 1500, p95Bytes: 2000, deferralRate: 0, share: 0.5 },
      {
        name: "notes",
        turns: 2,
        meanBytes: 800,
        p95Bytes: 800,
        deferralRate: 0.5,
        share: 800 / 6000,
      },
    ]);
  });

  test("promptTurnSampleFromSpan / FromEvent validate shape and drop invalid entries", () => {
    expect(promptTurnSampleFromSpan(span({ kind: "tool" }))).toBeUndefined();
    expect(
      promptTurnSampleFromSpan(
        turnSpan("t", -5, [
          { name: "ok", bytes: 10, deferred: false },
          { name: "", bytes: 10, deferred: false },
          { name: "neg", bytes: -1, deferred: false },
        ]),
      ),
    ).toEqual({ sections: [{ name: "ok", bytes: 10, deferred: false }] });
    const event: EngineEvent = {
      type: "agent_turn_start",
      name: "Ada",
      traceId: "t",
      spanId: "s",
      promptBytes: 42,
      promptSections: [{ name: "events", bytes: 40, deferred: false }],
      timestamp: 1,
    };
    expect(promptTurnSampleFromEvent(event)).toEqual({
      promptBytes: 42,
      sections: [{ name: "events", bytes: 40, deferred: false }],
    });
    expect(
      promptTurnSampleFromEvent({ type: "agent_turn_start", name: "Ada", timestamp: 1 }),
    ).toBeUndefined();
    expect(
      promptTurnSampleFromEvent({
        type: "agent_turn_end",
        name: "Ada",
        hadToolCalls: false,
        toolCount: 0,
        timestamp: 1,
      }),
    ).toBeUndefined();
  });
});
