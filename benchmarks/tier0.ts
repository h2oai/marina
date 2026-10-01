#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tier-0 evaluation preset: a small, fixed, hard slice for crew and formation
 * sweeps.
 *
 *   bun run bench:tier0 --endpoint marina:<crew>                 # a crew on the local server
 *   bun run bench:tier0 --endpoint openrouter/<vendor>/<model>   # one model, direct
 *   bun run bench:tier0 --endpoint http://host:port --model <id> # any OpenAI-compatible /v1
 *
 * Sets (each a deterministic slice: same --seed ⇒ same items, same option order):
 *   hle-verified-gold  40 items   (--hle N)
 *   gpqa               40 items   (--gpqa N; gated — needs HF_TOKEN)
 *   frames             20 items   (--frames N; 0 skips)
 *
 * Each set runs as its own harness process and writes one result JSON into
 * --out-dir (default benchmarks/results/tier0-<label>-<timestamp>/), plus
 * summary.json. A set that fails (e.g. GPQA without HF_TOKEN) is reported and
 * the rest still run; the exit code is 1 if any set failed.
 *
 * Judge-scored items (HLE short answers, FRAMES) use --judge-model; the default
 * is the target model itself, except for `marina:<crew>` targets, which are
 * judged by `marina/default` so no crew grades its own answers and every crew in
 * a sweep shares one judge.
 *
 * Keys never go on the harness command line: the child gets MARINA_BENCH_API_KEY.
 * `marina:` targets use --api-key or MARINA_BENCH_API_KEY; `openrouter/` targets
 * use OPENROUTER_API_KEY. Compare two Tier-0 directories with
 * `bun run bench:compare <dirA> <dirB>`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { wilsonInterval } from "./stats";
import type { BenchmarkResult } from "./types";
import { formatUsd, totalCostUsd } from "./usage";

export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api";
export const DEFAULT_LOCAL_ENDPOINT = "http://localhost:3300";

export interface Tier0Target {
  endpoint: string;
  model: string;
  apiKey?: string;
  /** Filesystem-safe name for the output directory. */
  label: string;
  /** Judge model when `--judge-model` is not given (else the harness uses the target). */
  defaultJudgeModel?: string;
  /** Per-request timeout when `--timeout` is not given (else the harness default). */
  defaultTimeoutMs?: number;
}

/** The judge for `marina:<crew>` targets — the same model for every crew compared. */
export const MARINA_DEFAULT_JUDGE_MODEL = "marina/default";

/**
 * Per-request timeout for `marina:<crew>` targets. A crew deliberating on a
 * hard item legitimately takes minutes; a client that gives up first scores
 * an answer that was still on its way as wrong. The server bounds the same
 * request with its own MODEL_REQUEST_TIMEOUT_MS (600 s by default): raise that
 * too when a crew needs more than ten minutes.
 */
export const MARINA_TARGET_TIMEOUT_MS = 900_000;

const safeLabel = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);

/**
 * Resolve `--endpoint` into the harness endpoint, model and key.
 * `marina:<crew>` → the local server (or `--base`), model `marina:<crew>`;
 * `openrouter/<vendor>/<model>` → OpenRouter direct, model `<vendor>/<model>`;
 * anything else is an endpoint URL used with `--model`.
 */
export function resolveTier0Target(
  endpoint: string,
  opts: { model?: string; apiKey?: string; base?: string },
  env: Record<string, string | undefined>,
): Tier0Target {
  if (endpoint.startsWith("marina:")) {
    return {
      endpoint: opts.base ?? DEFAULT_LOCAL_ENDPOINT,
      model: endpoint,
      apiKey: opts.apiKey ?? env.MARINA_BENCH_API_KEY,
      label: safeLabel(endpoint),
      // A crew never grades itself: judge with the server's default model.
      defaultJudgeModel: MARINA_DEFAULT_JUDGE_MODEL,
      defaultTimeoutMs: MARINA_TARGET_TIMEOUT_MS,
    };
  }
  if (endpoint.startsWith("openrouter/")) {
    const model = endpoint.slice("openrouter/".length);
    if (!model) throw new Error("openrouter/ target needs a model: openrouter/<vendor>/<model>");
    return {
      endpoint: OPENROUTER_ENDPOINT,
      model,
      apiKey: opts.apiKey ?? env.OPENROUTER_API_KEY,
      label: safeLabel(endpoint),
    };
  }
  if (!/^https?:\/\//.test(endpoint)) {
    throw new Error(
      `unrecognized --endpoint "${endpoint}": use marina:<crew>, openrouter/<vendor>/<model>, or an http(s) URL`,
    );
  }
  const model = opts.model ?? "marina";
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    model,
    apiKey: opts.apiKey ?? env.MARINA_BENCH_API_KEY,
    label: safeLabel(model),
  };
}

export interface Tier0Set {
  benchmark: string;
  limit: number;
}

