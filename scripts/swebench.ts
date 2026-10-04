#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * SWE-bench — a thin adapter over Marina's one-shot coding entry point.
 *
 *   bun run swebench export                                  task fields → <data>/verified.jsonl (once)
 *   bun run swebench subset --n 50 --seed 7                 seeded, repo-mixed instance ids
 *   bun run swebench run --arm single --model <m> --replicate 1 [--review-model <m2>] [--env-image]
 *   bun run swebench score --arm single --replicate 1       official harness, unmodified
 *   bun run swebench file --arm single --replicate 1        scored run → benchmark ledger
 *
 * `run` and `file` read the subset `subset` wrote, so give them the same `--n` and
 * `--seed` (or the same `--ids` file). `run` records the subset and configuration in
 * the replicate's `arm.json` and refuses to continue a replicate under a different
 * one; `file` takes the seed from there. `file` is idempotent: the ledger result's
 * timestamp is the last attempt's write, never the filing time, so filing a
 * finished replicate again is a no-op. `--mirror-cache <dir>` shares repository
 * mirrors across data directories (the reproduction kit's fresh run directories).
 *
 * Common flags: --data <dir> (default ~/.local/share/marina-swebench/data, outside the
 * repository), --instances <file.jsonl> (from benchmarks/swebench/export.py),
 * --concurrency N, --timeout-min M. `score` needs SWEBENCH_PYTHON (a Python with the
 * `swebench` package) and, for Podman, DOCKER_HOST pointing at the Podman socket.
 *
 * SWE-bench Pro: --benchmark pro (instances default to pro.jsonl, the ledger dataset is
 * swe-bench-pro) and `score --tasks <SWE-bench_Pro-os>/v2/tasks`, which grades with the
 * benchmark's own per-task verifier (benchmarks/swebench/pro_grade.py).
 * Nothing is submitted anywhere; leaderboard submission is a separate, approved act.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  attemptInstance,
  ledgerResult,
  loadInstances,
  SWE_BENCHMARKS,
  type SweArm,
  type SweAttempt,
  type SweBenchmark,
  selectSubset,
} from "../benchmarks/swebench/adapter";
import { SpendGuard } from "../src/engine/spend-guard";
import { projectSlug } from "./code";

const REPO_ROOT = resolve(import.meta.dir, "..");
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: "string", default: join(homedir(), ".local/share/marina-swebench/data") },
    instances: { type: "string" },
    n: { type: "string", default: "50" },
    seed: { type: "string", default: "7" },
    ids: { type: "string" },
    arm: { type: "string", default: "single" },
    model: { type: "string" },
    "review-model": { type: "string" },
    replicate: { type: "string", default: "1" },
    concurrency: { type: "string", default: "3" },
    "timeout-min": { type: "string", default: "25" },
    // A hard total for this run (every attempt, including ones already recorded):
    // each attempt gets an even share of what is left as its session's cap.
    "max-usd": { type: "string" },
    workers: { type: "string", default: "4" },
    db: { type: "string" },
    group: { type: "string" },
    // Opt-in: the agent's commands run inside the instance's environment image
    // (Marina's container runner), so it can run the project's existing tests.
    "env-image": { type: "boolean" },
    benchmark: { type: "string", default: "verified" },
    // SWE-bench Pro: the harness's v2 task directories (per-task verifier).
    tasks: { type: "string" },
    // Repository mirrors shared across data directories (symlinked as <data>/mirrors).
    "mirror-cache": { type: "string" },
  },
});
const cmd = positionals[0];
const benchmark = values.benchmark as SweBenchmark;
if (!Object.hasOwn(SWE_BENCHMARKS, benchmark)) {
  throw new Error(`--benchmark must be one of ${Object.keys(SWE_BENCHMARKS).join(", ")}`);
}
const dataDir = resolve(values.data as string);
const instancesPath = values.instances ?? join(dataDir, SWE_BENCHMARKS[benchmark].instances);
const idsPath = values.ids ?? join(dataDir, `subset-n${values.n}-s${values.seed}.txt`);
const replicate = Number(values.replicate);
const runDir = join(dataDir, "runs", `${values.arm}-r${replicate}`);

