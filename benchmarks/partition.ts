// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A fixed, disjoint split of a benchmark's items. `holdout` (≈20%) is where
 * candidates are JUDGED; `tune` (the rest) is where anyone may iterate. The
 * split is a hash of the item id, so it never changes and the two halves share
 * no item — unlike drawing a different seed, which only reshuffles one pool.
 */

export type Partition = "holdout" | "tune";

const HOLDOUT_EVERY = 5;

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return h >>> 0;
}

export function partitionOf(dataset: string, itemId: string): Partition {
  return djb2(`${dataset}:${itemId}`) % HOLDOUT_EVERY === 0 ? "holdout" : "tune";
}

export function inPartition<T extends { id: string }>(
  dataset: string,
  items: T[],
  partition: Partition,
): T[] {
  return items.filter((i) => partitionOf(dataset, i.id) === partition);
}

export function parsePartition(raw: unknown): Partition | undefined {
  return raw === "holdout" || raw === "tune" ? raw : undefined;
}
