// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The last stage of a typed forecast: pool the finished answer toward its
 * prior (`./prior.ts`), then recalibrate it (`./recalibration.ts`) — both
 * learned only from resolved history visible at the cutoff (`./history.ts`),
 * both opt-in, both recorded on the answer (`adjustment`).
 *
 *   raw     the forecast in numbers before this stage: the answer's own
 *           probabilities, or — when the question did not ask for them — the
 *           runs' implicit ones (each run's pick at its stated confidence,
 *           averaged by weight); a number's point and sd
 *   prior   the best prior at the cutoff, its weight (fitted, or the default)
 *   calib   the map for the answer's group, adopted only on a held-out win
 *   final   what the answer now carries
 *
 * A question that asked for probabilities gets the adjusted probabilities (and
 * the most probable option). One that asked only for a pick keeps its pick
 * unless the adjustment moves the most probable option (or, for a
 * multi-select, the set of options at or above one half) — then the adjusted
 * one replaces it and the old one is recorded. A number takes the adjusted
 * point and spread. Rankings and free text have no prior and pass through.
 *
 * Applied once, at the end of any formation (`forecastFormed`), so every
 * formation is adjusted the same way.
 */

import { type AnswerSpec, formatAnswer } from "./answer-types";
import {
  argmax,
  averageDistributions,
  averageMarginals,
  completeMarginals,
  type Distribution,
  pickDistribution,
} from "./distribution";
import { clampP, type ProperScore } from "./fitting";
import {
  answerGroup,
  type ForecastHistory,
  type ForecastNumbers,
  historyFromEnv,
  informative,
  type PriorContext,
  type PriorSource,
  priorBucket,
  type ResolvedRecord,
  resolvedRecord,
  visibleRecords,
} from "./history";
import {
  type ChosenPrior,
  choosePrior,
  fitShrinkWeight,
  type ShrinkWeight,
  type SuppliedPrior,
  shrink,
} from "./prior";
import { applyCalibration, type CalibrationFit, fitCalibration } from "./recalibration";
import type { TypedForecastAnswer, TypedForecastRequest } from "./typed";

export interface AdjustSettings {
  /** Pool toward the prior (default off). */
  prior: "off" | "on";
  /**
   * Recalibrate: `on` fits a map on resolved history (adopted only on a held-out
   * win), `observe` fits and records without applying, `fixed` applies a fixed
   * Platt slope (`fixedSlope`, b = 0) from the first forecast — the cold start
   * a new board needs (default off).
   */
  calibration: "off" | "observe" | "on" | "fixed";
  /** The slope for `fixed` calibration (> 1 extremizes). */
  fixedSlope?: number;
  /** Clamp final probabilities to [clamp, 1 − clamp] (a tail guard for log-scored boards). */
  clamp?: number;
  /** The default weight toward a supplied market or community prior (before evidence). */
  priorWeight: number;
  /** Relative held-out improvement a learned setting needs over its default. */
  margin: number;
  /** The proper score learned settings are judged by (numbers always use CRPS). */
  score: ProperScore;
  /** Fewest visible records before anything is fitted. */
  minRecords: number;
  history?: ForecastHistory;
}

export const DEFAULT_ADJUST: Omit<AdjustSettings, "history"> = {
  prior: "off",
  calibration: "off",
  priorWeight: 0.5,
  margin: 0.05,
  score: "brier",
  minRecords: 50,
};

const num = (v: string | undefined, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return v?.trim() && Number.isFinite(n) && n >= lo && n <= hi ? n : d;
};