function armFromFlags(): SweArm {
  if (!values.model) throw new Error("--model is required");
  return {
    name: values.arm as string,
    model: values.model,
    ...(values["review-model"] ? { reviewModel: values["review-model"] } : {}),
  };
}

/** What `run` records in a replicate's arm.json: the arm, its mode and the exact subset. */
interface ArmRecord extends SweArm {
  replicate: number;
  /** The ids file the replicate attempts. */
  ids: string;
  /** The subset's seed and size; null when the ids were given explicitly. */
  seed: number | null;
  n: number | null;
  mode: "agentless" | "env-image";
  benchmark: SweBenchmark;
}

/**
 * The fields where a recorded replicate and this invocation differ — those that
 * make two invocations the same replicate. A field an older arm.json never
 * recorded is not compared (the review model always is: absent means none).
 */
function armMismatch(prior: Partial<ArmRecord>, next: ArmRecord): string[] {
  const keys = ["name", "model", "reviewModel", "ids", "seed", "n", "mode", "benchmark"] as const;
  return keys.filter(
    (k) =>
      (k === "reviewModel" || k in prior) &&
      JSON.stringify(prior[k] ?? null) !== JSON.stringify(next[k] ?? null),
  );
}

/** The ledger target: what was run — never the replicate number or a local path. */
function ledgerTarget(a: Partial<ArmRecord> & SweArm) {
  return {
    harness: "marina -p",
    name: a.name,
    model: a.model,
    ...(a.reviewModel ? { reviewModel: a.reviewModel } : {}),
    ...(a.mode === "env-image" ? { mode: "env-image" } : {}),
  };
}

/** Python with the `datasets` package (the swebench venv has it). */
function python(): string {
  const py = process.env.SWEBENCH_PYTHON;
  if (!py) throw new Error("SWEBENCH_PYTHON must point at a Python with the swebench package");
  return py;
}

const HF_DATASETS: Record<SweBenchmark, string> = {
  verified: "SWE-bench/SWE-bench_Verified",
  pro: "ScaleAI/SWE-bench_Pro",
};

async function exportCmd(): Promise<number> {
  if (existsSync(instancesPath)) {
    console.log(`${instancesPath} exists — not exported again`);
    return 0;
  }
  mkdirSync(dataDir, { recursive: true });
  const proc = Bun.spawn(
    [
      python(),
      join(REPO_ROOT, "benchmarks/swebench/export.py"),
      instancesPath,
      process.env.SWEBENCH_DATASET ?? HF_DATASETS[benchmark],
      "test",
    ],
    { cwd: REPO_ROOT, stdout: "inherit", stderr: "inherit" },
  );
  return proc.exited;
}

