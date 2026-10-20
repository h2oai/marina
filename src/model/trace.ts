// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Request traces for in-process model calls. Each `src/model` call mints a
 * request id (`req-…`, the id `trace show` takes) and emits the same
 * `model_request_lifecycle` events the `/v1` paths do, with `routeKind:
 * "direct"` (or `"fallback"` when served by the same model on another route),
 * the call's purpose and the caller's trace context. The engine attaches the
 * sink at boot (`attachModelTraceSink`), so the events land in the event log
 * and `projectTraces`; a command-line process without an engine mints ids but
 * records nothing.
 */

import type { EngineEvent } from "../types";

export type ModelLifecycleEvent = Extract<EngineEvent, { type: "model_request_lifecycle" }>;

/** Caller-supplied trace context; every field is optional. */
export interface ModelTraceContext {
  /** Who made the call: `forecast.analyst`, `learning.lesson`, `arena.crew`, … */
  caller?: string;
  /** Join an existing trace (a forecast run, a `/v1` request); else the call is its own trace. */
  traceId?: string;
  /** The span this call belongs under. */
  parentSpanId?: string;
  taskId?: string;
  roundId?: string;
  questionId?: string;
}

let sink: { emit: (event: ModelLifecycleEvent) => void } | undefined;

/** Route lifecycle events to `emit` (the engine's `logEvent`); returns the detach. */
export function attachModelTraceSink(emit: (event: ModelLifecycleEvent) => void): () => void {
  const attachment = { emit };
  sink = attachment;
  return () => {
    if (sink === attachment) sink = undefined;
  };
}

export function emitModelTrace(event: ModelLifecycleEvent): void {
  try {
    sink?.emit(event);
  } catch {
    // Tracing never fails the call it describes.
  }
}

/** Same shape as the `/v1` request ids (`newRequestId`), so `trace show` takes it. */
export function newModelRequestId(): string {
  return `req-${crypto.randomUUID().slice(0, 8)}`;
}

/** The context fields that become `context.<key>` span attributes. */
export function traceContextAttributes(
  ctx: ModelTraceContext | undefined,
): Record<string, string> | undefined {
  if (!ctx) return undefined;
  const out: Record<string, string> = {};
  for (const key of ["caller", "taskId", "roundId", "questionId"] as const) {
    const value = ctx[key];
    if (value) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}
