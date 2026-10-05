// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local scoring with the OFFICIAL evaluators, unmodified, at the pinned
 * commits (`./dataset.ts` BOARDS): the repository tarball is unpacked into a
 * cache directory, a Python venv gets the evaluators' few dependencies, our
 * outputs are written in each board's layout, and the evaluator runs with its
 * own defaults (GPT-5.5 judge; DRB I's GPT-5.6-luna cleaner) through
 * `startJudgeProxy` — OpenRouter on our key, behind a hard dollar cap, with a
 * dummy key in the evaluator's environment.
 *
 * DRB I: `deepresearch_bench_race.py` (RACE) — FACT needs a Jina key and is
 * not run here. DRB II: `run_evaluation.py`, then the same per-task arithmetic
 * as its `aggregate_scores.py` (`drb2TaskScores`, ported and tested).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startJudgeProxy } from "../judge-proxy";
import { BOARDS, type Board } from "./dataset";

/** The official judges and DRB I's article cleaner, as OpenRouter ids. */
export const JUDGE_MODELS: Record<Board, readonly string[]> = {
  drb1: ["openai/gpt-5.5", "openai/gpt-5.6-luna"],
  drb2: ["openai/gpt-5.5"],
};

export const JUDGE_LABEL: Record<Board, string> = {
  drb1: `official RACE (openai/gpt-5.5; cleaner gpt-5.6-luna) @${BOARDS.drb1.commit.slice(0, 8)}`,
  drb2: `official rubric judge (openai/gpt-5.5) @${BOARDS.drb2.commit.slice(0, 8)}`,
};

const PY_DEPS = ["requests>=2.31,<3", "tqdm>=4.65,<5", "python-docx>=1.1,<2"];

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; log?: (line: string) => void },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) if (line.trim()) opts.log?.(line);
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** The evaluator's checkout at the pinned commit, unpacked once into `cacheDir`. */
export async function ensureCheckout(
  board: Board,
  cacheDir: string,
  log?: (line: string) => void,
): Promise<string> {
  const b = BOARDS[board];
  const dir = join(cacheDir, `${board}-${b.commit.slice(0, 12)}`);
  if (existsSync(join(dir, ".marina-ready"))) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const url = `https://codeload.github.com/${b.repo}/tar.gz/${b.commit}`;
  log?.(`fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${b.name} tarball: HTTP ${res.status}`);
  const tgz = join(cacheDir, `${board}-${b.commit.slice(0, 12)}.tar.gz`);
  writeFileSync(tgz, new Uint8Array(await res.arrayBuffer()));
  const code = await run("tar", ["-xzf", tgz, "-C", dir, "--strip-components=1"], { log });
  rmSync(tgz, { force: true });
  if (code !== 0) throw new Error(`${b.name}: tar exited ${code}`);
  writeFileSync(join(dir, ".marina-ready"), `${b.commit}\n`);
  return dir;
}

/** A venv with the evaluators' dependencies, created once in `cacheDir`. */
export async function ensureVenv(cacheDir: string, log?: (line: string) => void): Promise<string> {
  const venv = join(cacheDir, "venv");
  const python = join(venv, "bin", "python");
  if (existsSync(join(venv, ".marina-ready"))) return python;
  rmSync(venv, { recursive: true, force: true });
  if ((await run("python3", ["-m", "venv", venv], { log })) !== 0)
    throw new Error("python3 -m venv failed (Python 3.9+ with venv is required)");
  if ((await run(python, ["-m", "pip", "install", "-q", ...PY_DEPS], { log })) !== 0)
    throw new Error("pip install of the evaluator dependencies failed");
  writeFileSync(join(venv, ".marina-ready"), `${PY_DEPS.join("\n")}\n`);
  return python;
}

export interface Article {
  /** DRB I: query id; DRB II: `idx-<n>`. */
  id: string;
  prompt: string;
  markdown: string;
}

export interface TaskScore {
  id: string;
  /** The board's per-task headline, 0–1 (RACE overall / rubric pass rate). */
  score: number;
  dims: Record<string, number | null>;
}

export interface OfficialRun {
  board: Board;
  model: string;
  scores: TaskScore[];
  /** Tasks the evaluator returned no score for (an error, or the cap). */
  missing: string[];
  judgeUsd: number;
  judgeCalls: { ok: number; refused: number; failed: number };
  byModel: Record<
    string,
    { calls: number; usd: number; promptTokens: number; completionTokens: number }
  >;
}

/** DRB II per-task dimensions, exactly as `aggregate_scores.py` `compute_dimension_averages`. */
export function drb2TaskScores(result: unknown): Record<string, number | null> {
  const scores = ((result as { scores?: unknown })?.scores ?? {}) as Record<string, unknown>;
  const out: Record<string, number | null> = {};
  let ones = 0;
  let minus = 0;
  let items = 0;
  for (const [key, name] of [
    ["info_recall", "inforecall"],
    ["analysis", "analysis"],
    ["presentation", "presentation"],
  ] as const) {
    const dim = scores[key];
    if (dim && typeof dim === "object" && Object.keys(dim).length > 0) {
      const values = Object.values(dim as Record<string, unknown>)
        .map((v) => (v && typeof v === "object" ? (v as { score?: unknown }).score : undefined))
        .filter((s): s is number => typeof s === "number");
      const o = values.filter((s) => s === 1).length;
      const m = values.filter((s) => s === -1).length;
      out[name] = values.length > 0 ? o / values.length : null;
      ones += o;
      minus += m;
      items += values.length;
    } else out[name] = null;
  }
  out.total = items > 0 ? ones / items : null;
  out.blocked_rate = items > 0 ? minus / items : null;
  return out;
}

