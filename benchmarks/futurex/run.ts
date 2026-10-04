// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Run a FutureX batch through Marina's GENERAL typed forecaster and turn the
 * answers into a submission (or, for resolved rows, a scored backtest). Every
 * row becomes an ordinary `forecastTyped` call (see map.ts); the competition
 * adds nothing to Marina's core.
 *
 * Freezing: each answer's evidence cutoff is the earlier of now and the row's
 * end time (a backtest moves it earlier still, see `horizonDays`). A row whose
 * end time has already passed is answered with the cutoff AT its end time and
 * flagged `late`.
 *
 * A row that produced no usable answer still gets one: a missing prediction
 * scores zero, so the fallback (the first substantive option for a choice, the
 * runs' best partial value otherwise) is recorded with `fallback: true`.
 */

import type { AnswerSpec } from "../../src/forecast/answer-types";
import type { TypedForecastAnswer, TypedForecastDeps } from "../../src/forecast/typed";
import { forecastTyped } from "../../src/forecast/typed";
import type { FuturexRow } from "./dataset";
import { requestFor } from "./map";

export interface Variant {
  /** Short name (`cheap`, `frontier`, …). */
  label: string;
  /** The model segment of the submission file name. */
  model: string;
  analysts: string[];
  planner?: string;
  critic?: string;
  /** Checks each run's draft (the verification formation inside one forecast). */
  verifier?: string;
  verify?: boolean;
  runs?: number;
  researchRounds?: number;
  critique?: boolean;
  /** Wall-clock budget per row (ms): the forecast answers from what finished (labelled). */
  budgetMs?: number;
  /** How the runs become one answer (`agreement` default, or `confidence`). */
  selection?: "agreement" | "confidence";
}

/**
 * Built-in variants on current models; override with a JSON file of `Variant`s.
 * Model ids are pinned (no floating aliases) so a run is reproducible and a
 * clean backtest can bound what each model could have known.
 */
export const BUILTIN_VARIANTS: Record<string, Variant> = {
  cheap: {
    label: "cheap",
    model: "deepseek-v4-pro",
    analysts: ["openrouter/deepseek/deepseek-v4-pro-0813"],
    planner: "openrouter/deepseek/deepseek-v4-pro-0813",
    critic: "openrouter/deepseek/deepseek-v4-pro-0813",
    runs: 3,
    researchRounds: 2,
  },
  /**
   * The verification formation inside each forecast: cheap runs, every draft
   * checked by a different-vendor verifier before it counts, then the critic.
   */
  verify: {
    label: "verify",
    model: "deepseek-v4-pro-verified",
    analysts: ["openrouter/deepseek/deepseek-v4-pro-0813"],
    planner: "openrouter/deepseek/deepseek-v4-pro-0813",
    verifier: "openrouter/anthropic/claude-opus-5",
    critic: "openrouter/anthropic/claude-opus-5",
    verify: true,
    runs: 3,
    researchRounds: 2,
  },
  /** A frontier mix released before the latest resolved rows: backtestable cleanly. */
  "frontier-2607": {
    label: "frontier-2607",
    model: "claude-opus-5",
    analysts: [
      "openrouter/anthropic/claude-opus-5",
      "openrouter/deepseek/deepseek-v4-pro-0813",
      "openrouter/moonshotai/kimi-k3",
    ],
    planner: "openrouter/deepseek/deepseek-v4-pro-0813",
    critic: "openrouter/anthropic/claude-opus-5",
    runs: 3,
    researchRounds: 2,
  },
  frontier: {
    label: "frontier",
    model: "claude-opus-5.5",
    analysts: [
      "openrouter/anthropic/claude-opus-5.5",
      "openrouter/openai/gpt-6.1-sol",
      "openrouter/google/gemini-3.8-flash",
    ],
    planner: "openrouter/openai/gpt-6.1-sol",
    critic: "openrouter/anthropic/claude-opus-5.5",
    runs: 3,
    researchRounds: 3,
  },
  crew: {
    label: "crew",
    model: "marina-crew",
    analysts: ["marina:answerer"],
    planner: "openrouter/openai/gpt-6.1-sol",
    runs: 1,
    researchRounds: 2,
    critique: false,
  },
};

export interface RowResult {
  id: string;
  level: number;
  spec: AnswerSpec["type"];
  prediction: string;
  fallback: boolean;
  late: boolean;
  endTime?: string;
  cutoff: string;
  confidence?: number;
  costUsd: number;
  latencyMs: number;
  caveat?: string;
  /** The research lines the forecast actually kept (for a leak audit), when captured. */
  evidence?: string;
  answer: TypedForecastAnswer;
}

export interface BatchRun {
  variant: string;
  results: RowResult[];
  costUsd: number;
  startedAt: string;
  finishedAt: string;
}

export interface RunOptions {
  /** Answer evidence frozen this many days before each row's end time (backtests). */
  horizonDays?: number;
  concurrency?: number;
  now?: () => Date;
  /** Called after each row (progress). */
  onRow?: (r: RowResult, done: number, total: number) => void;
  /**
   * Awaited after each row, before its worker takes the next one — e.g. score a
   * resolved row and write its lesson, so later rows can recall it.
   */
  afterRow?: (row: FuturexRow, r: RowResult) => Promise<void>;
  /**
   * Checked before each row is started: a reason stops the batch cleanly (rows in
   * flight finish, no new row starts) and `runBatch` rejects with it — e.g. a
   * spend budget about to run out, which would otherwise turn rows into fallbacks.
   */
  shouldStop?: () => string | undefined;
}

/** Deps for one row: fresh per row so cost (and, when captured, evidence) is attributable to it. */
export type DepsFactory = () => {
  deps: TypedForecastDeps;
  costUsd: () => number;
  evidence?: () => string;
};

export async function runBatch(
  rows: FuturexRow[],
  variant: Variant,
  makeDeps: DepsFactory,
  opts: RunOptions = {},
): Promise<BatchRun> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const results: RowResult[] = new Array(rows.length);
  let next = 0;
  let done = 0;
  let stopped: string | undefined;
  const worker = async () => {
    while (next < rows.length && !stopped) {
      stopped = opts.shouldStop?.();
      if (stopped) break;
      const i = next++;
      const row = rows[i]!;
      results[i] = await runRow(row, makeDeps, now(), opts.horizonDays);
      if (opts.afterRow) await opts.afterRow(row, results[i]!);
      done++;
      opts.onRow?.(results[i]!, done, rows.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, rows.length)) }, worker),
  );
  if (stopped) throw new Error(`batch stopped after ${done}/${rows.length} rows: ${stopped}`);
  return {
    variant: variant.label,
    results,
    costUsd: Math.round(results.reduce((s, r) => s + r.costUsd, 0) * 10_000) / 10_000,
    startedAt,
    finishedAt: now().toISOString(),
  };
}

