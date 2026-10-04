// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Probabilistic answers from the typed forecaster (src/forecast/typed.ts):
 *
 *   - a choice asked with `probabilities: true` carries a probability for
 *     every option — each run states one, the runs are averaged by weight,
 *     and a critic's applied revision is blended in;
 *   - a multi-select asked with `probabilities: true` carries each option's
 *     own probability of being true (marginals; they need not sum to 1);
 *   - a number carries an uncertainty: each run states an `sd`, and the
 *     combined sd adds the runs' own uncertainty to their disagreement.
 *
 * Proper scoring rules (Brier, log, CRPS, peer scores) reward these, where a
 * single picked option or point would not. Pure functions: no I/O.
 */

import { type AnswerOption, matchOption } from "./answer-types";

export type Distribution = Record<string, number>;

/** Smallest probability any option keeps after normalising (never exactly 0 or 1). */
export const PROBABILITY_FLOOR = 0.001;

const finite = (n: number) => Number.isFinite(n);

function asProbability(v: unknown): number | undefined {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string") {
    const t = v.trim();
    n = Number(t.replace(/%$/, ""));
    if (t.endsWith("%")) n /= 100;
  } else return undefined;
  if (!finite(n) || n < 0) return undefined;
  // A model writing 35 for 35 % (all values >1 handled by the caller's normalisation).
  return n;
}

/**
 * A model's `probabilities` field as a normalised distribution over the
 * options, or undefined when unusable. Keys may be option ids or labels;
 * options it leaves out get 0 before the floor.
 */
export function parseDistribution(options: AnswerOption[], raw: unknown): Distribution | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Distribution = {};
  for (const o of options) out[o.id] = 0;
  const entries: Array<[string, unknown]> = Array.isArray(raw)
    ? (raw as unknown[]).flatMap((x) => {
        const r = x as Record<string, unknown> | undefined;
        const key = r?.id ?? r?.option ?? r?.label;
        return typeof key === "string" ? [[key, r?.probability ?? r?.p] as [string, unknown]] : [];
      })
    : Object.entries(raw as Record<string, unknown>);
  let any = false;
  for (const [key, value] of entries) {
    const o = matchOption(key, options);
    const p = asProbability(value);
    if (!o || p === undefined) continue;
    out[o.id] = (out[o.id] ?? 0) + p;
    any = true;
  }
  if (!any) return undefined;
  return normalise(out);
}

/** Normalised to sum 1 with every option at least `PROBABILITY_FLOOR`; undefined if all zero. */
export function normalise(d: Distribution, floor = PROBABILITY_FLOOR): Distribution | undefined {
  const keys = Object.keys(d);
  const total = keys.reduce((s, k) => s + Math.max(0, d[k] ?? 0), 0);
  if (!(total > 0) || keys.length === 0) return undefined;
  const raw = keys.map((k) => Math.max(0, d[k] ?? 0) / total);
  // Lift every option to the floor, taking the mass proportionally from the rest.
  const lifted = raw.map((p) => Math.max(p, floor));
  const excess = lifted.reduce((s, p) => s + p, 0) - 1;
  const room = lifted.reduce((s, p) => s + (p > floor ? p - floor : 0), 0);
  const out: Distribution = {};
  keys.forEach((k, i) => {
    const p = lifted[i]!;
    const adjusted = p > floor && room > 0 ? p - (excess * (p - floor)) / room : p;
    out[k] = round(adjusted);
  });
  return out;
}

/**
 * A run that picked an option but gave no usable probabilities: its stated
 * confidence on the pick (default 0.6), the rest spread evenly.
 */
export function pickDistribution(
  options: AnswerOption[],
  picked: string,
  confidence?: number,
): Distribution {
  const n = options.length;
  const c = Math.min(0.99, Math.max(1 / n, confidence ?? 0.6));
  const rest = n > 1 ? (1 - c) / (n - 1) : 0;
  const d: Distribution = {};
  for (const o of options) d[o.id] = o.id === picked ? c : rest;
  return normalise(d)!;
}

/** The weighted average of distributions over the same options (undefined when none weigh). */
export function averageDistributions(
  items: Array<{ distribution: Distribution; weight: number }>,
): Distribution | undefined {
  const usable = items.filter((i) => i.weight > 0);
  const total = usable.reduce((s, i) => s + i.weight, 0);
  if (usable.length === 0 || !(total > 0)) return undefined;
  const out: Distribution = {};
  for (const { distribution, weight } of usable) {
    for (const [k, p] of Object.entries(distribution))
      out[k] = (out[k] ?? 0) + (p * weight) / total;
  }
  return normalise(out);
}

/** How the runs' probabilities are averaged: arithmetically, or in log-odds (`MARINA_FORECAST_POOL`). */
export type PoolMethod = "linear" | "logodds";

const logOdds = (p: number) => {
  const q = Math.min(1 - PROBABILITY_FLOOR, Math.max(PROBABILITY_FLOOR, p));
  return Math.log(q / (1 - q));
};

/**
 * The weighted geometric mean of distributions over the same options,
 * renormalised — the log-odds pool. Unlike the arithmetic mean it does not
 * drag confident, agreeing runs toward uniform.
 */
