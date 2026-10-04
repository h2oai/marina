// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared arithmetic of the learned forecast parts (prior shrink,
 * recalibration): pooling in log-odds, proper scores over resolved records,
 * and the arena's adoption rule —
 *
 *   fit on the OLDER part of the visible history, score the candidate and the
 *   default on the NEWER part, adopt the candidate only if it improves the
 *   board's proper score there by at least `margin` (relative, default 5 %),
 *   then refit on everything visible.
 *
 * That is how the arena chose each series' spread (`src/arena/forecast.ts`,
 * `CALIBRATION_MARGIN`): a learned setting earns its place on outcomes it was
 * not fitted on, or the default stands. Pure functions.
 */

import { crpsNormal } from "../arena/score";
import type { AnswerOption } from "./answer-types";
import { type Distribution, normalise, PROBABILITY_FLOOR } from "./distribution";
import type { ForecastNumbers, ResolvedRecord } from "./history";

export type ProperScore = "brier" | "log";

const LO = PROBABILITY_FLOOR;
const HI = 1 - PROBABILITY_FLOOR;
export const clampP = (p: number) => Math.min(HI, Math.max(LO, p));
export const logit = (p: number) => {
  const q = clampP(p);
  return Math.log(q / (1 - q));
};
export const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/**
 * A distribution moved toward `prior` by `w` (0 = unchanged, 1 = the prior),
 * log-linearly (a geometric pool, renormalised) — for two options, exactly a
 * blend of their log-odds.
 */
export function poolDistribution(d: Distribution, prior: Distribution, w: number): Distribution {
  const out: Distribution = {};
  for (const k of Object.keys(d)) {
    const p = clampP(d[k] ?? 0);
    const q = clampP(prior[k] ?? p);
    out[k] = Math.exp((1 - w) * Math.log(p) + w * Math.log(q));
  }
  return normalise(out) ?? d;
}

/** Independent per-option probabilities moved toward `prior` by `w`, in log-odds. */
export function poolMarginals(d: Distribution, prior: Distribution, w: number): Distribution {
  const out: Distribution = {};
  for (const k of Object.keys(d)) {
    const z = (1 - w) * logit(d[k] ?? 0.5) + w * logit(prior[k] ?? d[k] ?? 0.5);
    out[k] = round(clampP(sigmoid(z)));
  }
  return out;
}

/** A number moved toward its prior by `w`; the spread blends the same way (when both have one). */
export function poolNumber(
  f: { value: number; sd?: number },
  prior: { value: number; sd?: number },
  w: number,
): { value: number; sd?: number } {
  const value = f.value + w * (prior.value - f.value);
  const sd =
    f.sd !== undefined && prior.sd !== undefined
      ? (1 - w) * f.sd + w * prior.sd
      : (f.sd ?? prior.sd);
  return { value: round(value, 6), ...(sd !== undefined ? { sd: round(sd, 6) } : {}) };
}

// ─── Proper scores of one record ─────────────────────────────────────────────

/**
 * The loss (lower is better) of `f` on a resolved record: Brier (multi-class
 * for a choice, per known option for a multi-select) or log loss for
 * probabilities; CRPS for a number with an sd (absolute error without one).
 * Undefined when the forecast and the outcome cannot be compared.
 */
export function recordLoss(
  r: ResolvedRecord,
  f: ForecastNumbers,
  score: ProperScore = "brier",
): number | undefined {
  if (r.answerType === "number") {
    if (f.value === undefined || r.outcome.value === undefined) return undefined;
    return f.sd !== undefined && f.sd > 0
      ? crpsNormal(f.value, f.sd, r.outcome.value)
      : Math.abs(f.value - r.outcome.value);
  }
  const d = f.distribution;
  if (!d) return undefined;
  const truth = new Set(r.outcome.options ?? []);
  if (r.answerType === "multi") {
    const known = r.resolvedOptions ?? Object.keys(d);
    const events = known.filter((o) => d[o] !== undefined);
    if (events.length === 0) return undefined;
    let s = 0;
    for (const o of events) s += eventLoss(d[o]!, truth.has(o), score);
    return s / events.length;
  }
  if (r.answerType !== "choice" || truth.size !== 1) return undefined;
  const ids = Object.keys(d);
  if (score === "log") {
    const [t] = [...truth];
    return -Math.log(clampP(d[t!] ?? 0));
  }
  return ids.reduce((s, o) => s + ((d[o] ?? 0) - (truth.has(o) ? 1 : 0)) ** 2, 0);
}

