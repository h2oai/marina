// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Series fit: a dated (or plain) numeric series and a horizon in, a point
 * estimate with a spread and quantiles out. Pure, dependency-free, no model
 * call. Promoted from the arena's baselines (`src/arena/forecast.ts`,
 * `src/arena/poll-level.ts`), which now call these primitives; the arena
 * regression tests (`test/quant-arena-equivalence.test.ts`) pin that their
 * numbers did not move.
 *
 * Methods, each an `steps`-ahead mean from the values so far:
 *
 *   persistence  the last value
 *   ewma         exponentially weighted level, seeded at the first value (α 0.4)
 *   blend        the average of persistence and the EWMA (a light shrink toward the recent level)
 *   trend        least-squares line through the last `trendWindow` values, projected `steps` ahead
 *   damped       the same line with its slope damped by φ per step (φ 0.9)
 *   combo        the average of persistence, EWMA and damped trend
 *   auto         the method with the lowest rolling-origin error, but only when it
 *                beats persistence by `autoMargin`; otherwise persistence
 *
 * Spread: the RMS of the method's OWN `steps`-ahead errors at earlier origins
 * (each prediction made only from the values before its origin), over the last
 * `window` origins. With too few origins it falls back to √steps × the RMS of
 * one-step changes, and a single value has no spread (sd = `minSd`, default 0).
 * Quantiles assume a normal around the mean. Steps count releases, not days:
 * a `target` date is converted with the series' median spacing.
 */

import { normalQuantile } from "./normal";

const DAY_MS = 86_400_000;

/** One observation; `date` is any `Date.parse`-able string. */
export interface DatedValue {
  date?: string;
  value: number;
}

export type SeriesInput = readonly number[] | readonly DatedValue[];

export type FitMethod = "persistence" | "ewma" | "blend" | "trend" | "damped" | "combo";

export const FIT_METHODS: readonly FitMethod[] = [
  "persistence",
  "ewma",
  "blend",
  "trend",
  "damped",
  "combo",
];

export const DEFAULT_EWMA_ALPHA = 0.4;
export const DEFAULT_DAMPING = 0.9;
export const DEFAULT_TREND_WINDOW = 12;
export const DEFAULT_ERROR_WINDOW = 26;
export const DEFAULT_WARM_UP = 4;
export const DEFAULT_MIN_ERRORS = 6;
export const DEFAULT_AUTO_MARGIN = 0.05;
export const DEFAULT_LEVELS: readonly number[] = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95];

// ─── Primitives (the arena calls these directly) ────────────────────────────

/** Release cadence in days: the median positive gap between consecutive dates; 7 with none. */
export function medianSpacingDays(points: readonly { date: string }[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const d = (Date.parse(points[i]!.date) - Date.parse(points[i - 1]!.date)) / DAY_MS;
    if (d > 0) gaps.push(d);
  }
  if (gaps.length === 0) return 7;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}

/**
 * Releases between the last point and `target` (at least 1), at the median
 * spacing (or `spacingDays` when given). An unparseable date yields NaN.
 */
export function stepsAhead(
  points: readonly { date: string }[],
  target: string,
  spacingDays?: number,
): number {
  const last = points.at(-1);
  if (!last) return 1;
  const days = (Date.parse(target) - Date.parse(last.date)) / DAY_MS;
  return Math.max(1, Math.round(days / (spacingDays ?? medianSpacingDays(points))));
}

/** Exponentially weighted level, seeded at the first value. Throws on an empty series. */
export function ewma(values: readonly number[], alpha = DEFAULT_EWMA_ALPHA): number {
  if (values.length === 0) throw new Error("empty history");
  let m = values[0]!;
  for (let i = 1; i < values.length; i++) m = alpha * values[i]! + (1 - alpha) * m;
  return m;
}

export interface RollingOriginOptions {
  /** Only the last `window` origins are scored. */
  window?: number;
  /** Values every prediction sees at least (the first origin is `warmUp + steps − 1`). */
  warmUp?: number;
}

