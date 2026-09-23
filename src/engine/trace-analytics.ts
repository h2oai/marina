// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { EngineEvent } from "../types";
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

/** One continuation-prompt section of one agent turn (`agent_turn_start.promptSections[i]`). */
export interface PromptSectionSample {
  name: string;
  bytes: number;
  /** The section did not fit the budget this turn and was re-queued (not dropped). */
  deferred: boolean;
}

/** The prompt-budget metrics one `agent_turn_start` event carried. */
export interface PromptTurnSample {
  /** Total continuation-prompt bytes actually sent; absent on older producers. */
  promptBytes?: number;
  sections: readonly PromptSectionSample[];
}

/**
 * Per-section prompt mechanics over a window of turns. Byte statistics
 * (`meanBytes`, `p95Bytes`, `share`) cover the appearances that REACHED the
 * prompt (non-deferred) — a deferred section's reported size is what it would
 * have cost, not what was sent — while `deferralRate` counts every appearance.
 */
export interface PromptSectionAggregate {
  name: string;
  /** Turns in which the section appeared (deferred or not). */
  turns: number;
  meanBytes: number;
  /** Nearest-rank p95 of the non-deferred byte sizes. */
  p95Bytes: number;
  /** deferred appearances / `turns`, 0..1. */
  deferralRate: number;
  /** Non-deferred bytes of this section / total prompt bytes of the window, 0..1. */
  share: number;
}

export interface TraceAnalytics {
  schema: "marina.trace.analytics.v1";
  tracesObserved: number;
  partialTraces: number;
  models: TraceAggregate[];
  agentModels: TraceAggregate[];
  routes: TraceAggregate[];
  tools: TraceAggregate[];
  /** Agent turns (spans) that carried `promptSections`. */
  promptTurnsSampled: number;
  /** Per-section prompt-budget mechanics over those turns, largest share first. */
  promptSections: PromptSectionAggregate[];
}

/**
 * Aggregate observed execution mechanics without assigning quality or routing scores.
 * Partial spans remain visible in `observed` but are excluded from rates and latency.
 */
export function analyzeTraces(traces: readonly TraceView[]): TraceAnalytics {
  const promptTurns = traces.flatMap((trace) =>
    trace.spans
      .filter((span) => span.kind === "agent_turn")
      .map(promptTurnSampleFromSpan)
      .filter((sample): sample is PromptTurnSample => sample !== undefined),
  );
  const prompt = aggregatePromptSections(promptTurns);
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
    promptTurnsSampled: prompt.turnsSampled,
    promptSections: prompt.sections,
  };
}

// ─── Prompt sections ────────────────────────────────────────────────────────

function isPromptSectionSample(value: unknown): value is PromptSectionSample {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    v.name.length > 0 &&
    typeof v.bytes === "number" &&
    Number.isFinite(v.bytes) &&
    v.bytes >= 0 &&
    typeof v.deferred === "boolean"
  );
}

function promptTurnSample(promptBytes: unknown, sections: unknown): PromptTurnSample | undefined {
  if (!Array.isArray(sections)) return undefined;
  const valid = sections.filter(isPromptSectionSample);
  if (valid.length === 0) return undefined;
  const total =
    typeof promptBytes === "number" && Number.isFinite(promptBytes) && promptBytes >= 0
      ? promptBytes
      : undefined;
  return { ...(total === undefined ? {} : { promptBytes: total }), sections: valid };
}

/** Read the prompt metrics an `agent_turn` span carries (`promptSections` is JSON on the span). */
export function promptTurnSampleFromSpan(span: TraceSpanView): PromptTurnSample | undefined {
  if (span.kind !== "agent_turn") return undefined;
  const raw = span.attributes.promptSections;
  if (typeof raw !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return promptTurnSample(span.attributes.promptBytes, parsed);
}

/** Read the prompt metrics straight off an `agent_turn_start` event (no projection needed). */
export function promptTurnSampleFromEvent(event: EngineEvent): PromptTurnSample | undefined {
  if (event.type !== "agent_turn_start") return undefined;
  return promptTurnSample(event.promptBytes, event.promptSections);
}

/**
 * Aggregate per-section prompt mechanics over a window of turns. The share
 * denominator is the window's total prompt bytes — `promptBytes` per turn when
 * the producer reported it, else that turn's non-deferred section bytes — so
 * shares of one window sum to ≤ 1 (framing bytes account for the rest).
 * Sections are ordered by share, then by name; deterministic for equal input.
 */
export function aggregatePromptSections(turns: readonly PromptTurnSample[]): {
  turnsSampled: number;
  totalPromptBytes: number;
  sections: PromptSectionAggregate[];
} {
  const grouped = new Map<string, { turns: number; deferred: number; sent: number[] }>();
  let totalPromptBytes = 0;
  for (const turn of turns) {
    let sentBytes = 0;
    for (const section of turn.sections) {
      const entry = grouped.get(section.name) ?? { turns: 0, deferred: 0, sent: [] };
      entry.turns++;
      if (section.deferred) entry.deferred++;
      else {
        entry.sent.push(section.bytes);
        sentBytes += section.bytes;
      }
      grouped.set(section.name, entry);
    }
    totalPromptBytes += turn.promptBytes ?? sentBytes;
  }
  const sections = [...grouped.entries()]
    .map(([name, entry]): PromptSectionAggregate => {
      const sorted = [...entry.sent].sort((a, b) => a - b);
      const sentTotal = sum(sorted);
      return {
        name,
        turns: entry.turns,
        meanBytes: sorted.length > 0 ? sentTotal / sorted.length : 0,
        p95Bytes: sorted.length > 0 ? percentile(sorted, 0.95) : 0,
        deferralRate: entry.turns > 0 ? entry.deferred / entry.turns : 0,
        share: totalPromptBytes > 0 ? sentTotal / totalPromptBytes : 0,
      };
    })
    .sort((a, b) => b.share - a.share || a.name.localeCompare(b.name));
  return { turnsSampled: turns.length, totalPromptBytes, sections };
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
