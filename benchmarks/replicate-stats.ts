// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Statistics over REPLICATES — repeated runs of one configuration on the same
 * items with the same judge. A single run is one draw: identical crews can
 * differ by several items out of a few hundred, and one comparison's p-value
 * moves with them. These functions pool a group's replicates and compare two
 * groups so that run-to-run variance is part of the answer.
 *
 * Pure and deterministic (seeded resampling). A replicate is a map from item
 * id to correct/incorrect; only items present in EVERY replicate of a group
 * (and, for a comparison, in both groups) are used, so a missing item never
 * silently counts as wrong.
 *
 * Method (documented in docs/guides/testing.md → "Replicates"):
 *  - per item, a group's score is the mean of its replicates' outcomes;
 *    pooled accuracy is the mean of those item scores; the majority view
 *    counts an item correct when more than half its replicates are (a tie
 *    counts ½);
 *  - between-replicate variation: the sample SD of the replicates' accuracies
 *    on the common items, and per-item agreement (unanimous items, mean
 *    pairwise agreement);
 *  - group comparison: a two-stage (cluster) bootstrap — resample each group's
 *    replicate RUNS with replacement, then the ITEMS with replacement, and
 *    recompute the mean per-item difference. Resampling runs puts run-level
 *    variance (a degraded crew, a provider bad patch) into the interval as well
 *    as item variance. The percentile interval and a two-sided bootstrap p are
 *    reported. With one replicate in a group the run stage is degenerate: the
 *    result is flagged `replicated: false` and rests on item variance alone.
 *  - every replicate-pair's exact McNemar p is listed too, to show how much a
 *    single-run comparison would have moved.
 */

import { mcnemarExact, mulberry32 } from "./stats";

/** One replicate: item id → correct. */
export type Replicate = ReadonlyMap<string, boolean>;

/** Item ids present in every replicate given (sorted, for determinism). */
export function commonItems(groups: readonly (readonly Replicate[])[]): string[] {
  const all = groups.flat();
  if (all.length === 0) return [];
  const [first, ...rest] = all as [Replicate, ...Replicate[]];
  return [...first.keys()].filter((id) => rest.every((r) => r.has(id))).sort();
}

export interface PooledGroup {
  replicates: number;
  items: number;
  /** Mean over items of the per-item mean outcome. */
  meanAccuracy: number;
  /** Majority vote per item (ties count ½). */
  majorityAccuracy: number;
  /** Each replicate's accuracy on the common items. */
  replicateAccuracies: number[];
  /** Sample SD of the replicate accuracies (0 with one replicate). */
  betweenSd: number;
  /** Share of items on which every replicate agrees (1 with one replicate). */
  unanimous: number;
  /** Mean agreement over replicate pairs (1 with one replicate). */
  pairwiseAgreement: number;
}

/** Pool one group's replicates on the given items (default: their common items). */
export function poolGroup(reps: readonly Replicate[], items?: readonly string[]): PooledGroup {
  const ids = items ?? commonItems([reps]);
  const k = reps.length;
  const n = ids.length;
  if (k === 0 || n === 0) {
    return {
      replicates: k,
      items: n,
      meanAccuracy: 0,
      majorityAccuracy: 0,
      replicateAccuracies: reps.map(() => 0),
      betweenSd: 0,
      unanimous: 1,
      pairwiseAgreement: 1,
    };
  }
  let mean = 0;
  let majority = 0;
  let unanimous = 0;
  for (const id of ids) {
    const c = reps.filter((r) => r.get(id) === true).length;
    mean += c / k;
    majority += c * 2 > k ? 1 : c * 2 === k ? 0.5 : 0;
    if (c === 0 || c === k) unanimous++;
  }
  const accs = reps.map((r) => ids.filter((id) => r.get(id) === true).length / n);
  const avg = accs.reduce((s, a) => s + a, 0) / k;
  const sd = k > 1 ? Math.sqrt(accs.reduce((s, a) => s + (a - avg) ** 2, 0) / (k - 1)) : 0;
  let agreeSum = 0;
  let pairs = 0;
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const ri = reps[i] as Replicate;
      const rj = reps[j] as Replicate;
      agreeSum += ids.filter((id) => ri.get(id) === rj.get(id)).length / n;
      pairs++;
    }
  }
  return {
    replicates: k,
    items: n,
    meanAccuracy: mean / n,
    majorityAccuracy: majority / n,
    replicateAccuracies: accs,
    betweenSd: sd,
    unanimous: unanimous / n,
    pairwiseAgreement: pairs > 0 ? agreeSum / pairs : 1,
  };
}

