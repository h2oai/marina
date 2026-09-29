// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * TabH2O (H2O.ai's tabular foundation model, src/net/tabh2o-client.ts) as an
 * EXPERIMENTAL arena forecaster: `tabh2o[:forecast][@nowcast]`.
 *
 * Each round's training table is built from ONLY what the round froze at its
 * lock — the lock's own published history for the series (each cell's, for a
 * profile) — or, with `@nowcast` on a Civiqs round, the daily series from the
 * newest archived snapshot FETCHED by the lock (the same snapshot the nowcast
 * reads). Nothing later ever enters a row, so a backtest through
 * `evaluateResolved` keeps its guarantees.
 *
 *   - `regression` (default): one row per (origin, horizon) with lagged level,
 *     diffs, deviation from the 4-point mean, time index, day of week, horizon
 *     (and the cell, for a profile); the target is the change from the origin
 *     to the value `h` steps later. The test row is the last point at the
 *     round's horizon. Predicting the change rather than the level keeps a
 *     tree-like learner from refusing to extrapolate a trending level.
 *   - `forecast`: the series itself with a time column, sent to `/forecast`;
 *     the test rows are the next `steps` period dates and the last is used.
 *
 * The model's answer becomes a distribution — mean from the prediction, sd
 * from the returned confidence interval (the API does not document its level;
 * a 90 % interval is assumed, {@link CI_Z}), else from the residual spread of
 * the training targets — and is then SHRUNK toward the start forecast (the
 * baseline, or the nowcast with `@nowcast`) exactly as `model-forecaster.ts`
 * does, with the same blowup guard. Any failure — no key, an HTTP error, too
 * little history — files the start forecast with a recorded `fallback`.
 */

import { dailyCapRefusal, recordSpend } from "../engine/spend-ledger";
import {
  type TabH2OPredictRequest,
  type TabH2OResult,
  type TabH2ORow,
  tabh2oPredict,
} from "../net/tabh2o-client";
import type { RoundForecast } from "./forecast";
import { horizonSteps } from "./forecast";
import type { Usage } from "./model-backend";
import { blend, type ModelRoundForecast } from "./model-forecaster";
import { withoutDaily } from "./prompt-context";
import type { ArenaLock, ArenaPoint, ArenaRound, Distribution } from "./types";

/** z of the interval TabH2O returns — its level is undocumented; 90 % assumed. */
export const CI_Z = 1.645;
/** Lags a row reads (the origin and three before it). */
const LAGS = 3;
/** Fewer training rows than this and the start forecast is kept. */
export const MIN_TRAINING_ROWS = 8;
/** Points of a series used (the newest ones). */
export const MAX_POINTS = 120;
const DAY_MS = 86_400_000;

export type TabH2OMode = "regression" | "forecast";

export interface TabH2OSpec {
  mode: TabH2OMode;
  /** Start from (and read the daily series of) the nowcast instead of the baseline. */
  nowcast: boolean;
}

/** `tabh2o`, `tabh2o:forecast`, `tabh2o@nowcast`, `tabh2o:forecast@nowcast`. */
export function parseTabH2OSpec(spec: string): TabH2OSpec | undefined {
  const m = /^tabh2o(:regression|:forecast)?(@nowcast)?$/i.exec(spec.trim());
  if (!m) return undefined;
  return { mode: m[1]?.toLowerCase() === ":forecast" ? "forecast" : "regression", nowcast: !!m[2] };
}

export interface TabH2OOptions {
  /** Share of TabH2O's move from the start kept (0 = start, 1 = raw model). */
  weight: number;
  /** A mean further than this many start sds from it is a blowup (start kept). */
  maxSdMove: number;
}

export const DEFAULT_TABH2O_OPTIONS: TabH2OOptions = { weight: 0.5, maxSdMove: 4 };

/** One TabH2O call, as the forecaster sees it: the result, and whether it was billed. */
export type TabPredict = (
  request: TabH2OPredictRequest,
) => Promise<{ result: TabH2OResult; cached: boolean; ms: number }>;

/** One series to learn from: its points (oldest first) and the horizon to predict. */
export interface SeriesInput {
  key: string;
  points: ArenaPoint[];
  steps: number;
}

export interface BuiltTable {
  request: TabH2OPredictRequest;
  /** Per series: the origin value the prediction is added to (regression) and the residual sd. */
  series: Array<{ key: string; origin: number; residualSd: number; testRows: number }>;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

function dow(date: string): number {
  const t = Date.parse(date);
  return Number.isFinite(t) ? new Date(t).getUTCDay() : 0;
}

function spacingDays(points: ArenaPoint[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const d = (Date.parse(points[i]!.date) - Date.parse(points[i - 1]!.date)) / DAY_MS;
    if (d > 0) gaps.push(d);
  }
  if (!gaps.length) return 7;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}

function rms(xs: number[]): number {
  return xs.length ? Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length) : Number.NaN;
}

