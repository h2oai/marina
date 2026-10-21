// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Start forecast for noisy scalar poll toplines. A weekly poll's topline is a
 * sample around a slowly moving level (Economist/YouGov approval went 38, 37,
 * 40, 35, 36, 38), so the last release carries its own sampling error and
 * persistence over-reacts to it. This rule files the average of persistence
 * and the arena's own EWMA null (α 0.4, `ssa/baselines.py`) — a light shrink
 * toward the recent level — with a spread of half the rule's own recent
 * one-step RMS error, floored at a third of the persistence spread.
 *
 * Why half the RMS: the leaderboard averages per-round skill against
 * persistence at sd 1.5, and rounds where the poll barely moves dominate that
 * average, so the per-round-skill optimum is narrower than the CRPS optimum.
 * The scale and the family list were chosen by walk-forward backtest over
 * every resolved round and every pre-lock history.
 *
 * Gated per tracker family: monthly series that trend (UMich sentiment and
 * party splits) lose to persistence under any shrink, and Civiqs's daily
 * tracker is already smoothed. Pure: frozen values in, forecast out.
 */

import { ewma, fitSeries, predictWith, rms, rollingOriginErrors } from "../quant/series-fit";
import type { Distribution } from "./types";

/** Tracker families whose scalar toplines use the poll-level start (walk-forward backtest). */
export const POLL_LEVEL_TRACKERS: ReadonlySet<string> = new Set([
  "economist_yougov",
  "morning_consult",
  "aaii",
]);
/** The arena's EWMA baseline smoothing (`ssa/baselines.py` `ewma`, alpha 0.4). */
export const POLL_EWMA_ALPHA = 0.4;
/** Filed sd = this × the rule's own recent RMS error. */
export const POLL_LEVEL_SD_SCALE = 0.5;
/** Spread floor: a third of the arena's persistence sd (1.5). */
export const POLL_LEVEL_MIN_SD = 0.5;
/** Origins whose errors size the spread (as for the baseline spread). */
const ERROR_WINDOW = 26;
/** Fewest past errors a spread is estimated from; fewer ⇒ the baseline stands. */
const MIN_ERRORS = 6;
/** Releases before the first scored error (the EWMA's warm-up). */
const WARM_UP = 8;

export type PollLevelMode = "on" | "off";

/** `MARINA_ARENA_POLL_LEVEL=on|off` (default on); anything but `off` is on. */
export function pollLevelModeFromEnv(env: NodeJS.ProcessEnv = process.env): PollLevelMode {
  return env.MARINA_ARENA_POLL_LEVEL?.trim().toLowerCase() === "off" ? "off" : "on";
}

/** What the filing detail records about a poll-level start. */
export interface PollLevelEvidence {
  rule: "persistence-ewma-blend";
  /** The two means averaged. */
  persistence: number;
  ewma: number;
  alpha: number;
  /** Releases ahead the answer is. */
  steps: number;
  sd: {
    basis: "rule-rms";
    /** RMS of the rule's own `steps`-ahead errors over the last `errors` origins. */
    rms: number;
    errors: number;
    scale: number;
    floor: number;
  };
}

/** The arena's EWMA (`ssa/baselines.py`): seeded at the first value, alpha `POLL_EWMA_ALPHA`. */
export function arenaEwma(values: number[], alpha = POLL_EWMA_ALPHA): number {
  return ewma(values, alpha);
}

/** The rule's mean: the average of persistence and the arena's EWMA. */
export function pollBlendMean(values: number[]): number {
  return predictWith("blend", values, 1, { alpha: POLL_EWMA_ALPHA });
}

/**
 * RMS of `predict`'s own `steps`-ahead errors over the last `ERROR_WINDOW`
 * origins of `values` — each prediction made from the values before its
 * origin only. Undefined with fewer than `MIN_ERRORS` errors.
 */
export function ruleErrorRms(
  values: number[],
  predict: (prefix: number[]) => number,
  steps: number,
): { rms: number; n: number } | undefined {
  const errors = rollingOriginErrors(values, (p) => predict(p as number[]), steps, {
    window: ERROR_WINDOW,
    warmUp: WARM_UP,
  });
  return errors.length < MIN_ERRORS ? undefined : { rms: rms(errors), n: errors.length };
}

/**
 * The poll-level start for one series, or undefined when its history is too
 * short to size the spread (the caller then files its baseline). The shared
 * series fit (`src/quant/series-fit.ts`, method `blend`) with the arena's
 * constants.
 */
export function pollLevelForecast(
  values: number[],
  steps: number,
): { forecast: Distribution; evidence: PollLevelEvidence } | undefined {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0 || !Number.isSafeInteger(steps) || steps < 1) return undefined;
  const fit = fitSeries(finite, {
    steps,
    method: "blend",
    alpha: POLL_EWMA_ALPHA,
    window: ERROR_WINDOW,
    warmUp: WARM_UP,
    minErrors: MIN_ERRORS,
    sdScale: POLL_LEVEL_SD_SCALE,
    minSd: POLL_LEVEL_MIN_SD,
    levels: [],
  });
  if (fit?.sdBasis !== "rolling-origin") return undefined;
  const persistence = finite.at(-1)!;
  const ewmaLevel = arenaEwma(finite);
  return {
    forecast: { mean: fit.mean, sd: fit.sd },
    evidence: {
      rule: "persistence-ewma-blend",
      persistence,
      ewma: round3(ewmaLevel),
      alpha: POLL_EWMA_ALPHA,
      steps,
      sd: {
        basis: "rule-rms",
        rms: round3(fit.errorRms!),
        errors: fit.errorCount,
        scale: POLL_LEVEL_SD_SCALE,
        floor: POLL_LEVEL_MIN_SD,
      },
    },
  };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
