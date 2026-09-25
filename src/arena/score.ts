// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** The arena's scoring rules, as far as Marina needs them to choose and to learn. Pure. */

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

/** The arena's skill: 1 − CRPS / persistence CRPS (0 = persistence, 1 = perfect). */
export function skill(entrantCrps: number, persistenceCrps: number): number {
  return persistenceCrps === 0 ? 0 : 1 - entrantCrps / persistenceCrps;
}