/** Horizons trained on: the round's own and its neighbours (more rows, same regime). */
function horizons(steps: number): number[] {
  return [...new Set([Math.max(1, steps - 1), steps, steps + 1])];
}

/**
 * The training table for one round. Pure: every row is built from `series`,
 * which the caller took from what the round froze at its lock. Returns
 * undefined when there are too few rows to learn from.
 */
export function buildTable(inputs: SeriesInput[], mode: TabH2OMode): BuiltTable | undefined {
  const multi = inputs.length > 1;
  const training: TabH2ORow[] = [];
  const predict: TabH2ORow[] = [];
  const series: BuiltTable["series"] = [];
  for (const [s, input] of inputs.entries()) {
    const pts = input.points.filter((p) => Number.isFinite(p.value)).slice(-MAX_POINTS);
    const v = pts.map((p) => p.value);
    const n = v.length;
    if (n < LAGS + 2) return undefined;
    const steps = Math.max(1, input.steps);
    const sameH = [];
    for (let o = steps; o < n; o++) sameH.push(v[o]! - v[o - steps]!);
    const residualSd = rms(sameH);
    const cell: TabH2ORow = multi ? { cell: s } : {};
    if (mode === "forecast") {
      const item: TabH2ORow = multi ? { item_id: `c${s}` } : {};
      for (const p of pts) training.push({ ...item, date: p.date.slice(0, 10), y: p.value });
      const gap = spacingDays(pts) * DAY_MS;
      const last = Date.parse(pts.at(-1)!.date);
      for (let k = 1; k <= steps; k++) {
        predict.push({ ...item, date: new Date(last + k * gap).toISOString().slice(0, 10) });
      }
      series.push({ key: input.key, origin: v.at(-1)!, residualSd, testRows: steps });
      continue;
    }
    const features = (o: number, h: number): TabH2ORow => ({
      ...cell,
      t: o - (n - 1),
      dow: dow(pts[o]!.date),
      h,
      level: r3(v[o]!),
      d1: r3(v[o]! - v[o - 1]!),
      d2: r3(v[o - 1]! - v[o - 2]!),
      d3: r3(v[o - 2]! - v[o - 3]!),
      dev4: r3(v[o]! - (v[o]! + v[o - 1]! + v[o - 2]! + v[o - 3]!) / 4),
    });
    for (const h of horizons(steps)) {
      for (let o = LAGS; o + h < n; o++) {
        training.push({ ...features(o, h), y: r3(v[o + h]! - v[o]!) });
      }
    }
    predict.push(features(n - 1, steps));
    series.push({ key: input.key, origin: v.at(-1)!, residualSd, testRows: 1 });
  }
  if (training.length < MIN_TRAINING_ROWS * (mode === "forecast" ? 1 : inputs.length)) {
    return undefined;
  }
  return {
    request: {
      task: mode === "forecast" ? "forecast" : "regression",
      training,
      predict_on: predict,
      target_column: "y",
      ...(mode === "forecast" ? { time_column: "date" } : {}),
    },
    series,
  };
}

/** A distribution per series from TabH2O's answer (undefined for a malformed one). */
export function distributionsFrom(
  table: BuiltTable,
  result: TabH2OResult & { ok: true },
  mode: TabH2OMode,
): Array<{ dist: Distribution; sdSource: "ci" | "residual"; ci?: [number, number] }> | undefined {
  const preds = result.response.predictions;
  const out: Array<{ dist: Distribution; sdSource: "ci" | "residual"; ci?: [number, number] }> = [];
  let row = 0;
  for (const s of table.series) {
    row += s.testRows;
    const p = preds[row - 1];
    const value = Number(p?.prediction);
    if (!p || !Number.isFinite(value)) return undefined;
    const mean = mode === "forecast" ? value : s.origin + value;
    const ci = p.confidence_interval;
    const width = ci ? ci[1] - ci[0] : Number.NaN;
    const fromCi = Number.isFinite(width) && width > 0 ? width / (2 * CI_Z) : undefined;
    const sd = fromCi ?? s.residualSd;
    if (!Number.isFinite(sd) || sd <= 0) return undefined;
    const shift = mode === "forecast" ? 0 : s.origin;
    out.push({
      dist: { mean: r3(mean), sd: r3(Math.max(sd, 0.01)) },
      sdSource: fromCi ? "ci" : "residual",
      ...(ci ? { ci: [r3(ci[0] + shift), r3(ci[1] + shift)] as [number, number] } : {}),
    });
  }
  return out;
}