/** The Tier-0 sets with their item counts; a count of 0 drops the set. */
export function tier0Sets(
  counts: { hle?: number; gpqa?: number; frames?: number } = {},
): Tier0Set[] {
  const sets: Tier0Set[] = [
    { benchmark: "hle-verified-gold", limit: counts.hle ?? 40 },
    { benchmark: "gpqa", limit: counts.gpqa ?? 40 },
    { benchmark: "frames", limit: counts.frames ?? 20 },
  ];
  return sets.filter((s) => s.limit > 0);
}

/** Where (and as what) a Tier-0 run files into a Marina's benchmark ledger. */
export interface Tier0Filing {
  fileTo: string;
  targetKind: "model" | "crew" | "population";
  target: string;
  label: string;
}

/**
 * The ledger filing for a run. A `marina:<crew>` target files into its own
 * server by default — Marina ranks what it does — as a `crew`; any other
 * target files only when `--file-to` names a Marina, as a `model`. `--no-file`
 * turns filing off; `--target-kind` / `--target` override what is recorded.
 */
export function tier0Filing(
  target: Tier0Target,
  opts: { fileTo?: string; noFile?: boolean; targetKind?: string; target?: string; label?: string },
): Tier0Filing | undefined {
  if (opts.noFile) return undefined;
  const isCrew = target.model.startsWith("marina:");
  const fileTo = opts.fileTo ?? (isCrew ? target.endpoint : undefined);
  if (!fileTo) return undefined;
  const kind = (opts.targetKind ?? (isCrew ? "crew" : "model")) as Tier0Filing["targetKind"];
  const recorded =
    opts.target ??
    (isCrew ? JSON.stringify({ crew: target.model.slice("marina:".length) }) : target.model);
  return { fileTo, targetKind: kind, target: recorded, label: opts.label ?? target.label };
}

/** argv for one harness child. No key — that goes in the environment. */
export function tier0HarnessArgs(
  set: Tier0Set,
  target: Tier0Target,
  opts: {
    seed: number;
    concurrency: number;
    judgeModel?: string;
    judgeEndpoint?: string;
    timeoutMs?: number;
    filing?: Tier0Filing;
  },
): string[] {
  const args = [
    "run",
    join(import.meta.dir, "harness.ts"),
    "--benchmark",
    set.benchmark,
    "--limit",
    String(set.limit),
    "--seed",
    String(opts.seed),
    "--mode",
    "passthrough",
    "--concurrency",
    String(opts.concurrency),
    "--model",
    target.model,
    "--endpoint",
    target.endpoint,
  ];
  const judgeModel = opts.judgeModel ?? target.defaultJudgeModel;
  if (judgeModel) args.push("--judge-model", judgeModel);
  if (opts.judgeEndpoint) args.push("--judge-endpoint", opts.judgeEndpoint);
  const timeoutMs = opts.timeoutMs ?? target.defaultTimeoutMs;
  if (timeoutMs) args.push("--timeout", String(timeoutMs));
  if (opts.filing) {
    args.push(
      "--file-to",
      opts.filing.fileTo,
      "--target-kind",
      opts.filing.targetKind,
      "--target",
      opts.filing.target,
      "--label",
      opts.filing.label,
    );
  }
  return args;
}

export interface Tier0SetSummary {
  benchmark: string;
  status: "completed" | "failed";
  file?: string;
  n?: number;
  correct?: number;
  accuracy?: number;
  wilson?: { low: number; high: number };
  errors?: number;
  costUsd?: number;
  costPerItemUsd?: number;
  promptTokens?: number;
  completionTokens?: number;
  error?: string;
}

/** Summarize one finished set from its result JSON. Pure. */
export function summarizeSet(
  benchmark: string,
  file: string,
  result: BenchmarkResult,
): Tier0SetSummary {
  const items = result.items ?? [];
  const correct = items.filter((i) => i.correct).length;
  const n = items.length;
  const cost = totalCostUsd(result.metadata?.usage);
  return {
    benchmark,
    status: "completed",
    file,
    n,
    correct,
    accuracy: n > 0 ? correct / n : 0,
    wilson: wilsonInterval(correct, n),
    errors: items.filter((i) => i.actual?.startsWith("ERROR:")).length,
    costUsd: cost,
    costPerItemUsd: cost !== undefined && n > 0 ? cost / n : undefined,
    promptTokens: result.metadata?.usage?.promptTokens,
    completionTokens: result.metadata?.usage?.completionTokens,
  };
}

/**
 * The error message in a failed harness child's stderr: the last `error:` line
 * (Bun's thrown-error line), else the last non-stack line. Pure.
 */
export function failureReason(stderr: string): string | undefined {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const error = lines.filter((l) => /^(?:error|Error|Fatal error)\b.*:/.test(l)).pop();
  if (error) return error.replace(/^error:\s*/, "");
  return lines.filter((l) => !l.startsWith("at ") && !/^\d+ \|/.test(l)).pop();
}

