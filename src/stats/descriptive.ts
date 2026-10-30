// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Descriptive summaries with one definition each. `percentileCeil` /
 * `percentileFloor` (bootstrap.ts) are the nearest-rank forms; these are the
 * two other conventions the code base settled on. Each caller that moved here
 * is held bit-identical to its frozen original by `test/stats-equivalence.test.ts`.
 */

/** The middle value of `values` (the mean of the two middle values when even); 0 when empty. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/**
 * Linear interpolation between the neighbours of rank `q · (n − 1)` of an
 * ascending `sorted` array (R type 7 / NumPy default); 0 when empty.
 */
export function quantileInterpolated(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.max(0, q * (sorted.length - 1)));
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}