/** Settings from MARINA_FORECAST_PRIOR / _PRIOR_WEIGHT / _CALIBRATION / _CALIBRATION_MARGIN / _CALIBRATION_SCORE / _HISTORY / _HISTORY_MIN. */
export function adjustSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): AdjustSettings {
  const on = (v: string | undefined) => ["on", "true", "1"].includes(v?.trim().toLowerCase() ?? "");
  const cal = env.MARINA_FORECAST_CALIBRATION?.trim().toLowerCase();
  const fixed = cal?.startsWith("fixed:") ? fixedSlope(cal.slice("fixed:".length)) : undefined;
  const clamp = num(env.MARINA_FORECAST_PROB_CLAMP, 0.0001, 0.2, Number.NaN);
  const history = historyFromEnv(env);
  return {
    prior: on(env.MARINA_FORECAST_PRIOR) ? "on" : "off",
    calibration:
      fixed !== undefined ? "fixed" : cal === "observe" ? "observe" : on(cal) ? "on" : "off",
    ...(fixed !== undefined ? { fixedSlope: fixed } : {}),
    ...(Number.isFinite(clamp) ? { clamp } : {}),
    priorWeight: num(env.MARINA_FORECAST_PRIOR_WEIGHT, 0, 1, DEFAULT_ADJUST.priorWeight),
    margin: num(env.MARINA_FORECAST_CALIBRATION_MARGIN, 0, 1, DEFAULT_ADJUST.margin),
    score: env.MARINA_FORECAST_CALIBRATION_SCORE?.trim().toLowerCase() === "log" ? "log" : "brier",
    minRecords: Math.round(
      num(env.MARINA_FORECAST_HISTORY_MIN, 10, 100_000, DEFAULT_ADJUST.minRecords),
    ),
    ...(history ? { history } : {}),
  };
}

/** A fixed slope from `1.73`, `sqrt3` or `√3` (0.25–4), else undefined. */
export function fixedSlope(raw: string): number | undefined {
  const t = raw.trim().toLowerCase();
  const m = t.match(/^(?:sqrt|√)\s*\(?\s*([\d.]+)\s*\)?$/);
  const a = m ? Math.sqrt(Number(m[1])) : Number(t);
  return Number.isFinite(a) && a >= 0.25 && a <= 4 ? a : undefined;
}

/** Whether the stage does anything (else it is skipped and nothing is recorded). */
export const adjustActive = (s: AdjustSettings | undefined): s is AdjustSettings =>
  !!s && (s.prior === "on" || s.calibration !== "off" || s.clamp !== undefined);

type Learned = Pick<
  ShrinkWeight,
  "adopted" | "reason" | "nFit" | "nHoldout" | "holdout" | "through"
>;

export interface AdjustmentRecord {
  /** The forecast before this stage (what a resolved record keeps). */
  raw: ForecastNumbers;
  /** `raw` was derived from the runs' picks (the question asked for no probabilities). */
  implicit?: boolean;
  prior?: ChosenPrior;
  rejectedPriors?: Array<{ source: string; reason: string }>;
  /** How many resolved records were visible at the cutoff, and the newest one's time. */
  history: { visible: number; through?: string; error?: string };
  shrink?: Learned & { source: PriorSource; weight: number; applied: boolean; bucket?: string };
  calibration?: Partial<Learned> & {
    group: string;
    map: CalibrationFit["params"];
    score: CalibrationFit["score"] | "fixed";
    applied: boolean;
  };
  /** The tail guard applied to the final probabilities. */
  clamp?: number;
  final: ForecastNumbers;
  /** The prediction this stage replaced, when it replaced one. */
  replaced?: string;
}

/**
 * The forecast in numbers before adjustment: the answer's probabilities, the
 * runs' implicit ones for a pick-only choice or multi-select, a number's point
 * and sd. Undefined for rankings, text and answers without a usable run.
 */
export function implicitForecast(
  spec: AnswerSpec,
  answer: Pick<TypedForecastAnswer, "distribution" | "runs" | "prediction" | "uncertainty">,
): { numbers: ForecastNumbers; implicit: boolean } | undefined {
  if (answer.prediction === undefined) return undefined;
  if (spec.type === "number") {
    if (typeof answer.prediction !== "number") return undefined;
    return {
      numbers: {
        value: answer.prediction,
        ...(answer.uncertainty?.sd !== undefined ? { sd: answer.uncertainty.sd } : {}),
      },
      implicit: false,
    };
  }
  if (spec.type !== "choice" && spec.type !== "multi") return undefined;
  if (answer.distribution)
    return { numbers: { distribution: answer.distribution }, implicit: false };
  const runs = answer.runs.filter((r) => r.value !== undefined && r.weight > 0);
  if (runs.length === 0) return undefined;
  const d =
    spec.type === "choice"
      ? averageDistributions(
          runs.map((r) => ({
            distribution:
              r.distribution ?? pickDistribution(spec.options, r.value as string, r.confidence),
            weight: r.weight,
          })),
        )
      : averageMarginals(
          runs.map((r) => ({
            distribution:
              r.distribution ??
              completeMarginals(spec.options, undefined, r.value as string[], r.confidence),
            weight: r.weight,
          })),
        );
  return d ? { numbers: { distribution: d }, implicit: true } : undefined;
}