export function logOddsDistributions(
  items: Array<{ distribution: Distribution; weight: number }>,
): Distribution | undefined {
  const usable = items.filter((i) => i.weight > 0);
  const total = usable.reduce((s, i) => s + i.weight, 0);
  if (usable.length === 0 || !(total > 0)) return undefined;
  const keys = new Set(usable.flatMap((i) => Object.keys(i.distribution)));
  const out: Distribution = {};
  for (const k of keys) {
    let s = 0;
    for (const { distribution, weight } of usable) {
      s += (weight / total) * Math.log(Math.max(PROBABILITY_FLOOR, distribution[k] ?? 0));
    }
    out[k] = Math.exp(s);
  }
  return normalise(out);
}

/** The weighted mean of each option's own probability in log-odds. */
export function logOddsMarginals(
  items: Array<{ distribution: Distribution; weight: number }>,
): Distribution | undefined {
  const usable = items.filter((i) => i.weight > 0);
  if (usable.length === 0) return undefined;
  const sums: Distribution = {};
  const weights: Distribution = {};
  for (const { distribution, weight } of usable) {
    for (const [k, p] of Object.entries(distribution)) {
      sums[k] = (sums[k] ?? 0) + logOdds(p) * weight;
      weights[k] = (weights[k] ?? 0) + weight;
    }
  }
  const out: Distribution = {};
  for (const k of Object.keys(sums)) out[k] = clampP(1 / (1 + Math.exp(-sums[k]! / weights[k]!)));
  return out;
}

/** `a` moved toward `b` by `w` (0 = a, 1 = b). */
export function blendDistributions(a: Distribution, b: Distribution, w: number): Distribution {
  const out: Distribution = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out[k] = (1 - w) * (a[k] ?? 0) + w * (b[k] ?? 0);
  }
  return normalise(out)!;
}

/** The most probable option (ties: option order). */
export function argmax(options: AnswerOption[], d: Distribution): string {
  let best = options[0]!.id;
  for (const o of options) if ((d[o.id] ?? 0) > (d[best] ?? 0)) best = o.id;
  return best;
}

/**
 * The combined sd of a numeric forecast: the runs' own stated uncertainty
 * (weighted root-mean-square) plus their disagreement (`spread`), in
 * quadrature. Undefined when no run gave an sd and the runs agree exactly.
 */
export function combinedSd(
  runs: Array<{ sd?: number; weight: number }>,
  spread = 0,
): number | undefined {
  const withSd = runs.filter((r) => r.weight > 0 && r.sd !== undefined && r.sd > 0);
  const total = withSd.reduce((s, r) => s + r.weight, 0);
  const own =
    total > 0 ? Math.sqrt(withSd.reduce((s, r) => s + r.weight * r.sd! ** 2, 0) / total) : 0;
  const sd = Math.sqrt(own ** 2 + spread ** 2);
  return sd > 0 && finite(sd) ? round(sd, 6) : undefined;
}

// ─── Independent per-option probabilities (multi-select) ─────────────────────

const clampP = (p: number) =>
  round(Math.min(1 - PROBABILITY_FLOOR, Math.max(PROBABILITY_FLOOR, p)));

/**
 * A multi-select forecast's `probabilities`: each option's own probability of
 * being true (they need not sum to 1), clamped to [floor, 1 − floor]. Options
 * left out are absent from the result; undefined when none is usable.
 */
export function parseMarginals(options: AnswerOption[], raw: unknown): Distribution | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entries: Array<[string, unknown]> = Array.isArray(raw)
    ? (raw as unknown[]).flatMap((x) => {
        const r = x as Record<string, unknown> | undefined;
        const key = r?.id ?? r?.option ?? r?.label;
        return typeof key === "string" ? [[key, r?.probability ?? r?.p] as [string, unknown]] : [];
      })
    : Object.entries(raw as Record<string, unknown>);
  const out: Distribution = {};
  for (const [key, value] of entries) {
    const o = matchOption(key, options);
    let p = asProbability(value);
    if (!o || p === undefined) continue;
    if (p > 1) p /= 100; // 70 for 70 %
    if (p > 1) continue;
    out[o.id] = clampP(p);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Every option's probability: the run's own where it gave one, else from its
 * picks (picked at `confidence`, default 0.7; the rest at 1 − it).
 */
export function completeMarginals(
  options: AnswerOption[],
  partial: Distribution | undefined,
  picked: string[],
  confidence?: number,
): Distribution {
  const c = Math.min(0.99, Math.max(0.5, confidence ?? 0.7));
  const out: Distribution = {};
  for (const o of options) out[o.id] = partial?.[o.id] ?? clampP(picked.includes(o.id) ? c : 1 - c);
  return out;
}

/** The weighted mean of each option's probability (undefined when none weigh). */
export function averageMarginals(
  items: Array<{ distribution: Distribution; weight: number }>,
): Distribution | undefined {
  const usable = items.filter((i) => i.weight > 0);
  if (usable.length === 0) return undefined;
  const sums: Distribution = {};
  const weights: Distribution = {};
  for (const { distribution, weight } of usable) {
    for (const [k, p] of Object.entries(distribution)) {
      sums[k] = (sums[k] ?? 0) + p * weight;
      weights[k] = (weights[k] ?? 0) + weight;
    }
  }
  const out: Distribution = {};
  for (const k of Object.keys(sums)) out[k] = clampP(sums[k]! / weights[k]!);
  return out;
}

/** `a` moved toward `b` by `w`, option by option. */
export function blendMarginals(a: Distribution, b: Distribution, w: number): Distribution {
  const out: Distribution = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out[k] = clampP((1 - w) * (a[k] ?? b[k] ?? 0.5) + w * (b[k] ?? a[k] ?? 0.5));
  }
  return out;
}

function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
