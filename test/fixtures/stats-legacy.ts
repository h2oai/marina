// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * FROZEN copies of the bootstrap / Wilson / PRNG implementations as they were
 * before they were deduplicated onto `src/stats/` (2026-10-20). The
 * equivalence test (`test/stats-equivalence.test.ts`) requires the shared
 * implementations to reproduce these bit for bit. Never edit this file to
 * make that test pass.
 */

/** benchmarks/stats.ts mulberry32 (also the private copies in longmemeval/convert.ts and synthetic-skills-v1.generator.ts). */
export function legacyMulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** benchmarks/stats.ts wilsonInterval. */
export function legacyWilsonInterval(
  successes: number,
  n: number,
  z = 1.959963984540054,
): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    low: successes <= 0 ? 0 : Math.max(0, centre - half),
    high: successes >= n ? 1 : Math.min(1, centre + half),
  };
}

/** src/learned/format.ts wilsonLow. */
export function legacyWilsonLow(successes: number, n: number, z = 1.959963984540054): number {
  if (n <= 0 || successes <= 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return Math.max(0, centre - half);
}

/** benchmarks/memory/genbench.ts wilson95. */
export function legacyWilson95(correct: number, n: number): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 0 };
  const z = 1.959963984540054;
  const p = correct / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

/** benchmarks/transfer/core.ts bootstrapMean. */
export function legacyTransferBootstrapMean(
  deltas: readonly number[],
  opts: { resamples?: number; seed?: number; level?: number } = {},
): { mean: number; low: number; high: number; resamples: number } {
  const n = deltas.length;
  const resamples = opts.resamples ?? 10_000;
  const level = opts.level ?? 0.95;
  if (n === 0) return { mean: 0, low: 0, high: 0, resamples: 0 };
  const mean = deltas.reduce((s, v) => s + v, 0) / n;
  const rand = legacyMulberry32(opts.seed ?? 1);
  const stats = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += deltas[Math.floor(rand() * n)] ?? 0;
    stats[r] = s / n;
  }
  stats.sort();
  const alpha = (1 - level) / 2;
  const at = (q: number) =>
    stats[Math.min(resamples - 1, Math.max(0, Math.floor(q * resamples)))] ?? 0;
  return { mean, low: at(alpha), high: at(1 - alpha), resamples };
}

/** benchmarks/transfer/core.ts twoStageBootstrap. */
export function legacyTwoStageBootstrap(
  candidate: ReadonlyArray<ReadonlyMap<string, number>>,
  baseline: ReadonlyArray<ReadonlyMap<string, number>>,
  ids: readonly string[],
  opts: { resamples?: number; seed?: number; level?: number } = {},
): { mean: number; low: number; high: number; resamples: number } {
  const resamples = opts.resamples ?? 10_000;
  const level = opts.level ?? 0.95;
  if (ids.length === 0 || candidate.length === 0 || baseline.length === 0)
    return { mean: 0, low: 0, high: 0, resamples: 0 };
  const rand = legacyMulberry32(opts.seed ?? 1);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const itemMean = (runs: ReadonlyArray<ReadonlyMap<string, number>>, id: string) =>
    runs.reduce((s, r) => s + (r.get(id) ?? 0), 0) / runs.length;
  const mean =
    ids.reduce((s, id) => s + itemMean(candidate, id) - itemMean(baseline, id), 0) / ids.length;
  const stats = new Float64Array(resamples);
  for (let k = 0; k < resamples; k++) {
    const c = candidate.map(() => pick(candidate));
    const b = baseline.map(() => pick(baseline));
    let s = 0;
    for (let j = 0; j < ids.length; j++) {
      const id = pick(ids);
      s += itemMean(c, id) - itemMean(b, id);
    }
    stats[k] = s / ids.length;
  }
  stats.sort();
  const alpha = (1 - level) / 2;
  const at = (q: number) =>
    stats[Math.min(resamples - 1, Math.max(0, Math.floor(q * resamples)))] ?? 0;
  return { mean, low: at(alpha), high: at(1 - alpha), resamples };
}

