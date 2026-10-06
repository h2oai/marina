// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One ForecastBench round: forecast every question with resume (each answer
 * is appended to a JSONL journal as it lands, so a rerun forecasts only what
 * is missing or failed), assemble the set with fallbacks counted, and — once
 * the round's resolution set is out — score each resolved question and write
 * an outcome to the learning loop.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dailyCapRefusal } from "../../src/engine/spend-ledger";
import type { Outcome } from "../../src/learning/outcomes";
import type { MarinaStores } from "../../src/persistence/interfaces";
import type { Forecaster } from "../forecasting/configs";
import { mapLimit, reasoningText } from "../forecasting/shared";
import { type FbQuestion, type FbQuestionSet, type FbResolution, isMarket } from "./dataset";
import { type FbForecast, fallbackForecasts, forecastsFrom, requestFor } from "./map";
import { type DatasetPrior, priorLine } from "./priors";

export interface JournalLine {
  key: string;
  ok: boolean;
  forecasts: FbForecast[];
  costUsd: number;
  latencyMs?: number;
  error?: string;
  at: string;
}

export const questionKey = (q: Pick<FbQuestion, "source" | "id">) => `${q.source}|${q.id}`;

/** The latest line per question (a retry supersedes a failure). */
export function readJournal(path: string): Map<string, JournalLine> {
  const out = new Map<string, JournalLine>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as JournalLine;
      const prev = out.get(j.key);
      if (!prev || j.ok || !prev.ok) out.set(j.key, j);
    } catch {
      // allow-empty-catch: a torn last line (interrupted write) is redone on resume
    }
  }
  return out;
}