/**
 * `predict`'s own `steps`-ahead errors (actual − predicted) over the last
 * `window` origins of `values`, each prediction made from the values before
 * its origin only. Oldest first.
 */
export function rollingOriginErrors(
  values: readonly number[],
  predict: (prefix: readonly number[]) => number,
  steps: number,
  { window = DEFAULT_ERROR_WINDOW, warmUp = 1 }: RollingOriginOptions = {},
): number[] {
  const errors: number[] = [];
  for (let t = Math.max(warmUp + steps - 1, values.length - window); t < values.length; t++) {
    errors.push(values[t]! - predict(values.slice(0, t - steps + 1)));
  }
  return errors;
}

/** `rollingOriginErrors` of persistence (the `steps`-ahead changes), without copying prefixes. */
export function stepChanges(
  values: readonly number[],
  steps: number,
  { window = DEFAULT_ERROR_WINDOW, warmUp = 1 }: RollingOriginOptions = {},
): number[] {
  const diffs: number[] = [];
  for (let i = Math.max(warmUp + steps - 1, values.length - window); i < values.length; i++) {
    diffs.push(values[i]! - values[i - steps]!);
  }
  return diffs;
}

/** Root mean square; NaN for an empty list. */
export function rms(xs: readonly number[]): number {
  return Math.sqrt(xs.reduce((s, d) => s + d * d, 0) / xs.length);
}

/** Spike-resistant spread: 1.4826 × the (upper) median absolute value — the normal-consistent MAD about 0. */
export function robustSpread(xs: readonly number[]): number {
  const abs = xs.map(Math.abs).sort((a, b) => a - b);
  return 1.4826 * abs[Math.floor(abs.length / 2)]!;
}

/** Least-squares line through `ys` at x = 0..n−1: the fitted value at the last x and the slope. */
export function linearFit(ys: readonly number[]): { last: number; slope: number } {
  const n = ys.length;
  if (n === 0) throw new Error("empty history");
  if (n === 1) return { last: ys[0]!, slope: 0 };
  const mx = (n - 1) / 2;
  let my = 0;
  for (const y of ys) my += y;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - mx) * (ys[i]! - my);
    sxx += (i - mx) * (i - mx);
  }
  const slope = sxy / sxx;
  return { last: my + slope * (n - 1 - mx), slope };
}

export interface MethodParams {
  alpha?: number;
  damping?: number;
  trendWindow?: number;
}

/** The `steps`-ahead mean of `method` from `values` (non-empty, finite). */
export function predictWith(
  method: FitMethod,
  values: readonly number[],
  steps: number,
  {
    alpha = DEFAULT_EWMA_ALPHA,
    damping = DEFAULT_DAMPING,
    trendWindow = DEFAULT_TREND_WINDOW,
  } = {},
): number {
  switch (method) {
    case "persistence":
      return values.at(-1)!;
    case "ewma":
      return ewma(values, alpha);
    case "blend":
      return (values.at(-1)! + ewma(values, alpha)) / 2;
    case "trend": {
      const { last, slope } = linearFit(values.slice(-trendWindow));
      return last + slope * steps;
    }
    case "damped":
      return dampedTrend(values, steps, damping, trendWindow);
    case "combo":
      return (
        (values.at(-1)! + ewma(values, alpha) + dampedTrend(values, steps, damping, trendWindow)) /
        3
      );
  }
}

function dampedTrend(
  values: readonly number[],
  steps: number,
  damping: number,
  trendWindow: number,
): number {
  const { last, slope } = linearFit(values.slice(-trendWindow));
  // φ + φ² + … + φ^steps
  const reach = damping === 1 ? steps : (damping * (1 - damping ** steps)) / (1 - damping);
  return last + slope * reach;
}

// ─── The fit ────────────────────────────────────────────────────────────────

