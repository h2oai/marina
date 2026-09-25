// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The arena's scores for the two non-scalar round shapes, ported exactly from
 * `ssa/scoring.py` and `ssa/ranking_round.py` so Marina's evaluation agrees
 * with the leaderboard to the digit (`test/arena-score-shapes.test.ts` pins
 * values the arena published):
 *
 *   profile  — energy score over a deterministic Latin-hypercube point set:
 *              each cell walks the quantile grid (i + 0.5) / draws through its
 *              own normal inverse CDF (Acklam), permuted per cell by the order
 *              of sha256("seed:dim:index"); no random numbers anywhere.
 *   ranking  — rank-biased overlap loss (1 − RBO, truncated at the list
 *              length, normalised by the weight used).
 *
 * Skill is the scalar convention everywhere: 1 − loss / persistence loss.
 */

import { createHash } from "node:crypto";

export const PROFILE_SEED = 20260811;
export const PROFILE_DRAWS = 400;

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

/** Acklam's inverse normal CDF, as the arena computes it. */
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

const perms = new Map<string, number[]>();

function perm(dim: number, draws: number, seed: number): number[] {
  const key = `${dim}:${draws}:${seed}`;
  let got = perms.get(key);
  if (!got) {
    const digests = Array.from({ length: draws }, (_, i) =>
      createHash("sha256").update(`${seed}:${dim}:${i}`).digest(),
    );
    got = Array.from({ length: draws }, (_, i) => i).sort((a, b) =>
      Buffer.compare(digests[a]!, digests[b]!),
    );
    perms.set(key, got);
  }
  return got;
}

/** The arena's point set for per-cell normal marginals (rows = draws, columns = cells). */
export function cellSamples(
  cells: Array<{ mean: number; sd: number }>,
  seed = PROFILE_SEED,
  draws = PROFILE_DRAWS,
): number[][] {
  const cols = cells.map((c, dim) => {
    if (!(c.sd > 0)) throw new Error(`cell sd must be > 0, got ${c.sd}`);
    return perm(dim, draws, seed).map((i) => normalQuantile(c.mean, c.sd, (i + 0.5) / draws));
  });
  return Array.from({ length: draws }, (_, r) => cols.map((col) => col[r]!));
}

function dist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    s += d * d;
  }
  return Math.sqrt(s);
}

/** mean‖X − y‖ − ½ mean‖X − X′‖ (the V-statistic form the arena uses). */
export function energyScore(samples: number[][], outcome: number[]): number {
  const n = samples.length;
  if (n === 0) throw new Error("no samples");
  let t1 = 0;
  for (const x of samples) t1 += dist(x, outcome);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const xi = samples[i]!;
    for (let j = i + 1; j < n; j++) acc += dist(xi, samples[j]!);
  }
  return t1 / n - 0.5 * ((2 * acc) / (n * n));
}

/** Energy score of per-cell normal marginals, cells in the round's order. */
export function profileEnergy(
  forecast: Record<string, { mean: number; sd: number }>,
  outcome: Record<string, number>,
  cells: string[],
): number {
  const samples = cellSamples(cells.map((c) => forecast[c]!));
  return energyScore(
    samples,
    cells.map((c) => outcome[c]!),
  );
}

/** Rank-biased overlap in [0, 1], truncated at `depth` and normalised by the weight used. */
export function rboSimilarity(
  predicted: string[],
  truth: string[],
  p: number,
  depth?: number,
): number {
  const d = depth ?? Math.max(predicted.length, truth.length);
  if (d <= 0) throw new Error("rank-biased overlap needs a non-empty list");
  if (!(p > 0 && p < 1)) throw new Error(`rbo p must be in (0, 1), got ${p}`);
  const seenP = new Set<string>();
  const seenT = new Set<string>();
  let agreement = 0;
  let weight = 0;
  let hit = 0;
  for (let i = 0; i < d; i++) {
    if (i < predicted.length) {
      const x = predicted[i]!;
      if (seenT.has(x)) hit++;
      seenP.add(x);
    }
    if (i < truth.length) {
      const y = truth[i]!;
      if (seenP.has(y)) hit++;
      seenT.add(y);
    }
    const w = (1 - p) * p ** i;
    weight += w;
    agreement += w * (hit / (i + 1));
  }
  return agreement / weight;
}

export function rboLoss(predicted: string[], truth: string[], p: number, depth?: number): number {
  return 1 - rboSimilarity(predicted, truth, p, depth);
}
