// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * BenchmarkRunner — engine primitive for running benchmarks from inside the world.
 *
 * Design: spawn the existing harness (benchmarks/harness.ts) as a subprocess,
 * parse the result JSON, commit a row to benchmark_runs, emit feed events.
 * This keeps the engine decoupled from benchmark adapter internals while
 * turning every run into a first-class persistent artifact.
 *
 * Learning: a completed run feeds ONE outcome (ids, score, category accuracy)
 * to the judged lesson loop in `src/learning/`. No benchmark path writes an
 * item's question, expected answer or model answer to memory: a memorised
 * answer contaminates every later run of the same benchmark
 * (`test/benchmark-no-content-memory.test.ts`). Runs before this rule left
 * per-item notes in `benchmark:<name>` pools; `purgeBenchmarkContentNotes`
 * retires them (`benchmark purge-content-notes`).
 *
 * The harness writes its result to benchmarks/results/<bench>-passthrough-<ts>.json;
 * we read the newest matching file once the subprocess exits.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../config/data-dir";
import { noteBenchmarkRun } from "../learning/intake";
import { caseGuardFromItems } from "../learning/leak-guard";
import { localHttpBase } from "../net/listen-ports";
import { DEFAULT_STACK, parseStackHeader } from "../net/model-api/stack";
import type { MarinaDB } from "../persistence/database";
import type { EngineEvent, EntityId } from "../types";
import {
  fallbackInvalidReason,
  type HarnessResultFile,
  isFallbackItem,
  ledgerFromHarnessResult,
} from "./benchmark-ledger";
import { mintRunKey, revokeRunKey } from "./benchmark-run-keys";
import { getErrorMessage } from "./errors";
import { featureEnvSnapshot } from "./feature-env";
import { Logger } from "./logger";

const log = new Logger();

interface BenchmarkSpec {
  name: string;
  description: string;
  datasetFile: string;
  /** Repo-relative path when the dataset is tracked rather than downloaded. */
  datasetPath?: string;
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

/** The harness result file, as far as the runner reads it. */
export interface HarnessResult {
  scores?: { overall?: number; breakdown?: Record<string, number> };
  metadata?: { total?: number; answered?: number };
  items?: ResultItemRaw[];
}

/** What one harness invocation produced: its result file, or why there is none. */
export type HarnessOutcome =
  | { result: HarnessResult; error?: undefined }
  | { error: string; result?: undefined };

/** A category label longer than this is not a taxonomy label: it is left out. */
const MAX_CATEGORY_LABEL = 48;

/**
 * Per-category tallies of a run's items, from the item's `category` label and
 * `correct` verdict only. Question, expected and actual text are never read.
 */
export function categoryAccuracy(
  items: ReadonlyArray<Pick<ResultItemRaw, "category" | "correct">>,
): { category: string; n: number; correct: number }[] {
  const tally = new Map<string, { n: number; correct: number }>();
  for (const item of items) {
    const label = item.category?.replace(/\s+/g, " ").trim();
    if (!label || label.length > MAX_CATEGORY_LABEL) continue;
    const t = tally.get(label) ?? { n: 0, correct: 0 };
    t.n++;
    if (item.correct) t.correct++;
    tally.set(label, t);
  }
  return [...tally].map(([category, t]) => ({ category, ...t }));
}

const DATASETS_DIR = "benchmarks/datasets";
const RESULTS_DIR = "benchmarks/results";

/**
 * Where an in-world run's harness writes its result file: under
 * `MARINA_DATA_DIR` when set (`<dir>/benchmark-results`, nothing in the
 * checkout), else `benchmarks/results` in the working directory.
 */
export function benchmarkResultsDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = dataDir(env);
  return dir ? join(dir, "benchmark-results") : join(process.cwd(), RESULTS_DIR);
}

