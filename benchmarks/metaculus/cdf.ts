// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A numeric or discrete Metaculus forecast as the CDF the API takes:
 * `cdfSize` heights at evenly spaced locations of the question's range
 * (log-spaced when it has a zero point), standardized the way Metaculus
 * requires — no mass beyond a closed bound, a minimum beyond an open one,
 * strictly increasing, no step taller than the cap. A port of the
 * standardization in Metaculus's bot template (`_standardize_cdf`).
 *
 * The forecast itself is a normal (log-normal on a log-scaled question) at the
 * forecaster's value and sd, mixed with a 3×-wider component so a wrong centre
 * still leaves mass in the tails.
 */

export interface CdfQuestion {
  rangeMin: number;
  rangeMax: number;
  zeroPoint: number | null;
  openLower: boolean;
  openUpper: boolean;
  /** 201 for numeric; inbound_outcome_count + 1 for discrete. */
  cdfSize: number;
}

const DEFAULT_CDF_SIZE = 201;
const MAX_PMF = 0.2;
const TAIL_WEIGHT = 0.1;
const TAIL_WIDTH = 3;

/** The real-world value at a CDF location in [0, 1]. */
export function nominalAt(q: CdfQuestion, location: number): number {
  const { rangeMin: lo, rangeMax: hi, zeroPoint: zp } = q;
  if (zp === null) return lo + (hi - lo) * location;
  const deriv = (hi - zp) / (lo - zp);
  return lo + ((hi - lo) * (deriv ** location - 1)) / (deriv - 1);
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 erf, |error| < 1.5e-7). */
export function phi(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** The forecast CDF at value `x`. */
function forecastCdf(q: CdfQuestion, mean: number, sd: number, x: number): number {
  const mix = (z: number) => (1 - TAIL_WEIGHT) * phi(z) + TAIL_WEIGHT * phi(z / TAIL_WIDTH);
  if (q.zeroPoint !== null && mean > q.zeroPoint) {
    // Log-scaled: normal in log(x − zero point), sd by the delta method.
    if (x <= q.zeroPoint) return 0;
    const mu = Math.log(mean - q.zeroPoint);
    const s = Math.max(sd / (mean - q.zeroPoint), 1e-3);
    return mix((Math.log(x - q.zeroPoint) - mu) / s);
  }
  return mix((x - mean) / sd);
}

/** The raw CDF heights at the question's evaluation locations. */
export function rawCdf(q: CdfQuestion, mean: number, sd: number): number[] {
  const n = q.cdfSize;
  const floor = Math.abs(q.rangeMax - q.rangeMin) / (n - 1);
  const s = Math.max(sd, floor);
  return Array.from({ length: n }, (_, i) => forecastCdf(q, mean, s, nominalAt(q, i / (n - 1))));
}

/** Metaculus's standardization of a CDF (see the module comment). */
export function standardizeCdf(q: CdfQuestion, raw: number[]): number[] {
  const cdf = [...raw];
  const n = cdf.length;
  const lowerOpen = q.openLower;
  const upperOpen = q.openUpper;
  const lowTo = lowerOpen ? 0 : cdf[0]!;
  const highTo = upperOpen ? 1 : cdf[n - 1]!;
  const inbound = highTo - lowTo || 1;
  for (let i = 0; i < n; i++) {
    const f = (cdf[i]! - lowTo) / inbound;
    const loc = i / (n - 1);
    if (lowerOpen && upperOpen) cdf[i] = 0.988 * f + 0.01 * loc + 0.001;
    else if (lowerOpen) cdf[i] = 0.989 * f + 0.01 * loc + 0.001;
    else if (upperOpen) cdf[i] = 0.989 * f + 0.01 * loc;
    else cdf[i] = 0.99 * f + 0.01 * loc;
  }
  // PMF with the mass below and above the range at either end.
  const pmf = [cdf[0]!, ...cdf.slice(1).map((v, i) => v - cdf[i]!), 1 - cdf[n - 1]!];
  const cap = MAX_PMF * ((DEFAULT_CDF_SIZE - 1) / (n - 1)) * 0.95;
  const capped = (scale: number) => [
    pmf[0]!,
    ...pmf.slice(1, -1).map((p) => Math.min(cap, scale * p)),
    pmf[pmf.length - 1]!,
  ];
  const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
  let lo = 1;
  let hi = 1;
  let scale = 1;
  while (sum(capped(hi)) < 1) hi *= 1.2;
  for (let k = 0; k < 100; k++) {
    scale = 0.5 * (lo + hi);
    const s = sum(capped(scale));
    if (s < 1) lo = scale;
    else hi = scale;
    if (s === 1 || hi - lo < 2e-5) break;
  }
  const out = capped(scale);
  const inner = sum(out.slice(1, -1));
  const target = cdf[n - 1]! - cdf[0]!;
  for (let i = 1; i < out.length - 1; i++) out[i] = (out[i]! * target) / inner;
  const result: number[] = [];
  let acc = 0;
  for (let i = 0; i < out.length - 1; i++) {
    acc += out[i]!;
    result.push(Math.round(acc * 1e10) / 1e10);
  }
  return result;
}

/** The API's `continuous_cdf` for a forecast of `mean` ± `sd`. */
export function continuousCdf(q: CdfQuestion, mean: number, sd: number): number[] {
  return standardizeCdf(q, rawCdf(q, mean, sd));
}

/** The value at which a CDF crosses `p` (for the comment: median and 80 % interval). */
export function quantileOf(q: CdfQuestion, cdf: number[], p: number): number {
  const n = cdf.length;
  for (let i = 1; i < n; i++) {
    if (cdf[i]! >= p) {
      const f = (p - cdf[i - 1]!) / (cdf[i]! - cdf[i - 1]! || 1);
      return nominalAt(q, (i - 1 + f) / (n - 1));
    }
  }
  return nominalAt(q, 1);
}
