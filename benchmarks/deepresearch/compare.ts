// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Graded-score statistics for small paired pilots: mean with a bootstrap interval, paired differences. */

import { mulberry32 } from "../stats";

export interface MeanInterval {
  n: number;
  mean: number;
  low: number;
  high: number;
}

function percentile(sorted: Float64Array, q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))] ?? 0;
}

/** Mean of `xs` with a 95 % percentile bootstrap interval (resampling items). */
export function bootstrapMean(xs: readonly number[], resamples = 10_000, seed = 1): MeanInterval {
  const n = xs.length;
  if (n === 0) return { n: 0, mean: Number.NaN, low: Number.NaN, high: Number.NaN };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const rand = mulberry32(seed);
  const stats = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[Math.floor(rand() * n)] ?? 0;
    stats[r] = s / n;
  }
  stats.sort();
  return { n, mean, low: percentile(stats, 0.025), high: percentile(stats, 0.975) };
}

export interface PairedDiff extends MeanInterval {
  /** Items where B scored higher / lower / the same. */
  wins: number;
  losses: number;
  ties: number;
}

/**
 * B − A over the items both have, with replicates averaged within an item
 * first (`a`/`b` map item id → that arm's replicate scores).
 */
export function pairedDifference(
  a: ReadonlyMap<string, readonly number[]>,
  b: ReadonlyMap<string, readonly number[]>,
  seed = 1,
): PairedDiff {
  const avg = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const diffs: number[] = [];
  for (const [id, as] of a) {
    const bs = b.get(id);
    if (!bs?.length || !as.length) continue;
    diffs.push(avg(bs) - avg(as));
  }
  const m = bootstrapMean(diffs, 10_000, seed);
  return {
    ...m,
    wins: diffs.filter((d) => d > 1e-9).length,
    losses: diffs.filter((d) => d < -1e-9).length,
    ties: diffs.filter((d) => Math.abs(d) <= 1e-9).length,
  };
}
