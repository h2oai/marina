// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marina's arena baseline. Pure: a round definition and its frozen inputs in, a
 * forecast out. The arena scores everyone against persistence with a FIXED
 * sd of 1.5 whatever the series' scale; this keeps persistence's mean and
 * replaces the spread with one calibrated to how the series actually moves —
 * but only for a series whose own history says that wins by a clear margin.
 * Otherwise it files exact persistence, which ties the reference (skill 0)
 * and can never blow up. Agents improve on it; they never have to beat
 * nothing.
 */

import { medianSpacingDays, rms, robustSpread, stepChanges, stepsAhead } from "../quant/series-fit";
import {
  POLL_LEVEL_TRACKERS,
  type PollLevelEvidence,
  type PollLevelMode,
  pollLevelForecast,
  pollLevelModeFromEnv,
} from "./poll-level";
import {
  chooseLevelWindow,
  type LevelEvidence,
  levelForecast,
  SAMPLING_NOISE_TRACKERS,
} from "./sampling-noise";
import { crpsNormal } from "./score";
import type { ArenaLock, ArenaPoint, ArenaRound, Distribution } from "./types";

/** The arena's own persistence spread (`ssa/baselines.py`). */
export const PERSISTENCE_SD = 1.5;
/** Calibration must beat persistence in-sample by this share to be used. */
export const CALIBRATION_MARGIN = 0.05;
/** Changes used to estimate the spread. */
const SD_WINDOW = 26;
/** Warm-up before the in-sample comparison starts. */
const MIN_HISTORY = 12;
const MIN_SD = 0.05;
const DAY_MS = 86_400_000;

/**
 * `level` (sampling-noise profiles only, `sampling-noise.ts`) also moves the
 * mean: the mean of the last k releases, with the spread of its own misses.
 * `poll-level` (noisy scalar poll toplines, `poll-level.ts`) files the average
 * of persistence and the arena's EWMA with half its own recent RMS error.
 */
export type SpreadRule = "persistence" | "calibrated" | "robust" | "level" | "poll-level";

export interface ScalarForecast extends Distribution {
  rule: SpreadRule;
  /** Mean in-sample per-round skill of each candidate spread — the evidence behind `rule`. */
  evidence?: { skill: Record<string, number>; points: number };
  steps: number;
}

/** Release cadence of a series in days (median spacing of its points; `src/quant/series-fit.ts`). */
const spacingDays = (points: ArenaPoint[]): number => medianSpacingDays(points);

/** How many releases ahead the round's answer is from the last known point. */
export function horizonSteps(points: ArenaPoint[], releaseAt: string): number {
  return stepsAhead(points, releaseAt);
}

function recentChanges(values: number[], steps: number): number[] | undefined {
  const diffs = stepChanges(values, steps, { window: SD_WINDOW, warmUp: 1 });
  return diffs.length < 6 ? undefined : diffs;
}

/**
 * Candidate spreads from the series' own recent `steps`-ahead changes: RMS
 * (`calibrated`) and a spike-resistant median-based one (`robust`, 1.4826 ×
 * median |change| — the normal-consistent MAD), for series such as pageviews
 * where a few spikes would otherwise make every forecast needlessly wide.
 */
function candidateSpreads(values: number[], steps: number): Partial<Record<SpreadRule, number>> {
  const diffs = recentChanges(values, steps);
  if (!diffs) return {};
  return {
    calibrated: Math.max(rms(diffs), MIN_SD),
    robust: Math.max(robustSpread(diffs), MIN_SD),
  };
}

/**
 * Persistence mean; the spread chosen by this series' own rolling-origin record,
 * scored the way the leaderboard scores: the MEAN of per-round skill
 * (1 − CRPS ÷ persistence CRPS), not the ratio of total CRPS. The two differ
 * sharply on spiky series — a wide spread wins on the spikes' total but loses
 * nearly every ordinary week, and the leaderboard counts weeks.
 */