export function eventLoss(p: number, y: boolean, score: ProperScore): number {
  if (score === "log") return -Math.log(y ? clampP(p) : 1 - clampP(p));
  return (p - (y ? 1 : 0)) ** 2;
}

export function meanLoss(
  records: ResolvedRecord[],
  forecast: (r: ResolvedRecord) => ForecastNumbers | undefined,
  score: ProperScore,
): { loss: number; n: number } {
  let s = 0;
  let n = 0;
  for (const r of records) {
    const f = forecast(r);
    const l = f ? recordLoss(r, f, score) : undefined;
    if (l === undefined || !Number.isFinite(l)) continue;
    s += l;
    n++;
  }
  return { loss: n ? s / n : Number.NaN, n };
}

// ─── Adoption on held-out history ────────────────────────────────────────────

export interface AdoptionResult<P> {
  /** The parameters in force: the refit candidate when adopted, else the default. */
  params: P;
  adopted: boolean;
  /** The candidate as fitted on the older part (what the holdout judged). */
  candidate?: P;
  nFit: number;
  nHoldout: number;
  /** Holdout loss of the default and of the candidate (lower is better). */
  holdout?: { default: number; candidate: number; improvement: number };
  /** The newest outcome time used (ISO) — every one at or before the cutoff. */
  through?: string;
  reason: string;
}

export const DISCOVERY_SHARE = 0.6;

/**
 * The arena's rule over `records` (oldest first, all visible at the cutoff):
 * fit on the older `DISCOVERY_SHARE`, compare with the default on the rest,
 * adopt on a relative improvement ≥ `margin`, then refit on all.
 */
export function adoptOnHoldout<P>(
  records: ResolvedRecord[],
  opts: {
    fallback: P;
    fit: (rs: ResolvedRecord[]) => P | undefined;
    loss: (rs: ResolvedRecord[], p: P) => { loss: number; n: number };
    margin: number;
    minRecords: number;
  },
): AdoptionResult<P> {
  const through = records.at(-1)?.resolvedAt;
  const base = { params: opts.fallback, adopted: false, ...(through ? { through } : {}) };
  if (records.length < opts.minRecords) {
    return {
      ...base,
      nFit: 0,
      nHoldout: 0,
      reason: `insufficient history (${records.length} < ${opts.minRecords} resolved records)`,
    };
  }
  const cut = Math.floor(records.length * DISCOVERY_SHARE);
  const older = records.slice(0, cut);
  const newer = records.slice(cut);
  const candidate = opts.fit(older);
  if (candidate === undefined) {
    return { ...base, nFit: older.length, nHoldout: newer.length, reason: "no fit" };
  }
  const d = opts.loss(newer, opts.fallback);
  const c = opts.loss(newer, candidate);
  if (!(d.n > 0) || !(c.n > 0) || !Number.isFinite(d.loss) || !Number.isFinite(c.loss)) {
    return { ...base, candidate, nFit: older.length, nHoldout: 0, reason: "no scorable holdout" };
  }
  const improvement = d.loss > 0 ? (d.loss - c.loss) / d.loss : 0;
  const holdout = {
    default: round(d.loss, 6),
    candidate: round(c.loss, 6),
    improvement: round(improvement, 4),
  };
  if (improvement < opts.margin) {
    return {
      ...base,
      candidate,
      nFit: older.length,
      nHoldout: d.n,
      holdout,
      reason: `held-out improvement ${(improvement * 100).toFixed(1)}% < ${(opts.margin * 100).toFixed(0)}%`,
    };
  }
  const refit = opts.fit(records) ?? candidate;
  return {
    params: refit,
    adopted: true,
    candidate,
    nFit: older.length,
    nHoldout: d.n,
    holdout,
    ...(through ? { through } : {}),
    reason: `held-out improvement ${(improvement * 100).toFixed(1)}% ≥ ${(opts.margin * 100).toFixed(0)}%`,
  };
}

/** The candidate on a grid that minimises the loss (ties: the first). */
export function gridArgmin<P>(grid: P[], loss: (p: P) => number): P | undefined {
  let best: P | undefined;
  let bestLoss = Number.POSITIVE_INFINITY;
  for (const p of grid) {
    const l = loss(p);
    if (Number.isFinite(l) && l < bestLoss - 1e-12) {
      best = p;
      bestLoss = l;
    }
  }
  return best;
}

/** Uniform over the options (the type default for a choice). */
export function uniform(options: AnswerOption[]): Distribution {
  const p = 1 / Math.max(1, options.length);
  return Object.fromEntries(options.map((o) => [o.id, p]));
}

export function round(x: number, d = 4): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