function evaluatorEnv(extra: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: "C.UTF-8",
    PYTHONIOENCODING: "utf-8",
    ...extra,
  };
}

/**
 * Score `articles` with the official evaluator for `board`. `model` names the
 * run inside the evaluator's layout (letters, digits, `-`, `_`, `.`).
 */
export async function scoreOfficial(input: {
  board: Board;
  model: string;
  articles: Article[];
  cacheDir: string;
  apiKey: string;
  maxUsd: number;
  workers?: number;
  log?: (line: string) => void;
}): Promise<OfficialRun> {
  const { board, model, articles, log } = input;
  if (!/^[\w.-]+$/.test(model)) throw new Error(`model label "${model}" must be [A-Za-z0-9_.-]`);
  const dir = await ensureCheckout(board, input.cacheDir, log);
  const python = await ensureVenv(input.cacheDir, log);
  const proxy = startJudgeProxy({
    apiKey: input.apiKey,
    maxUsd: input.maxUsd,
    allowModels: JUDGE_MODELS[board],
    ...(log ? { log } : {}),
  });
  const workers = String(input.workers ?? 4);
  try {
    let scores: TaskScore[];
    if (board === "drb1") {
      const raw = join(dir, "data", "test_data", "raw_data");
      mkdirSync(raw, { recursive: true });
      writeFileSync(
        join(raw, `${model}.jsonl`),
        articles
          .map((a) => JSON.stringify({ id: Number(a.id), prompt: a.prompt, article: a.markdown }))
          .join("\n")
          .concat("\n"),
      );
      const out = join(dir, "results", "race", model);
      rmSync(out, { recursive: true, force: true });
      rmSync(join(dir, "data", "test_data", "cleaned_data", `${model}.jsonl`), { force: true });
      const code = await run(
        python,
        [
          "-u",
          "deepresearch_bench_race.py",
          model,
          "--raw_data_dir",
          "data/test_data/raw_data",
          "--max_workers",
          workers,
          "--query_file",
          "data/prompt_data/query.jsonl",
          "--output_dir",
          `results/race/${model}`,
        ],
        {
          cwd: dir,
          env: evaluatorEnv({
            LLM_BACKEND: "openrouter",
            OPENROUTER_API_KEY: "marina-judge-proxy",
            OPENROUTER_BASE_URL: proxy.baseUrl,
          }),
          ...(log ? { log } : {}),
        },
      );
      if (code !== 0) log?.(`RACE evaluator exited ${code}`);
      const file = join(out, "raw_results.jsonl");
      const rows = existsSync(file)
        ? readFileSync(file, "utf8")
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [];
      scores = rows
        .filter((r) => !r.error && typeof r.overall_score === "number")
        .map((r) => ({
          id: String(r.id),
          score: r.overall_score as number,
          dims: {
            comprehensiveness: (r.comprehensiveness as number) ?? null,
            insight: (r.insight as number) ?? null,
            instruction_following: (r.instruction_following as number) ?? null,
            readability: (r.readability as number) ?? null,
          },
        }));
    } else {
      const reportRoot = join(dir, `report-${model}`);
      rmSync(reportRoot, { recursive: true, force: true });
      mkdirSync(join(reportRoot, model), { recursive: true });
      for (const a of articles) writeFileSync(join(reportRoot, model, `${a.id}.md`), a.markdown);
      const outJsonl = join(dir, `result-${model}.jsonl`);
      rmSync(outJsonl, { force: true });
      const code = await run(python, ["-u", "run_evaluation.py"], {
        cwd: dir,
        env: evaluatorEnv({
          OPENAI_API_URL: `${proxy.baseUrl}/chat/completions`,
          OPENAI_API_KEY: "marina-judge-proxy",
          OPENAI_MODEL: "openai/gpt-5.5",
          OPENAI_REASONING_EFFORT: "medium",
          OPENAI_MAX_OUTPUT_TOKENS: "32768",
          OPENAI_TIMEOUT: "600",
          PDF_DIR: `report-${model}`,
          OUT_JSONL: `result-${model}.jsonl`,
          TASKS_JSONL: "tasks_and_rubrics.jsonl",
          CHUNK_SIZE: "50",
          MAX_WORKERS: workers,
          MAX_RETRIES: "5",
          MAX_PAPER_CHARS: "150000",
          LOG_FILE: `run_evaluation-${model}.log`,
        }),
        ...(log ? { log } : {}),
      });
      if (code !== 0) log?.(`DRB II evaluator exited ${code}`);
      const rows = existsSync(outJsonl)
        ? readFileSync(outJsonl, "utf8")
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l) as { idx?: unknown; result?: unknown })
        : [];
      scores = rows
        .map((r) => ({ id: `idx-${String(r.idx)}`, dims: drb2TaskScores(r.result) }))
        .filter((r) => typeof r.dims.total === "number")
        .map((r) => ({ id: r.id, score: r.dims.total as number, dims: r.dims }));
    }
    const got = new Set(scores.map((s) => s.id));
    return {
      board,
      model,
      scores,
      missing: articles.map((a) => a.id).filter((id) => !got.has(id)),
      judgeUsd: proxy.spentUsd(),
      judgeCalls: proxy.calls(),
      byModel: proxy.byModel(),
    };
  } finally {
    proxy.stop();
  }
}