export function forecastScalar(points: ArenaPoint[], releaseAt: string): ScalarForecast {
  const values = points.map((p) => p.value).filter((v) => Number.isFinite(v));
  if (values.length === 0) throw new Error("no history to forecast from");
  const steps = horizonSteps(points, releaseAt);
  const mean = round(values.at(-1)!);
  const sums: Record<string, number> = { calibrated: 0, robust: 0 };
  let n = 0;
  for (let t = Math.max(MIN_HISTORY, steps); t < values.length; t++) {
    const spreads = candidateSpreads(values.slice(0, t - steps + 1), steps);
    if (spreads.calibrated === undefined || spreads.robust === undefined) continue;
    const origin = values[t - steps]!;
    const pers = crpsNormal(origin, PERSISTENCE_SD, values[t]!);
    if (pers <= 0) continue;
    for (const rule of ["calibrated", "robust"] as const) {
      sums[rule]! += 1 - crpsNormal(origin, spreads[rule]!, values[t]!) / pers;
    }
    n++;
  }
  const skillOf = (rule: string) => (n ? sums[rule]! / n : Number.NEGATIVE_INFINITY);
  const current = candidateSpreads(values, steps);
  const best: SpreadRule = skillOf("robust") > skillOf("calibrated") ? "robust" : "calibrated";
  const wins = n >= 6 && current[best] !== undefined && skillOf(best) >= CALIBRATION_MARGIN;
  return {
    mean,
    sd: wins ? round(current[best]!) : PERSISTENCE_SD,
    rule: wins ? best : "persistence",
    steps,
    ...(n > 0
      ? {
          evidence: {
            skill: { calibrated: skillOf("calibrated"), robust: skillOf("robust") },
            points: n,
          },
        }
      : {}),
  };
}

/** The arena's `main_page_and_namespaces_v1` rule (`ssa/adapters/wikipedia.py`). */
const EXCLUDED_TITLES = new Set(["Main_Page"]);
const NAMESPACE_PREFIXES = [
  "Special:",
  "Wikipedia:",
  "Portal:",
  "Help:",
  "File:",
  "Template:",
  "Category:",
  "Draft:",
  "User:",
  "Talk:",
  "Wikipedia_talk:",
  "Portal_talk:",
  "Help_talk:",
  "File_talk:",
  "Template_talk:",
  "Category_talk:",
  "Draft_talk:",
  "User_talk:",
];
export function isExcludedTitle(title: string): boolean {
  return EXCLUDED_TITLES.has(title) || NAMESPACE_PREFIXES.some((p) => title.startsWith(p));
}

/** Recency half-life for ranking views (days), chosen by backtest over the arena's archived weeks. */
export const RANKING_HALF_LIFE_DAYS = 3;

/**
 * Top-N from recent daily lists, views weighted by recency (half-life
 * `RANKING_HALF_LIFE_DAYS`, counted back from the newest list): a spike fades,
 * a sustained article keeps its place. Ties by title, as the arena breaks them.
 */
export function forecastRanking(lock: ArenaLock, length: number, allowed?: string[]): string[] {
  const ranked = rankingScores(lock, allowed).map(([t]) => t);
  if (ranked.length < length) {
    throw new Error(`only ${ranked.length} candidates for a top-${length}`);
  }
  return ranked.slice(0, length);
}

