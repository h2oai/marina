#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * SWE-bench — a thin adapter over Marina's one-shot coding entry point.
 *
 *   bun run swebench subset --n 50 --seed 7                 seeded, repo-mixed instance ids
 *   bun run swebench run --arm single --model <m> --replicate 1 [--review-model <m2>]
 *   bun run swebench score --arm single --replicate 1       official harness, unmodified
 *   bun run swebench file --arm single --replicate 1        scored run → benchmark ledger
 *
 * Common flags: --data <dir> (default ~/.local/share/marina-swebench/data, outside the
 * repository), --instances <file.jsonl> (from benchmarks/swebench/export.py),
 * --concurrency N, --timeout-min M. `score` needs SWEBENCH_PYTHON (a Python with the
 * `swebench` package) and, for Podman, DOCKER_HOST pointing at the Podman socket.
 * Nothing is submitted anywhere; leaderboard submission is a separate, approved act.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  attemptInstance,
  ledgerResult,
  loadInstances,
  type SweArm,
  type SweAttempt,
  selectSubset,
} from "../benchmarks/swebench/adapter";
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
    workers: { type: "string", default: "4" },
    db: { type: "string" },
    group: { type: "string" },
  },
});
const cmd = positionals[0];
const dataDir = resolve(values.data as string);
const instancesPath = values.instances ?? join(dataDir, "verified.jsonl");
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
  const ids = readFileSync(idsPath, "utf8").split("\n").filter(Boolean);
  const all = new Map(loadInstances(instancesPath).map((r) => [r.instance_id, r]));
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "arm.json"),
    JSON.stringify({ ...arm, replicate, ids: idsPath }, null, 2),
  );
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
  async function worker(): Promise<void> {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const inst = all.get(id);
      if (!inst) {
        console.error(`unknown instance ${id}`);
        continue;
      }
      try {
        const { attempt, prediction } = await attemptInstance(inst, arm, {
          repoRoot: REPO_ROOT,
          dataDir,
          outDir: runDir,
          replicate,
          timeoutMs,
          slug: projectSlug,
        });
        appendFileSync(predsPath, `${JSON.stringify(prediction)}\n`);
        appendFileSync(attemptsPath, `${JSON.stringify(attempt)}\n`);
        console.log(
          `${id}: exit ${attempt.exitCode}${attempt.reviewExitCode === undefined ? "" : `/${attempt.reviewExitCode}`} · patch ${attempt.patchBytes}B · $${attempt.costUsd.toFixed(3)} · ${Math.round(attempt.durationMs / 1000)}s`,
        );
      } catch (error) {
        console.error(`${id}: ${String(error).slice(0, 300)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Number(values.concurrency) }, () => worker()));
  return 0;
}

async function scoreCmd(): Promise<number> {
  const py = process.env.SWEBENCH_PYTHON;
  if (!py) throw new Error("SWEBENCH_PYTHON must point at a Python with the swebench package");
  const preds = join(runDir, "predictions.jsonl");
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
  const arm = JSON.parse(readFileSync(join(runDir, "arm.json"), "utf8")) as SweArm;
  const reportName = `marina-${arm.name}-r${replicate}.marina-${values.arm}-r${replicate}.json`;
  const reportPath = [join(runDir, reportName)].find((p) => existsSync(p));
  if (!reportPath) throw new Error(`no harness report in ${runDir} (run score first)`);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as { resolved_ids?: string[] };
  const attempts = readFileSync(join(runDir, "attempts.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SweAttempt);
  const result = ledgerResult(report, attempts, {
    arm,
    replicate,
    subsetSeed: Number(values.seed),
  });
  const resultPath = join(runDir, "ledger-result.json");
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
  const cost = attempts.reduce((t, a) => t + a.costUsd, 0);
  console.log(
    `${arm.name} r${replicate}: ${result.items.filter((i) => i.correct).length}/${result.items.length} resolved · $${cost.toFixed(2)}`,
  );
  const target = JSON.stringify({ harness: "marina -p", ...arm });
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
      "swebench-harness",
      "--cost-usd",
      cost.toFixed(4),
      "--group",
      values.group ?? `swebench-${arm.name}`,
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
        "usage: bun run swebench subset|run|score|file [flags] (see scripts/swebench.ts)",
      );
      return 2;
  }
}

process.exit(await main());