// Subset known to exist in benchmarks/harness.ts registry. Kept in sync
// manually — if the harness adds a benchmark, add it here to expose it to
// in-world agents. (Reading the harness at runtime would couple the engine
// to harness module-load behavior; we prefer the static list.)
export const BENCHMARKS: Record<string, BenchmarkSpec> = {
  smoke: {
    name: "smoke",
    description: "Frozen 15-item prompt A/B set — measure a prompt or crew change in seconds",
    datasetFile: "smoke-eval.json",
    datasetPath: "benchmarks/smoke-eval.json",
  },
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
  gpqa: {
    name: "gpqa",
    description: "GPQA-Diamond graduate-level science MC, options shuffled per seed (gated)",
    datasetFile: "gpqa-diamond.json",
  },
  "hle-verified-gold": {
    name: "hle-verified-gold",
    description: "HLE-Verified Gold subset, text-only (exact match, else equivalence judge)",
    datasetFile: "hle-verified-gold.json",
  },
  "hle-verified-gold-mm": {
    name: "hle-verified-gold-mm",
    description: "HLE-Verified Gold image items (image_url parts; exact match, else judge)",
    datasetFile: "hle-verified-gold-mm.json",
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
  /**
   * What was measured behind a `marina:<name>` endpoint: the agents serving
   * it, their role and the hash of the exact system prompt in force. Part of
   * the config (and its hash), so a changed prompt is a different config and
   * `evolve evaluate benchmark:<id>` can tie a score to a candidate role.
   */
  subjects?: BenchmarkSubject[];
  /** Judge on the fixed `holdout` split, iterate on `tune` (benchmarks/partition.ts). */
  partition?: "holdout" | "tune";
  /** Recall judged lessons on the target's requests (`--lessons`). */
  lessons?: boolean;
  /**
   * `measure` (default): a measurement — the board's own lessons are never
   * recalled (leakage rule 2); `live` lifts that for an actual entry.
   */
  lessonsMode?: "measure" | "live";
  /**
   * The arm: which passthru instruments the run's requests get — `bare` (none),
   * `on` (the identified-caller default stack), `full`, or a member list
   * (`lessons,obligations`). Given an arm or a cap, the run is served by a run
   * key (`benchmark-run-keys.ts`) instead of the internal token.
   */
  arm?: string;
  /** Upstream spend cap for the run, USD; every call past it is refused. */
  capUsd?: number;
  /** Explicit replicate group for the run's ledger row (`benchmark compare-run` sets one per arm). */
  replicateGroup?: string;
}

let cachedSource: string | null | undefined;

/**
 * The source revision this server runs: the git commit (12 hex, `-dirty` when
 * the checkout has local changes), or null outside a git checkout. Read once —
 * the code a process runs does not change under it. Part of an in-world run's
 * target (`source`), so runs on different code never pair as replicates and a
 * comparison names the model AND the code it measured (`model@source`).
 */
export function sourceRevision(): string | null {
  if (cachedSource !== undefined) return cachedSource;
  try {
    const cwd = join(import.meta.dir, "../..");
    const head = Bun.spawnSync(["git", "rev-parse", "--short=12", "HEAD"], { cwd });
    const sha = head.exitCode === 0 ? head.stdout.toString().trim() : "";
    if (!/^[0-9a-f]{7,40}$/.test(sha)) cachedSource = null;
    else {
      const dirty = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=no"], {
        cwd,
      });
      cachedSource = dirty.exitCode === 0 && dirty.stdout.toString().trim() ? `${sha}-dirty` : sha;
    }
  } catch {
    cachedSource = null;
  }
  return cachedSource;
}

/** Test seam: pin (or clear, with undefined) the source revision. */
export function setSourceRevisionForTests(value: string | null | undefined): void {
  cachedSource = value;
}

/**
 * What an in-world run measured, as its ledger target: the model, the arm's
 * instrument stack and the source revision. Bare runs record no stack, so they
 * stay model evidence; an instrumented arm is a different target.
 */
export function inWorldTarget(config: {
  model: string;
  arm?: string;
  lessons?: boolean;
  lessonsMode?: string;
  partition?: string;
  source?: string;
}): Record<string, unknown> {
  const stack = config.arm ? armStack(config.arm) : undefined;
  const s = stack && "stack" in stack && stack.stack !== "none" ? stack.stack : undefined;
  return {
    model: config.model,
    ...(s ? { stack: s } : {}),
    ...(config.lessons ? { lessons: config.lessonsMode ?? "measure" } : {}),
    ...(config.partition ? { partition: config.partition } : {}),
    ...(config.source ? { source: config.source } : {}),
  };
}

/**
 * The `x-marina-stack` value an arm asks for, or an error. `bare` → `none`,
 * `on` → the default stack, `full` → `full`, else a member list as given.
 */
export function armStack(arm: string): { stack: string } | { error: string } {
  const a = arm.trim().toLowerCase();
  if (a === "bare" || a === "none") return { stack: "none" };
  if (a === "on" || a === "default") return { stack: DEFAULT_STACK.join(",") };
  const parsed = parseStackHeader(a);
  if (!parsed || parsed.kind === "error")
    return { error: parsed?.kind === "error" ? parsed.message : `unknown arm "${arm}"` };
  return { stack: a };
}

