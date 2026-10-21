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
 *
 * `--file` (opt-in; with `--variant <name>` or `--variants <file.json>`, the
 * configuration the saved answers ran with, and `--db <path>`, default
 * DB_PATH) files the comparison through the one promotion path instead of
 * stopping at this script's own verdict: one ledger run per answers file per
 * mode (target = the variant with `selection` set; one replicate group per
 * mode so the files pool), then `fileSlotPromotion` on `--slot` (default
 * `forecast-config:futurex` with `--file`, the slot live FutureX reads). An
 * empty slot is seeded with the INCUMBENT first, so a challenger never takes
 * an empty slot uncontested; the challenger then contests it, and the verdict
 * printed is `fileSlotPromotion`'s (replicate minimum, holdout interval,
 * fishing margin, append-only history).
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  type FiledPromotion,
  fileSlotPromotion,
  itemSplit,
} from "../../src/engine/benchmark-promotion";
import { boardSlotKey } from "../../src/engine/default-resolution";
import { promotionMargin } from "../../src/engine/fishing-margin";
import { SELECTION_MODES, type SelectionMode } from "../../src/forecast/answer-types";
import { FORECAST_CONFIG_SLOT } from "../../src/forecast/defaults";
import { reselect, type TypedForecastAnswer } from "../../src/forecast/typed";
import { MarinaDB } from "../../src/persistence/database";
import { mulberry32, percentileCeil, percentileFloor } from "../../src/stats";
import type { FuturexRow } from "./dataset";
import { PAST_BENCHMARK, recordScoredRun } from "./ledger";
import { BUILTIN_VARIANTS, type RowResult, type Variant } from "./run";
import { LEVEL_WEIGHTS, scoreBatch, scoreItem } from "./score";

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
  const low = percentileFloor(stats, 0.025);
  const high = percentileCeil(stats, 0.975);
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

/** The slot live FutureX reads its earned configuration from. */
export const FUTUREX_CONFIG_SLOT = boardSlotKey(FORECAST_CONFIG_SLOT, "futurex");

export interface FiledRescore {
  slot: string;
  /** Ledger runs recorded per mode (one per answers file). */
  runs: Record<"incumbent" | "challenger", string[]>;
  /** The incumbent's seeding of an empty slot (absent when the slot had one). */
  seeded?: FiledPromotion;
  /** The challenger's filing: `fileSlotPromotion`'s verdict. */
  filed: FiledPromotion;
}

/**
 * File the comparison through `fileSlotPromotion`: one ledger run per answers
 * file per mode (rows every file answered, scored with the published metric),
 * the incumbent seeded into an empty slot first, then the challenger contested.
 */
export function fileRescore(
  db: MarinaDB,
  input: {
    runs: readonly SavedRow[][];
    truth: Map<string, FuturexRow>;
    variant: Variant;
    challenger: SelectionMode;
    incumbent: SelectionMode;
    slot?: string;
    minReplicates?: number;
    now?: number;
  },
): FiledRescore {
  const slot = input.slot ?? FUTUREX_CONFIG_SLOT;
  const now = input.now ?? Date.now();
  // Only rows every file answered: replicates must share one item slice.
  const ids = [...input.truth.keys()].filter((id) =>
    input.runs.every((run) => run.some((r) => r.id === id)),
  );
  const rows = ids.map((id) => input.truth.get(id)!);
  const record = (mode: SelectionMode): string[] =>
    input.runs.map((run, i) => {
      const byId = new Map(run.map((r) => [r.id, r]));
      const predictions = new Map(ids.map((id) => [id, predictionUnder(byId.get(id)!, mode)]));
      const at = new Date(now + i).toISOString();
      const results = ids.map(
        (id): RowResult => ({
          id,
          level: input.truth.get(id)!.level,
          spec: byId.get(id)!.answer.answer.type,
          prediction: predictions.get(id)!,
          fallback: byId.get(id)!.fallback === true,
          late: false,
          cutoff: at,
          costUsd: 0,
          latencyMs: 0,
          answer: byId.get(id)!.answer as TypedForecastAnswer,
        }),
      );
      const variant: Variant = {
        ...input.variant,
        label: `${input.variant.label}+${mode}`,
        selection: mode,
      };
      return recordScoredRun(db, {
        benchmark: PAST_BENCHMARK,
        batchSha: `rescore${String(i + 1).padStart(2, "0")}`,
        variant,
        run: { variant: variant.label, results, costUsd: 0, startedAt: at, finishedAt: at },
        score: scoreBatch(rows, predictions),
        replicateGroup: `rescore:${slot}:${input.variant.label}:${mode}`,
        extra: { rescore: true, answersFile: i + 1 },
        now: now + i,
        // Saved answers from an earlier run: this process did not produce them.
        marina: null,
      }).id;
    });
  const runs = { incumbent: record(input.incumbent), challenger: record(input.challenger) };
  const promote = (runId: string) =>
    fileSlotPromotion(db, {
      slot,
      runId,
      // The operator owns the database; the history records the operator key.
      actor: { key: "operator", keyOf: (id) => db.durableEntityKey(id) },
      ...(input.minReplicates !== undefined ? { minReplicates: input.minReplicates } : {}),
      now,
    });
  const seeded = db.getBenchmarkDefault(slot)?.incumbent_run_id
    ? undefined
    : promote(runs.incumbent[0]!);
  return { slot, runs, ...(seeded ? { seeded } : {}), filed: promote(runs.challenger[0]!) };
}

