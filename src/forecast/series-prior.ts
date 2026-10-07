// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A statistical prior for "will the series be higher on date d than on the
 * baseline date?" — from the series' own history before the cutoff, with no
 * model call. Pure functions.
 *
 * Methods, each the smoothed frequency of a rise over the same horizon:
 *
 *   half       0.5 (a coin flip: what an efficient price series earns)
 *   drift      every h-day window of the last five years
 *   momentum   the windows whose previous h-day move had the same sign as the latest one
 *   seasonal   the same calendar window in each of the last twelve years (± a week)
 *
 * plus each one shrunk halfway toward 0.5. The series chooses its own method:
 * every method is replayed at earlier pseudo-cutoffs inside the series' own
 * past (only data before each pseudo-cutoff, only outcomes before the real
 * cutoff) and the lowest Brier wins, but only when it beats `half` by
 * `SELECT_MARGIN` — otherwise the prior is 0.5. Nothing here can see past the
 * cutoff: the history it is given already ends before it.
 */

import type { SeriesPoint } from "./series-history";

export type SeriesMethod =
  | "half"
  | "drift"
  | "drift/2"
  | "momentum"
  | "momentum/2"
  | "seasonal"
  | "seasonal/2";

export const SERIES_METHODS: readonly SeriesMethod[] = [
  "half",
  "drift",
  "drift/2",
  "momentum",
  "momentum/2",
  "seasonal",
  "seasonal/2",
];

export interface ComparisonQuestion {
  /** The date the targets are compared with (YYYY-MM-DD). */
  baseline: string;
  /** The dates whose value is compared with the baseline's (YYYY-MM-DD). */
  targets: string[];
  /** `>` (default) or `>=`. */
  strict?: boolean;
}

export interface MethodScore {
  method: SeriesMethod;
  brier: number;
  n: number;
}

export interface ComparisonPrior {
  /** Per target date, the probability the comparison holds. */
  probabilities: Record<string, number>;
  method: SeriesMethod;
  /** The in-series replay every method was judged on (best first). */
  replay: MethodScore[];
  /** The latest value and its date. */
  last: SeriesPoint;
  detail: string;
}

/** Relative Brier improvement over `half` a method needs to be chosen. */
export const SELECT_MARGIN = 0.05;
/** Fewest replayed outcomes before anything but `half` can be chosen. */
export const MIN_REPLAY = 30;
const MIN_WINDOWS = 10;
const DRIFT_YEARS = 5;
const SEASONAL_YEARS = 12;
const SEASONAL_DAYS = 7;
const MAX_WINDOWS = 400;
const REPLAY_EVERY_DAYS = 14;
const REPLAY_SPAN_DAYS = 5 * 365;
/** Horizons longer than this are not replayed (too few outcomes); they use the chosen method. */
const MAX_REPLAY_HORIZON = 180;
const DAY_MS = 86_400_000;

const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => toDay(toMs(d) + n * DAY_MS);
const daysBetween = (a: string, b: string) => Math.round((toMs(b) - toMs(a)) / DAY_MS);

/** A sorted series with day-indexed lookups. */
class Series {
  readonly days: number[];
  readonly values: number[];
  constructor(points: SeriesPoint[]) {
    this.days = points.map((p) => toMs(p.date) / DAY_MS);
    this.values = points.map((p) => p.value);
  }
  /** Index of the last point on or before `day` (-1 if none). */
  indexAt(day: number): number {
    let lo = 0;
    let hi = this.days.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.days[mid]! <= day) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }
  at(day: number): number | undefined {
    const i = this.indexAt(day);
    return i >= 0 ? this.values[i] : undefined;
  }
}

const rose = (a: number, b: number, strict: boolean) => (strict ? b > a : b >= a);
const smooth = (up: number, n: number) => (up + 1) / (n + 2);
const halve = (p: number | undefined) => (p === undefined ? undefined : 0.5 + (p - 0.5) / 2);

/** The probability of a rise over `h` days, by `method`, seen from `cut` (a day number). */
function methodP(
  s: Series,
  method: SeriesMethod,
  cut: number,
  h: number,
  strict: boolean,
): number | undefined {
  const base = method.replace("/2", "") as "half" | "drift" | "momentum" | "seasonal";
  const p =
    base === "half"
      ? 0.5
      : base === "drift"
        ? drift(s, cut, h, strict)
        : base === "momentum"
          ? momentum(s, cut, h, strict)
          : seasonal(s, cut, h, strict);
  return method.endsWith("/2") ? halve(p) : p;
}

function windows(s: Series, cut: number, h: number, years: number): number[] {
  const i0 = s.indexAt(cut - years * 365 - 1) + 1;
  const i1 = s.indexAt(cut - h);
  if (i1 < i0) return [];
  const step = Math.max(1, Math.floor((i1 - i0 + 1) / MAX_WINDOWS));
  const out: number[] = [];
  for (let i = i0; i <= i1; i += step) out.push(i);
  return out;
}