export interface BenchmarkSubject {
  agent: string;
  role?: string;
  promptVersion?: string;
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

/** The author the runner wrote its (retired) per-item outcome notes under. */
const LEGACY_NOTE_AUTHOR = "benchmark-runner";
/** The shape of a legacy per-item note: `WRONG [cat] Q: … | expected=…` / `OK [cat] Q: … | answer=…`. */
const LEGACY_CONTENT_NOTE = /^(WRONG|OK) (\[[^\]]*\] )?Q: .*\| (expected|answer)=/s;

/** The citation a legacy outcome note carries for its run (`bench:<id>`, as lessons cite it). */
function outcomeNoteRef(runId: string): string {
  return `bench:${runId}`;
}

/** Notes written before outcome notes carried the full id cite a 16-char prefix. */
const LEGACY_NOTE_PREFIX = 16;

/**
 * A ledger run was invalidated: retire the per-item outcome notes earlier
 * versions of the runner deposited for it in the `benchmark:<name>` pool (they
 * record what the infrastructure did, not the target; the runner no longer
 * writes them, see `purgeBenchmarkContentNotes`). Retirement is `note delete`'s path —
 * the canonical record is revised and stays readable in its history; the
 * invalidation's own audit row carries the reason. Older notes cite only a
 * 16-character prefix of the run id (`run=<prefix>`); they are retired only
 * when no other run on that benchmark shares the prefix, otherwise counted as
 * `ambiguous` and left in place. Never throws.
 */
export function retireOutcomeNotesForRun(
  db: MarinaDB,
  runId: string,
): { retired: number; ambiguous: number; error?: string } {
  try {
    const run = db.getBenchmarkRun(runId);
    if (!run) return { retired: 0, ambiguous: 0 };
    const pool = db.getMemoryPool(`benchmark:${run.benchmark}`);
    if (!pool) return { retired: 0, ambiguous: 0 };
    const full = outcomeNoteRef(runId);
    const prefix = runId.slice(0, LEGACY_NOTE_PREFIX);
    const legacy = `| run=${prefix}`;
    const legacyUnique =
      runId.length > LEGACY_NOTE_PREFIX
        ? !db
            .queryBenchmarkRuns({ benchmark: run.benchmark, limit: 500 })
            .some((r) => r.id !== runId && r.id.startsWith(prefix))
        : true;
    let retired = 0;
    let ambiguous = 0;
    const notes = db.getPoolNotes(pool.id, Math.max(1, db.countPoolNotes(pool.id)));
    for (const note of notes) {
      if (note.entity_name !== LEGACY_NOTE_AUTHOR) continue;
      const content = note.content ?? "";
      const legacyHit = content.endsWith(legacy);
      if (!content.endsWith(`| ${full}`) && !(legacyHit && legacyUnique)) {
        if (legacyHit) ambiguous++;
        continue;
      }
      if (db.deleteNote(note.id, note.entity_name)) retired++;
    }
    return { retired, ambiguous };
  } catch (err) {
    return { retired: 0, ambiguous: 0, error: getErrorMessage(err) };
  }
}

export interface BenchmarkContentPurge {
  /** Every `benchmark:<name>` pool that holds content notes, with their count. */
  pools: { name: string; notes: number }[];
  /** Content notes found (dry run) or retired (applied). */
  found: number;
  retired: number;
  failed: number;
  applied: boolean;
  error?: string;
}

/**
 * Find, and with `apply` retire, the per-item notes earlier versions of the
 * runner wrote into `benchmark:<name>` pools: each carried a benchmark item's
 * question and expected answer, which contaminates later runs and bypasses
 * the judged lesson loop. A note counts when the runner wrote it or it has the
 * runner's `WRONG|OK … Q: … | expected=|answer=` shape. Retirement is
 * `note delete`'s audited path (the canonical record is revised, never
 * erased); no row is deleted directly. The pools themselves stay. Dry run by
 * default; never returns note content. Never throws.
 */
