// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The bootstrap / Wilson / PRNG copies were deduplicated onto `src/stats/`.
 * Every former copy must still produce BIT-IDENTICAL output: each is compared
 * with its frozen original (`test/fixtures/stats-legacy.ts`) by exact
 * equality (Object.is per number) over fixed inputs and seeds.
 */

import { describe, expect, test } from "bun:test";
import { bootstrapMean as deepresearchBootstrapMean } from "../benchmarks/deepresearch/compare";
import { pairedBootstrap as selectPairedBootstrap } from "../benchmarks/forecasting/select";
import { bootstrapOverall, weightedOverall } from "../benchmarks/futurex/clean-run";
import { bootstrapInterval as longmemevalInterval } from "../benchmarks/longmemeval/convert";
import { wilson95 } from "../benchmarks/memory/genbench";
import { mulberry32 as shimMulberry32, wilsonInterval as shimWilson } from "../benchmarks/stats";
import {
  bootstrapMean as transferBootstrapMean,
  twoStageBootstrap,
} from "../benchmarks/transfer/core";
import { wilsonLow } from "../src/learned/format";
import { lcg32, mulberry32, percentileFloor, resampleMeans, wilsonInterval } from "../src/stats";
import {
  legacyArenaWikiBootstrapCi,
  legacyBootstrapOverall,
  legacyDeepresearchBootstrapMean,
  legacyLongmemevalBootstrapInterval,
  legacyMulberry32,
  legacySelectPairedBootstrap,
  legacyTransferBootstrapMean,
  legacyTwoStageBootstrap,
  legacyWilson95,
  legacyWilsonInterval,
  legacyWilsonLow,
} from "./fixtures/stats-legacy";

