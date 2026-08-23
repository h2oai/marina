// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { evaluateTrace } from "../src/engine/trace-evaluation";
import type { TraceSpanView, TraceView } from "../src/engine/trace-projection";

function span(
  input: Partial<TraceSpanView> & Pick<TraceSpanView, "spanId" | "kind">,
): TraceSpanView {
  return {
    name: input.spanId,
    status: "completed",
    startedAt: 100,
    endedAt: 110,
    durationMs: 10,
    partial: false,
    attributes: {},
    ...input,
  };
}

function trace(spans: TraceSpanView[]): TraceView {
  return {
    traceId: "trace",
    runId: "run",
    status: spans[0]?.status ?? "running",
    startedAt: 100,
    partial: spans.some((item) => item.partial),
    spans,
  };
}

describe("evaluateTrace", () => {
  it("passes completed, structurally sound execution without inventing a tool requirement", () => {
    const evaluation = evaluateTrace(trace([span({ spanId: "root", kind: "model_request" })]));
    expect(evaluation).toEqual({
      evaluator: "marina.execution.v2",
      checks: [
        expect.objectContaining({ id: "terminal_outcome", result: "passed" }),
        expect.objectContaining({ id: "history_integrity", result: "passed" }),
        expect.objectContaining({ id: "agent_turns", result: "not_applicable" }),
        expect.objectContaining({ id: "tool_results", result: "not_applicable" }),
        expect.objectContaining({ id: "metrics_integrity", result: "not_applicable" }),
      ],
    });
  });

  it("validates normalized metrics without treating their absence as failure", () => {
    const valid = evaluateTrace(
      trace([
        span({
          spanId: "valid",
          kind: "agent_turn",
          durationMs: 10,
          attributes: { ttftMs: 3, inputTokens: 20, outputTokens: 5, costUsd: 0 },
        }),
      ]),
    );
    expect(valid.checks.find((item) => item.id === "metrics_integrity")).toMatchObject({
      result: "passed",
      evidenceSpanIds: ["valid"],
    });

    const invalid = evaluateTrace(
      trace([
        span({
          spanId: "invalid",
          kind: "agent_turn",
          durationMs: 10,
          attributes: { ttftMs: 11 },
        }),
      ]),
    );
    expect(invalid.checks.find((item) => item.id === "metrics_integrity")).toMatchObject({
      result: "failed",
      evidenceSpanIds: ["invalid"],
    });
  });

  it("reports root and tool failures independently with exact evidence", () => {
    const evaluation = evaluateTrace(
      trace([
        span({ spanId: "root", kind: "model_request", status: "failed" }),
        span({ spanId: "turn", parentSpanId: "root", kind: "agent_turn" }),
        span({ spanId: "tool", parentSpanId: "turn", kind: "tool", status: "failed" }),
      ]),
    );
    expect(evaluation.checks.find((item) => item.id === "terminal_outcome")).toMatchObject({
      result: "failed",
      evidenceSpanIds: ["root"],
    });
    expect(evaluation.checks.find((item) => item.id === "tool_results")).toMatchObject({
      result: "failed",
      evidenceSpanIds: ["tool"],
    });
  });

  it("keeps running work inconclusive and detects partial, missing, and cyclic parents", () => {
    const evaluation = evaluateTrace(
      trace([
        span({ spanId: "root", kind: "model_request", status: "running", endedAt: undefined }),
        span({ spanId: "partial", kind: "agent_turn", partial: true, parentSpanId: "missing" }),
        span({ spanId: "cycle-a", kind: "tool", parentSpanId: "cycle-b" }),
        span({ spanId: "cycle-b", kind: "tool", parentSpanId: "cycle-a" }),
      ]),
    );
    expect(evaluation.checks.find((item) => item.id === "terminal_outcome")?.result).toBe(
      "inconclusive",
    );
    expect(evaluation.checks.find((item) => item.id === "history_integrity")).toMatchObject({
      result: "failed",
      evidenceSpanIds: expect.arrayContaining(["partial", "cycle-a", "cycle-b"]),
    });
  });
});