export function purgeBenchmarkContentNotes(
  db: MarinaDB,
  opts: { apply?: boolean } = {},
): BenchmarkContentPurge {
  const out: BenchmarkContentPurge = {
    pools: [],
    found: 0,
    retired: 0,
    failed: 0,
    applied: !!opts.apply,
  };
  try {
    for (const pool of db.listMemoryPools()) {
      if (!pool.name.startsWith("benchmark:")) continue;
      const notes = db
        .getPoolNotes(pool.id, Math.max(1, db.countPoolNotes(pool.id)))
        .filter(
          (n) => n.entity_name === LEGACY_NOTE_AUTHOR || LEGACY_CONTENT_NOTE.test(n.content ?? ""),
        );
      if (!notes.length) continue;
      out.pools.push({ name: pool.name, notes: notes.length });
      out.found += notes.length;
      if (!opts.apply) continue;
      for (const note of notes) {
        try {
          if (db.deleteNote(note.id, note.entity_name)) out.retired++;
          else out.failed++;
        } catch {
          out.failed++;
        }
      }
    }
  } catch (err) {
    out.error = getErrorMessage(err);
  }
  return out;
}

/** Where the harness sends its model calls: this instance's own /v1, authenticated. */
export interface HarnessTarget {
  endpoint: string;
  apiKey?: string;
}

/**
 * The configuration a run records (and hashes): what was asked for, plus the
 * Marina feature settings of THIS server — the run executes inside it, so its
 * instruments are part of what was measured and a changed setting is a
 * different configuration.
 */
export function benchmarkRunConfig(
  opts: BenchmarkRunOptions,
  env: Record<string, string | undefined> = process.env,
) {
  const serverFeatures = featureEnvSnapshot(env);
  return {
    benchmark: opts.benchmark,
    limit: opts.limit ?? 100,
    seed: opts.seed ?? 42,
    model: opts.model ?? "marina",
    judgeModel: opts.judgeModel,
    concurrency: opts.concurrency ?? 5,
    ...(opts.subjects?.length ? { subjects: opts.subjects } : {}),
    ...(opts.partition ? { partition: opts.partition } : {}),
    ...(opts.lessons ? { lessons: true } : {}),
    ...(opts.lessonsMode ? { lessonsMode: opts.lessonsMode } : {}),
    ...(opts.arm ? { arm: opts.arm.trim().toLowerCase() } : {}),
    ...(opts.capUsd !== undefined ? { capUsd: opts.capUsd } : {}),
    ...(opts.replicateGroup ? { replicateGroup: opts.replicateGroup } : {}),
    ...(sourceRevision() ? { source: sourceRevision() as string } : {}),
    ...(Object.keys(serverFeatures).length ? { serverFeatures } : {}),
  };
}

/** The harness child's argv and environment. The key travels in the environment,
 * never argv, so it is not visible in the process list. */
export function harnessInvocation(
  benchmark: string,
  config: {
    limit: number;
    seed: number;
    model: string;
    judgeModel?: string;
    concurrency: number;
    partition?: string;
    lessons?: boolean;
    lessonsMode?: "measure" | "live";
  },
  target: HarnessTarget,
  resultFile?: string,
): { args: string[]; env: Record<string, string> } {
  const args = [
    "run",
    "benchmarks/harness.ts",
    "--benchmark",
    benchmark,
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
    "--endpoint",
    target.endpoint,
  ];
  if (config.judgeModel) args.push("--judge-model", config.judgeModel);
  if (config.partition) args.push("--partition", config.partition);
  if (config.lessons) args.push("--lessons");
  if (config.lessonsMode) args.push("--lessons-mode", config.lessonsMode);
  const env: Record<string, string> = {};
  if (target.apiKey) env.MARINA_BENCH_API_KEY = target.apiKey;
  if (resultFile) env.MARINA_BENCH_RESULT_FILE = resultFile;
  return { args, env };
}

/**
 * A harness that exits 0 can still have failed every item (unreachable endpoint,
 * auth, an upstream 400). Such a run must not land on the leaderboard as a 0% score.
 */
export function harnessFailure(result: {
  metadata?: { total?: number; answered?: number };
  items?: ResultItemRaw[];
}): string | undefined {
  const total = result.metadata?.total ?? result.items?.length ?? 0;
  if (total === 0) return "harness answered no items";
  if ((result.metadata?.answered ?? 0) > 0) return undefined;
  const firstError = result.items?.find((i) => i.actual?.startsWith("ERROR:"))?.actual;
  return `every item errored${firstError ? ` — ${firstError.slice(0, 300)}` : ""}`;
}

export class BenchmarkRunner {
  private active = new Map<string, Promise<unknown>>();