/** The closing table. Pure. */
export function formatTier0Summary(target: Tier0Target, sets: Tier0SetSummary[]): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines = [`Tier 0 — ${target.model} @ ${target.endpoint}`];
  let total: number | undefined;
  for (const s of sets) {
    if (s.status === "failed") {
      lines.push(`  ${s.benchmark.padEnd(18)} FAILED — ${(s.error ?? "unknown").slice(0, 200)}`);
      continue;
    }
    if (s.costUsd !== undefined) total = (total ?? 0) + s.costUsd;
    const w = s.wilson ? `[${pct(s.wilson.low)}, ${pct(s.wilson.high)}]` : "";
    lines.push(
      `  ${s.benchmark.padEnd(18)} ${pct(s.accuracy ?? 0).padStart(6)} (${s.correct}/${s.n}) 95% Wilson ${w}` +
        `  cost ${formatUsd(s.costUsd)} (${formatUsd(s.costPerItemUsd)}/item)` +
        (s.errors ? `  errors ${s.errors}` : ""),
    );
  }
  lines.push(`  total cost ${formatUsd(total)}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      endpoint: { type: "string", short: "e" },
      model: { type: "string" },
      base: { type: "string" },
      "api-key": { type: "string", short: "k" },
      "judge-model": { type: "string" },
      "judge-endpoint": { type: "string" },
      seed: { type: "string", short: "s", default: "42" },
      concurrency: { type: "string", short: "c", default: "5" },
      hle: { type: "string" },
      gpqa: { type: "string" },
      frames: { type: "string" },
      timeout: { type: "string" },
      "out-dir": { type: "string" },
      "file-to": { type: "string" },
      "no-file": { type: "boolean" },
      "target-kind": { type: "string" },
      target: { type: "string" },
      label: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !values.endpoint) {
    console.log(
      "usage: bun run bench:tier0 --endpoint <marina:<crew> | openrouter/<vendor>/<model> | URL> [--model id] [--base url] [--seed 42] [--concurrency 5] [--hle 40] [--gpqa 40] [--frames 20] [--judge-model id] [--judge-endpoint url] [--timeout ms] [--out-dir dir] [--file-to url | --no-file] [--target-kind k] [--target json|id] [--label text]",
    );
    process.exit(values.help ? 0 : 1);
  }
  const target = resolveTier0Target(
    values.endpoint,
    { model: values.model, apiKey: values["api-key"], base: values.base },
    process.env,
  );
  const int = (v: string | undefined) => (v === undefined ? undefined : Number.parseInt(v, 10));
  const sets = tier0Sets({
    hle: int(values.hle),
    gpqa: int(values.gpqa),
    frames: int(values.frames),
  });
  const seed = int(values.seed) ?? 42;
  const concurrency = int(values.concurrency) ?? 5;
  const outDir =
    values["out-dir"] ?? join(import.meta.dir, "results", `tier0-${target.label}-${Date.now()}`);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const filing = tier0Filing(target, {
    fileTo: values["file-to"],
    noFile: values["no-file"],
    targetKind: values["target-kind"],
    target: values.target,
    label: values.label,
  });
  if (filing) console.log(`[tier0] filing each set into the ledger at ${filing.fileTo}`);

  const summaries: Tier0SetSummary[] = [];
  for (const set of sets) {
    const file = join(outDir, `${set.benchmark}.json`);
    console.log(`\n[tier0] ${set.benchmark} — ${set.limit} items, seed ${seed}`);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.MARINA_BENCH_RESULT_FILE = file;
    if (target.apiKey) env.MARINA_BENCH_API_KEY = target.apiKey;
    const proc = Bun.spawn(
      [
        "bun",
        ...tier0HarnessArgs(set, target, {
          seed,
          concurrency,
          judgeModel: values["judge-model"],
          judgeEndpoint: values["judge-endpoint"],
          timeoutMs: int(values.timeout),
          filing,
        }),
      ],
      { env, stdout: "inherit", stderr: "pipe" },
    );
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    if (stderr) process.stderr.write(stderr);
    if (code !== 0 || !existsSync(file)) {
      const reason = failureReason(stderr) ?? `exit ${code}`;
      summaries.push({ benchmark: set.benchmark, status: "failed", error: reason });
      continue;
    }
    const result = JSON.parse(readFileSync(file, "utf-8")) as BenchmarkResult;
    summaries.push(summarizeSet(set.benchmark, file, result));
  }

  writeFileSync(
    join(outDir, "summary.json"),
    JSON.stringify(
      { target: { endpoint: target.endpoint, model: target.model }, seed, sets: summaries },
      null,
      2,
    ),
  );
  console.log(`\n${formatTier0Summary(target, summaries)}`);
  console.log(`\n  Results: ${outDir}`);
  if (summaries.some((s) => s.status === "failed")) process.exit(1);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Fatal error:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
