// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * BenchmarkRunner — engine primitive for running benchmarks from inside the world.
 *
 * Design: spawn the existing harness (benchmarks/harness.ts) as a subprocess,
 * parse the result JSON, commit a row to benchmark_runs, emit feed events.
 * This keeps the engine decoupled from benchmark adapter internals while
 * turning every run into a first-class persistent artifact.
 *
 * The harness writes its result to benchmarks/results/<bench>-passthrough-<ts>.json;
 * we read the newest matching file once the subprocess exits.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MarinaDB } from "../persistence/database";
import type { EngineEvent, EntityId } from "../types";

interface BenchmarkSpec {
  name: string;
  description: string;
  datasetFile: string;
}

/** Shape of a per-item entry in the harness result JSON. Kept intentionally
 *  loose — the harness lineage is independent of the engine. */
interface ResultItemRaw {
  id?: string;
  question?: string;
  expected?: string;
  actual?: string;
  correct?: boolean;
  category?: string;
}

const DATASETS_DIR = "benchmarks/datasets";
const RESULTS_DIR = "benchmarks/results";

// Subset known to exist in benchmarks/harness.ts registry. Kept in sync
// manually — if the harness adds a benchmark, add it here to expose it to
// in-world agents. (Reading the harness at runtime would couple the engine
// to harness module-load behavior; we prefer the static list.)
export const BENCHMARKS: Record<string, BenchmarkSpec> = {
  "mmlu-pro": {
    name: "mmlu-pro",
    description: "12K 10-choice MC questions across 57 subjects",
    datasetFile: "mmlu-pro.json",
  },
  truthfulqa: {
    name: "truthfulqa",
    description: "817 MC questions testing truthfulness",
    datasetFile: "truthfulqa.json",
  },
  "arc-challenge": {
    name: "arc-challenge",
    description: "Grade-school science reasoning MC",
    datasetFile: "arc-challenge.json",
  },
  hellaswag: {
    name: "hellaswag",
    description: "Commonsense sentence-completion MC",
    datasetFile: "hellaswag.json",
  },
  musr: {
    name: "musr",
    description: "Multi-step soft reasoning (murder mysteries)",
    datasetFile: "musr.json",
  },
  bbh: {
    name: "bbh",
    description: "BIG-Bench Hard logical deduction (5 objects)",
    datasetFile: "bbh.json",
  },
  gsm8k: {
    name: "gsm8k",
    description: "Grade-school math word problems (numeric answer)",
    datasetFile: "gsm8k.json",
  },
  math: {
    name: "math",
    description: "Competition math (MATH-500 subset)",
    datasetFile: "math.json",
  },
  "simple-qa": {
    name: "simple-qa",
    description: "Short-answer factual (OpenAI SimpleQA)",
    datasetFile: "simpleqa.json",
  },
  humaneval: {
    name: "humaneval",
    description: "164 Python function completion tasks",
    datasetFile: "humaneval.json",
  },
  ifeval: {
    name: "ifeval",
    description: "Instruction-following verifier prompts",
    datasetFile: "ifeval.json",
  },
  frames: {
    name: "frames",
    description: "Multi-hop factual retrieval (Google FRAMES)",
    datasetFile: "frames.json",
  },
  aime: {
    name: "aime",
    description: "AIME 2024 olympiad math (30 problems)",
    datasetFile: "aime-2024.json",
  },
};

export interface BenchmarkRunOptions {
  benchmark: string;
  limit?: number;
  seed?: number;
  model?: string; // default "marina"
  judgeModel?: string;
  concurrency?: number;
  agentId?: string;
}

export interface BenchmarkRunHandle {
  id: string;
  configHash: string;
}

export type BenchmarkFeedEmitter = (event: EngineEvent) => void;

