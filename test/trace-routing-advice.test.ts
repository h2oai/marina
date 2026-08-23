// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import type { TraceCohortComparison } from "../src/engine/trace-dataset";
import {
  adviseTraceAggregates,
  adviseTraceRouting,
  selectAdaptiveCandidate,
} from "../src/engine/trace-routing-advice";

function cohort(
  name: string,
  observed: number,
  successRate?: number,
  p50Ms?: number,
): TraceCohortComparison {
  return {
    dimension: "model",
    name,
    mechanics: {
      name,
      observed,
      eligible: observed,
      excludedPartial: 0,
      completed: successRate === undefined ? 0 : Math.round(successRate * observed),
      failed: 0,
      running: 0,
      ...(successRate === undefined ? {} : { successRate, terminalRate: 1 }),
      latency: {
        samples: p50Ms === undefined ? 0 : observed,
        ...(p50Ms === undefined ? {} : { p50Ms, p95Ms: p50Ms }),
      },
      ttft: { samples: 0 },
      tokens: { samples: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: { samples: 0, totalUsd: 0 },
    },
    judgments: { total: 0, passed: 0, failed: 0, inconclusive: 0, evaluators: 0, criteria: {} },
  };
}

describe("shadow routing advice", () => {
  test("reports insufficient evidence with fewer than two cohorts", () => {
    expect(adviseTraceRouting([cohort("a", 1)], "model")).toMatchObject({
      mode: "insufficient",
      candidates: [],
      advisoryOnly: true,
    });
  });

  test("identifies a unique Pareto candidate without inventing metric weights", () => {
    const result = adviseTraceRouting([cohort("a", 4, 1, 10), cohort("b", 4, 0.5, 20)], "model");
    expect(result).toMatchObject({ mode: "pareto", candidates: ["a"] });
    expect(result.reasons.join(" ")).toContain("Judgments are shown separately");
  });

  test("recommends exploration when cohorts are mechanically incomparable", () => {
    const result = adviseTraceRouting(
      [cohort("fast", 5, 0.5, 10), cohort("accurate", 2, 1, 30)],
      "model",
    );
    expect(result).toMatchObject({ mode: "explore", candidates: ["accurate"] });
    expect(result.reasons.join(" ")).toContain("counters popularity feedback");
  });

  test("applies advice only inside the already-eligible set and otherwise falls back", () => {
    const advice = adviseTraceRouting(
      [cohort("eligible", 2, 1, 10), cohort("other", 3, 0.5, 20)],
      "route",
    );
    expect(selectAdaptiveCandidate(["eligible"], advice, () => "fallback")).toMatchObject({
      target: "eligible",
      applied: true,
    });
    expect(selectAdaptiveCandidate(["different"], advice, () => "different")).toMatchObject({
      target: "different",
      applied: false,
    });
  });

  test("keeps autonomous-model and tool aggregate advice shadow-only", () => {
    const result = adviseTraceAggregates(
      [cohort("search", 4, 1, 10).mechanics, cohort("read", 4, 0.5, 20).mechanics],
      "tool",
    );
    expect(result).toMatchObject({
      dimension: "tool",
      mode: "pareto",
      candidates: ["search"],
      advisoryOnly: true,
    });
  });
});