async function runRow(
  row: FuturexRow,
  makeDeps: DepsFactory,
  now: Date,
  horizonDays: number | undefined,
): Promise<RowResult> {
  const base = requestFor(row);
  const end = base.endTime ? Date.parse(base.endTime) : Number.NaN;
  let asOf: string | undefined;
  if (Number.isFinite(end) && horizonDays !== undefined) {
    asOf = new Date(Math.min(end - horizonDays * 86_400_000, now.getTime())).toISOString();
  }
  const late = Number.isFinite(end) && end <= now.getTime() && horizonDays === undefined;
  const req = { ...base, ...(asOf ? { asOf } : {}) };
  const made = makeDeps();
  const answer = await forecastTyped(req, { ...made.deps, now: () => now });
  answer.costUsd = made.costUsd();
  const fb = answer.formatted === undefined ? fallbackPrediction(req.answer, answer) : undefined;
  return {
    id: row.id,
    level: row.level,
    spec: req.answer.type,
    prediction: answer.formatted ?? fb ?? "",
    fallback: answer.formatted === undefined,
    late,
    ...(req.endTime ? { endTime: req.endTime } : {}),
    cutoff: answer.cutoff.at,
    ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
    costUsd: answer.costUsd,
    latencyMs: answer.latencyMs,
    ...(answer.caveat ? { caveat: answer.caveat } : {}),
    ...(made.evidence ? { evidence: made.evidence() } : {}),
    answer,
  };
}

/** Something to file when no run produced a usable answer (missing scores zero anyway). */
export function fallbackPrediction(
  spec: AnswerSpec,
  answer: TypedForecastAnswer,
): string | undefined {
  const partial = answer.runs.find((r) => r.formatted !== undefined)?.formatted;
  if (partial) return partial;
  if (spec.type === "choice" || spec.type === "multi") {
    const substantive = spec.options.find((o) => !/NO_OFFICIAL/i.test(o.label ?? o.id));
    return (substantive ?? spec.options[0])?.id;
  }
  return undefined;
}
