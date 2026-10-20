// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * FROZEN ORACLE — do not edit. Verbatim copies of the arena baseline math as
 * it stood before the shared series-fit helpers (`src/quant/`) replaced it
 * (origin/main e50f238f: `src/arena/forecast.ts`, `poll-level.ts`,
 * `score.ts`, `score-shapes.ts`). `test/quant-arena-equivalence.test.ts`
 * asserts the refactored arena code returns bit-identical numbers. Only the
 * imports, `export` keywords and formatting differ.
 */

import type { PollLevelEvidence } from "../../src/arena/poll-level";
import type { ArenaPoint, Distribution } from "../../src/arena/types";

type SpreadRule = "persistence" | "calibrated" | "robust" | "level" | "poll-level";
interface ScalarForecast extends Distribution {
  rule: SpreadRule;
  evidence?: { skill: Record<string, number>; points: number };
  steps: number;
}

// ── score.ts ──
const SQRT_2PI = Math.sqrt(2 * Math.PI);
const SQRT_PI = Math.sqrt(Math.PI);

/** Abramowitz–Stegun 7.1.26, |error| < 1.5e-7 — ample for scoring. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return sign * y;
}

/** Closed-form CRPS of a normal forecast (the arena's `crps_normal`). */
export function crpsNormal(mean: number, sd: number, outcome: number): number {
  if (sd <= 0) return Math.abs(outcome - mean);
  const z = (outcome - mean) / sd;
  const pdf = Math.exp((-z * z) / 2) / SQRT_2PI;
  const cdf = 0.5 * (1 + erf(z / Math.SQRT2));
  return sd * (z * (2 * cdf - 1) + 2 * pdf - 1 / SQRT_PI);
}

// ── score-shapes.ts ──
const A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
  -3.066479806614716e1, 2.506628277459239,
];
const B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
  -1.328068155288572e1,
];
const C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
  4.374664141464968, 2.938163982698783,
];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

