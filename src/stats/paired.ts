// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Paired statistics for comparing two harness runs (arms) on the same items.
 * Pure functions: no I/O, deterministic for a given seed.
 */

/** z for a two-sided 95 % interval. */
export const Z95 = 1.959963984540054;

export interface Interval {
  low: number;
  high: number;
}

/**
 * The raw Wilson score bounds for `successes` out of `n > 0`, clamped to
 * [0, 1] only (no exact 0 / 1 at the extremes). `wilsonInterval` is the
 * usual reading; a caller that needs the unclamped-extreme arithmetic (a
 * frozen harness output) reads this.
 */
export function wilsonBounds(successes: number, n: number, z = Z95): Interval {
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Wilson score interval for `successes` out of `n` (95 % by default). */
export function wilsonInterval(successes: number, n: number, z = Z95): Interval {
  if (n <= 0) return { low: 0, high: 1 };
  const b = wilsonBounds(successes, n, z);
  return {
    low: successes <= 0 ? 0 : b.low,
    high: successes >= n ? 1 : b.high,
  };
}

/** log C(n, k) via a running sum — exact enough for n in the thousands. */
function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

export interface McNemarResult {
  /** Items arm A got right and arm B got wrong. */
  b: number;
  /** Items arm A got wrong and arm B got right. */
  c: number;
  /** Two-sided exact p-value (binomial, p = 0.5, on the b + c discordant pairs). */
  p: number;
}

/** McNemar's exact test on the discordant counts. No discordant pairs ⇒ p = 1. */
export function mcnemarExact(b: number, c: number): McNemarResult {
  const n = b + c;
  if (n === 0) return { b, c, p: 1 };
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return { b, c, p: Math.min(1, 2 * tail) };
}

/** mulberry32 — small seeded PRNG so bootstrap intervals are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapResult {
  /** Observed difference in accuracy, arm B minus arm A. */
  diff: number;
  /** Percentile interval of the resampled difference. */
  interval: Interval;
  resamples: number;
}

/**
 * Paired bootstrap of accuracy(B) − accuracy(A): resample ITEMS with
 * replacement, keeping each item's pair of outcomes together.
 */
export function pairedBootstrap(
  a: boolean[],
  b: boolean[],
  opts: { resamples?: number; seed?: number; level?: number } = {},
): BootstrapResult {
  if (a.length !== b.length) throw new Error("paired bootstrap needs equal-length arms");
  const n = a.length;
  const resamples = opts.resamples ?? 10_000;
  const level = opts.level ?? 0.95;
  if (n === 0) return { diff: 0, interval: { low: 0, high: 0 }, resamples: 0 };
  const d = a.map((x, i) => Number(b[i]) - Number(x));
  const diff = d.reduce((s, v) => s + v, 0) / n;
  const rand = mulberry32(opts.seed ?? 1);
  const stats = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[Math.floor(rand() * n)] ?? 0;
    stats[r] = s / n;
  }
  stats.sort();
  const alpha = (1 - level) / 2;
  const at = (q: number) =>
    stats[Math.min(resamples - 1, Math.max(0, Math.floor(q * resamples)))] ?? 0;
  return { diff, interval: { low: at(alpha), high: at(1 - alpha) }, resamples };
}

/**
 * 95% interval on p1 − p2 for two independent proportions (Agresti–Caffo: add
 * one success and one failure to each arm). Well-behaved for small n and for
 * scores of 0% or 100%, where the plain Wald interval collapses to zero width
 * and would call a 15-item tie-break "certain".
 */
export function differenceInterval(
  p1: number,
  n1: number,
  p2: number,
  n2: number,
): [number, number] {
  const a1 = (p1 * n1 + 1) / (n1 + 2);
  const a2 = (p2 * n2 + 1) / (n2 + 2);
  const se = Math.sqrt((a1 * (1 - a1)) / (n1 + 2) + (a2 * (1 - a2)) / (n2 + 2));
  const d = a1 - a2;
  // A difference of two proportions lives in [-1, 1].
  return [Math.max(-1, d - 1.96 * se), Math.min(1, d + 1.96 * se)];
}