export interface PooledComparison {
  items: number;
  a: PooledGroup;
  b: PooledGroup;
  /** Pooled accuracy difference, A − B (mean over items of the per-item mean difference). */
  delta: number;
  /** 95 % two-stage bootstrap percentile interval on `delta`. */
  low: number;
  high: number;
  /** Two-sided bootstrap p for delta = 0. */
  p: number;
  resamples: number;
  /** True only when both groups have at least two replicates. */
  replicated: boolean;
  /** Exact McNemar p for every (A replicate, B replicate) pair — how far one draw can swing. */
  pairP: { min: number; max: number; pairs: number };
}

/**
 * Compare two groups of replicates (A − B) on the items common to every
 * replicate of both: pooled accuracies, a two-stage cluster bootstrap interval
 * and p, and the spread of single-pair McNemar p-values.
 */
export function comparePooled(
  a: readonly Replicate[],
  b: readonly Replicate[],
  opts: { resamples?: number; seed?: number } = {},
): PooledComparison {
  const ids = commonItems([a, b]);
  const pa = poolGroup(a, ids);
  const pb = poolGroup(b, ids);
  const n = ids.length;
  const resamples = opts.resamples ?? 2000;
  const ka = a.length;
  const kb = b.length;
  // Outcome matrices: [replicate][item] as 0/1.
  const ma = a.map((r) => ids.map((id) => (r.get(id) === true ? 1 : 0)));
  const mb = b.map((r) => ids.map((id) => (r.get(id) === true ? 1 : 0)));
  const delta = pa.meanAccuracy - pb.meanAccuracy;
  let low = delta;
  let high = delta;
  let p = 1;
  if (n > 0 && ka > 0 && kb > 0 && resamples > 0) {
    const rand = mulberry32(opts.seed ?? 1);
    const stats = new Float64Array(resamples);
    let le = 0;
    let ge = 0;
    const pickA = new Int32Array(ka);
    const pickB = new Int32Array(kb);
    for (let s = 0; s < resamples; s++) {
      for (let r = 0; r < ka; r++) pickA[r] = Math.floor(rand() * ka);
      for (let r = 0; r < kb; r++) pickB[r] = Math.floor(rand() * kb);
      let sum = 0;
      for (let t = 0; t < n; t++) {
        const i = Math.floor(rand() * n);
        let ca = 0;
        for (let r = 0; r < ka; r++) ca += (ma[pickA[r] as number] as number[])[i] as number;
        let cb = 0;
        for (let r = 0; r < kb; r++) cb += (mb[pickB[r] as number] as number[])[i] as number;
        sum += ca / ka - cb / kb;
      }
      const v = sum / n;
      stats[s] = v;
      if (v <= 0) le++;
      if (v >= 0) ge++;
    }
    stats.sort();
    const at = (q: number) =>
      stats[Math.min(resamples - 1, Math.max(0, Math.floor(q * resamples)))] ?? 0;
    low = at(0.025);
    high = at(0.975);
    p = Math.min(1, (2 * (Math.min(le, ge) + 1)) / (resamples + 1));
  }
  let min = 1;
  let max = 0;
  let pairs = 0;
  for (const ra of ma) {
    for (const rb of mb) {
      let bw = 0;
      let cw = 0;
      for (let i = 0; i < n; i++) {
        if (ra[i] && !rb[i]) bw++;
        else if (!ra[i] && rb[i]) cw++;
      }
      const pp = mcnemarExact(bw, cw).p;
      min = Math.min(min, pp);
      max = Math.max(max, pp);
      pairs++;
    }
  }
  return {
    items: n,
    a: pa,
    b: pb,
    delta,
    low,
    high,
    p,
    resamples: n > 0 ? resamples : 0,
    replicated: ka >= 2 && kb >= 2,
    pairP: pairs > 0 ? { min, max, pairs } : { min: 1, max: 1, pairs: 0 },
  };
}

/** A stable bootstrap seed from run ids, so the same evidence gives the same interval. */
export function seedFromIds(ids: readonly string[]): number {
  let h = 2166136261;
  for (const ch of [...ids].sort().join("|")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