/** A multi-select's picks from per-option probabilities: ≥ ½, within min/max picks. */
export function picksFrom(spec: Extract<AnswerSpec, { type: "multi" }>, d: Distribution): string[] {
  const ids = spec.options.map((o) => o.id);
  const ranked = [...ids].sort((a, b) => (d[b] ?? 0) - (d[a] ?? 0));
  let picked = ids.filter((id) => (d[id] ?? 0) >= 0.5);
  const min = spec.minPicks ?? 1;
  if (picked.length < min) picked = ranked.slice(0, min);
  if (spec.maxPicks !== undefined && picked.length > spec.maxPicks) {
    picked = ranked.filter((id) => picked.includes(id)).slice(0, spec.maxPicks);
  }
  return ids.filter((id) => picked.includes(id));
}

/**
 * Pool the finished answer toward its prior and recalibrate it, per
 * `settings`, in place; the record goes on `answer.adjustment`. Anything the
 * stage cannot do (no history, no prior, a ranking) leaves the answer as it was.
 */
export async function adjustForecast(
  answer: TypedForecastAnswer,
  req: TypedForecastRequest,
  settings: AdjustSettings,
): Promise<void> {
  const spec = req.answer;
  const start = implicitForecast(spec, answer);
  if (!start) return;
  const cutoff = answer.cutoff.at;
  let all: ResolvedRecord[] = [];
  let historyError: string | undefined;
  if (settings.history) {
    try {
      all = await settings.history.all();
    } catch (err) {
      historyError = (err instanceof Error ? err.message : String(err)).slice(0, 160);
    }
  }
  const visible = visibleRecords(all, cutoff, req.id);
  const chosen = choosePrior({
    spec,
    cutoff,
    ...(req.priors ? { supplied: req.priors } : {}),
    ...(answer.lookups ? { lookups: answer.lookups } : {}),
    ...(answer.anchor ? { anchor: answer.anchor } : {}),
    history: visible,
    ...(req.category ? { category: req.category } : {}),
  });
  if (chosen.prior) {
    const h = horizonDays(cutoff, req.endTime);
    if (h !== undefined) chosen.prior.horizonDays = h;
  }
  const rec: AdjustmentRecord = {
    raw: start.numbers,
    ...(start.implicit ? { implicit: true } : {}),
    ...(chosen.prior ? { prior: chosen.prior } : {}),
    ...(chosen.rejected ? { rejectedPriors: chosen.rejected } : {}),
    history: {
      visible: visible.length,
      ...(visible.length ? { through: visible.at(-1)!.resolvedAt } : {}),
      ...(historyError ? { error: historyError } : {}),
    },
    final: start.numbers,
  };
  // One fitted weight per prior source, shared by this forecast and the
  // calibration fit (which sees each record as it would have been pooled).
  const weights = new Map<string, ShrinkWeight>();
  const weightFor = (source: PriorSource, context?: PriorContext) => {
    const key = `${source}|${context ? priorBucket(context) : ""}`;
    let w = weights.get(key);
    if (!w) {
      w = fitShrinkWeight({
        spec,
        source,
        history: visible,
        priorWeight: settings.priorWeight,
        margin: settings.margin,
        minRecords: settings.minRecords,
        score: settings.score,
        ...(context ? { context } : {}),
      });
      weights.set(key, w);
    }
    return w;
  };
  let f = start.numbers;
  // Only an informative prior earns a shrink: pooling toward the uniform
  // default only adds to the hedging LLM forecasters already show.
  if (settings.prior === "on" && chosen.prior && informative(chosen.prior.source)) {
    const w = weightFor(chosen.prior.source, chosen.prior);
    f = shrink(spec.type, f, chosen.prior, w.params);
    rec.shrink = {
      source: chosen.prior.source,
      weight: w.params,
      applied: w.params > 0,
      ...(w.bucket ? { bucket: w.bucket } : {}),
      ...learned(w),
    };
  }
  if (settings.calibration === "fixed" && settings.fixedSlope !== undefined) {
    const group = answerGroup(spec);
    if (spec.type === "choice" || spec.type === "multi") {
      const map = { kind: "platt" as const, a: settings.fixedSlope, b: 0 };
      f = applyCalibration(group, map, f);
      rec.calibration = {
        group,
        map,
        score: "fixed",
        applied: true,
        reason: "fixed slope (cold start)",
      };
    }
  } else if (settings.calibration !== "off") {
    const fit = fitCalibration({
      spec,
      history: visible,
      forecastOf: (r) =>
        settings.prior === "on" && r.prior && informative(r.prior.source)
          ? shrink(r.answerType, r.raw, r.prior, weightFor(r.prior.source, r.prior).params)
          : r.raw,
      margin: settings.margin,
      minRecords: settings.minRecords,
      score: settings.score,
    });
    if (fit) {
      const applied = settings.calibration === "on" && fit.adopted;
      if (applied) f = applyCalibration(fit.group, fit.params, f);
      rec.calibration = {
        group: fit.group,
        map: fit.params,
        score: fit.score,
        applied,
        ...learned(fit),
      };
    }
  }
  if (settings.clamp !== undefined && f.distribution) {
    f = { distribution: clampDistribution(spec, f.distribution, settings.clamp) };
    rec.clamp = settings.clamp;
  }
  rec.final = f;
  const before = answer.formatted;
  setFinal(answer, spec, start.numbers, f, start.implicit);
  if (answer.formatted !== before && before !== undefined) rec.replaced = before;
  answer.adjustment = rec;
}

