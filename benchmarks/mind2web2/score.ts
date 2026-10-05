// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reads the official judge's results and computes the leaderboard's metrics.
 *
 * The judge writes `eval_results/<agent>/<task>/<answer_base>/results/<ts>_<answer>.json`
 * with `final_score` (the rubric tree's root score, 0–1). The latest file per
 * answer counts. Metrics follow the paper: partial completion = mean root
 * score; success = share of tasks with a root score of 1; pass@k = share of
 * tasks with a perfect score in at least one of k runs. With several runs per
 * task, partial completion and success are means over runs (as the official
 * summary computes them: per-run averages, then the mean across runs).
 *
 * A run the spend guard stopped (`budget`) is not scored; a run that errored or
 * produced no answer scores 0 — it is the system's own failure.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mulberry32 } from "../stats";
import type { RunRecord } from "./run";

export interface AnswerScore {
  task: string;
  k: number;
  score: number;
  /** Where the score came from. */
  source: "judge" | "failed-run";
}

/** The latest judged score per (task, k) for one agent. */
export function readJudged(out: string, agent: string): AnswerScore[] {
  const root = join(out, "eval_results", agent);
  if (!existsSync(root)) return [];
  const scores: AnswerScore[] = [];
  for (const task of readdirSync(root)) {
    const taskDir = join(root, task);
    let answers: string[];
    try {
      answers = readdirSync(taskDir);
    } catch {
      continue;
    }
    for (const base of answers) {
      const m = /^answer_(\d+)$/.exec(base);
      const resDir = join(taskDir, base, "results");
      if (!m || !existsSync(resDir)) continue;
      const files = readdirSync(resDir)
        .filter((f) => f.endsWith(".json") && !f.includes("_debug"))
        .sort();
      const latest = files.at(-1);
      if (!latest) continue;
      const parsed = JSON.parse(readFileSync(join(resDir, latest), "utf8")) as {
        final_score?: unknown;
      };
      const score = Number(parsed.final_score);
      if (!Number.isFinite(score)) continue;
      scores.push({ task, k: Number(m[1]), score, source: "judge" });
    }
  }
  return scores;
}

/** Every run record of one agent. */
export function readRunRecords(out: string, agent: string): RunRecord[] {
  const root = join(out, "runs", agent);
  if (!existsSync(root)) return [];
  const recs: RunRecord[] = [];
  for (const task of readdirSync(root)) {
    for (const f of readdirSync(join(root, task))) {
      if (!f.endsWith(".json")) continue;
      recs.push(JSON.parse(readFileSync(join(root, task, f), "utf8")) as RunRecord);
    }
  }
  return recs;
}

/**
 * Judged scores plus 0 for runs that failed to produce an answer; budget-stopped
 * runs and answers still awaiting the judge are left out.
 */
export function scoredAnswers(
  out: string,
  agent: string,
  tasks?: ReadonlySet<string>,
): AnswerScore[] {
  const judged = readJudged(out, agent);
  const seen = new Set(judged.map((s) => `${s.task}#${s.k}`));
  const failed: AnswerScore[] = readRunRecords(out, agent)
    .filter((r) => (r.status === "error" || r.status === "empty") && !seen.has(`${r.task}#${r.k}`))
    .map((r) => ({ task: r.task, k: r.k, score: 0, source: "failed-run" as const }));
  return [...judged, ...failed].filter((s) => !tasks || tasks.has(s.task));
}

export interface Metrics {
  tasks: number;
  answers: number;
  partial: number;
  success: number;
  /** pass@k over the runs present (k = max runs of any task). */
  passAtK: number;
  k: number;
}

/** Leaderboard metrics over `answers` (per-task means, then the mean across tasks). */
export function metrics(answers: readonly AnswerScore[]): Metrics {
  const byTask = new Map<string, number[]>();
  for (const a of answers) byTask.set(a.task, [...(byTask.get(a.task) ?? []), a.score]);
  const tasks = [...byTask.values()];
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  return {
    tasks: tasks.length,
    answers: answers.length,
    partial: mean(tasks.map(mean)),
    success: mean(tasks.map((s) => mean(s.map((x) => (x >= 1 - 1e-9 ? 1 : 0))))),
    passAtK: mean(tasks.map((s) => (s.some((x) => x >= 1 - 1e-9) ? 1 : 0))),
    k: Math.max(0, ...tasks.map((s) => s.length)),
  };
}

/** Per-task mean root score. */
export function taskMeans(answers: readonly AnswerScore[]): Map<string, number> {
  const by = new Map<string, number[]>();
  for (const a of answers) by.set(a.task, [...(by.get(a.task) ?? []), a.score]);
  return new Map([...by].map(([t, s]) => [t, s.reduce((x, y) => x + y, 0) / s.length]));
}

/**
 * Paired comparison over tasks both arms answered: mean difference (B − A) of
 * per-task mean scores and a percentile bootstrap interval over tasks.
 */
export function pairedDifference(
  a: readonly AnswerScore[],
  b: readonly AnswerScore[],
  opts: { resamples?: number; seed?: number } = {},
): { tasks: number; diff: number; lo: number; hi: number } {
  const ma = taskMeans(a);
  const mb = taskMeans(b);
  const diffs = [...ma.keys()].filter((t) => mb.has(t)).map((t) => mb.get(t)! - ma.get(t)!);
  if (diffs.length === 0) return { tasks: 0, diff: 0, lo: 0, hi: 0 };
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const rand = mulberry32(opts.seed ?? 20261005);
  const boots: number[] = [];
  for (let i = 0; i < (opts.resamples ?? 10_000); i++) {
    const sample = diffs.map(() => diffs[Math.floor(rand() * diffs.length)]!);
    boots.push(mean(sample));
  }
  boots.sort((x, y) => x - y);
  return {
    tasks: diffs.length,
    diff: mean(diffs),
    lo: boots[Math.floor(0.025 * boots.length)]!,
    hi: boots[Math.min(boots.length - 1, Math.floor(0.975 * boots.length))]!,
  };
}
