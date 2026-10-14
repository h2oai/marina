// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Level estimate for sampling-noise profiles. A subgroup crosstab cell (a few
 * hundred respondents of one weekly poll) is a noisy draw around a slowly
 * moving level: last week's value carries last week's sampling error, so the
 * mean of the last k releases predicts the next one better than persistence,
 * and the spread is the size of that mean's own recent misses.
 *
 * k is chosen ONCE per round, pooled across the profile's cells, from the
 * cells' own rolling-origin record (only values before each origin), and is
 * used only when it beats the per-cell baseline by the calibration margin;
 * otherwise the baseline stands. Pure: frozen histories in, forecast out.
 */

import { crpsNormal } from "./score";
import type { ArenaPoint, Distribution } from "./types";

/** Trackers whose profile cells are small-sample subgroup estimates. */
export const SAMPLING_NOISE_TRACKERS: ReadonlySet<string> = new Set(["yougov_xtab"]);
/** Candidate windows (releases averaged); 1 is the persistence mean. */
export const LEVEL_WINDOWS = [1, 2, 4, 6, 8] as const;
/** Origins whose own-error spread is estimated (as for the baseline spread). */
const ERROR_WINDOW = 26;
/** Fewest past errors a spread is estimated from. */
const MIN_ERRORS = 6;
/** Warm-up before an origin is scored in-sample. */
const MIN_HISTORY = 12;
const MIN_SD = 0.05;

export interface LevelEvidence {
  /** Releases averaged. */
  k: number;
  /** Releases ahead the answer is. */
  steps: number;
  /** Pooled in-sample mean skill vs persistence (sd 1.5): `baseline` and each `k<N>`. */
  skill: Record<string, number>;
  /** Scored cell-origins behind `skill` (skill itself is per target date, summed over cells). */
  points: number;
}

function meanOfLast(values: number[], k: number): number {
  const tail = values.slice(-k);
  return tail.reduce((s, x) => s + x, 0) / tail.length;
}

/** RMS of the k-mean's own `steps`-ahead errors over the last origins of `values`. */
export function levelSpread(values: number[], k: number, steps: number): number | undefined {
  let sum = 0;
  let n = 0;
  for (let t = Math.max(k + steps - 1, values.length - ERROR_WINDOW); t < values.length; t++) {
    const e = values[t]! - meanOfLast(values.slice(0, t - steps + 1), k);
    sum += e * e;
    n++;
  }
  return n < MIN_ERRORS ? undefined : Math.max(Math.sqrt(sum / n), MIN_SD);
}

/** The k-mean forecast of the next `steps`-ahead value, or undefined without enough history. */
export function levelForecast(
  values: number[],
  k: number,
  steps: number,
): Distribution | undefined {
  if (values.length < k) return undefined;
  const sd = levelSpread(values, k, steps);
  return sd === undefined ? undefined : { mean: meanOfLast(values, k), sd };
}

/**
 * Choose k for a whole profile from its cells' rolling-origin record, scored
 * like the leaderboard (per-origin skill vs persistence sd `persistenceSd`).
 * `baseline(prefix)` is what the cell would file otherwise; the level rule
 * replaces it only when the best k beats it by `margin`. Undefined = keep the
 * baseline.
 */
export function chooseLevelWindow(
  cells: ArenaPoint[][],
  steps: number,
  baseline: (prefix: ArenaPoint[]) => Distribution,
  persistenceSd: number,
  margin: number,
): LevelEvidence | undefined {
  // Per target date, CRPS summed over the cells scored that date: the profile
  // is scored as one vector, and a per-cell ratio would be dominated by cells
  // that happened to land on last week's value (persistence CRPS near 0).
  const keys = ["baseline", ...LEVEL_WINDOWS.map((k) => `k${k}`)];
  const byDate = new Map<string, { pers: number; crps: Record<string, number> }>();
  let points = 0;
  for (const hist of cells) {
    const values = hist.map((p) => p.value);
    for (let t = Math.max(MIN_HISTORY, steps); t < values.length; t++) {
      const prefix = values.slice(0, t - steps + 1);
      const y = values[t]!;
      const level = LEVEL_WINDOWS.map((k) => levelForecast(prefix, k, steps));
      if (level.some((f) => f === undefined)) continue;
      const base = baseline(hist.slice(0, t - steps + 1));
      const at = byDate.get(hist[t]!.date) ?? {
        pers: 0,
        crps: Object.fromEntries(keys.map((key) => [key, 0])),
      };
      at.pers += crpsNormal(prefix.at(-1)!, persistenceSd, y);
      at.crps.baseline! += crpsNormal(base.mean, base.sd, y);
      LEVEL_WINDOWS.forEach((k, i) => {
        at.crps[`k${k}`]! += crpsNormal(level[i]!.mean, level[i]!.sd, y);
      });
      byDate.set(hist[t]!.date, at);
      points++;
    }
  }
  const scored = [...byDate.values()].filter((d) => d.pers > 0);
  if (scored.length === 0) return undefined;
  const skill = Object.fromEntries(
    keys.map((key) => [
      key,
      scored.reduce((s, d) => s + 1 - d.crps[key]! / d.pers, 0) / scored.length,
    ]),
  );
  let best: number = LEVEL_WINDOWS[0];
  for (const k of LEVEL_WINDOWS) if (skill[`k${k}`]! > skill[`k${best}`]!) best = k;
  if (skill[`k${best}`]! < skill.baseline! + margin) return undefined;
  return { k: best, steps, skill, points };
}