function hashConfig(config: unknown): string {
  // Stable but non-cryptographic — djb2 xor, 32-bit, hex. Enough for a run id.
  const s = JSON.stringify(config);
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export class BenchmarkRunner {
  private active = new Map<string, Promise<unknown>>();

  constructor(
    private db: MarinaDB,
    private emitFeed: BenchmarkFeedEmitter,
  ) {}

  list(): BenchmarkSpec[] {
    return Object.values(BENCHMARKS);
  }

  datasetReady(name: string): boolean {
    const spec = BENCHMARKS[name];
    if (!spec) return false;
    const path = join(process.cwd(), DATASETS_DIR, spec.datasetFile);
    return existsSync(path);
  }

  /**
   * Kick off a benchmark run. Returns immediately with the run id; the
   * subprocess executes asynchronously. Callers can poll via
   * db.getBenchmarkRun(id) or wait on benchmark_completed feed events.
   */
  start(opts: BenchmarkRunOptions): BenchmarkRunHandle {
    const spec = BENCHMARKS[opts.benchmark];
    if (!spec) {
      throw new Error(
        `unknown benchmark: ${opts.benchmark}. known: ${Object.keys(BENCHMARKS).join(", ")}`,
      );
    }
    if (!this.datasetReady(opts.benchmark)) {
      throw new Error(
        `dataset not cached for ${opts.benchmark}. run "bun run benchmarks/download-all.ts"`,
      );
    }

    const config = {
      benchmark: opts.benchmark,
      limit: opts.limit ?? 100,
      seed: opts.seed ?? 42,
      model: opts.model ?? "marina",
      judgeModel: opts.judgeModel,
      concurrency: opts.concurrency ?? 5,
    };
    const configHash = hashConfig(config);
    const id = `br_${configHash}_${Date.now().toString(36)}`;
    const started = Date.now();

    this.db.insertBenchmarkRun({
      id,
      benchmark: opts.benchmark,
      config_hash: configHash,
      config_json: JSON.stringify(config),
      status: "running",
      agent_id: opts.agentId,
      started_at: started,
    });

    this.emitFeed({
      type: "feed_event",
      kind: "benchmark_started",
      entity: opts.agentId as EntityId | undefined,
      ref: id,
      summary: `benchmark ${opts.benchmark} started — limit=${config.limit} seed=${config.seed} model=${config.model}`,
      payload: { id, configHash, ...config },
      timestamp: started,
    });

    const promise = this.execute(id, opts, config, started);
    this.active.set(id, promise);
    promise.finally(() => this.active.delete(id));
    return { id, configHash };
  }

  private async execute(
    id: string,
    opts: BenchmarkRunOptions,
    config: {
      benchmark: string;
      limit: number;
      seed: number;
      model: string;
      judgeModel?: string;
      concurrency: number;
    },
    started: number,
  ): Promise<void> {
    const args = [
      "run",
      "benchmarks/harness.ts",
      "--benchmark",
      opts.benchmark,
      "--limit",
      String(config.limit),
      "--seed",
      String(config.seed),
      "--mode",
      "passthrough",
      "--concurrency",
      String(config.concurrency),
      "--model",
      config.model,
    ];
    if (config.judgeModel) {
      args.push("--judge-model", config.judgeModel);
    }

    let score: number | null = null;
    let breakdownJson: string | null = null;
    let answered = 0;
    let total = 0;
    let status = "failed";
    let errorMsg: string | undefined;
    let resultItems: ResultItemRaw[] = [];

    try {
      const proc = Bun.spawn(["bun", ...args], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const err = await new Response(proc.stderr).text();
        throw new Error(`harness exited ${exitCode}: ${err.slice(0, 500)}`);
      }

      const result = this.readLatestResult(opts.benchmark, started);
      if (!result) {
        throw new Error("harness completed but no result file found");
      }
      score = result.scores?.overall ?? null;
      breakdownJson = JSON.stringify(result.scores?.breakdown ?? {});
      answered = result.metadata?.answered ?? 0;
      total = result.metadata?.total ?? 0;
      resultItems = result.items ?? [];
      status = "completed";
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      breakdownJson = JSON.stringify({ error: errorMsg.slice(0, 500) });
    }

    const duration_ms = Date.now() - started;
    this.db.completeBenchmarkRun(id, {
      score,
      breakdown_json: breakdownJson,
      answered,
      total,
      status,
      completed_at: Date.now(),
      duration_ms,
    });

    const now = Date.now();
    if (status === "completed" && score !== null) {
      // Learning loop: for every item the harness answered, deposit a note
      // into the benchmark:<name> pool so subsequent runs can recall prior
      // wrong-answers and successful-recipes. This is the feedback path
      // that turns a one-shot benchmark run into accumulating wisdom.
      const depositCount = this.depositOutcomeNotes(opts.benchmark, id, resultItems);

      this.emitFeed({
        type: "feed_event",
        kind: "benchmark_completed",
        entity: opts.agentId as EntityId | undefined,
        ref: id,
        summary: `benchmark ${opts.benchmark} ${(score * 100).toFixed(1)}% (${answered}/${total}) in ${Math.round(duration_ms / 1000)}s${depositCount > 0 ? `, deposited ${depositCount} notes to benchmark:${opts.benchmark}` : ""}`,
        payload: {
          id,
          benchmark: opts.benchmark,
          score,
          answered,
          total,
          duration_ms,
          depositedNotes: depositCount,
        },
        timestamp: now,
      });
    } else {
      this.emitFeed({
        type: "feed_event",
        kind: "benchmark_failed",
        entity: opts.agentId as EntityId | undefined,
        ref: id,
        summary: `benchmark ${opts.benchmark} failed: ${(errorMsg ?? "unknown").slice(0, 200)}`,
        payload: { id, benchmark: opts.benchmark, error: errorMsg },
        timestamp: now,
      });
    }
  }

  /**
   * Deposit per-item outcome notes into the benchmark:<name> pool so the
   * orchestrator on the next run can recall them as evidence. Creates the
   * pool on demand. Wrong answers and surprising patterns get higher
   * importance so recall surfaces them first.
   *
   * Returns number of notes actually written.
   */
  private depositOutcomeNotes(benchmark: string, runId: string, items: ResultItemRaw[]): number {
    if (items.length === 0) return 0;
    const poolName = `benchmark:${benchmark}`;
    let pool = this.db.getMemoryPool(poolName);
    if (!pool) {
      const newId = `pool-${crypto.randomUUID().slice(0, 8)}`;
      try {
        this.db.createMemoryPool(newId, poolName, "benchmark-runner");
        pool = this.db.getMemoryPool(poolName);
      } catch {
        // Race: another call created it. Re-read.
        pool = this.db.getMemoryPool(poolName);
      }
    }
    if (!pool) return 0;

    let count = 0;
    // Cap to avoid runaway pool growth — prioritize wrong answers, then a
    // sample of correct ones. Wrong answers are the learning signal.
    const MAX_DEPOSITS = 60;
    const wrong = items.filter((i) => !i.correct && typeof i.actual === "string");
    const correct = items.filter((i) => i.correct);
    const chosenWrong = wrong.slice(0, Math.min(wrong.length, 40));
    const remaining = MAX_DEPOSITS - chosenWrong.length;
    const chosenCorrect = correct.slice(0, Math.max(0, remaining));

    for (const item of chosenWrong) {
      const qFrag = (item.question ?? "").slice(0, 200).replace(/\s+/g, " ").trim();
      const cat = item.category ? `[${item.category}] ` : "";
      const content =
        `WRONG ${cat}Q: ${qFrag} | expected=${item.expected} | we_answered=${item.actual} ` +
        `| run=${runId.slice(0, 16)}`;
      try {
        this.db.addPoolNote(pool.id, "benchmark-runner", content, 7);
        count++;
      } catch {
        // best-effort
      }
    }
    for (const item of chosenCorrect) {
      const qFrag = (item.question ?? "").slice(0, 150).replace(/\s+/g, " ").trim();
      const cat = item.category ? `[${item.category}] ` : "";
      const content = `OK ${cat}Q: ${qFrag} | answer=${item.expected} | run=${runId.slice(0, 16)}`;
      try {
        this.db.addPoolNote(pool.id, "benchmark-runner", content, 4);
        count++;
      } catch {
        // best-effort
      }
    }
    return count;
  }

  /**
   * The harness writes results as benchmarks/results/<bench>-passthrough-<ts>.json.
   * Pick the newest one whose mtime is >= this run's start timestamp.
   */
  private readLatestResult(
    benchmark: string,
    startedAfter: number,
  ): {
    scores?: { overall?: number; breakdown?: Record<string, number> };
    metadata?: { total?: number; answered?: number };
    items?: ResultItemRaw[];
  } | null {
    const dir = join(process.cwd(), RESULTS_DIR);
    if (!existsSync(dir)) return null;
    // The harness saves as <dataset>-<mode>-<ts>.json. For some benchmarks the
    // dataset basename differs from the benchmark key (e.g. aime → aime-2024,
    // simple-qa → simpleqa). Derive the prefix from BENCHMARKS[key].datasetFile
    // so the lookup works for every registered benchmark.
    const spec = BENCHMARKS[benchmark];
    const datasetBase = spec ? spec.datasetFile.replace(/\.json$/, "") : benchmark;
    const prefix = `${datasetBase}-passthrough-`;
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
      .map((f) => {
        const full = join(dir, f);
        return { path: full, mtime: statSync(full).mtimeMs };
      })
      .filter((f) => f.mtime >= startedAfter - 5000) // 5s fudge for clock skew
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return null;
    const first = files[0];
    if (!first) return null;
    try {
      return JSON.parse(readFileSync(first.path, "utf-8"));
    } catch {
      return null;
    }
  }
}
