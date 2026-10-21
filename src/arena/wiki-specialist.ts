// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wikipedia top-10 specialist (`wiki-specialist[:<model>[,…]]`). Pure: daily
 * top lists in, a projected weekly ranking out.
 *
 * The round (`ssa/ranking_round.py`, `ssa/adapters/wikipedia.py`): the target
 * week runs Monday to Sunday; its answer is the seven daily top-1000 lists
 * (`top/en.wikipedia/all-access`, all agents) summed per article, Main_Page
 * and non-article namespaces excluded, top 10 by weekly total, ties by title.
 * Loss is 1 − rank-biased overlap (p = 0.9, depth 10); skill is
 * 1 − loss ÷ loss of persistence, the last completed week before the lock.
 * The lock is the Friday 14:00 UTC before the target week, so the week has not
 * started at lock time (no partial-week hours to observe) and the last daily
 * list published in time is the lock day − `WIKITOP_PUBLICATION_LAG_DAYS`
 * (a Wednesday): the forecast reaches 5 to 11 days ahead.
 *
 * The recency-weighted nowcast (`rankingScores`) ranks what was read recently;
 * this ranks what will be read in the target week. For each candidate (every
 * title in the top `candidateDepth` of a recent daily list) it splits the
 * page's views into a base level (a low quantile of its own history, which a
 * perennial page such as Deaths_in_2026 sits on) and an excess over it (an
 * event spike), lets the excess decay exponentially with a half-life measured
 * from the page's own decline since its peak (shrunk toward a prior chosen by
 * backtest), and sums the projected days of the target week. The order is by
 * that projected weekly sum, discounted by the share of it that is transient:
 * under RBO the top slots weigh most, and a stable page is a safer bet for
 * them than a fading spike of the same projected mass.
 *
 * Defaults were chosen by walk-forward backtest on mean per-round skill
 * (`scripts/arena-wiki-backtest.ts`).
 */

import { isExcludedTitle } from "./forecast";
import { rboLoss } from "./score-shapes";

const DAY_MS = 86_400_000;

/** One day's top list: `{article: views}`, as archived under `wikitop/` and served by Wikimedia. */
export interface DailyTop {
  date: string;
  articles: Record<string, number>;
}

export interface SpecialistParams {
  /** Prior half-life (days) of a page's excess views over its base level. */
  halfLifeDays: number;
  /** Geometric weight of the page's own measured half-life against the prior (0 = prior only). */
  pageWeight: number;
  /** Most recent days averaged for the current level. */
  levelDays: number;
  /** Quantile of the page's own history taken as its base (perennial) level. */
  baseQuantile: number;
  /** Days of daily history read per page. */
  historyDays: number;
  /** Order by weekly × (1 − risk × transient share): a fading spike yields top slots to a steady page. */
  risk: number;
  /** Candidates: titles within the top `candidateDepth` of any of the last `candidateDays` lists. */
  candidateDepth: number;
  candidateDays: number;
  /** Correct the current level for the weekday mix of the days it averages (global factors). */
  dayOfWeek: boolean;
}

/**
 * Chosen by walk-forward backtest (`scripts/arena-wiki-backtest.ts`) over 67
 * reconstructed weeks ending 2025-07-13 … 2026-10-18: the setting the weekly
 * re-selection picked most often (half-life 8 d, half the page's own decay,
 * the newest day as level, the median as base, a 15 % discount on the
 * transient share, weekday-corrected level).
 */
export const DEFAULT_SPECIALIST_PARAMS: SpecialistParams = {
  halfLifeDays: 8,
  pageWeight: 0.5,
  levelDays: 1,
  baseQuantile: 0.5,
  historyDays: 28,
  risk: 0.15,
  candidateDepth: 100,
  candidateDays: 14,
  dayOfWeek: true,
};

/** Half-life bounds (days): a page cannot decay faster than half a day or slower than a season. */
const MIN_HALF_LIFE = 0.5;
const MAX_HALF_LIFE = 90;

export const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (day: string, n: number) => iso(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);

