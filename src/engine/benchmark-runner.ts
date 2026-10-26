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
 * The harness writes its result to the file the runner names
 * (`MARINA_BENCH_RESULT_FILE`, under `benchmarkResultsDir()`); the runner
 * reads it once the subprocess exits.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../config/data-dir";
import { noteBenchmarkRun } from "../learning/intake";
import { caseGuardFromItems } from "../learning/leak-guard";
import { localHttpBase } from "../net/listen-ports";
import { DEFAULT_STACK, parseStackHeader } from "../net/model-api/stack";
import type { MarinaDB } from "../persistence/database";
import { bunScriptArgv, MARINA_ROOT } from "../runtime-paths";
import type { EngineEvent, EntityId } from "../types";
import { resolveBenchmarkJudge } from "./benchmark-judge";
import {
  fallbackInvalidReason,
  type HarnessResultFile,
  isFallbackItem,
  ledgerFromHarnessResult,
} from "./benchmark-ledger";
import { resolveParticipants } from "./benchmark-participants";
import {
  BENCHMARK_KEYS,
  BENCHMARK_REGISTRY,
  type BenchmarkEntry,
  benchmarkEntry,
  benchmarkUsesJudge,
} from "./benchmark-registry";
import { mintRunKey, type RunKeyGrant, revokeRunKey } from "./benchmark-run-keys";
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
  /** Items are generated in code: always ready, nothing to download. */
  generated?: boolean;
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
const RESULTS_DIR = join("data", "benchmark-results");

/**
 * Where an in-world run's harness writes its result file: under
 * `MARINA_DATA_DIR` when set (`<dir>/benchmark-results`), else
 * `data/benchmark-results` beside the world's other state (`data/assets`,
 * `data/scratch`) in the working directory — never a checkout path, since the
 * server may run from any directory (a project folder included).
 */
export function benchmarkResultsDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = dataDir(env);
  return dir ? join(dir, "benchmark-results") : join(process.cwd(), RESULTS_DIR);
}

/**
 * Every benchmark the world can run, derived from the ONE registry
 * (`src/engine/benchmark-registry.ts`) that the harness and the web UI read
 * too — never a hand-synced copy (`test/benchmark-registry.test.ts`).
 */
export const BENCHMARKS: Record<string, BenchmarkSpec> = Object.fromEntries(
  BENCHMARK_KEYS.map((key) => {
    const e: BenchmarkEntry = BENCHMARK_REGISTRY[key];
    const spec: BenchmarkSpec = {
      name: key,
      description: e.description,
      datasetFile: `${e.dataset}.json`,
      ...(e.source.kind === "tracked" ? { datasetPath: e.source.path } : {}),
      ...(e.source.kind === "generated" ? { generated: true } : {}),
    };
    return [key, spec];
  }),
);

/**
 * The crew a `marina:<name>` target names, or undefined for any other id
 * (`marina`, `marina/default`, `marina/verify:…`, a provider model). A crew
 * target measures the residents serving `model-<name>`; anything else is a
 * bare-model control.
 */
export function crewOfTarget(model: string): string | undefined {
  return /^marina:([A-Za-z0-9][\w.-]*)$/.exec(model.trim())?.[1];
}