export interface SeriesFitOptions extends MethodParams, RollingOriginOptions {
  /** Releases ahead (a positive whole number). Default 1, or derived from `target`. */
  steps?: number;
  /** Target date; converted to `steps` at the series' median spacing (needs dated points). */
  target?: string;
  /** Overrides the median spacing used with `target`. */
  spacingDays?: number;
  method?: FitMethod | "auto";
  /** Fewest rolling-origin errors that size the spread; fewer ⇒ the step-change fallback. */
  minErrors?: number;
  /** sd = max(sdScale × error RMS, minSd). */
  sdScale?: number;
  minSd?: number;
  /** `auto` takes a method over persistence only when its RMS is at least this share lower. */
  autoMargin?: number;
  /** Quantile levels reported, each in (0, 1). */
  levels?: readonly number[];
}

export type SdBasis = "rolling-origin" | "step-changes" | "none";

export interface MethodScore {
  method: FitMethod;
  mean: number;
  /** RMS of its rolling-origin errors, when there were at least `minErrors`. */
  rms?: number;
  errors: number;
}

export interface SeriesFit {
  method: FitMethod;
  mean: number;
  sd: number;
  steps: number;
  sdBasis: SdBasis;
  /** The RMS the sd was sized from (before `sdScale`/`minSd`), and how many errors it averaged. */
  errorRms?: number;
  errorCount: number;
  quantiles: Array<{ level: number; value: number }>;
  /** Values used, and how many non-finite ones were dropped. */
  n: number;
  dropped: number;
  /** Every method's mean and error, when `method` was `auto`. */
  candidates?: MethodScore[];
}

function isDated(series: SeriesInput): series is readonly DatedValue[] {
  return series.length > 0 && typeof series[0] === "object";
}

/**
 * Fit `series` and forecast `steps` releases ahead. Returns undefined when no
 * finite value remains. Throws RangeError on an invalid horizon, option or
 * date. Dated input is sorted by date first.
 */