/** One line for a filing verdict. */
export function describeFiled(f: FiledPromotion): string {
  if (f.kind === "error") return `not filed: ${f.message}`;
  if (f.kind === "seeded")
    return `seeded ${f.slot} with ${f.challenger.id} (${f.replicates} replicates)`;
  const e = f.evaluation;
  return f.kind === "promoted"
    ? `PROMOTED ${f.challenger.id} over ${f.incumbent.id} on ${f.slot}: holdout ${pts(e.stats.delta)} [${pts(e.stats.low)}, ${pts(e.stats.high)}], margin ${pts(e.margin)}`
    : `refused on ${f.slot} (incumbent ${f.incumbent.id} stands): ${e.reasons.join("; ")}`;
}

/** A variant by name: a built-in or one from a variants file. */
function variantNamed(name: string, file?: string): Variant | undefined {
  const fromFile: Variant[] = file ? JSON.parse(readFileSync(file, "utf8")) : [];
  return fromFile.find((v) => v.label === name) ?? BUILTIN_VARIANTS[name];
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
      slot: { type: "string" },
      challenger: { type: "string", default: "confidence" },
      incumbent: { type: "string", default: "agreement" },
      file: { type: "boolean" },
      db: { type: "string" },
      variant: { type: "string" },
      variants: { type: "string" },
      "min-replicates": { type: "string" },
    },
  });
  // Filing reads the split `fileSlotPromotion` reads: the slot it files on.
  values.slot ??= values.file ? FUTUREX_CONFIG_SLOT : "forecast.selection";
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
    `holdout ${challenger} − ${incumbent}: ${pts(check.delta)} [${pts(check.low)}, ${pts(check.high)}] · margin ${pts(check.margin)} (tried ${values.tried}) → ${check.promotable ? "PROMOTABLE" : `stays opt-in: ${check.reasons.join("; ")}`}${values.file ? " (advisory; the filing below decides)" : ""}`,
  );
  if (!values.file) return 0;
  const variant = values.variant ? variantNamed(values.variant, values.variants) : undefined;
  if (!variant) {
    console.error("--file needs --variant <name> (a built-in or one in --variants <file.json>)");
    return 2;
  }
  const minReplicates = values["min-replicates"] ? Number(values["min-replicates"]) : undefined;
  const db = new MarinaDB(values.db ?? (process.env.DB_PATH || "marina.db"));
  try {
    const filed = fileRescore(db, {
      runs,
      truth,
      variant,
      challenger,
      incumbent,
      slot: values.slot,
      ...(minReplicates !== undefined && Number.isInteger(minReplicates) ? { minReplicates } : {}),
    });
    console.log(
      `ledger runs: ${incumbent} ${filed.runs.incumbent.join(",")} · ${challenger} ${filed.runs.challenger.join(",")}`,
    );
    if (filed.seeded) console.log(`incumbent: ${describeFiled(filed.seeded)}`);
    console.log(`challenger: ${describeFiled(filed.filed)}`);
  } finally {
    db.close();
  }
  return 0;
}

if (import.meta.main) process.exit(main());
