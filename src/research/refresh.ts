// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { type EvidenceIndex, evidenceChanges } from "./evidence-index";
import { type ReleaseEvent, releasesDue } from "./survey";

export interface EvidenceRefreshState {
  /** Caller-owned access scope and exact target/config/input identity. Never shared across users. */
  key: string;
  forecastAt: string;
  evidence: EvidenceIndex;
  complete: boolean;
}

/** Called after fresh retrieval. Reuse saves the expensive panel, not the source check.
 * Failures and unknown provenance never become successful refreshes. A final run
 * remains mandatory even when nothing changed since the previous daily run.
 */
export function decideEvidenceRefresh(input: {
  previous?: EvidenceRefreshState;
  key: string;
  evidence?: EvidenceIndex;
  now: string;
  deadline: string;
  researchComplete: boolean;
  finalLeadMs?: number;
  maxAgeMs?: number;
  target?: string;
  releases?: ReleaseEvent[];
}): { run: boolean; reason: string } {
  const at = Date.parse(input.now);
  const deadline = Date.parse(input.deadline);
  const p = input.previous;
  if (![at, deadline].every(Number.isFinite) || at >= deadline)
    return { run: false, reason: "deadline closed or invalid" };
  if (!input.researchComplete)
    return { run: false, reason: "research incomplete; preserve accepted answer" };
  if (!p?.complete || p.key !== input.key || !input.evidence)
    return { run: true, reason: "no matching complete evidence state" };
  const previousAt = Date.parse(p.forecastAt);
  if (!Number.isFinite(previousAt) || previousAt > at)
    return { run: true, reason: "invalid prior forecast time" };
  if (
    input.target &&
    releasesDue(
      (input.releases ?? []).filter((r) => r.target === input.target),
      input.now,
      p.forecastAt,
    ).length
  )
    return { run: true, reason: "scheduled release needs verification" };
  const finalAt = deadline - (input.finalLeadMs ?? 2 * 3_600_000);
  if (at >= finalAt && previousAt < finalAt)
    return { run: true, reason: "mandatory final refresh" };
  if (at - previousAt >= (input.maxAgeMs ?? 24 * 3_600_000))
    return { run: true, reason: "maximum forecast age" };
  const change = evidenceChanges(p.evidence, input.evidence);
  return change.changed
    ? { run: true, reason: "evidence or vintage changed" }
    : { run: false, reason: "same claims and inputs; reuse complete forecast" };
}

/** Keys that record when something was read, not what was read. */
const READ_TIME_KEYS = new Set(["fetchedAt", "checkedAt", "capturedAt"]);

/**
 * `value` without read timestamps, at any depth: an evidence key must change
 * when the inputs change, not every time the same inputs are fetched again.
 */
export function withoutReadTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutReadTimes);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !READ_TIME_KEYS.has(k))
        .map(([k, v]) => [k, withoutReadTimes(v)]),
    );
  return value;
}