function drift(s: Series, cut: number, h: number, strict: boolean): number | undefined {
  let up = 0;
  let n = 0;
  for (const i of windows(s, cut, h, DRIFT_YEARS)) {
    const b = s.at(s.days[i]! + h);
    if (b === undefined) continue;
    n++;
    if (rose(s.values[i]!, b, strict)) up++;
  }
  return n >= MIN_WINDOWS ? smooth(up, n) : undefined;
}

function momentum(s: Series, cut: number, h: number, strict: boolean): number | undefined {
  const look = Math.min(h, 365);
  const last = s.at(cut);
  const prev = s.at(cut - look);
  if (last === undefined || prev === undefined) return undefined;
  const sign = Math.sign(last - prev);
  let up = 0;
  let n = 0;
  for (const i of windows(s, cut, h, DRIFT_YEARS)) {
    const a = s.values[i]!;
    const p = s.at(s.days[i]! - look);
    const b = s.at(s.days[i]! + h);
    if (p === undefined || b === undefined || Math.sign(a - p) !== sign) continue;
    n++;
    if (rose(a, b, strict)) up++;
  }
  return n >= MIN_WINDOWS ? smooth(up, n) : undefined;
}

function seasonal(s: Series, cut: number, h: number, strict: boolean): number | undefined {
  let up = 0;
  let n = 0;
  const cutDay = toDay(cut * DAY_MS);
  for (let k = 1; k <= SEASONAL_YEARS; k++) {
    const sameDay = toMs(`${Number(cutDay.slice(0, 4)) - k}${cutDay.slice(4)}`) / DAY_MS;
    if (!Number.isFinite(sameDay)) continue;
    for (let off = -SEASONAL_DAYS; off <= SEASONAL_DAYS; off += 2) {
      const t = sameDay + off;
      if (t + h > cut) continue;
      const a = s.at(t);
      const b = s.at(t + h);
      if (a === undefined || b === undefined) continue;
      n++;
      if (rose(a, b, strict)) up++;
    }
  }
  return n >= MIN_WINDOWS ? smooth(up, n) : undefined;
}

/** Every method replayed at earlier pseudo-cutoffs inside the history (best first). */
export function replayMethods(
  points: SeriesPoint[],
  horizons: number[],
  strict = true,
): MethodScore[] {
  const s = new Series(points);
  if (s.days.length === 0) return [];
  const end = s.days[s.days.length - 1]!;
  const hs = [...new Set(horizons.filter((h) => h > 0 && h <= MAX_REPLAY_HORIZON))];
  const scores = SERIES_METHODS.map((method) => ({ method, loss: 0, n: 0 }));
  for (const h of hs) {
    for (let c = end - h; c >= end - REPLAY_SPAN_DAYS; c -= REPLAY_EVERY_DAYS) {
      const a = s.at(c + 1);
      const b = s.at(c + 1 + h);
      if (a === undefined || b === undefined || c + 1 + h > end) continue;
      const y = rose(a, b, strict) ? 1 : 0;
      for (const sc of scores) {
        const p = methodP(s, sc.method, c, h, strict) ?? 0.5;
        sc.loss += (p - y) ** 2;
        sc.n++;
      }
    }
  }
  return scores
    .filter((sc) => sc.n > 0)
    .map((sc) => ({ method: sc.method, brier: sc.loss / sc.n, n: sc.n }))
    .sort((x, y) => x.brier - y.brier);
}

/** The method the replay supports: the best one when it beats `half` by the margin, else `half`. */
export function chooseMethod(replay: MethodScore[], margin = SELECT_MARGIN): SeriesMethod {
  const half = replay.find((r) => r.method === "half");
  const best = replay[0];
  if (!half || !best || best.n < MIN_REPLAY) return "half";
  return best.brier <= half.brier * (1 - margin) ? best.method : "half";
}

/**
 * The prior for a comparison question from the history before the cutoff
 * (`points`, which must already end before it). Undefined with no history.
 */
export function comparisonPrior(
  points: SeriesPoint[],
  q: ComparisonQuestion,
  opts: { margin?: number } = {},
): ComparisonPrior | undefined {
  const last = points.at(-1);
  if (!last) return undefined;
  const strict = q.strict !== false;
  const horizons = q.targets.map((t) => daysBetween(q.baseline, t));
  const replay = replayMethods(points, horizons, strict);
  const method = chooseMethod(replay, opts.margin);
  const s = new Series(points);
  const cut = toMs(last.date) / DAY_MS;
  const probabilities: Record<string, number> = {};
  q.targets.forEach((t, i) => {
    const p = methodP(s, method, cut, horizons[i]!, strict) ?? 0.5;
    probabilities[t] = Math.round(Math.min(0.99, Math.max(0.01, p)) * 1e4) / 1e4;
  });
  const top = replay.slice(0, 3).map((r) => `${r.method} ${r.brier.toFixed(3)}`);
  return {
    probabilities,
    method,
    replay,
    last,
    detail: `${method} (replay on ${replay[0]?.n ?? 0} past windows: ${top.join(", ") || "none"}); latest ${last.value} on ${last.date}`,
  };
}

/** For tests and callers that phrase a horizon as days after the baseline. */
export const targetAfter = (baseline: string, days: number) => addDays(baseline, days);