/** The seven days (Monday → Sunday) of the week ending `weekEnd`. */
export function weekDays(weekEnd: string): string[] {
  const d = new Date(`${weekEnd}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.getUTCDay() !== 0) {
    throw new Error(`${weekEnd} is not a Sunday; a Wikipedia ranking week runs Monday to Sunday`);
  }
  return Array.from({ length: 7 }, (_, i) => addDays(weekEnd, i - 6));
}

/**
 * The arena's resolution for the week ending `weekEnd` (`weekly_top`): the
 * seven daily lists summed per article, exclusions applied, ties by title.
 * Throws unless all seven days are present.
 */
export function weeklyTop(days: DailyTop[], weekEnd: string, length = 10): string[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const totals = new Map<string, number>();
  for (const day of weekDays(weekEnd)) {
    const got = byDate.get(day);
    if (!got) throw new Error(`week ending ${weekEnd} is missing ${day}`);
    for (const [t, v] of Object.entries(got.articles)) totals.set(t, (totals.get(t) ?? 0) + v);
  }
  return [...totals.entries()]
    .filter(([t]) => !isExcludedTitle(t))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, length)
    .map(([t]) => t);
}

/** The persistence null's week: the last Sunday strictly before the lock date (`frozen_history`). */
export function persistenceWeekEnd(lockAt: string): string {
  const lockDay = lockAt.slice(0, 10);
  let d = addDays(lockDay, -1);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 0) d = addDays(d, -1);
  return d;
}

/** The leaderboard's per-round skill: 1 − loss ÷ persistence loss (0 when persistence is perfect). */
export function rankingSkill(
  predicted: string[],
  truth: string[],
  persistence: string[],
  p = 0.9,
): number {
  const depth = truth.length;
  const pers = rboLoss(persistence, truth, p, depth);
  if (pers === 0) return 0;
  return 1 - rboLoss(predicted, truth, p, depth) / pers;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.max(0, q * (sorted.length - 1)));
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

export interface Projection {
  /** Projected sum of the target week's seven days. */
  weekly: number;
  /** Mean of the last `levelDays` days (weekday-corrected when enabled). */
  level: number;
  base: number;
  halfLife: number;
  /** Half-life measured from the page's own decline since its peak, when there was one. */
  pageHalfLife?: number;
  /** Share of `weekly` that is decaying excess over the base, in [0, 1]. */
  transient: number;
}

/**
 * Project one page's target-week sum from its daily series (oldest first, the
 * last entry the newest published day; a day the page was outside the top
 * list is 0). `horizons` are the target days' distances, in days, from that
 * newest day (1 = the next day).
 */
export function projectSeries(
  series: number[],
  horizons: number[],
  params: SpecialistParams = DEFAULT_SPECIALIST_PARAMS,
  levelFactor = 1,
): Projection {
  const n = series.length;
  if (n === 0) return { weekly: 0, level: 0, base: 0, halfLife: params.halfLifeDays, transient: 0 };
  const m = Math.max(1, Math.min(params.levelDays, n));
  const recent = series.slice(n - m);
  const level = (recent.reduce((s, v) => s + v, 0) / m) * levelFactor;
  const base = Math.min(
    level,
    quantile(
      [...series].sort((a, b) => a - b),
      params.baseQuantile,
    ),
  );
  // The level is centred (m − 1) / 2 days before the newest day.
  const centre = n - 1 - (m - 1) / 2;
  let pageHalfLife: number | undefined;
  const look = Math.max(0, n - 14);
  let peakAt = look;
  for (let i = look; i < n; i++) if (series[i]! >= series[peakAt]!) peakAt = i;
  const peak = series[peakAt]!;
  const elapsed = centre - peakAt;
  if (elapsed >= 1 && peak > level && level > base && peak > base) {
    const ratio = Math.log((peak - base) / (level - base));
    if (ratio > 0) pageHalfLife = (elapsed * Math.LN2) / ratio;
  }
  const raw =
    pageHalfLife === undefined
      ? params.halfLifeDays
      : Math.exp(
          (1 - params.pageWeight) * Math.log(params.halfLifeDays) +
            params.pageWeight * Math.log(pageHalfLife),
        );
  const halfLife = Math.min(MAX_HALF_LIFE, Math.max(MIN_HALF_LIFE, raw));
  const excess = level - base;
  let transientSum = 0;
  for (const h of horizons) transientSum += excess * 0.5 ** ((h + (m - 1) / 2) / halfLife);
  const weekly = base * horizons.length + transientSum;
  return {
    weekly,
    level,
    base,
    halfLife,
    ...(pageHalfLife !== undefined ? { pageHalfLife } : {}),
    transient: weekly > 0 ? transientSum / weekly : 0,
  };
}

/**
 * Global weekday factors from the lists themselves: each weekday's mean of the
 * day's total views over its 7-day centred mean (1 = an average day).
 */
export function dayOfWeekFactors(days: DailyTop[]): number[] {
  const totals = new Map<string, number>();
  for (const d of days) {
    let s = 0;
    for (const [t, v] of Object.entries(d.articles)) if (!isExcludedTitle(t)) s += v;
    totals.set(d.date, s);
  }
  const sums = Array(7).fill(0) as number[];
  const counts = Array(7).fill(0) as number[];
  for (const [date, total] of totals) {
    const around = Array.from({ length: 7 }, (_, i) => totals.get(addDays(date, i - 3)));
    if (around.some((v) => v === undefined)) continue;
    const mean = (around as number[]).reduce((s, v) => s + v, 0) / 7;
    if (mean <= 0) continue;
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    sums[dow]! += total / mean;
    counts[dow]!++;
  }
  return sums.map((s, i) => (counts[i]! >= 2 ? s / counts[i]! : 1));
}

export interface SpecialistOptions {
  /** The target week's Sunday (the week runs Monday to Sunday). */
  weekEnd: string;
  /** The newest day the forecast may read (the last list published before the lock). */
  lastDay: string;
  length?: number;
  params?: Partial<SpecialistParams>;
}

export interface SpecialistResult {
  ranking: string[];
  /** Every candidate, best first: projected weekly sum and the ordering score. */
  scored: Array<{ title: string; score: number } & Projection>;
  /** The newest and oldest day read, and how many lists. */
  read: { from: string; to: string; days: number };
}

/**
 * Project every candidate's target-week sum and rank. Lists dated after
 * `lastDay` are ignored, never read: the cutoff is enforced here as well as
 * by the caller.
 */
export function specialistRanking(days: DailyTop[], opts: SpecialistOptions): SpecialistResult {
  const params = { ...DEFAULT_SPECIALIST_PARAMS, ...opts.params };
  const length = opts.length ?? 10;
  const from = addDays(opts.lastDay, 1 - params.historyDays);
  const usable = days
    .filter((d) => d.date <= opts.lastDay && d.date >= from)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (usable.length === 0) throw new Error(`no daily top list on or before ${opts.lastDay}`);
  const newest = usable.at(-1)!.date;
  const window = Array.from({ length: params.historyDays }, (_, i) =>
    addDays(newest, i + 1 - params.historyDays),
  );
  const byDate = new Map(usable.map((d) => [d.date, d.articles]));
  const candidates = new Set<string>();
  for (const d of usable.slice(-params.candidateDays)) {
    Object.entries(d.articles)
      .filter(([t]) => !isExcludedTitle(t))
      .sort((a, b) => b[1] - a[1])
      .slice(0, params.candidateDepth)
      .forEach(([t]) => {
        candidates.add(t);
      });
  }
  const newestMs = Date.parse(`${newest}T00:00:00Z`);
  const horizons = weekDays(opts.weekEnd).map(
    (d) => (Date.parse(`${d}T00:00:00Z`) - newestMs) / DAY_MS,
  );
  let levelFactor = 1;
  if (params.dayOfWeek) {
    const f = dayOfWeekFactors(usable);
    const levelDays = window.slice(-Math.max(1, params.levelDays));
    const mean =
      levelDays.reduce((s, d) => s + f[new Date(`${d}T00:00:00Z`).getUTCDay()]!, 0) /
      levelDays.length;
    if (mean > 0) levelFactor = 1 / mean;
  }
  const scored = [...candidates].map((title) => {
    const series = window.map((d) => byDate.get(d)?.[title] ?? 0);
    const p = projectSeries(series, horizons, params, levelFactor);
    const score = p.weekly * Math.max(0, 1 - params.risk * p.transient);
    return { title, score, ...p };
  });
  scored.sort((a, b) => b.score - a.score || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  if (scored.length < length) {
    throw new Error(`only ${scored.length} candidates for a top-${length}`);
  }
  return {
    ranking: scored.slice(0, length).map((s) => s.title),
    scored,
    read: { from: usable[0]!.date, to: newest, days: usable.length },
  };
}
