// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { analyzeTraces } from "../src/engine/trace-analytics";
import type { TraceSpanView, TraceView } from "../src/engine/trace-projection";

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
});
