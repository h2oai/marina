// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { TraceSpanView, TraceStatus, TraceView } from "./trace-projection";

export interface TraceLatencySummary {
  samples: number;
  p50Ms?: number;
  p95Ms?: number;
}

export interface TraceAggregate {
  name: string;
  observed: number;
  eligible: number;
  excludedPartial: number;
  completed: number;
  failed: number;
  running: number;
  terminalRate?: number;
  successRate?: number;
  latency: TraceLatencySummary;
  ttft: TraceLatencySummary;
  tokens: {
    samples: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  cost: { samples: number; totalUsd: number; averageUsd?: number };
}

export interface TraceAnalytics {
  schema: "marina.trace.analytics.v1";
  tracesObserved: number;
  partialTraces: number;
  models: TraceAggregate[];
  agentModels: TraceAggregate[];
  routes: TraceAggregate[];
  tools: TraceAggregate[];
}

/**
 * Aggregate observed execution mechanics without assigning quality or routing scores.
 * Partial spans remain visible in `observed` but are excluded from rates and latency.
 */
export function analyzeTraces(traces: readonly TraceView[]): TraceAnalytics {
  return {
    schema: "marina.trace.analytics.v1",
    tracesObserved: traces.length,
    partialTraces: traces.filter((trace) => trace.partial).length,
    models: aggregate(
      traces.flatMap((trace) => trace.spans.filter((span) => span.kind === "model_request")),
    ),
    agentModels: aggregate(
      traces.flatMap((trace) =>
        trace.spans
          .filter((span) => span.kind === "agent_turn" && typeof span.attributes.model === "string")
          .map((span) => ({ ...span, name: String(span.attributes.model) })),
      ),
    ),
    routes: aggregate(
      traces.flatMap((trace) =>
        trace.spans
          .filter(
            (span) => span.kind === "model_request" && typeof span.attributes.target === "string",
          )
          .map((span) => ({ ...span, name: String(span.attributes.target) })),
      ),
    ),
    tools: aggregate(traces.flatMap((trace) => trace.spans.filter((span) => span.kind === "tool"))),
  };
}

function aggregate(spans: readonly TraceSpanView[]): TraceAggregate[] {
  const grouped = new Map<string, TraceSpanView[]>();
  for (const span of spans) {
    const current = grouped.get(span.name) ?? [];
    current.push(span);
    grouped.set(span.name, current);
  }
  return [...grouped.entries()]
    .map(([name, observed]) => summarize(name, observed))
    .sort((a, b) => b.observed - a.observed || a.name.localeCompare(b.name));
}

function summarize(name: string, observed: readonly TraceSpanView[]): TraceAggregate {
  const eligible = observed.filter((span) => !span.partial);
  const count = (status: TraceStatus) => eligible.filter((span) => span.status === status).length;
  const completed = count("completed");
  const failed = count("failed");
  const running = count("running");
  const terminal = completed + failed;
  const durations = eligible
    .filter((span) => span.status !== "running" && span.durationMs !== undefined)
    .map((span) => span.durationMs!)
    .sort((a, b) => a - b);
  const terminalSpans = eligible.filter((span) => span.status !== "running");
  const metric = (name: string): number[] =>
    terminalSpans
      .map((span) => span.attributes[name])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const ttft = metric("ttftMs").sort((a, b) => a - b);
  const input = metric("inputTokens");
  const output = metric("outputTokens");
  const cacheRead = metric("cacheReadTokens");
  const cacheWrite = metric("cacheWriteTokens");
  const costs = metric("costUsd");
  return {
    name,
    observed: observed.length,
    eligible: eligible.length,
    excludedPartial: observed.length - eligible.length,
    completed,
    failed,
    running,
    ...(eligible.length > 0 ? { terminalRate: terminal / eligible.length } : {}),
    ...(terminal > 0 ? { successRate: completed / terminal } : {}),
    latency: {
      samples: durations.length,
      ...(durations.length > 0
        ? { p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95) }
        : {}),
    },
    ttft: {
      samples: ttft.length,
      ...(ttft.length > 0 ? { p50Ms: percentile(ttft, 0.5), p95Ms: percentile(ttft, 0.95) } : {}),
    },
    tokens: {
      samples: new Set(
        terminalSpans
          .filter((span) =>
            ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].some(
              (key) => typeof span.attributes[key] === "number",
            ),
          )
          .map((span) => span.spanId),
      ).size,
      input: sum(input),
      output: sum(output),
      cacheRead: sum(cacheRead),
      cacheWrite: sum(cacheWrite),
    },
    cost: {
      samples: costs.length,
      totalUsd: sum(costs),
      ...(costs.length > 0 ? { averageUsd: sum(costs) / costs.length } : {}),
    },
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Nearest-rank percentile: simple, deterministic, and well-defined for small samples. */
function percentile(sorted: readonly number[], proportion: number): number {
  const rank = Math.max(1, Math.ceil(proportion * sorted.length));
  return sorted[rank - 1]!;
}
