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

export type SpreadRule = "persistence" | "calibrated" | "robust";

export interface ScalarForecast extends Distribution {
  rule: SpreadRule;
  /** Mean in-sample per-round skill of each candidate spread — the evidence behind `rule`. */
  evidence?: { skill: Record<string, number>; points: number };
  steps: number;
}

/** Release cadence of a series in days (median spacing of its points). */
function spacingDays(points: ArenaPoint[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const d = (Date.parse(points[i]!.date) - Date.parse(points[i - 1]!.date)) / DAY_MS;
    if (d > 0) gaps.push(d);
  }
  if (gaps.length === 0) return 7;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}

/** How many releases ahead the round's answer is from the last known point. */
export function horizonSteps(points: ArenaPoint[], releaseAt: string): number {
  const last = points.at(-1);
  if (!last) return 1;
  const days = (Date.parse(releaseAt) - Date.parse(last.date)) / DAY_MS;
  return Math.max(1, Math.round(days / spacingDays(points)));
}

function recentChanges(values: number[], steps: number): number[] | undefined {
  const diffs: number[] = [];
  for (let i = Math.max(steps, values.length - SD_WINDOW); i < values.length; i++) {
    diffs.push(values[i]! - values[i - steps]!);
  }
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
  const rms = Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / diffs.length);
  const abs = diffs.map(Math.abs).sort((a, b) => a - b);
  const median = abs[Math.floor(abs.length / 2)]!;
  return { calibrated: Math.max(rms, MIN_SD), robust: Math.max(1.4826 * median, MIN_SD) };
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

const NON_ARTICLE =
  /^(Special|Wikipedia|Portal|Help|File|Template|Category|Draft|User|Talk|[A-Za-z]+_talk):/;

/** Wikipedia top-N from the recent daily lists: views summed, ties by title. */
export function forecastRanking(lock: ArenaLock, length: number, allowed?: string[]): string[] {
  const obs = [...(lock.answer_obs ?? [])].sort((a, b) => a.date.localeCompare(b.date)).slice(-7);
  if (obs.length === 0) throw new Error("no ranking observations to forecast from");
  const totals = new Map<string, number>();
  for (const day of obs) {
    day.items.forEach((item, i) => {
      const views = day.views?.[item] ?? day.items.length - i;
      totals.set(item, (totals.get(item) ?? 0) + views);
    });
  }
  const allow = allowed ? new Set(allowed) : undefined;
  const ranked = [...totals.entries()]
    .filter(([t]) => t !== "Main_Page" && !NON_ARTICLE.test(t) && (!allow || allow.has(t)))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
  if (ranked.length < length)
    throw new Error(`only ${ranked.length} candidates for a top-${length}`);
  return ranked.slice(0, length);
}

export interface RoundForecast {
  topline?: Distribution;
  profile?: Record<string, Distribution>;
  ranking?: string[];
  /** Per series (or cell): which spread rule was used. */
  rules: Record<string, SpreadRule>;
  note: string;
}

export function forecastRound(round: ArenaRound, lock: ArenaLock): RoundForecast {
  if (round.target_type === "continuous_normal") {
    const f = forecastScalar(lock.answer_history ?? lock.history ?? [], round.release_at);
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
    for (const cell of cells) {
      const hist = lock.answer_history_by_cell?.[cell];
      if (!hist?.length) throw new Error(`${round.round_id}: no history for cell ${cell}`);
      const f = forecastScalar(hist, round.release_at);
      profile[cell] = { mean: f.mean, sd: f.sd };
      rules[cell] = f.rule;
    }
    return { profile, rules, note: noteFor(Object.values(rules)) };
  }
  const length = round.ranking?.length ?? 10;
  return {
    ranking: forecastRanking(lock, length, round.ranking?.items),
    rules: {},
    note: "marina-baseline v1: last-7-day pageview totals, ties by title",
  };
}

function noteFor(rules: SpreadRule[]): string {
  const cal = rules.filter((r) => r === "calibrated").length;
  return `marina-baseline v1: persistence mean; sd calibrated per series where its own history beat sd=1.5 by ${CALIBRATION_MARGIN * 100}% (${cal}/${rules.length})`;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

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
