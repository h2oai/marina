// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { TraceStatus, TraceView } from "./trace-projection";

export interface TraceQuery {
  limit: number;
  cursor?: string;
  status?: TraceStatus;
  model?: string;
  agent?: string;
  tool?: string;
  q?: string;
  since?: number;
  until?: number;
}

export interface TracePage {
  traces: TraceView[];
  nextCursor?: string;
  hasMore: boolean;
}

interface TraceCursor {
  startedAt: number;
  traceId: string;
}

export function queryTraces(traces: readonly TraceView[], query: TraceQuery): TracePage {
  const cursor = query.cursor ? decodeTraceCursor(query.cursor) : undefined;
  const filtered = traces.filter((trace) => {
    if (cursor && !isAfterCursor(trace, cursor)) return false;
    if (query.status && trace.status !== query.status) return false;
    if (query.since !== undefined && trace.startedAt < query.since) return false;
    if (query.until !== undefined && trace.startedAt > query.until) return false;
    if (query.model && !matchesModel(trace, query.model)) return false;
    if (query.agent && !matchesAgent(trace, query.agent)) return false;
    if (query.tool && !matchesTool(trace, query.tool)) return false;
    if (query.q && !traceSearchText(trace).includes(query.q.toLowerCase())) return false;
    return true;
  });
  const page = filtered.slice(0, query.limit);
  const hasMore = filtered.length > query.limit;
  const last = page.at(-1);
  return {
    traces: page,
    hasMore,
    ...(hasMore && last ? { nextCursor: encodeTraceCursor(last) } : {}),
  };
}

export function encodeTraceCursor(trace: Pick<TraceView, "startedAt" | "traceId">): string {
  return btoa(JSON.stringify({ startedAt: trace.startedAt, traceId: trace.traceId }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeTraceCursor(cursor: string): TraceCursor {
  if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new Error("Invalid trace cursor.");
  }
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const parsed = JSON.parse(atob(base64)) as Partial<TraceCursor>;
    if (
      !Number.isFinite(parsed.startedAt) ||
      typeof parsed.traceId !== "string" ||
      parsed.traceId.length === 0 ||
      parsed.traceId.length > 256
    ) {
      throw new Error("invalid fields");
    }
    return { startedAt: parsed.startedAt!, traceId: parsed.traceId };
  } catch {
    throw new Error("Invalid trace cursor.");
  }
}

function isAfterCursor(trace: TraceView, cursor: TraceCursor): boolean {
  return (
    trace.startedAt < cursor.startedAt ||
    (trace.startedAt === cursor.startedAt && trace.traceId.localeCompare(cursor.traceId) > 0)
  );
}

function matchesModel(trace: TraceView, value: string): boolean {
  const needle = value.toLowerCase();
  return trace.spans.some(
    (span) =>
      (span.kind === "model_request" && span.name.toLowerCase().includes(needle)) ||
      String(span.attributes.model ?? "")
        .toLowerCase()
        .includes(needle),
  );
}

function matchesAgent(trace: TraceView, value: string): boolean {
  const needle = value.toLowerCase();
  return trace.spans.some(
    (span) =>
      (span.kind === "agent_turn" && span.name.toLowerCase().includes(needle)) ||
      String(span.attributes.agent ?? "")
        .toLowerCase()
        .includes(needle),
  );
}

function matchesTool(trace: TraceView, value: string): boolean {
  const needle = value.toLowerCase();
  return trace.spans.some(
    (span) => span.kind === "tool" && span.name.toLowerCase().includes(needle),
  );
}

function traceSearchText(trace: TraceView): string {
  return [
    trace.traceId,
    trace.runId,
    trace.status,
    ...trace.spans.flatMap((span) => [
      span.spanId,
      span.parentSpanId ?? "",
      span.kind,
      span.name,
      span.status,
      ...Object.entries(span.attributes).flatMap(([key, value]) => [key, String(value)]),
    ]),
  ]
    .join("\n")
    .toLowerCase();
}
