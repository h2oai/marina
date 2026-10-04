#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Offline re-score of saved FutureX forecasts under each run-selection mode
 * (`src/forecast/answer-types.ts` `SelectionMode`) — no model calls. Each
 * saved row is re-selected from its recorded runs and critique (`reselect`)
 * and scored with the published metric (`score.ts`).
 *
 *   bun benchmarks/futurex/rescore-selection.ts --dataset <past-batch.json> \
 *     --runs <answers.json>[,<answers.json>…] [--holdout 0.5] [--tried 0] \
 *     [--slot forecast.selection] [--challenger confidence] [--incumbent agreement]
 *
 * Rows are split by a stable hash of slot + row id (`itemSplit`, the same
 * split the benchmark ledger's promotion uses). The challenger is promotable
 * only when, on the HOLDOUT split, its level-weighted score beats the
 * incumbent's by more than `promotionMargin(tried)` and the paired bootstrap
 * interval (rows resampled within level, runs averaged) is above zero. Pass
 * `--tried` as the number of selection candidates examined before this one,
 * including ones looked at on these rows, so fishing raises the bar.
 *
 * Prints ids-free aggregates only (no question or answer text).
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { itemSplit } from "../../src/engine/benchmark-promotion";
import { promotionMargin } from "../../src/engine/fishing-margin";
import { SELECTION_MODES, type SelectionMode } from "../../src/forecast/answer-types";
import { reselect, type TypedForecastAnswer } from "../../src/forecast/typed";
import { mulberry32 } from "../stats";
import type { FuturexRow } from "./dataset";
import { LEVEL_WEIGHTS, scoreItem } from "./score";

export interface SavedRow {
  id: string;
  level: number;
  prediction: string;
  fallback?: boolean;
  answer: Pick<TypedForecastAnswer, "answer" | "runs" | "critique">;
}

/** The prediction a saved row gives under `mode` (a fallback row keeps its fallback). */
export function predictionUnder(row: SavedRow, mode: SelectionMode | "saved"): string {
  if (mode === "saved" || row.fallback) return row.prediction;
  return reselect(row.answer, mode) ?? row.prediction;
}

/** Level-weighted mean of per-row scores (FutureX's overall). */
export function levelWeighted(scores: ReadonlyArray<{ level: number; score: number }>): number {
  const by = new Map<number, number[]>();
  for (const s of scores) by.set(s.level, [...(by.get(s.level) ?? []), s.score]);
  let w = 0;
  let t = 0;
  for (const [level, xs] of by) {
    const lw = LEVEL_WEIGHTS[level] ?? 0;
    w += lw;
    t += lw * (xs.reduce((a, b) => a + b, 0) / xs.length);
  }
  return w ? t / w : 0;
}

export interface RescoreResult {
  split: "holdout" | "selection" | "all";
  rows: number;
  runs: number;
  /** Mean level-weighted score over runs, per mode. */
  score: Record<string, number>;
}

export interface PromotionCheck {
  delta: number;
  low: number;
  high: number;
  margin: number;
  promotable: boolean;
  reasons: string[];
}

/** Per-row score (averaged over runs) under one mode, restricted to `ids`. */
function rowMeans(
  runs: readonly SavedRow[][],
  truth: Map<string, FuturexRow>,
  ids: readonly string[],
  mode: SelectionMode | "saved",
): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of ids) {
    let sum = 0;
    let n = 0;
    for (const run of runs) {
      const row = run.find((r) => r.id === id);
      const t = truth.get(id);
      if (!row || !t) continue;
      sum += scoreItem(t, predictionUnder(row, mode)).score;
      n++;
    }
    if (n) out.set(id, sum / n);
  }
  return out;
}

/** Score every mode on one split. */
export function rescore(
  runs: readonly SavedRow[][],
  truth: Map<string, FuturexRow>,
  ids: readonly string[],
  split: RescoreResult["split"],
): RescoreResult {
  const score: Record<string, number> = {};
  for (const mode of ["saved", ...SELECTION_MODES] as const) {
    const means = rowMeans(runs, truth, ids, mode);
    score[mode] = round(
      levelWeighted([...means].map(([id, s]) => ({ level: truth.get(id)!.level, score: s }))),
    );
  }
  return { split, rows: ids.length, runs: runs.length, score };
}

/**
 * Challenger − incumbent on `ids` with a 95 % paired bootstrap interval (rows
 * resampled within level, level weights kept), against the promotion margin.
 */
