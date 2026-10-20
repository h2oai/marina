// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * LongMemEval-V2 run folders → Marina's benchmark ledger and a summary. Reads only
 * the official harness outputs (`per_question.jsonl`, `run_args.json`); copies ids,
 * verdicts, categories and latencies — never question, context, answer or response
 * text.
 *
 * One operating point is a `web` and an `enterprise` run of the same method and tier;
 * the board combines them weighted by question count (`overall_full_set`), and its
 * latency is the mean memory query time over all questions.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessResultFile } from "../../src/engine/benchmark-ledger";
import { mulberry32, percentileCeil, percentileFloor, resampleMeans } from "../../src/stats";

export interface LmeRow {
  question_id: string;
  category: string;
  is_abstention_problem: boolean;
  is_unknown: boolean;
  score_bool: boolean;
  memory_query_duration_seconds: number;
  memory_context_token_count?: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface LmeRun {
  dir: string;
  domain: string;
  model: string;
  evaluator: string;
  rows: LmeRow[];
}

/** Read one harness output folder, keeping only the fields the ledger may hold. */
export function readRun(dir: string): LmeRun {
  const args = JSON.parse(readFileSync(join(dir, "run_args.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const rows = readFileSync(join(dir, "per_question.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const r = JSON.parse(line) as Record<string, unknown>;
      const usage = r.usage as LmeRow["usage"] | undefined;
      return {
        question_id: String(r.question_id),
        category: String(r.category ?? ""),
        is_abstention_problem: r.is_abstention_problem === true,
        is_unknown: r.is_unknown === true,
        score_bool: r.score_bool === true,
        memory_query_duration_seconds: Number(r.memory_query_duration_seconds ?? 0),
        ...(typeof r.memory_context_token_count === "number"
          ? { memory_context_token_count: r.memory_context_token_count }
          : {}),
        ...(usage
          ? {
              usage: {
                prompt_tokens: Number(usage.prompt_tokens ?? 0),
                completion_tokens: Number(usage.completion_tokens ?? 0),
              },
            }
          : {}),
      } satisfies LmeRow;
    });
  return {
    dir,
    domain: String(args.domain ?? "unknown"),
    model: String(args.model ?? "unknown"),
    evaluator: String(args.evaluator_model ?? "unknown"),
    rows,
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export interface LmeSummary {
  questions: number;
  /** The board's accuracy (×100): correct over every question, both domains pooled. */
  accuracy: number;
  /** 95 % question-bootstrap interval of `accuracy` (10k resamples, seeded). */
  interval: [number, number];
  /** Mean memory query seconds (the board's latency axis). */
  latencySeconds: number;
  byDomain: Record<string, { questions: number; accuracy: number }>;
  byCategory: Record<string, { questions: number; accuracy: number }>;
  /** Non-abstention questions answered with something other than UNKNOWN and wrong. */
  answeredWrongRate: number;
  /** Abstention (false-premise) questions answered as if the premise held, and wrong. */
  abstentionAnsweredWrongRate: number;
  unknownRate: number;
  meanContextTokens: number;
}

/** 95 % bootstrap interval of the accuracy (percent), seeded mulberry32 (`src/stats`). */
export function bootstrapInterval(
  outcomes: boolean[],
  resamples = 10_000,
  seed = 1,
): [number, number] {
  if (outcomes.length === 0) return [NaN, NaN];
  const stats = resampleMeans(
    outcomes.map((o) => (o ? 100 : 0)),
    resamples,
    mulberry32(seed),
  );
  return [percentileFloor(stats, 0.025), percentileCeil(stats, 0.975)];
}

export function summarize(runs: readonly LmeRun[]): LmeSummary {
  const rows = runs.flatMap((r) => r.rows.map((row) => ({ ...row, domain: r.domain })));
  const pct = (xs: { score_bool: boolean }[]) =>
    xs.length ? (100 * xs.filter((x) => x.score_bool).length) / xs.length : NaN;
  const group = (key: (r: (typeof rows)[number]) => string) => {
    const out: Record<string, { questions: number; accuracy: number }> = {};
    for (const k of [...new Set(rows.map(key))].sort()) {
      const xs = rows.filter((r) => key(r) === k);
      out[k] = { questions: xs.length, accuracy: pct(xs) };
    }
    return out;
  };
  const nonAbs = rows.filter((r) => !r.is_abstention_problem);
  const abs = rows.filter((r) => r.is_abstention_problem);
  const answeredWrong = (xs: typeof rows) =>
    xs.length ? xs.filter((r) => !r.score_bool && !r.is_unknown).length / xs.length : NaN;
  return {
    questions: rows.length,
    accuracy: pct(rows),
    interval: bootstrapInterval(rows.map((r) => r.score_bool)),
    latencySeconds: mean(rows.map((r) => r.memory_query_duration_seconds)),
    byDomain: group((r) => r.domain),
    byCategory: group((r) => r.category),
    answeredWrongRate: answeredWrong(nonAbs),
    abstentionAnsweredWrongRate: answeredWrong(abs),
    unknownRate: rows.length ? rows.filter((r) => r.is_unknown).length / rows.length : NaN,
    meanContextTokens: mean(rows.map((r) => r.memory_context_token_count ?? 0)),
  };
}

/** One ledger run for one operating point (both domains); item id = question id. */
export function toHarness(
  runs: readonly LmeRun[],
  opts: { benchmark: string; target: string },
): HarnessResultFile {
  const domains = runs.map((r) => r.domain).sort();
  if (new Set(domains).size !== domains.length) throw new Error("one run per domain");
  const models = new Set(runs.map((r) => r.model));
  const evaluators = new Set(runs.map((r) => r.evaluator));
  if (models.size !== 1 || evaluators.size !== 1)
    throw new Error("runs of one operating point must share the reader and the evaluator");
  const items = runs.flatMap((r) =>
    r.rows.map((row) => ({
      id: `${r.domain}:${row.question_id}`,
      correct: row.score_bool,
      score: row.score_bool ? 1 : 0,
      latencyMs: Math.round(row.memory_query_duration_seconds * 1000),
    })),
  );
  const s = summarize(runs);
  return {
    config: {
      dataset: opts.benchmark,
      model: opts.target,
      judge: { model: `${[...evaluators][0]} (LongMemEval-V2 official evaluator)` },
      reader: [...models][0],
      domains,
      memoryQueryAvgSeconds: s.latencySeconds,
    },
    timestamp: Date.now(),
    duration_ms: Math.round(items.reduce((t, i) => t + (i.latencyMs ?? 0), 0)),
    items,
  };
}
