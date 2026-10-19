// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Normal-distribution primitives shared by every numeric helper. Pure, no
 * dependencies. The arena's scoring (`src/arena/score.ts`,
 * `src/arena/score-shapes.ts`) re-exports these exact functions, so changing
 * one changes the arena's scores: `test/arena.test.ts` and
 * `test/arena-score-shapes.test.ts` pin the values.
 */

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

/**
 * P(X ≤ x) for X ~ N(mean, sd). A zero sd is a point mass at the mean
 * (1 at and above it, 0 below); a negative or non-finite sd is an error.
 */
export function normalCdf(x: number, mean = 0, sd = 1): number {
  if (!(sd >= 0) || !Number.isFinite(sd)) throw new RangeError(`sd must be ≥ 0, got ${sd}`);
  if (x === Number.POSITIVE_INFINITY) return 1;
  if (x === Number.NEGATIVE_INFINITY) return 0;
  if (sd === 0) return x >= mean ? 1 : 0;
  return standardNormalCdf((x - mean) / sd);
}

/**
 * Φ(z) to absolute error ~1e-15 (relative error < 1e-7 far into the tails): Hart's 1968 rational
 * approximation as given by West, "Better approximations to cumulative normal
 * functions" (2005). Exactly symmetric — Φ(−z) = 1 − Φ(z), Φ(0) = 0.5 — so
 * mirror-image buckets get equal probabilities. (The arena's scores keep the
 * Abramowitz–Stegun `erf` above.)
 */
export function standardNormalCdf(z: number): number {
  if (Number.isNaN(z)) return Number.NaN;
  const a = Math.abs(z);
  let c: number;
  if (a > 37) {
    c = 0;
  } else {
    const e = Math.exp((-a * a) / 2);
    if (a < 7.07106781186547) {
      let b = 3.52624965998911e-2 * a + 0.700383064443688;
      b = b * a + 6.37396220353165;
      b = b * a + 33.912866078383;
      b = b * a + 112.079291497871;
      b = b * a + 221.213596169931;
      b = b * a + 220.206867912376;
      c = e * b;
      b = 8.83883476483184e-2 * a + 1.75566716318264;
      b = b * a + 16.064177579207;
      b = b * a + 86.7807322029461;
      b = b * a + 296.564248779674;
      b = b * a + 637.333633378831;
      b = b * a + 793.826512519948;
      b = b * a + 440.413735824752;
      c /= b;
    } else {
      let b = a + 0.65;
      b = a + 4 / b;
      b = a + 3 / b;
      b = a + 2 / b;
      b = a + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return z > 0 ? 1 - c : c;
}

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

/** Acklam's inverse normal CDF (relative error < 1.2e-9), level clamped to [1e-9, 1 − 1e-9]. */
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