export interface RoundOptions {
  set: FbQuestionSet;
  forecast: Forecaster;
  journal: string;
  concurrency?: number;
  /** Only these questions (a sample, a dry run). */
  questions?: FbQuestion[];
  /** Stop starting new questions once this run has spent this much. */
  budgetUsd?: number;
  /** Dataset questions' statistical priors (`./priors.ts`), by question key. */
  priors?: ReadonlyMap<string, DatasetPrior>;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface RoundRun {
  attempted: number;
  ok: number;
  failed: number;
  skippedDone: number;
  costUsd: number;
  stoppedBy?: string;
}

export async function runRound(opts: RoundOptions): Promise<RoundRun> {
  const log = opts.log ?? (() => {});
  const due = opts.set.forecast_due_date;
  const done = readJournal(opts.journal);
  // An interrupted write can leave a torn last line; new lines start fresh.
  if (existsSync(opts.journal) && !readFileSync(opts.journal, "utf8").endsWith("\n")) {
    appendFileSync(opts.journal, "\n");
  }
  const all = opts.questions ?? opts.set.questions;
  const todo = all.filter((q) => !done.get(questionKey(q))?.ok);
  const run: RoundRun = {
    attempted: 0,
    ok: 0,
    failed: 0,
    skippedDone: all.length - todo.length,
    costUsd: 0,
  };
  let finished = 0;
  await mapLimit(todo, opts.concurrency ?? 6, async (q) => {
    if (run.stoppedBy) return;
    const capped = dailyCapRefusal(opts.env ?? process.env);
    if (capped) run.stoppedBy = capped;
    else if (opts.budgetUsd !== undefined && run.costUsd >= opts.budgetUsd) {
      run.stoppedBy = `budget $${opts.budgetUsd} reached`;
    }
    if (run.stoppedBy) return;
    run.attempted++;
    const started = Date.now();
    let line: JournalLine;
    try {
      const stat = opts.priors?.get(questionKey(q));
      const answer = await opts.forecast(
        requestFor(q, due, stat ? { prior: stat.prior, line: priorLine(stat) } : undefined),
      );
      const forecasts = forecastsFrom(q, answer, reasoningText(answer, { maxChars: 600 }) || null);
      line = {
        key: questionKey(q),
        ok: !!forecasts,
        forecasts: forecasts ?? [],
        costUsd: answer.costUsd,
        latencyMs: Date.now() - started,
        ...(forecasts ? {} : { error: answer.caveat ?? "no probabilities in the answer" }),
        at: new Date().toISOString(),
      };
    } catch (err) {
      line = {
        key: questionKey(q),
        ok: false,
        forecasts: [],
        costUsd: 0,
        error: (err as Error).message.slice(0, 300),
        at: new Date().toISOString(),
      };
    }
    appendFileSync(opts.journal, `${JSON.stringify(line)}\n`);
    run.costUsd += line.costUsd;
    if (line.ok) run.ok++;
    else run.failed++;
    finished++;
    log(
      `  [${finished}/${todo.length}] ${q.source}/${q.id.slice(0, 12)} ${line.ok ? line.forecasts.map((f) => f.forecast).join(" ") : `FAILED ${line.error}`} · $${line.costUsd.toFixed(3)}`,
    );
  });
  return run;
}

/** The round's forecasts: journaled answers, fallbacks for the rest (counted). */
export function assemble(
  set: FbQuestionSet,
  journal: string,
  priors?: ReadonlyMap<string, { byDate: Record<string, number> }>,
): { forecasts: FbForecast[]; fallback: number; answered: number; costUsd: number } {
  const done = readJournal(journal);
  const forecasts: FbForecast[] = [];
  let fallback = 0;
  let answered = 0;
  let costUsd = 0;
  for (const j of done.values()) costUsd += j.costUsd;
  for (const q of set.questions) {
    const j = done.get(questionKey(q));
    if (j?.ok) {
      forecasts.push(...j.forecasts);
      answered++;
    } else {
      forecasts.push(...fallbackForecasts(q, priors?.get(questionKey(q))?.byDate));
      fallback++;
    }
  }
  return { forecasts, fallback, answered, costUsd: Math.round(costUsd * 1e4) / 1e4 };
}

/** Mean cost per answered question so far in this journal, for an estimate. */
export function meanCost(journal: string): number | undefined {
  const lines = [...readJournal(journal).values()].filter((j) => j.ok);
  return lines.length ? lines.reduce((s, j) => s + j.costUsd, 0) / lines.length : undefined;
}

// ─── Outcomes → the learning loop ───────────────────────────────────────────

type OutcomeLedger = Pick<MarinaStores, "recordExternalSubmission" | "listExternalSubmissions">;
export const OUTCOME_BENCHMARK = "forecastbench-outcome";

export interface ResolveRoundOptions {
  set: FbQuestionSet;
  journal: string;
  resolutions: FbResolution[];
  db: OutcomeLedger;
  /** Hands each scored outcome to the learning loop (`noteOutcome`). */
  learn?: (o: Outcome) => void;
  /** The configuration that filed this set (label), carried into the outcomes. */
  config?: string;
  /** At most this many outcomes to learn from per call (worst-scored first). */
  maxLessons?: number;
  now?: () => Date;
}

/**
 * Score every resolved question this round answered (1 − Brier on its
 * earliest resolved forecast), hand the outcomes to the learning loop worst
 * first, and record each question's outcome once (`forecastbench-outcome`).
 */
export async function resolveRound(
  opts: ResolveRoundOptions,
): Promise<{ resolved: number; learned: number; meanBrier?: number }> {
  const now = opts.now ?? (() => new Date());
  const due = opts.set.forecast_due_date;
  const keyFor = (q: FbQuestion) =>
    createHash("sha256").update(`forecastbench-outcome:${due}:${q.source}:${q.id}`).digest("hex");
  const seen = new Set(
    opts.db.listExternalSubmissions(OUTCOME_BENCHMARK, 100_000).map((r) => r.file_sha256),
  );
  const journal = readJournal(opts.journal);
  const resolvedBy = new Map<string, FbResolution[]>();
  for (const r of opts.resolutions) {
    if (!r.resolved) continue;
    const k = `${r.source}|${r.id}`;
    resolvedBy.set(k, [...(resolvedBy.get(k) ?? []), r]);
  }
  const scored: Array<{ q: FbQuestion; f: FbForecast; r: FbResolution; brier: number }> = [];
  for (const q of opts.set.questions) {
    const j = journal.get(questionKey(q));
    const rs = resolvedBy.get(questionKey(q));
    if (!j?.ok || !rs || seen.has(keyFor(q))) continue;
    const pairs = j.forecasts
      .map((f) => ({
        f,
        r: isMarket(q) ? rs[0] : rs.find((x) => x.resolution_date === f.resolution_date),
      }))
      .filter((p): p is { f: FbForecast; r: FbResolution } => !!p.r)
      .sort((a, b) => a.r.resolution_date.localeCompare(b.r.resolution_date));
    const first = pairs[0];
    if (!first) continue;
    scored.push({ q, ...first, brier: (first.f.forecast - first.r.resolved_to) ** 2 });
  }
  scored.sort((a, b) => b.brier - a.brier);
  let learned = 0;
  for (const [i, s] of scored.entries()) {
    const teach = opts.learn && i < (opts.maxLessons ?? 60);
    if (teach) {
      const market = isMarket(s.q);
      opts.learn!({
        domain: "forecast",
        source: `forecastbench:${market ? "market" : "dataset"}`,
        succeeded: s.brier < 0.25,
        score: 1 - s.brier,
        resolvedAt: new Date(`${s.r.resolution_date}T23:59:59Z`).toISOString(),
        attempted: market
          ? `probability that a ${s.q.source} prediction market resolves Yes${opts.config ? ` (${opts.config})` : ""}`
          : `probability that a ${s.q.source} series is higher on a date than at the forecast${opts.config ? ` (${opts.config})` : ""}`,
        detail: `brier ${s.brier.toFixed(3)} (said ${Math.round(s.f.forecast * 100)}%, resolved ${s.r.resolved_to >= 0.5 ? "yes" : "no"}${s.f.resolution_date ? `, horizon ${s.f.resolution_date}` : ""})`,
        refs: [`forecastbench:${due}/${s.q.source}/${s.q.id}`],
        privateContext: [s.q.question, s.q.background ?? ""].join("\n"),
      });
      learned++;
    }
    opts.db.recordExternalSubmission({
      benchmark: OUTCOME_BENCHMARK,
      batch_ref: due,
      variant: opts.config ?? "",
      identity_json: "{}",
      file_name: `${s.q.source}/${s.q.id}`,
      file_sha256: keyFor(s.q),
      items: 1,
      answered: 1,
      cost_usd: null,
      meta_json: JSON.stringify({
        brier: s.brier,
        resolution_date: s.r.resolution_date,
        learned: !!teach,
      }),
      created_at: now().getTime(),
    });
  }
  const meanBrier = scored.length
    ? scored.reduce((a, s) => a + s.brier, 0) / scored.length
    : undefined;
  return { resolved: scored.length, learned, ...(meanBrier !== undefined ? { meanBrier } : {}) };
}