export function fitSeries(series: SeriesInput, opts: SeriesFitOptions = {}): SeriesFit | undefined {
  const window = opts.window ?? DEFAULT_ERROR_WINDOW;
  const warmUp = opts.warmUp ?? DEFAULT_WARM_UP;
  const minErrors = opts.minErrors ?? DEFAULT_MIN_ERRORS;
  const sdScale = opts.sdScale ?? 1;
  const minSd = opts.minSd ?? 0;
  const params: Required<MethodParams> = {
    alpha: opts.alpha ?? DEFAULT_EWMA_ALPHA,
    damping: opts.damping ?? DEFAULT_DAMPING,
    trendWindow: opts.trendWindow ?? DEFAULT_TREND_WINDOW,
  };
  const levels = opts.levels ?? DEFAULT_LEVELS;
  validateOptions({ window, warmUp, minErrors, sdScale, minSd, levels, ...params });

  let values: number[];
  let dated: Array<{ date: string; value: number }> | undefined;
  if (isDated(series)) {
    const finite = series.filter((p) => Number.isFinite(p.value));
    if (finite.some((p) => p.date !== undefined)) {
      for (const p of finite) {
        if (p.date === undefined || !Number.isFinite(Date.parse(p.date))) {
          throw new RangeError(`invalid date "${p.date ?? ""}"`);
        }
      }
      dated = finite
        .map((p) => ({ date: p.date!, value: p.value }))
        .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
      values = dated.map((p) => p.value);
    } else {
      values = finite.map((p) => p.value);
    }
  } else {
    values = (series as readonly number[]).filter((v) => Number.isFinite(v));
  }
  const dropped = series.length - values.length;
  if (values.length === 0) return undefined;

  let steps = opts.steps ?? 1;
  if (opts.target !== undefined) {
    if (opts.steps !== undefined) throw new RangeError("give steps or target, not both");
    if (!dated) throw new RangeError("a target date needs dated values");
    if (!Number.isFinite(Date.parse(opts.target))) {
      throw new RangeError(`invalid target date "${opts.target}"`);
    }
    if (opts.spacingDays !== undefined && !(opts.spacingDays > 0)) {
      throw new RangeError("spacingDays must be > 0");
    }
    steps = stepsAhead(dated, opts.target, opts.spacingDays);
  }
  if (!Number.isSafeInteger(steps) || steps < 1) {
    throw new RangeError(`steps must be a whole number ≥ 1, got ${steps}`);
  }

  const score = (method: FitMethod): MethodScore & { errs: number[] } => {
    const errs =
      method === "persistence"
        ? stepChanges(values, steps, { window, warmUp })
        : rollingOriginErrors(values, (p) => predictWith(method, p, steps, params), steps, {
            window,
            warmUp,
          });
    return {
      method,
      mean: predictWith(method, values, steps, params),
      errors: errs.length,
      ...(errs.length >= minErrors ? { rms: rms(errs) } : {}),
      errs,
    };
  };

  const requested = opts.method ?? "auto";
  let chosen: MethodScore & { errs: number[] };
  let candidates: MethodScore[] | undefined;
  if (requested === "auto") {
    const all = FIT_METHODS.map(score);
    candidates = all.map(({ errs: _errs, ...rest }) => rest);
    chosen = all[0]!;
    const base = chosen.rms;
    if (base !== undefined) {
      let best = chosen;
      for (const c of all) if (c.rms !== undefined && c.rms < best.rms!) best = c;
      if (best !== chosen && best.rms! <= (1 - (opts.autoMargin ?? DEFAULT_AUTO_MARGIN)) * base) {
        chosen = best;
      }
    }
  } else {
    if (!FIT_METHODS.includes(requested)) throw new RangeError(`unknown method "${requested}"`);
    chosen = score(requested);
  }

  let sdBasis: SdBasis;
  let errorRms: number | undefined;
  let errorCount: number;
  if (chosen.rms !== undefined) {
    sdBasis = "rolling-origin";
    errorRms = chosen.rms;
    errorCount = chosen.errors;
  } else if (values.length >= 2) {
    const ones = stepChanges(values, 1, { window: values.length, warmUp: 1 });
    sdBasis = "step-changes";
    errorRms = Math.sqrt(steps) * rms(ones);
    errorCount = ones.length;
  } else {
    sdBasis = "none";
    errorCount = 0;
  }
  const sd = Math.max(errorRms === undefined ? 0 : sdScale * errorRms, minSd);
  const mean = chosen.mean;
  return {
    method: chosen.method,
    mean,
    sd,
    steps,
    sdBasis,
    ...(errorRms !== undefined ? { errorRms } : {}),
    errorCount,
    quantiles: levels.map((level) => ({
      level,
      value: sd > 0 ? normalQuantile(mean, sd, level) : mean,
    })),
    n: values.length,
    dropped,
    ...(candidates ? { candidates } : {}),
  };
}

function validateOptions(o: {
  window: number;
  warmUp: number;
  minErrors: number;
  sdScale: number;
  minSd: number;
  levels: readonly number[];
  alpha: number;
  damping: number;
  trendWindow: number;
}): void {
  const whole = (name: string, v: number, min: number) => {
    if (!Number.isSafeInteger(v) || v < min) {
      throw new RangeError(`${name} must be a whole number ≥ ${min}, got ${v}`);
    }
  };
  whole("window", o.window, 1);
  whole("warmUp", o.warmUp, 1);
  whole("minErrors", o.minErrors, 1);
  whole("trendWindow", o.trendWindow, 2);
  if (!(o.alpha > 0 && o.alpha <= 1))
    throw new RangeError(`alpha must be in (0, 1], got ${o.alpha}`);
  if (!(o.damping > 0 && o.damping <= 1)) {
    throw new RangeError(`damping must be in (0, 1], got ${o.damping}`);
  }
  if (!(o.sdScale > 0) || !Number.isFinite(o.sdScale)) {
    throw new RangeError(`sdScale must be > 0, got ${o.sdScale}`);
  }
  if (!(o.minSd >= 0) || !Number.isFinite(o.minSd)) {
    throw new RangeError(`minSd must be ≥ 0, got ${o.minSd}`);
  }
  for (const l of o.levels) {
    if (!(l > 0 && l < 1)) throw new RangeError(`quantile levels must be in (0, 1), got ${l}`);
  }
}