/** benchmarks/deepresearch/compare.ts bootstrapMean. */
export function legacyDeepresearchBootstrapMean(
  xs: readonly number[],
  resamples = 10_000,
  seed = 1,
): { n: number; mean: number; low: number; high: number } {
  const percentile = (sorted: Float64Array, q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))] ?? 0;
  const n = xs.length;
  if (n === 0) return { n: 0, mean: Number.NaN, low: Number.NaN, high: Number.NaN };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const rand = legacyMulberry32(seed);
  const stats = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += xs[Math.floor(rand() * n)] ?? 0;
    stats[r] = s / n;
  }
  stats.sort();
  return { n, mean, low: percentile(stats, 0.025), high: percentile(stats, 0.975) };
}

/** benchmarks/longmemeval/convert.ts bootstrapInterval. */
export function legacyLongmemevalBootstrapInterval(
  outcomes: boolean[],
  resamples = 10_000,
  seed = 1,
): [number, number] {
  if (outcomes.length === 0) return [Number.NaN, Number.NaN];
  const rand = legacyMulberry32(seed);
  const stats: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let c = 0;
    for (let i = 0; i < outcomes.length; i++)
      if (outcomes[Math.floor(rand() * outcomes.length)]) c++;
    stats.push((100 * c) / outcomes.length);
  }
  stats.sort((a, b) => a - b);
  return [stats[Math.floor(0.025 * resamples)]!, stats[Math.ceil(0.975 * resamples) - 1]!];
}

/** benchmarks/futurex/clean-run.ts bootstrapOverall (its statistic passed in). */
export function legacyBootstrapOverall(
  items: Array<{ level: number; score: number }>,
  weightedOverall: (items: Array<{ level: number; score: number }>) => number,
  iterations = 2_000,
  seed = 7,
): [number, number] {
  const round = (x: number) => Math.round(x * 10_000) / 10_000;
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
  const byLevel = [1, 2, 3, 4].map((l) => items.filter((i) => i.level === l));
  const stats: number[] = [];
  for (let k = 0; k < iterations; k++) {
    const sample = byLevel.flatMap((at) => at.map(() => at[Math.floor(rand() * at.length)]!));
    stats.push(weightedOverall(sample));
  }
  stats.sort((a, b) => a - b);
  const q = (p: number) => stats[Math.min(stats.length - 1, Math.floor(p * stats.length))]!;
  return [round(q(0.025)), round(q(0.975))];
}

/** benchmarks/forecasting/select.ts pairedBootstrap. */
export function legacySelectPairedBootstrap(
  leader: Array<Map<string, number>>,
  other: Array<Map<string, number>>,
  ids: string[],
  iterations = 2_000,
  seed = 11,
): { diff: number; ci: [number, number] } {
  const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
  const rand = legacyMulberry32(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const itemMean = (runs: Array<Map<string, number>>, id: string) =>
    runs.reduce((s, r) => s + (r.get(id) ?? 0), 0) / runs.length;
  const observed =
    ids.reduce((s, id) => s + itemMean(leader, id) - itemMean(other, id), 0) / ids.length;
  const stats: number[] = [];
  for (let k = 0; k < iterations; k++) {
    const l = leader.map(() => pick(leader));
    const o = other.map(() => pick(other));
    let s = 0;
    for (let j = 0; j < ids.length; j++) {
      const id = pick(ids);
      s += itemMean(l, id) - itemMean(o, id);
    }
    stats.push(s / ids.length);
  }
  stats.sort((a, b) => a - b);
  const q = (p: number) => stats[Math.min(stats.length - 1, Math.floor(p * stats.length))]!;
  return { diff: round(observed), ci: [round(q(0.025)), round(q(0.975))] };
}

/** scripts/arena-wiki-backtest.ts bootstrapCi (private in a script with side effects). */
export function legacyArenaWikiBootstrapCi(d: number[], reps = 4000): [number, number] {
  if (d.length < 2) return [Number.NaN, Number.NaN];
  let seed = 20261019;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const means: number[] = [];
  for (let r = 0; r < reps; r++) {
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[Math.floor(rand() * d.length)]!;
    means.push(s / d.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * reps)]!, means[Math.floor(0.975 * reps)]!];
}