/**
 * `blend` (model-forecaster.ts) with the blowup guard measured in the larger of
 * the start's sd and the series' own typical `steps`-ahead move: a start that
 * is exact persistence carries the arena's fixed sd 1.5 whatever the series'
 * scale, which would call an ordinary week of a volatile series a blowup.
 */
export function guardedBlend(
  base: Distribution,
  model: Distribution,
  residualSd: number,
  opts: TabH2OOptions,
): Distribution | undefined {
  const scale = Math.max(base.sd, Number.isFinite(residualSd) ? residualSd : 0);
  if (Math.abs(model.mean - base.mean) > opts.maxSdMove * scale) return undefined;
  return blend(base, model, { ...opts, maxSdMove: Number.POSITIVE_INFINITY });
}

export interface TabH2ODeps {
  predict: TabPredict;
  /**
   * The series a round learns from. Default: the lock's own history (each
   * cell's, for a profile). `@nowcast` substitutes the Civiqs daily snapshot.
   */
  seriesFor?: (round: ArenaRound, lock: ArenaLock) => Promise<SeriesInput[] | undefined>;
  usage?: Usage;
}

/** The lock's own frozen history per series (the default training source). */
export function lockSeries(round: ArenaRound, lock: ArenaLock): SeriesInput[] | undefined {
  if (round.target_type === "continuous_normal") {
    const points = lock.answer_history ?? lock.history ?? [];
    if (!points.length) return undefined;
    return [
      {
        key: round.series ?? round.round_id,
        points,
        steps: horizonSteps(points, round.release_at),
      },
    ];
  }
  if (round.target_type === "profile_energy") {
    const out: SeriesInput[] = [];
    for (const c of round.cells ?? []) {
      const points = lock.answer_history_by_cell?.[c];
      if (!points?.length) return undefined;
      out.push({ key: c, points, steps: horizonSteps(points, round.release_at) });
    }
    return out.length ? out : undefined;
  }
  return undefined;
}

export interface TabH2ORoundForecast extends ModelRoundForecast {
  tabh2o?: {
    mode: TabH2OMode;
    rows: number;
    cells?: number;
    latencyMs?: number;
    cached?: boolean;
    model?: string;
    sdSource?: string;
    ci?: [number, number];
  };
  costUsd?: number;
}

export async function tabh2oForecastRound(
  round: ArenaRound,
  lock: ArenaLock,
  startForecast: RoundForecast,
  spec: TabH2OSpec,
  deps: TabH2ODeps,
  opts: TabH2OOptions = DEFAULT_TABH2O_OPTIONS,
): Promise<TabH2ORoundForecast> {
  const start = withoutDaily(startForecast);
  const keep = (why: string, extra: Partial<TabH2ORoundForecast> = {}): TabH2ORoundForecast => ({
    ...start,
    fallback: why,
    ...extra,
  });
  if (round.target_type === "ranking_list") return keep("ranking round: TabH2O not used");
  const inputs = (await deps.seriesFor?.(round, lock)) ?? lockSeries(round, lock);
  if (!inputs) return keep("no frozen history to learn from");
  const table = buildTable(inputs, spec.mode);
  if (!table) return keep(`fewer than ${MIN_TRAINING_ROWS} training rows`);
  const detail: NonNullable<TabH2ORoundForecast["tabh2o"]> = {
    mode: spec.mode,
    rows: table.request.training.length,
    ...(inputs.length > 1 ? { cells: inputs.length } : {}),
  };
  let call: Awaited<ReturnType<TabPredict>>;
  try {
    call = await deps.predict(table.request);
  } catch (err) {
    return keep(`tabh2o call failed: ${err instanceof Error ? err.message : String(err)}`, {
      tabh2o: detail,
    });
  }
  const { result } = call;
  detail.latencyMs = Math.round(call.ms);
  detail.cached = call.cached;
  const cost = !call.cached && result.ok ? (result.response.usage?.priceUsd ?? 0) : 0;
  if (deps.usage && !call.cached) {
    deps.usage.calls++;
    deps.usage.costUsd += cost;
  }
  if (!result.ok) return keep(`tabh2o unavailable: ${result.error}`, { tabh2o: detail });
  if (result.response.model_version) detail.model = result.response.model_version;
  const dists = distributionsFrom(table, result, spec.mode);
  if (!dists) return keep("tabh2o reply had no usable prediction", { tabh2o: detail });
  const from = spec.nowcast ? "the nowcast" : "the calibrated baseline";
  const note = `marina tabh2o ${spec.mode}${spec.nowcast ? "@nowcast" : ""}, weight ${opts.weight} on its move from ${from}`;
  const costed = cost > 0 ? { costUsd: cost } : {};

  if (round.target_type === "continuous_normal") {
    const [only] = dists;
    const base = start.topline;
    if (!only || !base) return keep("no start topline", { tabh2o: detail });
    detail.sdSource = only.sdSource;
    if (only.ci) detail.ci = only.ci;
    const topline = guardedBlend(base, only.dist, table.series[0]!.residualSd, opts);
    if (!topline) {
      return keep("tabh2o mean implausibly far from the start", {
        raw: { topline: only.dist },
        tabh2o: detail,
        ...costed,
      });
    }
    return { ...start, topline, raw: { topline: only.dist }, note, tabh2o: detail, ...costed };
  }
  const profile: Record<string, Distribution> = {};
  const raw: Record<string, Distribution> = {};
  for (const [i, s] of table.series.entries()) {
    const base = start.profile?.[s.key];
    const d = dists[i]!.dist;
    if (!base) return keep(`no start for cell ${s.key}`, { tabh2o: detail });
    raw[s.key] = d;
    // A blown-up cell keeps its start; the rest of the profile still moves.
    profile[s.key] = guardedBlend(base, d, s.residualSd, opts) ?? base;
  }
  detail.sdSource = dists.every((d) => d.sdSource === "ci") ? "ci" : "mixed";
  return { ...start, profile, raw: { profile: raw }, note, tabh2o: detail, ...costed };
}

