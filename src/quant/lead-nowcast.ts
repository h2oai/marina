// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Leading-indicator nowcast: move a slow series by what faster series did
 * since its last release. Pure, dependency-free, no model call.
 *
 * A target published weekly or monthly (a poll topline, a survey median) is
 * often preceded by series that publish more often or earlier (a daily
 * tracker, a weekly price, another survey's preliminary reading). A case is
 * one past release of the target: `x` = each indicator's change since the
 * target's previous release, as it could be read at that release's cutoff;
 * `y` = the target's realised change. The forecast is
 *
 *   mean = last + β · x
 *
 * with β the least-squares fit through the origin on the earlier cases,
 * shrunk toward 0 by a ridge prior worth `prior` pseudo-cases per indicator
 * (λ_j = prior × mean(x_j²)), so a handful of cases barely moves persistence.
 *
 * It is EARNED, not assumed: β is applied only when, walking forward over the
 * cases (each prediction fitted on the cases before it only), the fitted
 * rule's RMS error beats persistence's (β = 0) by `margin`. Otherwise the
 * answer is persistence and `applied` is false. The spread is the RMS of the
 * walk-forward errors of whichever rule is used.
 *
 * Leakage is the caller's contract: every `x` (and the `x` passed for the
 * forecast itself) must be built from data published before that case's
 * cutoff, and every case's `y` must have been published before the forecast's
 * cutoff.
 */

import { rms } from "./series-fit";

export interface LeadCase {
  /** Indicator changes since the target's previous release (one per indicator). */
  x: readonly number[];
  /** The target's realised change at this release. */
  y: number;
}

export interface LeadOptions {
  /** Ridge prior in pseudo-cases at β = 0 (default 8). */
  prior?: number;
  /** Cases fitted before the first walk-forward prediction (default 6). */
  warmUp?: number;
  /** Fewest walk-forward errors the decision is made on (default 6). */
  minErrors?: number;
  /** Relative RMS improvement over persistence required to apply β (default 0.05). */
  margin?: number;
  /** Only the last `window` walk-forward errors are scored (default 52). */
  window?: number;
}

export const DEFAULT_LEAD_PRIOR = 8;
export const DEFAULT_LEAD_WARM_UP = 6;
export const DEFAULT_LEAD_MIN_ERRORS = 6;
export const DEFAULT_LEAD_MARGIN = 0.05;
export const DEFAULT_LEAD_WINDOW = 52;

export interface LeadNowcast {
  mean: number;
  /** RMS of the used rule's walk-forward errors; undefined with too few. */
  sd?: number;
  /** Coefficients fitted on every case (applied only when `applied`). */
  beta: number[];
  /** β · x — the move added to `last` when applied. */
  move: number;
  applied: boolean;
  cases: number;
  errors: number;
  /** Walk-forward RMS of the fitted rule and of persistence (β = 0). */
  leadRms?: number;
  persistenceRms?: number;
  reason: string;
}

/** Ridge β through the origin, `prior` pseudo-cases per indicator at 0. */
export function fitLeadBeta(cases: readonly LeadCase[], prior = DEFAULT_LEAD_PRIOR): number[] {
  const k = cases[0]?.x.length ?? 0;
  if (k === 0) return [];
  const a: number[][] = Array.from({ length: k }, () => new Array<number>(k + 1).fill(0));
  for (const c of cases) {
    if (c.x.length !== k) throw new Error("lead cases disagree on the number of indicators");
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) a[i]![j]! += c.x[i]! * c.x[j]!;
      a[i]![k]! += c.x[i]! * c.y;
    }
  }
  const n = cases.length;
  for (let i = 0; i < k; i++) {
    const meanSq = n ? a[i]![i]! / n : 0;
    // A constant floor keeps an indicator that never moved from dividing by zero.
    a[i]![i]! += prior * meanSq + 1e-9;
  }
  return solve(a, k);
}

/** Gaussian elimination with partial pivoting on an augmented k × (k+1) matrix. */
function solve(a: number[][], k: number): number[] {
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    [a[col], a[piv]] = [a[piv]!, a[col]!];
    const p = a[col]![col]!;
    if (Math.abs(p) < 1e-12) return new Array<number>(k).fill(0);
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = a[r]![col]! / p;
      for (let c = col; c <= k; c++) a[r]![c]! -= f * a[col]![c]!;
    }
  }
  return a.map((row, i) => row[k]! / row[i]!);
}

function dot(b: readonly number[], x: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < b.length; i++) s += b[i]! * (x[i] ?? 0);
  return s;
}

/** Walk-forward errors (y − β·x, β fitted on the earlier cases only) and persistence's (y). */
export function leadWalkForward(
  cases: readonly LeadCase[],
  { prior = DEFAULT_LEAD_PRIOR, warmUp = DEFAULT_LEAD_WARM_UP } = {},
): { lead: number[]; persistence: number[] } {
  const lead: number[] = [];
  const persistence: number[] = [];
  for (let t = Math.max(1, warmUp); t < cases.length; t++) {
    const b = fitLeadBeta(cases.slice(0, t), prior);
    lead.push(cases[t]!.y - dot(b, cases[t]!.x));
    persistence.push(cases[t]!.y);
  }
  return { lead, persistence };
}

/** The leading-indicator nowcast of a series whose last value is `last`, given today's `x`. */
export function leadNowcast(
  last: number,
  x: readonly number[],
  cases: readonly LeadCase[],
  opts: LeadOptions = {},
): LeadNowcast {
  const prior = opts.prior ?? DEFAULT_LEAD_PRIOR;
  const minErrors = opts.minErrors ?? DEFAULT_LEAD_MIN_ERRORS;
  const margin = opts.margin ?? DEFAULT_LEAD_MARGIN;
  const window = opts.window ?? DEFAULT_LEAD_WINDOW;
  const usable = cases.filter(
    (c) => Number.isFinite(c.y) && c.x.length === x.length && c.x.every(Number.isFinite),
  );
  const beta = usable.length ? fitLeadBeta(usable, prior) : x.map(() => 0);
  const move = dot(beta, x);
  const wf = leadWalkForward(usable, { prior, warmUp: opts.warmUp ?? DEFAULT_LEAD_WARM_UP });
  const lead = wf.lead.slice(-window);
  const pers = wf.persistence.slice(-window);
  const base = { beta, move, cases: usable.length, errors: lead.length };
  if (!x.every(Number.isFinite) || x.length === 0) {
    return { ...base, mean: last, applied: false, reason: "no indicator reading" };
  }
  if (lead.length < minErrors) {
    return {
      ...base,
      mean: last,
      ...(pers.length ? { sd: rms(pers) } : {}),
      applied: false,
      reason: `${lead.length} walk-forward errors (need ${minErrors})`,
    };
  }
  const leadRms = rms(lead);
  const persistenceRms = rms(pers);
  const applied = leadRms <= (1 - margin) * persistenceRms;
  return {
    ...base,
    mean: applied ? last + move : last,
    sd: applied ? leadRms : persistenceRms,
    applied,
    leadRms,
    persistenceRms,
    reason: applied
      ? `walk-forward RMS ${leadRms.toFixed(3)} beats persistence ${persistenceRms.toFixed(3)} by ≥ ${margin * 100}%`
      : `walk-forward RMS ${leadRms.toFixed(3)} vs persistence ${persistenceRms.toFixed(3)}: not earned`,
  };
}