/** Point <data>/mirrors at a shared cache so a fresh data directory never re-clones. */
function linkMirrorCache(): void {
  const cache = values["mirror-cache"];
  if (!cache) return;
  const link = join(dataDir, "mirrors");
  if (existsSync(link)) return;
  mkdirSync(resolve(cache), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  symlinkSync(resolve(cache), link, "dir");
}

async function subsetCmd(): Promise<number> {
  const rows = loadInstances(instancesPath);
  const picked = selectSubset(rows, Number(values.n), Number(values.seed));
  writeFileSync(idsPath, `${picked.map((r) => r.instance_id).join("\n")}\n`);
  const repos = new Map<string, number>();
  for (const r of picked) repos.set(r.repo, (repos.get(r.repo) ?? 0) + 1);
  console.log(`${picked.length} ids → ${idsPath}`);
  console.log([...repos].map(([r, c]) => `${r}:${c}`).join(" "));
  return 0;
}

async function runCmd(): Promise<number> {
  const arm = armFromFlags();
  if (!existsSync(idsPath)) {
    throw new Error(
      `no subset ids at ${idsPath} — run \`subset\` with the same --n/--seed first, or pass --ids`,
    );
  }
  const ids = readFileSync(idsPath, "utf8").split("\n").filter(Boolean);
  const all = new Map(loadInstances(instancesPath).map((r) => [r.instance_id, r]));
  mkdirSync(runDir, { recursive: true });
  linkMirrorCache();
  const record: ArmRecord = {
    ...arm,
    replicate,
    ids: idsPath,
    seed: values.ids ? null : Number(values.seed),
    n: values.ids ? null : Number(values.n),
    mode: values["env-image"] ? "env-image" : "agentless",
    benchmark,
  };
  // A replicate continues only under its own configuration: attempts made by
  // another model, mode or subset must never be mixed into it.
  const armPath = join(runDir, "arm.json");
  if (existsSync(armPath) && existsSync(join(runDir, "attempts.jsonl"))) {
    const prior = JSON.parse(readFileSync(armPath, "utf8")) as Partial<ArmRecord>;
    const differs = armMismatch(prior, record);
    if (differs.length > 0) {
      throw new Error(
        `${runDir} holds attempts of another configuration (different ${differs.join(", ")}); use another --arm/--replicate or --data`,
      );
    }
  }
  writeFileSync(armPath, JSON.stringify(record, null, 2));
  const attemptsPath = join(runDir, "attempts.jsonl");
  const predsPath = join(runDir, "predictions.jsonl");
  const done = new Set(
    existsSync(attemptsPath)
      ? readFileSync(attemptsPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as SweAttempt).instance_id)
      : [],
  );
  const queue = ids.filter((id) => !done.has(id));
  console.log(`${arm.name} r${replicate}: ${queue.length} to run (${done.size} already done)`);
  const timeoutMs = Number(values["timeout-min"]) * 60_000;
  const concurrency = Number(values.concurrency);
  const maxUsd = values["max-usd"] === undefined ? undefined : Number(values["max-usd"]);
  if (maxUsd !== undefined && !(maxUsd >= 0))
    throw new Error("--max-usd must be a non-negative USD amount");
  const priorUsd = existsSync(attemptsPath)
    ? readFileSync(attemptsPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .reduce((t, l) => t + ((JSON.parse(l) as SweAttempt).costUsd ?? 0), 0)
    : 0;
  const budget = new SpendGuard({
    label: "--max-usd",
    ...(maxUsd !== undefined ? { budgetUsd: maxUsd } : {}),
    spentUsd: priorUsd,
    concurrency,
    daily: false, // each attempt's session keeps its own ledger
  });
  let running = 0;
  async function worker(): Promise<void> {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const inst = all.get(id);
      if (!inst) {
        console.error(`unknown instance ${id}`);
        continue;
      }
      // Split what is left among the attempts that may run at once.
      const share = budget.share(concurrency - running);
      if (!share) {
        console.error(
          `${id}: not started — --max-usd ${maxUsd} spent ($${budget.spentUsd.toFixed(2)})`,
        );
        queue.length = 0;
        return;
      }
      running++;
      let costUsd = 0;
      try {
        const { attempt, prediction } = await attemptInstance(inst, arm, {
          repoRoot: REPO_ROOT,
          dataDir,
          outDir: runDir,
          replicate,
          timeoutMs,
          slug: projectSlug,
          ...(values["env-image"] ? { mode: "env-image" as const } : {}),
          ...(Number.isFinite(share.capUsd) ? { capUsd: share.capUsd } : {}),
        });
        costUsd = attempt.costUsd;
        appendFileSync(predsPath, `${JSON.stringify(prediction)}\n`);
        appendFileSync(attemptsPath, `${JSON.stringify(attempt)}\n`);
        console.log(
          `${id}: exit ${attempt.exitCode}${attempt.reviewExitCode === undefined ? "" : `/${attempt.reviewExitCode}`} · patch ${attempt.patchBytes}B · $${attempt.costUsd.toFixed(3)} · ${Math.round(attempt.durationMs / 1000)}s`,
        );
      } catch (error) {
        console.error(`${id}: ${String(error).slice(0, 300)}`);
      } finally {
        running--;
        share.settle(costUsd);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return 0;
}

/** Where `score` leaves the Pro grader's report (`pro_grade.py --out`). */
const proReportDir = join(runDir, "pro-grade");

async function scoreCmd(): Promise<number> {
  const py = python();
  const preds = join(runDir, "predictions.jsonl");
  if (benchmark === "pro") {
    if (!values.tasks) throw new Error("--tasks <SWE-bench_Pro-os>/v2/tasks is required for Pro");
    const pro = Bun.spawn(
      [
        py,
        join(REPO_ROOT, "benchmarks/swebench/pro_grade.py"),
        "--tasks",
        resolve(values.tasks),
        "--predictions",
        preds,
        "--out",
        proReportDir,
        "--workers",
        String(values.workers),
      ],
      { cwd: runDir, stdout: "inherit", stderr: "inherit" },
    );
    return pro.exited;
  }
  const runId = `marina-${values.arm}-r${replicate}`;
  const proc = Bun.spawn(
    [
      py,
      "-m",
      "swebench.harness.run_evaluation",
      "--dataset_name",
      process.env.SWEBENCH_DATASET ?? "SWE-bench/SWE-bench_Verified",
      "--predictions_path",
      preds,
      "--max_workers",
      String(values.workers),
      "--run_id",
      runId,
      "--report_dir",
      runDir,
    ],
    { cwd: runDir, stdout: "inherit", stderr: "inherit" },
  );
  return proc.exited;
}

async function fileCmd(): Promise<number> {
  const arm = JSON.parse(readFileSync(join(runDir, "arm.json"), "utf8")) as Partial<ArmRecord> &
    SweArm;
  const reportName = `marina-${arm.name}-r${replicate}.marina-${values.arm}-r${replicate}.json`;
  const reportPath = [join(runDir, reportName), join(proReportDir, "report.json")].find((p) =>
    existsSync(p),
  );
  if (!reportPath) throw new Error(`no harness report in ${runDir} (run score first)`);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    resolved_ids?: string[];
    error_ids?: string[];
  };
  const attemptsPath = join(runDir, "attempts.jsonl");
  const attempts = readFileSync(attemptsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SweAttempt);
  // The ids this run was asked to attempt (recorded by `run` in arm.json): one with no
  // recorded attempt is filed as unresolved, never dropped.
  const armIds = arm.ids;
  const expectedIds =
    armIds && existsSync(armIds)
      ? readFileSync(armIds, "utf8").split("\n").filter(Boolean)
      : undefined;
  const result = ledgerResult(report, attempts, {
    arm,
    replicate,
    // The seed the replicate's subset was drawn with (recorded by `run`); an arm.json
    // from before that record falls back to the flag.
    subsetSeed: arm.seed !== undefined ? arm.seed : Number(values.seed),
    benchmark,
    ...(expectedIds ? { expectedIds } : {}),
    // The last attempt's write: fixed for a finished replicate, so re-filing is a no-op.
    completedAt: statSync(attemptsPath).mtimeMs,
  });
  const resultPath = join(runDir, "ledger-result.json");
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
  const cost = attempts.reduce((t, a) => t + a.costUsd, 0);
  console.log(
    `${arm.name} r${replicate}: ${result.items.filter((i) => i.correct).length}/${result.items.length} resolved · $${cost.toFixed(2)}`,
  );
  // Every replicate of one arm records the SAME target, so they pool (and promote) together.
  const target = JSON.stringify(ledgerTarget(arm));
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "scripts/benchmark-import.ts",
      resultPath,
      "--target-kind",
      arm.reviewModel ? "crew" : "model",
      "--target",
      target,
      "--label",
      `swebench-${arm.name}-r${replicate}`,
      "--judge",
      SWE_BENCHMARKS[benchmark].judge,
      "--cost-usd",
      cost.toFixed(4),
      "--group",
      values.group ?? `${benchmark === "pro" ? "swebench-pro" : "swebench"}-${arm.name}`,
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...(values.db ? { DB_PATH: values.db } : {}) },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  return proc.exited;
}

async function main(): Promise<number> {
  switch (cmd) {
    case "export":
      return exportCmd();
    case "subset":
      return subsetCmd();
    case "run":
      return runCmd();
    case "score":
      return scoreCmd();
    case "file":
      return fileCmd();
    default:
      console.error(
        "usage: bun run swebench export|subset|run|score|file [flags] (see scripts/swebench.ts)",
      );
      return 2;
  }
}

process.exit(await main());
