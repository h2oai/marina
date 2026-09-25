// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Is the decision backend actually answering? Configuration alone can't say —
 * and probing would cost a billed call — so this reads the `agent_decision`
 * events the harness already emits: a decision that failed carries `error`.
 * It matters operationally because a failing gate fails CLOSED and blocks
 * every world-mutating call it scores. Pure; readiness and the Ops view share it.
 */

import type { EngineEvent } from "../types";

export const DECISION_HEALTH_WINDOW_MS = 15 * 60_000;
/** At least this many failures before the backend is called degraded… */
export const DECISION_HEALTH_MIN_ERRORS = 3;
/** …and at least this share of the window's decisions. */
export const DECISION_HEALTH_ERROR_SHARE = 0.5;

export interface DecisionHealth {
  status: "ok" | "degraded";
  total: number;
  errors: number;
  windowMs: number;
  /** Most recent failure message, when there was one. */
  lastError?: string;
}

export function decisionHealth(
  events: Iterable<EngineEvent>,
  now = Date.now(),
  windowMs = DECISION_HEALTH_WINDOW_MS,
): DecisionHealth {
  const since = now - windowMs;
  let total = 0;
  let errors = 0;
  let lastError: { at: number; message: string } | undefined;
  for (const event of events) {
    if (event.type !== "agent_decision" || event.timestamp < since) continue;
    total++;
    if (!event.error) continue;
    errors++;
    if (!lastError || event.timestamp >= lastError.at) {
      lastError = { at: event.timestamp, message: event.error };
    }
  }
  const degraded =
    errors >= DECISION_HEALTH_MIN_ERRORS && errors / total >= DECISION_HEALTH_ERROR_SHARE;
  return {
    status: degraded ? "degraded" : "ok",
    total,
    errors,
    windowMs,
    ...(lastError ? { lastError: lastError.message } : {}),
  };
}
