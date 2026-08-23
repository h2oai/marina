// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { EngineEvent } from "../types";

export type TraceStatus = "running" | "completed" | "failed";

export interface TraceSpanView {
  spanId: string;
  parentSpanId?: string;
  kind: "model_request" | "agent_turn" | "tool";
  name: string;
  status: TraceStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  partial: boolean;
  attributes: Record<string, string | number | boolean>;
}

export interface TraceView {
  traceId: string;
  runId: string;
  status: TraceStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  partial: boolean;
  spans: TraceSpanView[];
}

interface MutableSpan extends TraceSpanView {
  observedStart: boolean;
  observedEnd: boolean;
}

interface MutableTrace {
  traceId: string;
  runId: string;
  spans: Map<string, MutableSpan>;
}

/** Build a bounded read model from the canonical events already held by Marina. */
export function projectTraces(events: readonly EngineEvent[]): TraceView[] {
  const traces = new Map<string, MutableTrace>();

  for (const event of events) {
    if (
      event.type !== "model_request_lifecycle" &&
      event.type !== "agent_turn_start" &&
      event.type !== "agent_turn_end" &&
      event.type !== "agent_tool_call" &&
      event.type !== "agent_tool_result"
    ) {
      continue;
    }
    if (!("traceId" in event) || !("spanId" in event) || !event.traceId || !event.spanId) continue;
    const runId = ("runId" in event && event.runId) || event.traceId;
    const trace = traces.get(event.traceId) ?? {
      traceId: event.traceId,
      runId,
      spans: new Map<string, MutableSpan>(),
    };
    traces.set(event.traceId, trace);

    if (event.type === "model_request_lifecycle") {
      const isStart = event.phase === "received";
      const isEnd = event.phase === "completed" || event.phase === "failed";
      upsertSpan(trace, {
        spanId: event.spanId,
        kind: "model_request",
        name: event.model,
        timestamp: event.timestamp,
        isStart,
        isEnd,
        failed: event.phase === "failed",
        durationMs: event.durationMs,
        attributes: {
          requestId: event.requestId,
          phase: event.phase,
          ...(event.target ? { target: event.target } : {}),
          ...(event.routeStrategy ? { routeStrategy: event.routeStrategy } : {}),
          ...(event.candidateCount === undefined ? {} : { candidateCount: event.candidateCount }),
          ...(event.routeAdviceMode ? { routeAdviceMode: event.routeAdviceMode } : {}),
          ...(event.routeReason ? { routeReason: event.routeReason } : {}),
          ...(event.routeKind ? { routeKind: event.routeKind } : {}),
          ...(event.detail ? { detail: event.detail } : {}),
        },
      });
    } else if (event.type === "agent_turn_start" || event.type === "agent_turn_end") {
      upsertSpan(trace, {
        spanId: event.spanId,
        parentSpanId: event.parentSpanId,
        kind: "agent_turn",
        name: event.name,
        timestamp: event.timestamp,
        isStart: event.type === "agent_turn_start",
        isEnd: event.type === "agent_turn_end",
        failed: false,
        attributes:
          event.type === "agent_turn_end"
            ? { hadToolCalls: event.hadToolCalls, toolCount: event.toolCount }
            : {},
      });
    } else if (event.type === "agent_tool_call" || event.type === "agent_tool_result") {
      upsertSpan(trace, {
        spanId: event.spanId,
        parentSpanId: event.parentSpanId,
        kind: "tool",
        name: event.toolName,
        timestamp: event.timestamp,
        isStart: event.type === "agent_tool_call",
        isEnd: event.type === "agent_tool_result",
        failed: event.type === "agent_tool_result" && event.isError,
        attributes:
          event.type === "agent_tool_call"
            ? {
                agent: event.name,
                ...(event.risk ? { risk: event.risk } : {}),
              }
            : { agent: event.name, isError: event.isError },
      });
    }
  }

  return [...traces.values()]
    .map(finalizeTrace)
    .sort((a, b) => b.startedAt - a.startedAt || a.traceId.localeCompare(b.traceId));
}

function upsertSpan(
  trace: MutableTrace,
  input: {
    spanId: string;
    parentSpanId?: string;
    kind: TraceSpanView["kind"];
    name: string;
    timestamp: number;
    isStart: boolean;
    isEnd: boolean;
    failed: boolean;
    durationMs?: number;
    attributes: TraceSpanView["attributes"];
  },
): void {
  const existing = trace.spans.get(input.spanId);
  const span: MutableSpan = existing ?? {
    spanId: input.spanId,
    parentSpanId: input.parentSpanId,
    kind: input.kind,
    name: input.name,
    status: "running",
    startedAt:
      input.durationMs === undefined ? input.timestamp : input.timestamp - input.durationMs,
    partial: true,
    attributes: {},
    observedStart: false,
    observedEnd: false,
  };
  if (input.isStart) {
    span.startedAt = Math.min(span.startedAt, input.timestamp);
    span.observedStart = true;
  }
  if (input.isEnd) {
    span.endedAt = input.timestamp;
    span.durationMs = input.durationMs ?? Math.max(0, input.timestamp - span.startedAt);
    span.status = input.failed ? "failed" : "completed";
    span.observedEnd = true;
  }
  span.parentSpanId ??= input.parentSpanId;
  span.attributes = { ...span.attributes, ...input.attributes };
  // Missing starts indicate retention trimming or a producer that joined late.
  // A missing end is represented truthfully by status="running", not partial.
  span.partial = !span.observedStart;
  trace.spans.set(input.spanId, span);
}

function finalizeTrace(trace: MutableTrace): TraceView {
  const spans = [...trace.spans.values()]
    .map(({ observedStart: _start, observedEnd: _end, ...span }) => span)
    .sort((a, b) => a.startedAt - b.startedAt || a.spanId.localeCompare(b.spanId));
  const root = spans.find((span) => span.kind === "model_request") ?? spans[0]!;
  const endedAt = root.endedAt;
  return {
    traceId: trace.traceId,
    runId: trace.runId,
    status: root.status,
    startedAt: root.startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(root.durationMs === undefined ? {} : { durationMs: root.durationMs }),
    partial: spans.some((span) => span.partial),
    spans,
  };
}
