// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Leading-indicator forecasts for monthly arena series (the `lead` forecaster
 * spec): the start forecast, with its mean moved by what faster official
 * series did since the target's last release (`src/quant/lead-nowcast.ts`),
 * only where that move has been earned on the series' own walk-forward
 * record. Everything else is the start forecast unchanged.
 *
 * Registered today: NY Fed SCE median inflation expectations. Each case is a
 * past SCE month M; its features are the month-over-month changes, as they
 * could be read by the round's usual cutoff (the 4th of M+1, before the
 * arena's lock and the NY Fed's release), of
 *
 *   MICH      UMich expected inflation, 1 year (final, published late in M)
 *   CPIAUCSL  CPI, all items (change in year-over-year inflation, latest month)
 *
 * US regular gasoline (GASREGW, `logpct`) was tried as a third indicator and
 * dropped: fitted on the 60 months a lock carries, its coefficient tracks the
 * 2022 price spike and over-moves on later swings (a 2015–2026 walk-forward
 * backtest gained nothing with it).
 *
 * Indicators are read from FRED through the shared series-history client as
 * of the round's lock (ALFRED vintages with FRED_API_KEY; keyless only for an
 * open round). A past case only sees observations whose publication lag puts
 * them before its own cutoff, so the features the fit learns from match the
 * features the forecast uses.
 *
 * Not registered: Economist/YouGov approval against Civiqs's daily tracker —
 * week-to-week YouGov changes were uncorrelated with Civiqs's change since
 * the previous poll (r ≈ −0.08 over 63 weeks), so there is nothing to earn.
 */

import { type SeriesHistoryDeps, seriesHistory } from "../forecast/series-history";
import {
  type LeadCase,
  type LeadNowcast,
  type LeadOptions,
  leadNowcast,
} from "../quant/lead-nowcast";
import type { ArenaLock, ArenaPoint, ArenaRound, Distribution } from "./types";

const DAY_MS = 86_400_000;

export type LeadTransform = "diff" | "logpct" | "yoy-diff";

export interface LeadIndicator {
  /** FRED series id. */
  id: string;
  transform: LeadTransform;
  /** Days from an observation's date until it is published (conservative). */
  lagDays: number;
}

export interface LeadSeriesSpec {
  indicators: LeadIndicator[];
  /** A month's features are read by the 1st of the next month + this many days. */
  cutoffDays: number;
}

const SCE_LEADS: LeadSeriesSpec = {
  indicators: [
    { id: "MICH", transform: "diff", lagDays: 30 },
    { id: "CPIAUCSL", transform: "yoy-diff", lagDays: 46 },
  ],
  cutoffDays: 3,
};

/** Arena series with registered leading indicators (by `round.series`). */
export const LEAD_SERIES: Readonly<Record<string, LeadSeriesSpec>> = {
  sce_inflation_1y: SCE_LEADS,
  sce_inflation_3y: SCE_LEADS,
};

const month = (date: string) => date.slice(0, 7);