/** Days from the cutoff to the question's close, when it has one. */
function horizonDays(cutoff: string, endTime: string | undefined): number | undefined {
  const d = endTime ? (Date.parse(endTime) - Date.parse(cutoff)) / 86_400_000 : Number.NaN;
  return Number.isFinite(d) && d >= 0 ? Math.round(d * 10) / 10 : undefined;
}

/** Probabilities held inside [ε, 1 − ε]; a choice's renormalised. */
function clampDistribution(spec: AnswerSpec, d: Distribution, eps: number): Distribution {
  const out: Distribution = {};
  for (const [k, p] of Object.entries(d)) out[k] = Math.min(1 - eps, Math.max(eps, p));
  if (spec.type !== "choice") return out;
  // Renormalise, then re-clamp what renormalising pushed past the guard.
  const total = Object.values(out).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(out)) out[k] = Math.min(1 - eps, Math.max(eps, out[k]! / total));
  return out;
}

function learned(r: Learned): Learned {
  return {
    adopted: r.adopted,
    reason: r.reason,
    nFit: r.nFit,
    nHoldout: r.nHoldout,
    ...(r.holdout ? { holdout: r.holdout } : {}),
    ...(r.through ? { through: r.through } : {}),
  };
}

function setFinal(
  answer: TypedForecastAnswer,
  spec: AnswerSpec,
  raw: ForecastNumbers,
  f: ForecastNumbers,
  implicit: boolean,
): void {
  if (spec.type === "number") {
    if (f.value === undefined) return;
    const value = spec.integer ? Math.round(f.value) : f.value;
    answer.prediction = value;
    answer.formatted = formatAnswer(value);
    if (f.sd !== undefined) answer.uncertainty = { sd: f.sd };
    return;
  }
  if (!f.distribution || !raw.distribution) return;
  if (spec.type === "choice") {
    const top = argmax(spec.options, f.distribution);
    if (!implicit) {
      answer.distribution = f.distribution;
      answer.prediction = top;
      answer.formatted = top;
      answer.confidence = f.distribution[top];
    } else if (top !== argmax(spec.options, raw.distribution)) {
      answer.prediction = top;
      answer.formatted = top;
      answer.confidence = clampP(f.distribution[top] ?? 0);
    }
    return;
  }
  if (spec.type === "multi") {
    if (!implicit) answer.distribution = f.distribution;
    const now = picksFrom(spec, f.distribution);
    if (now.join("|") !== picksFrom(spec, raw.distribution).join("|")) {
      answer.prediction = now;
      answer.formatted = formatAnswer(now);
    }
  }
}

