// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standing answers for questions that stay open for days: re-forecast on a
 * cadence, but REVISE a filed answer only on a material change — a confidence
 * gain, or the same-or-better confidence on materially new evidence. A changed
 * string with nothing behind it is noise and keeps the standing answer. Every
 * decision (kept or revised) carries its reason so the caller can ledger it.
 *
 * The cadence is generic: a daily run until the deadline plus one final run a
 * fixed lead before it. Competitions supply their deadline (a thin adapter).
 */

export interface StandingAnswer {
  prediction: string;
  /** 0–1, the forecaster's own agreement / confidence. */
  confidence?: number;
  /** The answer is a fallback (no forecast came back). */
  fallback?: boolean;
  /** The research lines the forecast kept, for the evidence-change test. */
  evidence?: string;
  /** ISO time the answer was produced. */
  at: string;
}

export interface RevisionPolicy {
  /** Revise when confidence rises by at least this much. */
  minConfidenceGain: number;
  /** Evidence counts as new when token overlap with the standing answer's falls below this. */
  evidenceOverlapBelow: number;
  /** Numeric answers within this relative distance are the same answer. */
  numericTolerance: number;
}

export const DEFAULT_REVISION_POLICY: RevisionPolicy = {
  minConfidenceGain: 0.1,
  evidenceOverlapBelow: 0.6,
  numericTolerance: 0.02,
};

export interface RevisionDecision {
  revise: boolean;
  reason: string;
}

const empty = (a: StandingAnswer) => a.fallback === true || a.prediction.trim() === "";

function canonical(p: string): string {
  const items = p
    .toLowerCase()
    .split(/\s*[,;|]\s*/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return items.sort().join("|");
}

function asNumber(p: string): number | undefined {
  const s = p.replace(/[,\s%$]/g, "");
  if (!/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
}

/** Jaccard overlap of two evidence texts' word sets (1 = same evidence). */
export function evidenceOverlap(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 && y.size === 0) return 1;
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return both / (x.size + y.size - both);
}

/** Should `next` replace the standing answer `prev`? */
export function decideRevision(
  prev: StandingAnswer | undefined,
  next: StandingAnswer,
  policy: RevisionPolicy = DEFAULT_REVISION_POLICY,
): RevisionDecision {
  if (!prev)
    return { revise: true, reason: empty(next) ? "first answer (fallback)" : "first answer" };
  if (empty(next)) return { revise: false, reason: "new run fell back; standing answer kept" };
  if (empty(prev)) return { revise: true, reason: "replaces a fallback" };
  if (canonical(prev.prediction) === canonical(next.prediction)) {
    return { revise: false, reason: "unchanged" };
  }
  const a = asNumber(prev.prediction);
  const b = asNumber(next.prediction);
  if (a !== undefined && b !== undefined) {
    const rel = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9);
    if (rel <= policy.numericTolerance) {
      return { revise: false, reason: `within numeric tolerance (${(rel * 100).toFixed(1)}%)` };
    }
  }
  const gain = (next.confidence ?? 0) - (prev.confidence ?? 0);
  if (gain >= policy.minConfidenceGain) {
    return { revise: true, reason: `confidence +${gain.toFixed(2)}` };
  }
  if (prev.evidence !== undefined && next.evidence !== undefined) {
    const overlap = evidenceOverlap(prev.evidence, next.evidence);
    if (overlap < policy.evidenceOverlapBelow && gain > -policy.minConfidenceGain / 2) {
      return { revise: true, reason: `new evidence (overlap ${overlap.toFixed(2)})` };
    }
  }
  return {
    revise: false,
    reason: `change not material (confidence ${gain >= 0 ? "+" : ""}${gain.toFixed(2)})`,
  };
}

export interface RevisionEntry {
  id: string;
  at: string;
  revised: boolean;
  reason: string;
  from?: string;
  to: string;
}

/**
 * Apply one run's answers to the standing set. Returns the new standing set
 * (never mutates the input) and one entry per answer considered.
 */
export function reviseStanding(
  standing: Readonly<Record<string, StandingAnswer>>,
  run: ReadonlyArray<{ id: string; answer: StandingAnswer }>,
  policy: RevisionPolicy = DEFAULT_REVISION_POLICY,
): { standing: Record<string, StandingAnswer>; entries: RevisionEntry[] } {
  const out: Record<string, StandingAnswer> = { ...standing };
  const entries: RevisionEntry[] = [];
  for (const { id, answer } of run) {
    const prev = standing[id];
    const d = decideRevision(prev, answer, policy);
    if (d.revise) out[id] = answer;
    entries.push({
      id,
      at: answer.at,
      revised: d.revise,
      reason: d.reason,
      ...(prev ? { from: prev.prediction } : {}),
      to: answer.prediction,
    });
  }
  return { standing: out, entries };
}

/** The next weekly deadline strictly after `now` (`weekday` 0 = Sunday, UTC). */
export function nextWeeklyDeadline(now: Date, weekday: number, hourUtc: number): Date {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0),
  );
  d.setUTCDate(d.getUTCDate() + ((weekday - d.getUTCDay() + 7) % 7));
  if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 7);
  return d;
}

export type DueRun = "final" | "daily";

/**
 * Which re-forecast, if any, is due at `now`: the `final` run once inside the
 * lead window before the deadline (once), else a `daily` run on the first
 * check of each UTC day at or after `dailyHourUtc`. Nothing at or after the deadline.
 */
export function dueRun(input: {
  now: Date;
  deadline: Date;
  lastRunAt?: string;
  finalLeadMs: number;
  dailyHourUtc?: number;
}): DueRun | null {
  const now = input.now.getTime();
  const deadline = input.deadline.getTime();
  if (now >= deadline) return null;
  const last = input.lastRunAt ? Date.parse(input.lastRunAt) : Number.NEGATIVE_INFINITY;
  const finalAt = deadline - input.finalLeadMs;
  if (now >= finalAt) return last < finalAt ? "final" : null;
  if (input.now.getUTCHours() < (input.dailyHourUtc ?? 0)) return null;
  const today = input.now.toISOString().slice(0, 10);
  const lastDay = Number.isFinite(last) ? new Date(last).toISOString().slice(0, 10) : "";
  return lastDay === today ? null : "daily";
}
