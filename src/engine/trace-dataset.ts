// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { TraceJudgmentRow } from "../persistence/db-entities";
import { analyzeTraces, type TraceAggregate } from "./trace-analytics";
import { evaluateTrace, type TraceEvaluation } from "./trace-evaluation";
import type { TraceView } from "./trace-projection";

export interface TraceWithJudgments extends TraceView {
  judgments?: TraceJudgmentRow[];
}

export interface TraceEvaluationCase {
  trace: TraceView;
  judgments: TraceJudgmentRow[];
  evaluation: TraceEvaluation;
}

export interface TraceEvaluationDataset {
  schema: "marina.trace.dataset.v1";
  generatedAt: number;
  cases: TraceEvaluationCase[];
}

export interface JudgmentSummary {
  total: number;
  passed: number;
  failed: number;
  inconclusive: number;
  evaluators: number;
  criteria: Record<string, number>;
}

export interface TraceCohortComparison {
  dimension: "model" | "route";
  name: string;
  mechanics: TraceAggregate;
  judgments: JudgmentSummary;
}

/** Export structural evidence that can replay Marina evaluators without private request content. */
export function buildTraceDataset(
  traces: readonly TraceWithJudgments[],
  generatedAt = Date.now(),
): TraceEvaluationDataset {
  return {
    schema: "marina.trace.dataset.v1",
    generatedAt,
    cases: [...traces]
      .sort((a, b) => a.traceId.localeCompare(b.traceId))
      .map(({ judgments = [], ...trace }) => ({
        trace,
        judgments: [...judgments].sort(
          (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
        ),
        evaluation: evaluateTrace(trace),
      })),
  };
}

/** Recompute objective checks from the exported spans; authored judgments remain unchanged. */
export function replayTraceDataset(dataset: TraceEvaluationDataset): TraceEvaluationCase[] {
  return dataset.cases.map((item) => ({
    ...item,
    evaluation: evaluateTrace(item.trace),
  }));
}

/** Side-by-side descriptive cohorts. No winner, significance, or routing decision is inferred. */
export function compareTraceCohorts(
  traces: readonly TraceWithJudgments[],
  dimension: "model" | "route",
): TraceCohortComparison[] {
  const grouped = new Map<string, TraceWithJudgments[]>();
  for (const trace of traces) {
    const root = trace.spans.find((span) => span.kind === "model_request");
    const name =
      dimension === "model"
        ? root?.name
        : typeof root?.attributes.target === "string"
          ? root.attributes.target
          : undefined;
    if (!name) continue;
    const rows = grouped.get(name) ?? [];
    rows.push(trace);
    grouped.set(name, rows);
  }
  return [...grouped.entries()]
    .map(([name, cohort]) => {
      const analytics = analyzeTraces(cohort);
      const mechanics =
        (dimension === "model" ? analytics.models : analytics.routes).find(
          (row) => row.name === name,
        ) ?? emptyAggregate(name);
      return { dimension, name, mechanics, judgments: summarizeJudgments(cohort) };
    })
    .sort((a, b) => b.mechanics.observed - a.mechanics.observed || a.name.localeCompare(b.name));
}

function summarizeJudgments(traces: readonly TraceWithJudgments[]): JudgmentSummary {
  const rows = traces.flatMap((trace) => trace.judgments ?? []);
  const criteria: Record<string, number> = {};
  for (const row of rows) criteria[row.criterion] = (criteria[row.criterion] ?? 0) + 1;
  return {
    total: rows.length,
    passed: rows.filter((row) => row.verdict === "passed").length,
    failed: rows.filter((row) => row.verdict === "failed").length,
    inconclusive: rows.filter((row) => row.verdict === "inconclusive").length,
    evaluators: new Set(rows.map((row) => row.evaluatorEntity)).size,
    criteria: Object.fromEntries(Object.entries(criteria).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function emptyAggregate(name: string): TraceAggregate {
  return {
    name,
    observed: 0,
    eligible: 0,
    excludedPartial: 0,
    completed: 0,
    failed: 0,
    running: 0,
    latency: { samples: 0 },
  };
}