export function promotionCheck(
  runs: readonly SavedRow[][],
  truth: Map<string, FuturexRow>,
  ids: readonly string[],
  challenger: SelectionMode,
  incumbent: SelectionMode,
  tried: number,
  draws = 4000,
  seed = 1,
): PromotionCheck {
  const a = rowMeans(runs, truth, ids, challenger);
  const b = rowMeans(runs, truth, ids, incumbent);
  const byLevel = new Map<number, string[]>();
  for (const id of ids) {
    if (!a.has(id) || !b.has(id)) continue;
    const l = truth.get(id)!.level;
    byLevel.set(l, [...(byLevel.get(l) ?? []), id]);
  }
  const diff = (sample: Map<number, string[]>) => {
    let w = 0;
    let t = 0;
    for (const [l, xs] of sample) {
      const lw = LEVEL_WEIGHTS[l] ?? 0;
      w += lw;
      t += (lw * xs.reduce((s, id) => s + a.get(id)! - b.get(id)!, 0)) / xs.length;
    }
    return w ? t / w : 0;
  };
  const delta = diff(byLevel);
  const rand = mulberry32(seed);
  const stats: number[] = [];
  for (let i = 0; i < draws; i++) {
    const sample = new Map<number, string[]>();
    for (const [l, xs] of byLevel) {
      sample.set(
        l,
        xs.map(() => xs[Math.floor(rand() * xs.length)]!),
      );
    }
    stats.push(diff(sample));
  }
  stats.sort((x, y) => x - y);
  const low = stats[Math.floor(0.025 * draws)] ?? 0;
  const high = stats[Math.ceil(0.975 * draws) - 1] ?? 0;
  const margin = promotionMargin(tried);
  const reasons: string[] = [];
  if (!(low > 0)) reasons.push(`the paired interval [${pts(low)}, ${pts(high)}] is not above 0`);
  if (!(delta > margin))
    reasons.push(`the gain ${pts(delta)} does not clear the margin ${pts(margin)}`);
  return {
    delta: round(delta),
    low: round(low),
    high: round(high),
    margin: round(margin),
    promotable: reasons.length === 0,
    reasons,
  };
}

const round = (x: number) => Math.round(x * 10_000) / 10_000;
const pts = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)} pts`;

function main(): number {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      dataset: { type: "string" },
      runs: { type: "string" },
      holdout: { type: "string", default: "0.5" },
      tried: { type: "string", default: "0" },
      slot: { type: "string", default: "forecast.selection" },
      challenger: { type: "string", default: "confidence" },
      incumbent: { type: "string", default: "agreement" },
    },
  });
  if (!values.dataset || !values.runs) {
    console.error("usage: rescore-selection.ts --dataset <past.json> --runs <answers.json>[,…]");
    return 2;
  }
  const challenger = values.challenger as SelectionMode;
  const incumbent = values.incumbent as SelectionMode;
  if (!SELECTION_MODES.includes(challenger) || !SELECTION_MODES.includes(incumbent)) {
    console.error(`modes: ${SELECTION_MODES.join(", ")}`);
    return 2;
  }
  const truth = new Map(
    (JSON.parse(readFileSync(values.dataset, "utf8")).rows as FuturexRow[]).map((r) => [r.id, r]),
  );
  const runs = values.runs
    .split(",")
    .map((p) => (JSON.parse(readFileSync(p.trim(), "utf8")) as { results: SavedRow[] }).results);
  const ids = [...new Set(runs.flatMap((r) => r.map((x) => x.id)))].filter((id) => truth.has(id));
  const fraction = Number(values.holdout);
  const holdout = ids.filter((id) => itemSplit(values.slot!, id, fraction) === "holdout");
  const selection = ids.filter((id) => itemSplit(values.slot!, id, fraction) === "selection");
  for (const r of [
    rescore(runs, truth, selection, "selection"),
    rescore(runs, truth, holdout, "holdout"),
    rescore(runs, truth, ids, "all"),
  ]) {
    console.log(
      `${r.split.padEnd(9)} rows=${r.rows} runs=${r.runs}  ${Object.entries(r.score)
        .map(([m, s]) => `${m}=${s.toFixed(4)}`)
        .join("  ")}`,
    );
  }
  const check = promotionCheck(runs, truth, holdout, challenger, incumbent, Number(values.tried));
  console.log(
    `holdout ${challenger} − ${incumbent}: ${pts(check.delta)} [${pts(check.low)}, ${pts(check.high)}] · margin ${pts(check.margin)} (tried ${values.tried}) → ${check.promotable ? "PROMOTABLE" : `stays opt-in: ${check.reasons.join("; ")}`}`,
  );
  return 0;
}

if (import.meta.main) process.exit(main());