/** Every eligible candidate with its recency-weighted score, best first (ties by title). */
export function rankingScores(lock: ArenaLock, allowed?: string[]): Array<[string, number]> {
  const obs = [...(lock.answer_obs ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  if (obs.length === 0) throw new Error("no ranking observations to forecast from");
  const newest = Date.parse(obs.at(-1)!.date);
  const totals = new Map<string, number>();
  for (const day of obs) {
    const age = (newest - Date.parse(day.date)) / DAY_MS;
    const w = 0.5 ** (age / RANKING_HALF_LIFE_DAYS);
    day.items.forEach((item, i) => {
      const views = day.views?.[item] ?? day.items.length - i;
      totals.set(item, (totals.get(item) ?? 0) + w * views);
    });
  }
  const allow = allowed ? new Set(allowed) : undefined;
  return [...totals.entries()]
    .filter(([t]) => !isExcludedTitle(t) && (!allow || allow.has(t)))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export interface RoundForecast {
  topline?: Distribution;
  profile?: Record<string, Distribution>;
  ranking?: string[];
  /** Per series (or cell): which spread rule was used. */
  rules: Record<string, SpreadRule>;
  /** The level window chosen for a sampling-noise profile, and the evidence behind it. */
  level?: LevelEvidence;
  /** The poll-level start for a noisy scalar poll topline (`poll-level.ts`). */
  pollLevel?: PollLevelEvidence;
  note: string;
  /** Dated inputs and the actual start distribution, retained through model stages. */
  origins?: Record<string, ForecastOrigin>;
  /** Observation freshness at preparation time, rechecked before signing. */
  freshness?: import("./freshness").FreshnessAudit;
  /** Set when a filed sd was raised to the measured nowcast error (submit.ts). */
  errorFloorApplied?: { fromSd?: number; notes: string[] };
  /** The earned-route decision for a routed round (`earned-routes.ts`). */
  routing?: import("./earned-routes").ArenaRouteDecision;
  /** Required research failed and this is what was filed instead (`research-fallback.ts`). */
  researchFallback?: import("./research-fallback").ResearchFallbackRecord;
  /** `none`: the round had no published history, so no baseline was used (no-anchor mode). */
  anchor?: "none";
}

export interface ForecastOrigin {
  selected: "daily" | "weekly";
  reading: { date: string; value: number };
  targetDate: string;
  horizonDays: number;
  source?: string;
  fetchedAt?: string;
  /** An unavailable live source is recorded even when a usable archive exists. */
  liveError?: string;
  weekly?: { date: string; value: number };
  daily?: Array<{ date: string; value: number }>;
  mode: "off" | "drift" | "sd" | "both";
  reason: string;
  projection?: Record<string, unknown>;
  start: Distribution;
  /**
   * The daily nowcast's measured miss on recent Fridays (civiqs-nowcast.ts
   * `nowcastErrorFloor`): the filed sd is never narrower (submit.ts).
   */
  errorFloor?: {
    sd: number;
    n: number;
    rms: number;
    errors: Array<{ date: string; error: number }>;
  };
}

export function forecastRound(
  round: ArenaRound,
  lock: ArenaLock,
  /** Defaults to `MARINA_ARENA_POLL_LEVEL` (on). */
  opts: { pollLevel?: PollLevelMode } = {},
): RoundForecast {
  if (round.target_type === "continuous_normal") {
    const history = lock.answer_history ?? lock.history ?? [];
    const pollLevel =
      POLL_LEVEL_TRACKERS.has(round.tracker) &&
      (opts.pollLevel ?? pollLevelModeFromEnv()) === "on" &&
      history.length > 0
        ? pollLevelForecast(
            history.map((p) => p.value),
            horizonSteps(history, round.release_at),
          )
        : undefined;
    if (pollLevel) {
      const { forecast, evidence } = pollLevel;
      return {
        topline: { mean: round3(forecast.mean), sd: round3(forecast.sd) },
        rules: { [round.series ?? round.round_id]: "poll-level" },
        pollLevel: evidence,
        note: `marina-baseline v1 (poll level): mean of persistence ${evidence.persistence} and the arena EWMA ${evidence.ewma} (alpha ${evidence.alpha}); sd ${evidence.sd.scale} x its own ${evidence.steps}-step RMS error ${evidence.sd.rms} over ${evidence.sd.errors} releases, floor ${evidence.sd.floor}`,
      };
    }
    const f = forecastScalar(history, round.release_at);
    return {
      topline: { mean: f.mean, sd: f.sd },
      rules: { [round.series ?? round.round_id]: f.rule },
      note: noteFor([f.rule]),
    };
  }
  if (round.target_type === "profile_energy") {
    const cells = round.cells ?? [];
    if (cells.length < 2) throw new Error(`${round.round_id}: profile round lists no cells`);
    const profile: Record<string, Distribution> = {};
    const rules: Record<string, SpreadRule> = {};
    const hists = cells.map((cell) => {
      const hist = lock.answer_history_by_cell?.[cell];
      if (!hist?.length) throw new Error(`${round.round_id}: no history for cell ${cell}`);
      return hist;
    });
    const level = SAMPLING_NOISE_TRACKERS.has(round.tracker)
      ? chooseLevelWindow(
          hists,
          horizonSteps(hists[0]!, round.release_at),
          (prefix) => forecastScalar(prefix, round.release_at),
          PERSISTENCE_SD,
          CALIBRATION_MARGIN,
        )
      : undefined;
    cells.forEach((cell, i) => {
      const hist = hists[i]!;
      const steps = horizonSteps(hist, round.release_at);
      const values = hist.map((p) => p.value).filter((v) => Number.isFinite(v));
      const l = level ? levelForecast(values, level.k, steps) : undefined;
      if (l) {
        profile[cell] = { mean: round3(l.mean), sd: round3(l.sd) };
        rules[cell] = "level";
        return;
      }
      const f = forecastScalar(hist, round.release_at);
      profile[cell] = { mean: f.mean, sd: f.sd };
      rules[cell] = f.rule;
    });
    if (!level) return { profile, rules, note: noteFor(Object.values(rules)) };
    const used = Object.values(rules).filter((r) => r === "level").length;
    return {
      profile,
      rules,
      level,
      note: `marina-baseline v1 (sampling-noise level): ${level.k === 1 ? "last release" : `mean of the last ${level.k} releases`} per cell, sd from its own recent ${level.steps}-step misses (${used}/${cells.length}; in-sample skill ${round3(level.skill[`k${level.k}`]!)} vs per-cell baseline ${round3(level.skill.baseline!)} over ${level.points})`,
    };
  }
  const length = round.ranking?.length ?? 10;
  return {
    ranking: forecastRanking(lock, length, round.ranking?.items),
    rules: {},
    note: `marina-baseline v2: recency-weighted pageviews (half-life ${RANKING_HALF_LIFE_DAYS} d), ties by title`,
  };
}

function noteFor(rules: SpreadRule[]): string {
  const cal = rules.filter((r) => r === "calibrated").length;
  return `marina-baseline v1: persistence mean; sd calibrated per series where its own history beat sd=1.5 by ${CALIBRATION_MARGIN * 100}% (${cal}/${rules.length})`;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
/** `round`, where a parameter named `round` shadows it. */
const round3 = round;

export interface BacktestResult {
  /** Mean skill vs the arena's persistence (sd 1.5) on the held-out half. */
  skill: number;
  points: number;
  rule: SpreadRule;
}

/**
 * Out-of-sample check of the baseline on one series: the first half of the
 * history chooses the spread rule exactly as a live forecast would, the second
 * half scores it one step at a time against the arena's own persistence.
 */
export function backtestSeries(points: ArenaPoint[], steps = 1): BacktestResult | undefined {
  const values = points.map((p) => p.value).filter((v) => Number.isFinite(v));
  const half = Math.floor(values.length / 2);
  if (values.length < 2 * MIN_HISTORY) return undefined;
  const pick = forecastScalar(
    points.slice(0, half),
    new Date(
      Date.parse(points[half - 1]!.date) + steps * spacingDays(points) * DAY_MS,
    ).toISOString(),
  ).rule;
  let total = 0;
  let n = 0;
  for (let t = half; t < values.length; t++) {
    const origin = values[t - steps]!;
    const sd =
      pick === "persistence"
        ? PERSISTENCE_SD
        : candidateSpreads(values.slice(0, t - steps + 1), steps)[pick];
    if (sd === undefined) continue;
    const pers = crpsNormal(origin, PERSISTENCE_SD, values[t]!);
    if (pers <= 0) continue;
    total += 1 - crpsNormal(origin, sd, values[t]!) / pers;
    n++;
  }
  if (n === 0) return undefined;
  return { skill: total / n, points: n, rule: pick };
}