export interface BenchmarkRunOptions {
  benchmark: string;
  limit?: number;
  seed?: number;
  /**
   * What is measured: `marina:<crew>` — the residents serving that crew's
   * endpoint (a `crew` target); any other id — the bare model, recorded as a
   * control. Default `marina` (a control); the in-world `benchmark run`
   * command always resolves a target before it gets here.
   */
  model?: string;
  /** Judge model; default `MARINA_BENCHMARK_JUDGE_MODEL`, else `marina/default`. */
  judgeModel?: string;
  /** Allow the judge to be the target model (recorded with the run). */
  selfJudge?: boolean;
  /** The crew's formation when the target is a crew (recorded in its target). */
  formation?: string;
  concurrency?: number;
  agentId?: string;
  /**
   * What was measured behind a `marina:<name>` endpoint: the agents serving
   * it, their role and the hash of the exact system prompt in force. Part of
   * the config (and its hash), so a changed prompt is a different config and
   * `evolve evaluate benchmark:<id>` can tie a score to a candidate role.
   */
  subjects?: BenchmarkSubject[];
  /** Judge on the fixed `holdout` split, iterate on `tune` (src/engine/benchmark-partition.ts). */
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
  formation?: string;
}): Record<string, unknown> {
  const stack = config.arm ? armStack(config.arm) : undefined;
  const s = stack && "stack" in stack && stack.stack !== "none" ? stack.stack : undefined;
  const crew = crewOfTarget(config.model);
  return {
    // A crew target names the crew (as tier0 and the kit file it) and its formation.
    ...(crew ? { crew, ...(config.formation ? { formation: config.formation } : {}) } : {}),
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

/**
 * The run key a run gets, or undefined for the internal token. An arm, a cap
 * or a crew target gets one (the run's eval context, arm and cap): a crew
 * run's requests are always the run's own, never the internal token's, so
 * they are attributed to the run and stop with it. A bare-model control
 * without arm or cap keeps the internal token (passthru, no residents).
 */
export function runKeyGrant(
  id: string,
  opts: Pick<BenchmarkRunOptions, "benchmark" | "arm" | "capUsd">,
  config: { targetKind: "crew" | "model"; lessonsMode?: string },
): RunKeyGrant | undefined {
  if (config.targetKind !== "crew" && !opts.arm && opts.capUsd === undefined) return undefined;
  const stack = opts.arm ? armStack(opts.arm) : undefined;
  return {
    runId: id,
    ...(stack && "stack" in stack ? { stack: stack.stack } : {}),
    evalTag: `benchmark=${opts.benchmark}; mode=${config.lessonsMode ?? "measure"}`,
    ...(opts.capUsd !== undefined ? { capUsd: opts.capUsd } : {}),
  };
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
  const model = opts.model ?? "marina";
  const crew = crewOfTarget(model);
  return {
    benchmark: opts.benchmark,
    limit: opts.limit ?? 100,
    seed: opts.seed ?? 42,
    model,
    // A crew target measures residents; anything else is a bare-model control.
    targetKind: crew ? ("crew" as const) : ("model" as const),
    ...(crew ? {} : { control: true }),
    ...(crew && opts.formation ? { formation: opts.formation } : {}),
    judgeModel: opts.judgeModel,
    ...(opts.selfJudge ? { selfJudge: true } : {}),
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
    selfJudge?: boolean;
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
  if (config.selfJudge) args.push("--self-judge");
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
    /** The concrete model `marina/default` routes to, so a judge naming it is recognised. */
    private defaultModel: () => string | undefined = () => undefined,
  ) {}

  list(): BenchmarkSpec[] {
    return Object.values(BENCHMARKS);
  }

  datasetReady(name: string): boolean {
    const spec = BENCHMARKS[name];
    if (!spec) return false;
    if (spec.generated) return true;
    // The checkout's own files, wherever the server was started from.
    const path = join(MARINA_ROOT, spec.datasetPath ?? join(DATASETS_DIR, spec.datasetFile));
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
        `dataset not downloaded for ${opts.benchmark}. run "benchmark fetch ${opts.benchmark}"`,
      );
    }

    if (opts.arm) {
      const stack = armStack(opts.arm);
      if ("error" in stack) throw new Error(stack.error);
    }
    if (opts.capUsd !== undefined && !(opts.capUsd > 0)) throw new Error("cap must be above $0");
    // A run never grades itself unless it opts in (src/engine/benchmark-judge.ts).
    // Benchmarks no judge grades get none.
    const entry = benchmarkEntry(opts.benchmark);
    if (entry && benchmarkUsesJudge(entry)) {
      const defaultModel = this.defaultModel();
      const choice = resolveBenchmarkJudge({
        target: opts.model ?? "marina",
        ...(opts.judgeModel ? { judge: opts.judgeModel } : {}),
        ...(opts.selfJudge ? { selfJudge: true } : {}),
        ...(defaultModel ? { defaultModel } : {}),
      });
      if ("error" in choice) throw new Error(choice.error);
      opts = {
        ...opts,
        judgeModel: choice.model,
        selfJudge: choice.selfJudge === true ? true : undefined,
      };
    } else {
      opts = { ...opts, judgeModel: undefined, selfJudge: undefined };
    }
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
      summary: `benchmark ${opts.benchmark} started — limit=${config.limit} seed=${config.seed} ${config.targetKind === "crew" ? `crew=${crewOfTarget(config.model)}` : `model=${config.model} (control: bare model, no residents)`}`,
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
      targetKind: "crew" | "model";
      judgeModel?: string;
      selfJudge?: boolean;
      concurrency: number;
      lessons?: boolean;
      lessonsMode?: "measure" | "live";
    },
    started: number,
  ): Promise<void> {
    const resultFile = join(benchmarkResultsDir(), `${id}.json`);
    const target = this.target();
    const crewRun = config.targetKind === "crew";
    const grant = runKeyGrant(id, opts, config);
    const runKey = grant ? mintRunKey(grant) : undefined;
    const { args, env } = harnessInvocation(
      opts.benchmark,
      config,
      runKey ? { ...target, apiKey: runKey } : target,
      resultFile,
    );

    let harness: HarnessOutcome;
    try {
      // The harness and its datasets are paths in the checkout (MARINA_ROOT),
      // not in whatever directory the server was started from.
      const proc = Bun.spawn([...bunScriptArgv(), ...args], {
        cwd: MARINA_ROOT,
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
    // A run key measured a bare-model run's upstream spend exactly; without
    // one the harness's own usage report is the cost. A crew run's residents
    // spend on their own turns, outside the key: its cost comes from the
    // harness and the participants' reported costs instead.
    this.recordHarnessResult(id, opts, started, harness, {
      ...(keyState && !crewRun ? { costUsd: keyState.spentUsd } : {}),
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
      const crew = crewOfTarget(config.model);
      // A crew run: resolve who worked each item from its trace, exactly as a
      // filed run is (POST /v1/benchmarks/runs), so the residents' work reaches
      // route evidence per participant and role. A control has no residents.
      const resultItems = crew ? withParticipants(this.db, result.items ?? []) : result.items;
      const { run: ledger, items } = ledgerFromHarnessResult(
        {
          ...result,
          ...(resultItems ? { items: resultItems } : {}),
          config: { ...(result.config ?? {}), dataset: opts.benchmark },
        },
        {
          targetKind: crew ? "crew" : "model",
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

/**
 * The items with the participants their trace resolves to (and, for an
 * unpriced item, the cost those participants reported) — the same
 * resolution `POST /v1/benchmarks/runs` applies to a filed crew run.
 */
function withParticipants(
  db: MarinaDB,
  items: NonNullable<HarnessResultFile["items"]>,
): NonNullable<HarnessResultFile["items"]> {
  const traceIds = items.flatMap((it) => (typeof it.traceId === "string" ? [it.traceId] : []));
  if (traceIds.length === 0) return items;
  const resolved = resolveParticipants(db, traceIds);
  return items.map((it) => {
    const a = typeof it.traceId === "string" ? resolved.get(it.traceId) : undefined;
    if (!a) return it;
    return {
      ...it,
      ...(a.participants.length > 0 ? { participants: a.participants } : {}),
      ...(typeof it.usage?.costUsd !== "number" && a.costUsd !== null
        ? { usage: { costUsd: a.costUsd } }
        : {}),
    };
  });
}