/**
 * The resolved record for a finished answer (for `ForecastHistory.add`): its
 * pre-adjustment forecast and prior, the outcome, when it became known. An
 * answer made without the stage still yields a record (its own numbers and
 * the prior it would have had from the request and its lookups).
 */
export function recordFromAnswer(input: {
  id: string;
  req: TypedForecastRequest;
  answer: TypedForecastAnswer;
  truth: { options?: string[]; value?: number };
  resolvedAt: string;
  resolvedOptions?: string[];
  formation?: string;
  score?: number;
}): ResolvedRecord | undefined {
  const { req, answer } = input;
  const numbers = answer.adjustment?.raw ?? implicitForecast(req.answer, answer)?.numbers;
  if (!numbers) return undefined;
  const prior =
    answer.adjustment?.prior ??
    choosePrior({
      spec: req.answer,
      cutoff: answer.cutoff.at,
      ...(req.priors ? { supplied: req.priors } : {}),
      ...(answer.lookups ? { lookups: answer.lookups } : {}),
      ...(answer.anchor ? { anchor: answer.anchor } : {}),
    }).prior;
  if (prior && prior.horizonDays === undefined) {
    const h = horizonDays(answer.cutoff.at, req.endTime);
    if (h !== undefined) prior.horizonDays = h;
  }
  return resolvedRecord({
    id: input.id,
    spec: req.answer,
    resolvedAt: input.resolvedAt,
    numbers,
    ...(prior ? { prior: priorNumbers(prior) } : {}),
    truth: input.truth,
    ...(input.resolvedOptions ? { resolvedOptions: input.resolvedOptions } : {}),
    ...(req.category ? { category: req.category } : {}),
    ...(input.formation ? { formation: input.formation } : {}),
    ...(input.score !== undefined ? { score: input.score } : {}),
  });
}

function priorNumbers(p: ChosenPrior): ForecastNumbers & { source: PriorSource } & PriorContext {
  return {
    source: p.source,
    ...(p.horizonDays !== undefined ? { horizonDays: p.horizonDays } : {}),
    ...(p.liquidity !== undefined ? { liquidity: p.liquidity } : {}),
    ...(p.distribution ? { distribution: p.distribution } : {}),
    ...(p.value !== undefined ? { value: p.value } : {}),
    ...(p.sd !== undefined ? { sd: p.sd } : {}),
  };
}

export type { SuppliedPrior };

/**
 * One resolved answer into the history recalibration, prior shrink and routing
 * learn from (`MARINA_FORECAST_HISTORY`; no history ⇒ nothing). Written once
 * per id (the file is append-only), never for a measurement run — a board's
 * measured outcomes must not tune what is measured on it — and with
 * `resolvedAt` the time the outcome became known, so `visibleRecords` keeps it
 * from every forecast cut off before then. Best-effort: false when nothing
 * was written (no history, measurement, unusable answer, or a duplicate).
 */
export async function noteResolvedForecast(
  history: ForecastHistory | undefined,
  input: Parameters<typeof recordFromAnswer>[0] & {
    eval?: import("../learning/eval-context").EvalContext;
  },
): Promise<boolean> {
  if (!history || input.eval?.mode === "measure") return false;
  const { eval: _eval, ...rest } = input;
  const record = recordFromAnswer(rest);
  if (!record) return false;
  if ((await history.all()).some((r) => r.id === record.id)) return false;
  await history.add(record);
  return true;
}

/** A typed resolution's outcome as history truth (option ids), or undefined. */
export function truthFromResolution(
  spec: AnswerSpec,
  outcome: string[] | string,
): { options: string[] } | undefined {
  if (spec.type !== "choice" && spec.type !== "multi") return undefined;
  const options = Array.isArray(outcome) ? outcome : [outcome];
  return options.length ? { options } : undefined;
}