/** Exact equality, number by number (distinguishes -0 / 0, equates NaN / NaN). */
function same(a: unknown, b: unknown, path = "$"): void {
  if (typeof a === "number" || typeof b === "number") {
    if (!Object.is(a, b)) throw new Error(`${path}: ${String(a)} !== ${String(b)}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    expect(a.length).toBe(b.length);
    for (const [i, x] of a.entries()) same(x, b[i], `${path}[${i}]`);
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    for (const k of Object.keys(a))
      same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    return;
  }
  expect(a).toBe(b);
}

const SEEDS = [0, 1, 7, 11, 42, 20261019, 0xdeadbeef];

/** Deterministic test data from a seed (legacy PRNG, so inputs never move). */
function data(seed: number, n: number, scale = 1): number[] {
  const r = legacyMulberry32(seed ^ 0x9e3779b9);
  return Array.from({ length: n }, () => Math.round((r() * 2 - 1) * scale * 1000) / 1000);
}
function bools(seed: number, n: number, p = 0.6): boolean[] {
  const r = legacyMulberry32(seed + 17);
  return Array.from({ length: n }, () => r() < p);
}
function runs(seed: number, k: number, ids: string[]): Map<string, number>[] {
  const r = legacyMulberry32(seed + 101);
  return Array.from(
    { length: k },
    () => new Map(ids.map((id) => [id, Math.round(r() * 100) / 100])),
  );
}

describe("stats dedupe is bit-identical to the frozen originals", () => {
  test("mulberry32 (src/stats and the benchmarks shim) matches the legacy stream", () => {
    for (const seed of SEEDS) {
      const a = mulberry32(seed);
      const s = shimMulberry32(seed);
      const l = legacyMulberry32(seed);
      for (let i = 0; i < 1000; i++) {
        const x = l();
        same(a(), x);
        same(s(), x);
      }
    }
  });

  test("Wilson: wilsonInterval, wilsonLow, wilson95 over a (k, n) grid incl. n=0, k=0, k=n", () => {
    const zs = [undefined, 1.96, 1.645, 2.576];
    for (let n = 0; n <= 120; n++) {
      for (let k = 0; k <= n; k++) {
        for (const z of zs) {
          same(wilsonInterval(k, n, z), legacyWilsonInterval(k, n, z));
          same(shimWilson(k, n, z), legacyWilsonInterval(k, n, z));
          same(wilsonLow(k, n, z), legacyWilsonLow(k, n, z));
        }
        same(wilson95(k, n), legacyWilson95(k, n));
      }
    }
    for (const n of [500, 1000, 9999, 10_000]) {
      for (const k of [0, 1, Math.floor(n / 3), n - 1, n]) {
        same(wilsonInterval(k, n), legacyWilsonInterval(k, n));
        same(wilsonLow(k, n), legacyWilsonLow(k, n));
        same(wilson95(k, n), legacyWilson95(k, n));
      }
    }
    // Out-of-range inputs a caller might pass keep their old answers too.
    for (const [k, n] of [
      [-1, 10],
      [3, -2],
      [12, 10],
    ] as const) {
      same(wilsonInterval(k, n), legacyWilsonInterval(k, n));
      same(wilsonLow(k, n), legacyWilsonLow(k, n));
      same(wilson95(k, n), legacyWilson95(k, n));
    }
  });

  test("transfer bootstrapMean (level quantiles)", () => {
    for (const seed of SEEDS) {
      for (const n of [0, 1, 2, 5, 37, 200]) {
        const xs = data(seed, n, 3);
        for (const level of [undefined, 0.9, 0.95, 0.99]) {
          for (const resamples of [undefined, 1, 999, 2000]) {
            const opts = { seed, ...(level ? { level } : {}), ...(resamples ? { resamples } : {}) };
            same(transferBootstrapMean(xs, opts), legacyTransferBootstrapMean(xs, opts));
          }
        }
      }
    }
  });

  test("transfer twoStageBootstrap and forecasting/select pairedBootstrap", () => {
    for (const seed of [1, 11, 0xdeadbeef]) {
      for (const n of [0, 1, 3, 25]) {
        const ids = Array.from({ length: n }, (_, i) => `q${i}`);
        for (const [ka, kb] of [
          [0, 2],
          [1, 1],
          [2, 3],
          [4, 2],
        ] as const) {
          const a = runs(seed, ka, ids);
          // A run missing an item (`?? 0`) is part of the old arithmetic too.
          const b = runs(
            seed + 1,
            kb,
            ids.filter((_, i) => i % 7 !== 3),
          );
          for (const level of [undefined, 0.9, 0.95]) {
            const opts = { seed, resamples: 400, ...(level ? { level } : {}) };
            same(twoStageBootstrap(a, b, ids, opts), legacyTwoStageBootstrap(a, b, ids, opts));
          }
          for (const it of [1, 2000]) {
            same(
              selectPairedBootstrap(a, b, ids, it, seed),
              legacySelectPairedBootstrap(a, b, ids, it, seed),
            );
          }
        }
      }
    }
    // The defaults (10 000 / 2 000 resamples, seeds 1 / 11), once each.
    const ids = Array.from({ length: 40 }, (_, i) => `q${i}`);
    const a = runs(5, 3, ids);
    const b = runs(6, 2, ids);
    same(twoStageBootstrap(a, b, ids), legacyTwoStageBootstrap(a, b, ids));
    same(selectPairedBootstrap(a, b, ids), legacySelectPairedBootstrap(a, b, ids));
  }, 30_000);

  test("deepresearch bootstrapMean (literal 0.025 / 0.975)", () => {
    for (const seed of SEEDS) {
      for (const n of [0, 1, 4, 60]) {
        const xs = data(seed, n, 10);
        for (const r of [1, 7, 10_000]) {
          same(
            deepresearchBootstrapMean(xs, r, seed),
            legacyDeepresearchBootstrapMean(xs, r, seed),
          );
        }
        same(deepresearchBootstrapMean(xs), legacyDeepresearchBootstrapMean(xs));
      }
    }
  });

  test("longmemeval bootstrapInterval (ceil upper index)", () => {
    for (const seed of SEEDS) {
      for (const n of [0, 1, 9, 120, 500]) {
        const xs = bools(seed, n);
        for (const r of [1, 3, 999, 10_000]) {
          same(longmemevalInterval(xs, r, seed), legacyLongmemevalBootstrapInterval(xs, r, seed));
        }
        same(longmemevalInterval(xs), legacyLongmemevalBootstrapInterval(xs));
      }
    }
  });

  test("futurex bootstrapOverall (LCG, stratified by level)", () => {
    for (const seed of SEEDS) {
      for (const n of [1, 5, 40, 150]) {
        const r = legacyMulberry32(seed + 3);
        const items = Array.from({ length: n }, () => ({
          level: 1 + Math.floor(r() * 4),
          score: Math.round(r() * 100) / 100,
        }));
        for (const it of [1, 2000, 2001]) {
          same(
            bootstrapOverall(items, it, seed),
            legacyBootstrapOverall(items, weightedOverall, it, seed),
          );
        }
        same(bootstrapOverall(items), legacyBootstrapOverall(items, weightedOverall));
      }
    }
  });

  test("arena-wiki bootstrapCi composition (lcg32 + resampleMeans + percentileFloor)", () => {
    // The script's private bootstrapCi body, as it now reads (scripts/arena-wiki-backtest.ts).
    const bootstrapCi = (d: number[], reps = 4000): [number, number] => {
      if (d.length < 2) return [Number.NaN, Number.NaN];
      const means = resampleMeans(d, reps, lcg32(20261019));
      return [percentileFloor(means, 0.025), percentileFloor(means, 0.975)];
    };
    for (const seed of SEEDS) {
      for (const n of [0, 1, 2, 30, 104]) {
        const d = data(seed, n, 0.5);
        for (const reps of [1, 3, 4000, 4001])
          same(bootstrapCi(d, reps), legacyArenaWikiBootstrapCi(d, reps));
        same(bootstrapCi(d), legacyArenaWikiBootstrapCi(d));
      }
    }
  });
});
