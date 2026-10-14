// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { forecastRound } from "../src/arena/forecast";
import { levelForecast, levelSpread } from "../src/arena/sampling-noise";
import type { ArenaLock, ArenaPoint, ArenaRound } from "../src/arena/types";

/** Deterministic standard normals (LCG + Box–Muller). */
function normals(seed: number, n: number): number[] {
  let s = seed;
  const u = () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return (s + 1) / (2 ** 31 + 1);
  };
  return Array.from(
    { length: n },
    () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()),
  );
}

const weekly = (values: number[]): ArenaPoint[] =>
  values.map((value, i) => ({
    date: new Date(Date.parse("2025-08-04") + i * 7 * 86_400_000).toISOString().slice(0, 10),
    value: Math.round(value),
  }));

function profileRound(
  tracker: string,
  cell: (k: number, i: number, z: number) => number,
): { round: ArenaRound; lock: ArenaLock; levels: number[] } {
  const cells = Array.from({ length: 6 }, (_, k) => `xtab_approve_g${k}`);
  const levels = cells.map((_, k) => 20 + 8 * k);
  const round: ArenaRound = {
    round_id: `${tracker}-2026-w43`,
    tracker,
    series: cells[0],
    question: "Percent approving in each subgroup?",
    unit: "percent approving",
    target_type: "profile_energy",
    cells,
    lock_at: "2026-10-18T14:00:00Z",
    release_at: "2026-10-20T14:00:00Z",
  };
  const n = 60;
  const lock: ArenaLock = {
    round_id: round.round_id,
    answer_history_by_cell: Object.fromEntries(
      cells.map((c, k) => {
        const z = normals(101 + k, n);
        return [c, weekly(z.map((zi, i) => cell(k, i, zi)))];
      }),
    ),
  };
  return { round, lock, levels };
}

describe("sampling-noise level rule", () => {
  it("averages a crosstab's noisy cells and sizes the spread from its own misses", () => {
    // Each cell: a fixed level plus fresh sampling noise (sd 3) every week.
    const { round, lock, levels } = profileRound("yougov_xtab", (k, _i, z) => 20 + 8 * k + 3 * z);
    const f = forecastRound(round, lock);
    expect(f.level).toBeDefined();
    expect(f.level!.k).toBeGreaterThan(1);
    expect(f.level!.skill[`k${f.level!.k}`]!).toBeGreaterThan(f.level!.skill.baseline!);
    expect(Object.values(f.rules).every((r) => r === "level")).toBe(true);
    expect(f.note).toContain(`mean of the last ${f.level!.k} releases`);
    const cells = round.cells!;
    let levelErr = 0;
    let persErr = 0;
    cells.forEach((c, k) => {
      const hist = lock.answer_history_by_cell![c]!;
      levelErr += Math.abs(f.profile![c]!.mean - levels[k]!);
      persErr += Math.abs(hist.at(-1)!.value - levels[k]!);
      // Sampling sd 3 (plus the average's own error): far wider than persistence's 1.5.
      expect(f.profile![c]!.sd).toBeGreaterThan(2);
      expect(f.profile![c]!.sd).toBeLessThan(5);
    });
    expect(levelErr).toBeLessThan(persErr);
  });

  it("keeps the persistence mean for a crosstab that moves like a random walk", () => {
    let walk = 0;
    const { round, lock } = profileRound("yougov_xtab", (k, i, z) => {
      if (i === 0) walk = 0;
      walk += 2 * z;
      return 30 + 8 * k + walk;
    });
    const f = forecastRound(round, lock);
    // Averaging loses on a walk; at most the spread is re-sized (k = 1).
    if (f.level) {
      expect(f.level.k).toBe(1);
      expect(f.note).toContain("(sampling-noise level): last release per cell");
    }
    for (const c of round.cells!)
      expect(f.profile![c]!.mean).toBe(lock.answer_history_by_cell![c]!.at(-1)!.value);
  });

  it("never applies outside the sampling-noise trackers", () => {
    const { round, lock } = profileRound("civiqs", (k, _i, z) => 20 + 8 * k + 3 * z);
    const f = forecastRound(round, lock);
    expect(f.level).toBeUndefined();
    expect(Object.values(f.rules).includes("level")).toBe(false);
  });

  it("estimates the spread only from enough past misses", () => {
    expect(levelSpread([1, 2, 3, 4, 5], 2, 1)).toBeUndefined();
    const values = [10, 12, 10, 12, 10, 12, 10, 12, 10, 12];
    // The 2-mean is always 11 and every miss is exactly 1.
    expect(levelSpread(values, 2, 1)).toBeCloseTo(1, 10);
    expect(levelForecast(values, 2, 1)).toEqual({ mean: 11, sd: 1 });
    expect(levelForecast(values.slice(0, 1), 2, 1)).toBeUndefined();
  });
});
