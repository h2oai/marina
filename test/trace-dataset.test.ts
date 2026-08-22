// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  buildTraceDataset,
  compareTraceCohorts,
  replayTraceDataset,
  type TraceWithJudgments,
} from "../src/engine/trace-dataset";

function trace(id: string, model: string, target?: string): TraceWithJudgments {
  return {
    traceId: id,
    runId: id,
    status: "completed",
    startedAt: 10,
    endedAt: 20,
    durationMs: 10,
    partial: false,
    spans: [
      {
        spanId: `${id}-root`,
        kind: "model_request",
        name: model,
        status: "completed",
        startedAt: 10,
        endedAt: 20,
        durationMs: 10,
        partial: false,
        attributes: target ? { target } : {},
      },
    ],
  };
}

describe("trace evaluation datasets", () => {
  test("exports sorted structural cases and deterministically replays objective checks", () => {
    const dataset = buildTraceDataset([trace("z", "b"), trace("a", "a")], 123);
    expect(dataset.schema).toBe("marina.trace.dataset.v1");
    expect(dataset.generatedAt).toBe(123);
    expect(dataset.cases.map((item) => item.trace.traceId)).toEqual(["a", "z"]);
    expect(replayTraceDataset(dataset)).toEqual(dataset.cases);
    expect(JSON.stringify(dataset)).not.toContain("prompt");
  });

  test("compares cohorts with mechanics and attributed judgment denominators", () => {
    const first = trace("a", "model-a", "Ada");
    first.judgments = [
      {
        id: "j1",
        traceId: "a",
        evaluatorEntity: "Reviewer",
        verdict: "passed",
        criterion: "correctness",
        rationale: "matched",
        evidenceSpanIds: ["a-root"],
        createdAt: 1,
      },
    ];
    const rows = compareTraceCohorts([first, trace("b", "model-b", "Bob")], "model");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      dimension: "model",
      name: "model-a",
      mechanics: { observed: 1, eligible: 1 },
      judgments: { total: 1, passed: 1, evaluators: 1, criteria: { correctness: 1 } },
    });
  });

  test("route cohorts omit traces with no observed selected target", () => {
    const rows = compareTraceCohorts([trace("a", "model", "Ada"), trace("b", "fast")], "route");
    expect(rows.map((row) => row.name)).toEqual(["Ada"]);
  });
});
