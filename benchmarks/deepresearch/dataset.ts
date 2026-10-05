// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * DeepResearch Bench I and II tasks, read from the official repositories at
 * pinned commits (raw files; stored outside the tracked tree).
 *
 * Only what a research agent is given reaches the generator: the prompt text,
 * its language, and — for DRB II — the structured `blocked` source the prompt
 * itself names (so retrieval can honour it). Criteria, reference articles and
 * rubrics are never loaded here; the official evaluators read them from their
 * own checkouts (`./official.ts`).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceExclusion } from "../../src/arena/research/briefs";

export type Board = "drb1" | "drb2";

export const BOARDS: Record<
  Board,
  { name: string; repo: string; commit: string; tasksPath: string; ledger: string }
> = {
  drb1: {
    name: "DeepResearch Bench",
    repo: "Ayanami0730/deep_research_bench",
    commit: "f2735b5c3636759c22f9e936c0232de8bf545b67",
    tasksPath: "data/prompt_data/query.jsonl",
    ledger: "deepresearch-bench",
  },
  drb2: {
    name: "DeepResearch Bench II",
    repo: "imlrz/DeepResearch-Bench-II",
    commit: "b38f360603db9531b102aef8c166cedb8509b6f6",
    tasksPath: "tasks_and_rubrics.jsonl",
    ledger: "deepresearch-bench-ii",
  },
};

export interface BenchTask {
  board: Board;
  /** DRB I: the query id (`"51"`); DRB II: `idx-<n>` (its report file name). */
  id: string;
  prompt: string;
  language: "en" | "zh";
  topic?: string;
  /** Per-task data license (DRB II). */
  license?: string;
  exclude: SourceExclusion;
}

/**
 * Pages every run bars: the benchmarks' own repositories, datasets,
 * leaderboards and papers, which publish reference articles, rubrics and other
 * systems' reports for these exact prompts.
 */
export const BENCHMARK_SELF_EXCLUSIONS: readonly string[] = [
  "github.com/Ayanami0730",
  "github.com/imlrz",
  "raw.githubusercontent.com/Ayanami0730",
  "raw.githubusercontent.com/imlrz",
  "huggingface.co/datasets/muset-ai",
  "huggingface.co/spaces/muset-ai",
  "huggingface.co/spaces/Ayanami0730",
  "deepresearch-bench.github.io",
  "agentresearchlab.com",
  "agentresearchlab.org",
  "agi-eval.cn",
  "arxiv.org/abs/2506.11763",
  "arxiv.org/pdf/2506.11763",
  "arxiv.org/html/2506.11763",
  "arxiv.org/abs/2601.08536",
  "arxiv.org/pdf/2601.08536",
  "arxiv.org/html/2601.08536",
];

export function rawUrl(board: Board): string {
  const b = BOARDS[board];
  return `https://raw.githubusercontent.com/${b.repo}/${b.commit}/${b.tasksPath}`;
}

/** The task file for `board`, cached in `dataDir` (fetched once per pinned commit). */
export async function taskFile(
  board: Board,
  dataDir: string,
  fetcher: (url: string) => Promise<Response> = fetch,
): Promise<string> {
  const b = BOARDS[board];
  const path = join(dataDir, `${board}-${b.commit.slice(0, 12)}.jsonl`);
  if (existsSync(path)) return readFileSync(path, "utf8");
  const res = await fetcher(rawUrl(board));
  if (!res.ok) throw new Error(`${b.name}: HTTP ${res.status} for ${rawUrl(board)}`);
  const text = await res.text();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, text);
  return text;
}

function jsonl(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function lang(v: unknown): "en" | "zh" {
  return v === "zh" ? "zh" : "en";
}

/** DRB I queries → tasks. */
export function parseDrb1(text: string): BenchTask[] {
  return jsonl(text).map((r) => ({
    board: "drb1",
    id: String(r.id),
    prompt: String(r.prompt ?? ""),
    language: lang(r.language),
    ...(typeof r.topic === "string" ? { topic: r.topic } : {}),
    exclude: { urls: [...BENCHMARK_SELF_EXCLUSIONS] },
  }));
}

/**
 * DRB II rows → tasks: the `prompt` (task text plus the barred-source rule, as
 * every entrant receives it) and the barred source from `content.blocked`.
 * The rubric is dropped here.
 */
export function parseDrb2(text: string): BenchTask[] {
  return jsonl(text).map((r) => {
    const content = (r.content ?? {}) as { blocked?: { title?: unknown; urls?: unknown } };
    const blocked = content.blocked ?? {};
    const urls = Array.isArray(blocked.urls)
      ? blocked.urls.filter((u): u is string => typeof u === "string")
      : [];
    const title = typeof blocked.title === "string" ? blocked.title : undefined;
    return {
      board: "drb2" as const,
      id: `idx-${String(r.idx)}`,
      prompt: String(r.prompt ?? ""),
      language: lang(r.language),
      ...(typeof r.theme === "string" ? { topic: r.theme } : {}),
      ...(typeof r.license === "string" ? { license: r.license } : {}),
      exclude: {
        urls: [...urls, ...BENCHMARK_SELF_EXCLUSIONS],
        ...(title ? { titles: [title] } : {}),
      },
    };
  });
}

export async function loadTasks(board: Board, dataDir: string): Promise<BenchTask[]> {
  const text = await taskFile(board, dataDir);
  return board === "drb1" ? parseDrb1(text) : parseDrb2(text);
}

/** Non-commercial tasks (DRB II per-task licenses): left out unless the operator opts in. */
export function nonCommercial(t: BenchTask): boolean {
  return /\bNC\b/.test(t.license ?? "");
}

/** sha256(seed + id), for a selection order nobody picked by hand. */
export function selectionKey(seed: string, id: string): string {
  return createHash("sha256").update(`${seed}\u0000${id}`).digest("hex");
}

export interface Selection {
  seed: string;
  board: Board;
  dev: string[];
  heldout: string[];
}

/**
 * The pre-registered split: per language, tasks ordered by `selectionKey`;
 * the first `dev` go to the dev split, the next `heldout` to the held-out one.
 * Non-commercial tasks are excluded first (unless `includeNonCommercial`).
 */
export function selectSplit(
  tasks: readonly BenchTask[],
  seed: string,
  sizes: { dev: number; heldout: number },
  opts: { includeNonCommercial?: boolean } = {},
): Selection {
  const pool = tasks.filter((t) => opts.includeNonCommercial || !nonCommercial(t));
  const dev: string[] = [];
  const heldout: string[] = [];
  for (const language of ["en", "zh"] as const) {
    const ordered = pool
      .filter((t) => t.language === language)
      .sort((a, b) => selectionKey(seed, a.id).localeCompare(selectionKey(seed, b.id)));
    dev.push(...ordered.slice(0, sizes.dev).map((t) => t.id));
    heldout.push(...ordered.slice(sizes.dev, sizes.dev + sizes.heldout).map((t) => t.id));
  }
  return { seed, board: tasks[0]?.board ?? "drb1", dev, heldout };
}