/** Acklam's inverse normal CDF, as the arena computes it. */
export function normalQuantile(mean: number, sd: number, level: number): number {
  const p = Math.min(Math.max(level, 1e-9), 1 - 1e-9);
  let z: number;
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    z =
      (((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) /
      ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
  } else if (p > 1 - 0.02425) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    z =
      -(((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) /
      ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
  } else {
    const q = p - 0.5;
    const r = q * q;
    z =
      ((((((A[0]! * r + A[1]!) * r + A[2]!) * r + A[3]!) * r + A[4]!) * r + A[5]!) * q) /
      (((((B[0]! * r + B[1]!) * r + B[2]!) * r + B[3]!) * r + B[4]!) * r + 1);
  }
  return mean + sd * z;
}

// ── forecast.ts ──
/** The arena's own persistence spread (`ssa/baselines.py`). */
export const PERSISTENCE_SD = 1.5;
/** Calibration must beat persistence in-sample by this share to be used. */
export const CALIBRATION_MARGIN = 0.05;
/** Changes used to estimate the spread. */
const SD_WINDOW = 26;
/** Warm-up before the in-sample comparison starts. */
const MIN_HISTORY = 12;
const MIN_SD = 0.05;
const DAY_MS = 86_400_000;

/** Release cadence of a series in days (median spacing of its points). */
export function spacingDays(points: ArenaPoint[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const d = (Date.parse(points[i]!.date) - Date.parse(points[i - 1]!.date)) / DAY_MS;
    if (d > 0) gaps.push(d);
  }
  if (gaps.length === 0) return 7;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}

/** How many releases ahead the round's answer is from the last known point. */
export function horizonSteps(points: ArenaPoint[], releaseAt: string): number {
  const last = points.at(-1);
  if (!last) return 1;
  const days = (Date.parse(releaseAt) - Date.parse(last.date)) / DAY_MS;
  return Math.max(1, Math.round(days / spacingDays(points)));
}

export function recentChanges(values: number[], steps: number): number[] | undefined {
  const diffs: number[] = [];
  for (let i = Math.max(steps, values.length - SD_WINDOW); i < values.length; i++) {
    diffs.push(values[i]! - values[i - steps]!);
  }
  return diffs.length < 6 ? undefined : diffs;
}

/**
 * Candidate spreads from the series' own recent `steps`-ahead changes: RMS
 * (`calibrated`) and a spike-resistant median-based one (`robust`, 1.4826 ×
 * median |change| — the normal-consistent MAD), for series such as pageviews
 * where a few spikes would otherwise make every forecast needlessly wide.
 */
export function candidateSpreads(
  values: number[],
  steps: number,
): Partial<Record<SpreadRule, number>> {
  const diffs = recentChanges(values, steps);
  if (!diffs) return {};
  const rms = Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / diffs.length);
  const abs = diffs.map(Math.abs).sort((a, b) => a - b);
  const median = abs[Math.floor(abs.length / 2)]!;
  return { calibrated: Math.max(rms, MIN_SD), robust: Math.max(1.4826 * median, MIN_SD) };
}

/**
 * Persistence mean; the spread chosen by this series' own rolling-origin record,
 * scored the way the leaderboard scores: the MEAN of per-round skill
 * (1 − CRPS ÷ persistence CRPS), not the ratio of total CRPS. The two differ
 * sharply on spiky series — a wide spread wins on the spikes' total but loses
 * nearly every ordinary week, and the leaderboard counts weeks.
 */
export function forecastScalar(points: ArenaPoint[], releaseAt: string): ScalarForecast {
  const values = points.map((p) => p.value).filter((v) => Number.isFinite(v));
  if (values.length === 0) throw new Error("no history to forecast from");
  const steps = horizonSteps(points, releaseAt);
  const mean = round(values.at(-1)!);
  const sums: Record<string, number> = { calibrated: 0, robust: 0 };
  let n = 0;
  for (let t = Math.max(MIN_HISTORY, steps); t < values.length; t++) {
    const spreads = candidateSpreads(values.slice(0, t - steps + 1), steps);
    if (spreads.calibrated === undefined || spreads.robust === undefined) continue;
    const origin = values[t - steps]!;
    const pers = crpsNormal(origin, PERSISTENCE_SD, values[t]!);
    if (pers <= 0) continue;
    for (const rule of ["calibrated", "robust"] as const) {
      sums[rule]! += 1 - crpsNormal(origin, spreads[rule]!, values[t]!) / pers;
    }
    n++;
  }
  const skillOf = (rule: string) => (n ? sums[rule]! / n : Number.NEGATIVE_INFINITY);
  const current = candidateSpreads(values, steps);
  const best: SpreadRule = skillOf("robust") > skillOf("calibrated") ? "robust" : "calibrated";
  const wins = n >= 6 && current[best] !== undefined && skillOf(best) >= CALIBRATION_MARGIN;
  return {
    mean,
    sd: wins ? round(current[best]!) : PERSISTENCE_SD,
    rule: wins ? best : "persistence",
    steps,
    ...(n > 0
      ? {
          evidence: {
            skill: { calibrated: skillOf("calibrated"), robust: skillOf("robust") },
            points: n,
          },
        }
      : {}),
  };
}

export function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export interface BacktestResult {
  /** Mean skill vs the arena's persistence (sd 1.5) on the held-out half. */
  skill: number;
  points: number;
  rule: SpreadRule;
}

/**
 * Out-of-sample check of the baseline on one series: the first half of the
 * history chooses the spread rule exactly as a live forecast would, the second
 * half scores it one step at a time against the arena's own persistence.
 */
export function backtestSeries(points: ArenaPoint[], steps = 1): BacktestResult | undefined {
  const values = points.map((p) => p.value).filter((v) => Number.isFinite(v));
  const half = Math.floor(values.length / 2);
  if (values.length < 2 * MIN_HISTORY) return undefined;
  const pick = forecastScalar(
    points.slice(0, half),
    new Date(
      Date.parse(points[half - 1]!.date) + steps * spacingDays(points) * DAY_MS,
    ).toISOString(),
  ).rule;
  let total = 0;
  let n = 0;
  for (let t = half; t < values.length; t++) {
    const origin = values[t - steps]!;
    const sd =
      pick === "persistence"
        ? PERSISTENCE_SD
        : candidateSpreads(values.slice(0, t - steps + 1), steps)[pick];
    if (sd === undefined) continue;
    const pers = crpsNormal(origin, PERSISTENCE_SD, values[t]!);
    if (pers <= 0) continue;
    total += 1 - crpsNormal(origin, sd, values[t]!) / pers;
    n++;
  }
  if (n === 0) return undefined;
  return { skill: total / n, points: n, rule: pick };
}

// ── poll-level.ts ──
export const POLL_EWMA_ALPHA = 0.4;
/** Filed sd = this × the rule's own recent RMS error. */
export const POLL_LEVEL_SD_SCALE = 0.5;
/** Spread floor: a third of the arena's persistence sd (1.5). */
export const POLL_LEVEL_MIN_SD = 0.5;
/** Origins whose errors size the spread (as for the baseline spread). */
const ERROR_WINDOW = 26;
/** Fewest past errors a spread is estimated from; fewer ⇒ the baseline stands. */
const MIN_ERRORS = 6;
/** Releases before the first scored error (the EWMA's warm-up). */
const WARM_UP = 8;

/** The arena's EWMA (`ssa/baselines.py`): seeded at the first value, alpha `POLL_EWMA_ALPHA`. */
export function arenaEwma(values: number[], alpha = POLL_EWMA_ALPHA): number {
  if (values.length === 0) throw new Error("empty history");
  let m = values[0]!;
  for (let i = 1; i < values.length; i++) m = alpha * values[i]! + (1 - alpha) * m;
  return m;
}

/** The rule's mean: the average of persistence and the arena's EWMA. */
export function pollBlendMean(values: number[]): number {
  return (values.at(-1)! + arenaEwma(values)) / 2;
}

/**
 * RMS of `predict`'s own `steps`-ahead errors over the last `ERROR_WINDOW`
 * origins of `values` — each prediction made from the values before its
 * origin only. Undefined with fewer than `MIN_ERRORS` errors.
 */
export function ruleErrorRms(
  values: number[],
  predict: (prefix: number[]) => number,
  steps: number,
): { rms: number; n: number } | undefined {
  let sum = 0;
  let n = 0;
  for (
    let t = Math.max(WARM_UP + steps - 1, values.length - ERROR_WINDOW);
    t < values.length;
    t++
  ) {
    const e = values[t]! - predict(values.slice(0, t - steps + 1));
    sum += e * e;
    n++;
  }
  return n < MIN_ERRORS ? undefined : { rms: Math.sqrt(sum / n), n };
}

/**
 * The poll-level start for one series, or undefined when its history is too
 * short to size the spread (the caller then files its baseline).
 */
export function pollLevelForecast(
  values: number[],
  steps: number,
): { forecast: Distribution; evidence: PollLevelEvidence } | undefined {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return undefined;
  const err = ruleErrorRms(finite, pollBlendMean, steps);
  if (!err) return undefined;
  const persistence = finite.at(-1)!;
  const ewma = arenaEwma(finite);
  const sd = Math.max(POLL_LEVEL_SD_SCALE * err.rms, POLL_LEVEL_MIN_SD);
  return {
    forecast: { mean: (persistence + ewma) / 2, sd },
    evidence: {
      rule: "persistence-ewma-blend",
      persistence,
      ewma: round3(ewma),
      alpha: POLL_EWMA_ALPHA,
      steps,
      sd: {
        basis: "rule-rms",
        rms: round3(err.rms),
        errors: err.n,
        scale: POLL_LEVEL_SD_SCALE,
        floor: POLL_LEVEL_MIN_SD,
      },
    },
  };
}

export function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