  constructor(
    private db: MarinaDB,
    private emitFeed: BenchmarkFeedEmitter,
    private target: () => HarnessTarget = () => ({
      endpoint: localHttpBase(),
    }),
  ) {}

  list(): BenchmarkSpec[] {
    return Object.values(BENCHMARKS);
  }

  datasetReady(name: string): boolean {
    const spec = BENCHMARKS[name];
    if (!spec) return false;
    const path = join(process.cwd(), spec.datasetPath ?? join(DATASETS_DIR, spec.datasetFile));
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

    if (opts.arm) {
      const stack = armStack(opts.arm);
      if ("error" in stack) throw new Error(stack.error);
    }
    if (opts.capUsd !== undefined && !(opts.capUsd > 0)) throw new Error("cap must be above $0");
    const config = benchmarkRunConfig(opts);
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
      lessons?: boolean;
      lessonsMode?: "measure" | "live";
    },
    started: number,
  ): Promise<void> {
    const resultFile = join(benchmarkResultsDir(), `${id}.json`);
    // An arm or a cap: the harness talks to /v1 with a run key carrying them.
    const target = this.target();
    const stack = opts.arm ? armStack(opts.arm) : undefined;
    const runKey =
      opts.arm || opts.capUsd !== undefined
        ? mintRunKey({
            runId: id,
            ...(stack && "stack" in stack ? { stack: stack.stack } : {}),
            evalTag: `benchmark=${opts.benchmark}; mode=${config.lessonsMode ?? "measure"}`,
            ...(opts.capUsd !== undefined ? { capUsd: opts.capUsd } : {}),
          })
        : undefined;
    const { args, env } = harnessInvocation(
      opts.benchmark,
      config,
      runKey ? { ...target, apiKey: runKey } : target,
      resultFile,
    );

    let harness: HarnessOutcome;
    try {
      const proc = Bun.spawn(["bun", ...args], {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const err = await new Response(proc.stderr).text();
        throw new Error(`harness exited ${exitCode}: ${err.slice(0, 500)}`);
      }
      const result = this.readResult(resultFile);
      if (!result) throw new Error("harness completed but no result file found");
      harness = { result };
    } catch (err) {
      harness = { error: getErrorMessage(err) };
    }
    const keyState = runKey ? revokeRunKey(runKey) : undefined;
    // A run key measured the run's upstream spend exactly; without one the
    // harness's own usage report is the cost.
    this.recordHarnessResult(id, opts, started, harness, {
      ...(keyState ? { costUsd: keyState.spentUsd } : {}),
    });
    // A run stopped by its key is not a clean measurement: record why.
    if (keyState?.tripped) {
      this.db.setBenchmarkRunValidity({
        run_id: id,
        action: "invalidate",
        reason:
          keyState.tripped === "transport"
            ? "run stopped: repeated upstream network failures"
            : `run stopped at its spend cap ($${keyState.spentUsd.toFixed(2)} of $${(keyState.capUsd ?? 0).toFixed(2)})`,
        actor: null,
        source: "auto",
        created_at: Date.now(),
      });
    }
  }

  /**
   * Record what the harness produced for run `id`: the run row, the feed event
   * and, for a valid scored run, one outcome for the judged learning loop
   * (`src/learning/`). The outcome carries the run's id, score and per-category
   * accuracy only; the items' question, expected and actual text is read for
   * counting and never written to memory, a pool or a lesson (a memorised
   * answer would contaminate every later run of the same benchmark).
   * Public so tests can drive it without spawning the harness.
   */
  recordHarnessResult(
    id: string,
    opts: Pick<BenchmarkRunOptions, "benchmark" | "agentId" | "replicateGroup">,
    started: number,
    harness: HarnessOutcome,
    measured: { costUsd?: number } = {},
  ): void {
    let score: number | null = null;
    let breakdownJson: string | null = null;
    let answered = 0;
    let total = 0;
    let status = "failed";
    let errorMsg: string | undefined = harness.error;
    let resultItems: ResultItemRaw[] = [];

    if (harness.result) {
      const result = harness.result;
      const failure = harnessFailure(result);
      if (failure) errorMsg = failure;
      else {
        score = result.scores?.overall ?? null;
        breakdownJson = JSON.stringify(result.scores?.breakdown ?? {});
        answered = result.metadata?.answered ?? 0;
        total = result.metadata?.total ?? 0;
        resultItems = result.items ?? [];
        status = "completed";
      }
    }
    if (status !== "completed") {
      breakdownJson = JSON.stringify({ error: (errorMsg ?? "unknown").slice(0, 500) });
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

    if (status === "completed" && harness.result) {
      this.attachItems(id, opts, harness.result as HarnessResultFile, measured.costUsd);
    }

    const now = Date.now();
    // Too many items errored instead of answering (spend cap, provider
    // outage): the run is kept, but recorded invalid so no reader ranks it.
    const invalid =
      status === "completed"
        ? fallbackInvalidReason(resultItems.length, resultItems.filter(isFallbackItem).length)
        : undefined;
    if (invalid) {
      this.db.setBenchmarkRunValidity({
        run_id: id,
        action: "invalidate",
        reason: invalid,
        actor: null,
        source: "auto",
        created_at: now,
      });
      this.emitFeed({
        type: "feed_event",
        kind: "benchmark_invalidated",
        entity: opts.agentId as EntityId | undefined,
        ref: id,
        summary: `benchmark ${opts.benchmark} run ${id} recorded invalid: ${invalid}`,
        payload: { id, benchmark: opts.benchmark, reason: invalid, source: "auto" },
        timestamp: now,
      });
    } else if (status === "completed" && score !== null) {
      // Learning loop: the run becomes ONE outcome for the judged lesson loop
      // (a no-op unless the server armed it). Ids, score and category
      // accuracy only, never an item's question or answer; the items' text
      // goes along only as hashed fingerprints for the mechanical leak check.
      const run = this.db.getBenchmarkRun(id);
      if (run)
        noteBenchmarkRun(this.db, run, {
          categories: categoryAccuracy(resultItems),
          guard: caseGuardFromItems(resultItems),
        });

      this.emitFeed({
        type: "feed_event",
        kind: "benchmark_completed",
        entity: opts.agentId as EntityId | undefined,
        ref: id,
        summary: `benchmark ${opts.benchmark} ${(score * 100).toFixed(1)}% (${answered}/${total}) in ${Math.round(duration_ms / 1000)}s`,
        payload: { id, benchmark: opts.benchmark, score, answered, total, duration_ms },
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
   * Record the run's per-item outcomes (item id, verdict, latency, cost, trace
   * id — never question or answer text) and its ledger columns, so the paired
   * readers (`compare`, `replicates`, `compare-run`) work on in-world runs.
   */
  private attachItems(
    id: string,
    opts: Pick<BenchmarkRunOptions, "benchmark" | "replicateGroup">,
    result: HarnessResultFile,
    costUsd: number | undefined,
  ): void {
    const run = this.db.getBenchmarkRun(id);
    if (!run) return;
    try {
      const config = JSON.parse(run.config_json) as Parameters<typeof inWorldTarget>[0];
      const { run: ledger, items } = ledgerFromHarnessResult(
        { ...result, config: { ...(result.config ?? {}), dataset: opts.benchmark } },
        {
          targetKind: "model",
          target: inWorldTarget(config),
          ...(costUsd !== undefined ? { costUsd } : {}),
          ...(opts.replicateGroup ? { replicateGroup: opts.replicateGroup } : {}),
          maxFallbackRate: null,
          raw: "",
          id,
          now: Date.now(),
        },
      );
      this.db.attachBenchmarkRunItems(
        id,
        {
          cost_usd: ledger.cost_usd,
          n: ledger.n,
          ci_low: ledger.ci_low,
          ci_high: ledger.ci_high,
          seed: ledger.seed,
          slice_hash: ledger.slice_hash,
          judge: ledger.judge,
          target_kind: ledger.target_kind,
          target_json: ledger.target_json,
          replicate_group: ledger.replicate_group ?? null,
        },
        items,
      );
    } catch (err) {
      log.warn("benchmark", `run ${id}: per-item outcomes not recorded: ${getErrorMessage(err)}`);
    }
  }

  /** Resolves when run `id` has finished and been recorded (at once if it is not running). */
  async done(id: string): Promise<void> {
    // allow-empty-catch: the run records its own failure; done() only waits for it to settle
    await this.active.get(id)?.catch(() => undefined);
  }

  /**
   * The harness wrote this run's result to the file the runner named for it
   * (`MARINA_BENCH_RESULT_FILE`). Reading an exact path — not "the newest
   * file for this dataset" — keeps concurrent runs, in this world or in child
   * worlds sharing the working directory, from reading each other's results.
   */
  private readResult(path: string): HarnessResult | null {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return null;
    }
  }
}
