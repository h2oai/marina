// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reciprocal-rank fusion (Cormack et al., 2009): every ranked list adds
 * `weight / (k + rank)` to each id it holds (rank from 1). Rank-only, so lists
 * with incomparable scores (BM25, cosine, a model's ordering) combine without
 * calibration. k = 60 is the usual constant.
 *
 * Ties keep the order in which ids were first seen (list order, then rank), so
 * one list fused alone reproduces itself.
 */

export const RRF_K = 60;

export interface RankedList {
  ids: readonly string[];
  /** Multiplies this list's contributions (default 1). */
  weight?: number;
  /** Only the first `depth` ids count (default: all). */
  depth?: number;
}

export interface FusedId {
  id: string;
  score: number;
}

export function reciprocalRankFusion(lists: readonly RankedList[], k = RRF_K): FusedId[] {
  const score = new Map<string, { score: number; order: number }>();
  let order = 0;
  for (const list of lists) {
    const weight = list.weight ?? 1;
    if (!(weight > 0)) continue;
    const ids = list.depth === undefined ? list.ids : list.ids.slice(0, list.depth);
    ids.forEach((id, rank) => {
      const add = weight / (k + rank + 1);
      const had = score.get(id);
      if (had) had.score += add;
      else score.set(id, { score: add, order: order++ });
    });
  }
  return [...score.entries()]
    .sort(([, a], [, b]) => b.score - a.score || a.order - b.order)
    .map(([id, s]) => ({ id, score: s.score }));
}
