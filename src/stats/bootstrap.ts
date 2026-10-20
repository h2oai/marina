// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The bootstraps every harness and core reader shares: seeded PRNGs, item
 * resampling of a mean, the two-stage (runs, then items) paired bootstrap,
 * and the percentile index rules the callers read their intervals with.
 * Pure and deterministic for a given seed. Each former copy
 * (`benchmarks/transfer`, `deepresearch`, `longmemeval`, `futurex`,
 * `forecasting/select`, `scripts/arena-wiki-backtest`) is now a thin call
 * here; `test/stats-equivalence.test.ts` holds them bit-identical to their
 * frozen originals (`test/fixtures/stats-legacy.ts`).
 */

import { mulberry32 } from "./paired";

/**
 * A 32-bit linear congruential generator (`s ← s·1664525 + 1013904223 mod 2³²`,
 * returns `s / 2³²`): the PRNG the FutureX and arena-wiki bootstraps were
 * seeded with. `mulberry32` is the default everywhere else.
 */
export function lcg32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

/** `sorted[floor(q·n)]`, clamped to the array (0 when empty). */
export function percentileFloor(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  return sorted[Math.min(n - 1, Math.max(0, Math.floor(q * n)))] ?? 0;
}

/** `sorted[ceil(q·n) − 1]`, clamped to the array (0 when empty). */
export function percentileCeil(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  return sorted[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))] ?? 0;
}

/**
 * `resamples` means of `xs` resampled with replacement (one `rand()` per
 * draw, in order), sorted ascending.
 */
export function resampleMeans(
  xs: readonly number[],
  resamples: number,
  rand: () => number,
): Float64Array {
  const n = xs.length;
  const stats = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[Math.floor(rand() * n)] ?? 0;
    stats[r] = s / n;
  }
  stats.sort();
  return stats;
}

export interface BootstrapInterval {
  mean: number;
  low: number;
  high: number;
  resamples: number;
}

export interface BootstrapOptions {
  /** Default 10 000. */
  resamples?: number;
  /** mulberry32 seed, default 1. */
  seed?: number;
  /** Two-sided level, default 0.95: quantiles (1 − level)/2 and 1 − (1 − level)/2. */
  level?: number;
  /**
   * Explicit [low, high] quantiles instead of `level`. Note that
   * `(1 − 0.95)/2` is not exactly 0.025 in floating point, so a caller that
   * read `0.025`/`0.975` literally passes them here to keep its indices.
   */
  quantiles?: readonly [number, number];
}

function quantilesOf(opts: BootstrapOptions): readonly [number, number] {
  if (opts.quantiles) return opts.quantiles;
  const alpha = (1 - (opts.level ?? 0.95)) / 2;
  return [alpha, 1 - alpha];
}

/**
 * Mean of `xs` with a percentile bootstrap interval (items resampled with
 * replacement, seeded mulberry32). Empty input: all zeros, no resamples.
 */
export function bootstrapMean(
  xs: readonly number[],
  opts: BootstrapOptions = {},
): BootstrapInterval {
  const n = xs.length;
  const resamples = opts.resamples ?? 10_000;
  if (n === 0) return { mean: 0, low: 0, high: 0, resamples: 0 };
  const mean = xs.reduce((s, v) => s + v, 0) / n;
  const stats = resampleMeans(xs, resamples, mulberry32(opts.seed ?? 1));
  const [lo, hi] = quantilesOf(opts);
  return { mean, low: percentileFloor(stats, lo), high: percentileFloor(stats, hi), resamples };
}

/**
 * Two-stage (cluster) paired bootstrap of mean(a − b): each iteration
 * resamples each arm's replicate runs with replacement, then the items, and
 * averages per item over the drawn runs. `a`/`b` are runs as item id → score.
 * Degenerate input (no ids or an empty arm): all zeros, no resamples.
 */
export function twoStageBootstrap(
  a: ReadonlyArray<ReadonlyMap<string, number>>,
  b: ReadonlyArray<ReadonlyMap<string, number>>,
  ids: readonly string[],
  opts: BootstrapOptions = {},
): BootstrapInterval {
  const resamples = opts.resamples ?? 10_000;
  if (ids.length === 0 || a.length === 0 || b.length === 0)
    return { mean: 0, low: 0, high: 0, resamples: 0 };
  const rand = mulberry32(opts.seed ?? 1);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const itemMean = (runs: ReadonlyArray<ReadonlyMap<string, number>>, id: string) =>
    runs.reduce((s, r) => s + (r.get(id) ?? 0), 0) / runs.length;
  const mean = ids.reduce((s, id) => s + itemMean(a, id) - itemMean(b, id), 0) / ids.length;
  const stats = new Float64Array(resamples);
  for (let k = 0; k < resamples; k++) {
    const ra = a.map(() => pick(a));
    const rb = b.map(() => pick(b));
    let s = 0;
    for (let j = 0; j < ids.length; j++) {
      const id = pick(ids);
      s += itemMean(ra, id) - itemMean(rb, id);
    }
    stats[k] = s / ids.length;
  }
  stats.sort();
  const [lo, hi] = quantilesOf(opts);
  return { mean, low: percentileFloor(stats, lo), high: percentileFloor(stats, hi), resamples };
}
