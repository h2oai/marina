// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { TraceSpanView, TraceView } from "./trace-projection";

export type TraceCheckResult = "passed" | "failed" | "inconclusive" | "not_applicable";

export interface TraceEvaluationCheck {
  id: "terminal_outcome" | "history_integrity" | "agent_turns" | "tool_results";
  result: TraceCheckResult;
  summary: string;
  evidenceSpanIds: string[];
}

export interface TraceEvaluation {
  evaluator: "marina.execution.v1";
  checks: TraceEvaluationCheck[];
}

/** Objective, threshold-free checks over one observed execution trace. */
export function evaluateTrace(trace: TraceView): TraceEvaluation {
  return {
    evaluator: "marina.execution.v1",
    checks: [
      terminalOutcome(trace),
      historyIntegrity(trace),
      spanGroupCheck(
        "agent_turns",
        "agent turn",
        trace.spans.filter((s) => s.kind === "agent_turn"),
      ),
      spanGroupCheck(
        "tool_results",
        "tool result",
        trace.spans.filter((s) => s.kind === "tool"),
      ),
    ],
  };
}

function terminalOutcome(trace: TraceView): TraceEvaluationCheck {
  const root = trace.spans.find((span) => span.kind === "model_request") ?? trace.spans[0];
  if (!root) {
    return check("terminal_outcome", "inconclusive", "No root span was observed.", []);
  }
  if (root.status === "failed") {
    return check("terminal_outcome", "failed", "The root span ended with an error.", [root.spanId]);
  }
  if (root.status === "running") {
    return check("terminal_outcome", "inconclusive", "The root span is still running.", [
      root.spanId,
    ]);
  }
  return check("terminal_outcome", "passed", "The root span completed.", [root.spanId]);
}

function historyIntegrity(trace: TraceView): TraceEvaluationCheck {
  const ids = new Set(trace.spans.map((span) => span.spanId));
  const evidence = new Set<string>();
  for (const span of trace.spans) {
    if (span.partial || (span.parentSpanId && !ids.has(span.parentSpanId)))
      evidence.add(span.spanId);
    if (hasParentCycle(span, trace.spans)) evidence.add(span.spanId);
  }
  if (evidence.size > 0) {
    return check(
      "history_integrity",
      "failed",
      "Observed history contains a partial span, missing parent, or parent cycle.",
      [...evidence],
    );
  }
  return check(
    "history_integrity",
    "passed",
    "All observed spans have complete starts and valid parent links.",
    trace.spans.map((span) => span.spanId),
  );
}

function spanGroupCheck(
  id: "agent_turns" | "tool_results",
  label: string,
  spans: TraceSpanView[],
): TraceEvaluationCheck {
  if (spans.length === 0) {
    return check(id, "not_applicable", `No ${label}s were observed.`, []);
  }
  const failed = spans.filter((span) => span.status === "failed");
  if (failed.length > 0) {
    return check(
      id,
      "failed",
      `${failed.length} of ${spans.length} ${label}s failed.`,
      ids(failed),
    );
  }
  const running = spans.filter((span) => span.status === "running");
  if (running.length > 0) {
    return check(
      id,
      "inconclusive",
      `${running.length} of ${spans.length} ${label}s are still running.`,
      ids(running),
    );
  }
  return check(id, "passed", `All ${spans.length} observed ${label}s completed.`, ids(spans));
}

function hasParentCycle(span: TraceSpanView, spans: readonly TraceSpanView[]): boolean {
  const byId = new Map(spans.map((candidate) => [candidate.spanId, candidate]));
  const seen = new Set<string>([span.spanId]);
  let parentId = span.parentSpanId;
  while (parentId) {
    if (seen.has(parentId)) return true;
    seen.add(parentId);
    parentId = byId.get(parentId)?.parentSpanId;
  }
  return false;
}

function ids(spans: TraceSpanView[]): string[] {
  return spans.map((span) => span.spanId);
}

function check(
  id: TraceEvaluationCheck["id"],
  result: TraceCheckResult,
  summary: string,
  evidenceSpanIds: string[],
): TraceEvaluationCheck {
  return { id, result, summary, evidenceSpanIds };
}