// ─── The live predictor: throttled, cached, metered ─────────────────────────

/** The free tier allows 10 requests a minute; stay under it. */
export const TABH2O_MIN_GAP_MS = 6_500;
const CACHE_LIMIT = 500;

/**
 * TabH2O through the client, one request at a time at most every
 * {@link TABH2O_MIN_GAP_MS}, identical requests answered once (a blend and its
 * raw variant share a call), a 429/503/504 retried once after the server's
 * `Retry-After` (≤ 60 s), and every priced call recorded on the daily
 * spend ledger — refused outright once the cap is reached.
 */
export function throttledTabPredict(
  env: NodeJS.ProcessEnv = process.env,
  opts: {
    call?: (req: TabH2OPredictRequest) => Promise<TabH2OResult>;
    minGapMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): TabPredict {
  const tabh2o = env.TABH2O_API_KEY;
  const call =
    opts.call ??
    ((req: TabH2OPredictRequest) =>
      tabh2oPredict(req, {
        ...(tabh2o ? { apiKey: tabh2o } : {}),
        timeoutMs: 60_000,
      }));
  const gap = opts.minGapMs ?? TABH2O_MIN_GAP_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cache = new Map<string, Promise<{ res: TabH2OResult; ms: number }>>();
  let chain: Promise<unknown> = Promise.resolve();
  let lastAt = 0;
  /** One request, after the pacing gap; `ms` is the HTTP round trip alone. */
  const paced = (req: TabH2OPredictRequest) => {
    const next = chain.then(async () => {
      const wait = lastAt + gap - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
      const t0 = performance.now();
      const res = await call(req);
      return { res, ms: performance.now() - t0 };
    });
    chain = next.catch(() => undefined);
    return next;
  };
  return async (req) => {
    const key = JSON.stringify(req);
    const hit = cache.get(key);
    if (hit) return { result: (await hit).res, cached: true, ms: 0 };
    const capped = dailyCapRefusal(env);
    if (capped) return { result: { ok: false, error: capped }, cached: false, ms: 0 };
    const run = (async () => {
      let out = await paced(req);
      const r = out.res;
      if (!r.ok && [429, 503, 504].includes(r.status ?? 0) && (r.retryAfterSec ?? 5) <= 60) {
        await sleep((r.retryAfterSec ?? 5) * 1000);
        out = await paced(req);
      }
      if (out.res.ok) recordSpend("forecast", out.res.response.usage?.priceUsd ?? 0);
      return out;
    })();
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(key, run);
    const { res, ms } = await run;
    // A failure is not remembered: the next ask tries again.
    if (!res.ok) cache.delete(key);
    return { result: res, cached: false, ms };
  };
}

let shared: TabPredict | undefined;

/** One predictor per process, so every `tabh2o` forecaster shares its pacing and cache. */
export function sharedTabPredict(env: NodeJS.ProcessEnv = process.env): TabPredict {
  shared ??= throttledTabPredict(env);
  return shared;
}