function addMonths(ym: string, k: number): string {
  const d = new Date(`${ym}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + k);
  return d.toISOString().slice(0, 7);
}

/** The instant a target month's features are read by: the 1st of the next month + `days`. */
export function monthCutoff(ym: string, days: number): number {
  return Date.parse(`${addMonths(ym, 1)}-01T00:00:00Z`) + days * DAY_MS;
}

/**
 * One indicator's change between its two most recent months visible at
 * `cutoffMs` (observation date + lag ≤ cutoff) and no later than `maxMonth`.
 * Weekly or daily observations are averaged per month (a partial latest month
 * averages the weeks published so far). Undefined when the latest visible
 * month is older than the month before `maxMonth`, or a needed month is
 * missing.
 */
export function monthlyChange(
  points: readonly ArenaPoint[],
  ind: LeadIndicator,
  cutoffMs: number,
  maxMonth: string,
): number | undefined {
  const sums = new Map<string, { s: number; n: number }>();
  for (const p of points) {
    const t = Date.parse(p.date);
    if (!Number.isFinite(p.value) || !Number.isFinite(t)) continue;
    if (t + ind.lagDays * DAY_MS > cutoffMs || month(p.date) > maxMonth) continue;
    const m = sums.get(month(p.date)) ?? { s: 0, n: 0 };
    m.s += p.value;
    m.n++;
    sums.set(month(p.date), m);
  }
  const v = (ym: string) => {
    const m = sums.get(ym);
    return m ? m.s / m.n : undefined;
  };
  const latest = [...sums.keys()].sort().at(-1);
  // A reading older than the month before `maxMonth` says nothing about this release.
  if (!latest || latest < addMonths(maxMonth, -1)) return undefined;
  const prev = addMonths(latest, -1);
  const a = v(latest);
  const b = v(prev);
  if (a === undefined || b === undefined) return undefined;
  if (ind.transform === "diff") return a - b;
  if (ind.transform === "logpct") return a > 0 && b > 0 ? 100 * Math.log(a / b) : undefined;
  const a0 = v(addMonths(latest, -12));
  const b0 = v(addMonths(prev, -12));
  if (!a0 || !b0) return undefined;
  return 100 * (a / a0 - 1) - 100 * (b / b0 - 1);
}

function features(
  indicators: readonly ArenaPoint[][],
  spec: LeadSeriesSpec,
  cutoffMs: number,
  maxMonth: string,
): number[] | undefined {
  const x = spec.indicators.map((ind, i) =>
    monthlyChange(indicators[i] ?? [], ind, cutoffMs, maxMonth),
  );
  return x.every((v) => v !== undefined) ? (x as number[]) : undefined;
}

export interface LeadEvidence {
  rule: "lead-nowcast";
  indicators: string[];
  /** Today's indicator changes, in `indicators` order. */
  x: number[];
  nowcast: Omit<LeadNowcast, "mean" | "sd"> & { sd?: number };
  start: number;
  targetMonth: string;
}

/**
 * The lead forecast from frozen inputs: the round's monthly `history`, each
 * indicator's observations as read at `lockAt`, and the start forecast.
 * Pure. The mean moves only when the walk-forward record earned it; the
 * start's sd is kept, so the change is to the centre only.
 */
export function leadForecastFromInputs(
  history: readonly ArenaPoint[],
  indicators: readonly ArenaPoint[][],
  spec: LeadSeriesSpec,
  lockAt: string,
  start: Distribution,
  opts: LeadOptions = {},
): { topline: Distribution; evidence: LeadEvidence } | undefined {
  const last = history.at(-1);
  if (!last) return undefined;
  const target = addMonths(month(last.date), 1);
  const cutoff = Math.min(Date.parse(lockAt), monthCutoff(target, spec.cutoffDays));
  const x = features(indicators, spec, cutoff, target);
  if (!x) return undefined;
  const cases: LeadCase[] = [];
  for (let j = 1; j < history.length; j++) {
    const m = month(history[j]!.date);
    if (addMonths(month(history[j - 1]!.date), 1) !== m) continue;
    const cx = features(indicators, spec, monthCutoff(m, spec.cutoffDays), m);
    if (cx) cases.push({ x: cx, y: history[j]!.value - history[j - 1]!.value });
  }
  const n = leadNowcast(last.value, x, cases, opts);
  const mean = n.applied ? start.mean + n.move : start.mean;
  const { mean: _m, sd: nsd, ...rest } = n;
  return {
    topline: { mean: Math.round(mean * 1000) / 1000, sd: start.sd },
    evidence: {
      rule: "lead-nowcast",
      indicators: spec.indicators.map((i) => i.id),
      x: x.map((v) => Math.round(v * 1000) / 1000),
      nowcast: { ...rest, ...(nsd !== undefined ? { sd: nsd } : {}) },
      start: start.mean,
      targetMonth: target,
    },
  };
}

/** Read each registered indicator as of the round's lock (FRED via series-history). */
export async function leadIndicatorsAt(
  spec: LeadSeriesSpec,
  lockAt: string,
  deps: SeriesHistoryDeps,
): Promise<ArenaPoint[][] | { error: string }> {
  const out: ArenaPoint[][] = [];
  for (const ind of spec.indicators) {
    const h = await seriesHistory({ source: "fred", id: ind.id }, new Date(lockAt), {
      years: 8,
      ...deps,
    });
    if ("error" in h) return { error: `${ind.id}: ${h.error}` };
    out.push(h.points);
  }
  return out;
}

/** The lead forecast for one numeric round, or undefined when its series has no registered leads. */
export async function leadForecast(
  round: ArenaRound,
  lock: ArenaLock,
  start: Distribution,
  deps: SeriesHistoryDeps,
): Promise<{ topline: Distribution; evidence: LeadEvidence } | { error: string } | undefined> {
  const spec = round.series ? LEAD_SERIES[round.series] : undefined;
  if (!spec || round.target_type !== "continuous_normal") return undefined;
  const history = lock.answer_history ?? lock.history ?? [];
  const indicators = await leadIndicatorsAt(spec, round.lock_at, deps);
  if ("error" in indicators) return indicators;
  return (
    leadForecastFromInputs(history, indicators, spec, round.lock_at, start) ?? {
      error: "indicators do not cover the target month",
    }
  );
}
