// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * In-world access to the reproduction kit (`benchmarks/repro/`, `bun run
 * repro`): list its setups, check prerequisites, print a plan, and launch a
 * run as a tracked background job that files into THIS world's ledger.
 *
 * The kit stays the one implementation — isolated Marina servers per arm,
 * third-party harnesses (τ², SWE-bench …), budget refusal on its estimate,
 * pooled comparisons. This module only launches it: allowlisted flags, each
 * value checked, passed as an argv array (never a shell), the job's output in
 * a log file under its run directory.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getErrorMessage } from "./errors";

/** Repository root (the kit and `scripts/repro.ts` live under it). */
const REPO = resolve(import.meta.dir, "../..");

/** Flags the in-world command may pass to the kit, and the kit's spelling of each. */
export const KIT_FLAGS: Record<string, string> = {
  arm: "--arm",
  arms: "--arm",
  replicates: "--replicates",
  limit: "--limit",
  budget: "--budget-usd",
  model: "--model",
  checker: "--checker",
  judge: "--judge",
  domain: "--domain",
  split: "--split",
  effort: "--effort",
  "user-effort": "--user-effort",
  "task-ids": "--task-ids",
  seed: "--seed",
};

const SAFE_VALUE = /^[A-Za-z0-9._:/@,+-]{1,200}$/;
const SAFE_SETUP = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * The kit argv for `<setup>` and the given `key → value` flags; an error when a
 * flag is not allowed or a value is not a plain token.
 */
export function kitArgs(
  setup: string,
  flags: Record<string, string>,
  extra: string[] = [],
): string[] | { error: string } {
  if (!SAFE_SETUP.test(setup)) return { error: `"${setup}" is not a setup name` };
  const argv = [setup];
  for (const [key, value] of Object.entries(flags)) {
    const flag = KIT_FLAGS[key];
    if (!flag)
      return { error: `unknown option ${key}: (allowed: ${Object.keys(KIT_FLAGS).join(", ")})` };
    const plain = value.replace(/^\$/, "");
    if (!SAFE_VALUE.test(plain)) return { error: `${key}: must be a plain value` };
    argv.push(flag, plain);
  }
  return [...argv, ...extra];
}

/** Where kit runs live: `MARINA_BENCHMARK_KIT_DIR`, else beside the world DB. */
export function kitRunRoot(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.MARINA_BENCHMARK_KIT_DIR?.trim();
  if (set) return set;
  const db = env.DB_PATH?.trim();
  return db ? join(dirname(resolve(db)), "kit-runs") : join(homedir(), ".local/share/marina-repro");
}

/** The world DB the kit files into (`DB_PATH`, as the server resolved it). */
export function worldLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.DB_PATH?.trim() || "marina.db");
}

/** Run a short kit command (list, doctor, a dry-run plan) and return its output. */
export async function kitCapture(
  argv: string[],
  timeoutMs = 120_000,
): Promise<{ code: number; output: string }> {
  try {
    const proc = Bun.spawn(["bun", "run", "scripts/repro.ts", ...argv], {
      cwd: REPO,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(timer);
    return { code, output: `${out}${err ? `\n${err}` : ""}`.trim() };
  } catch (error) {
    return { code: 1, output: getErrorMessage(error) };
  }
}

export interface KitJob {
  id: string;
  setup: string;
  owner: string;
  argv: string[];
  runDir: string;
  logFile: string;
  startedAt: number;
  status: "running" | "completed" | "failed";
  exitCode?: number;
  finishedAt?: number;
}

const jobs = new Map<string, KitJob>();

export function listKitJobs(): KitJob[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function getKitJob(id: string): KitJob | undefined {
  return jobs.get(id);
}

/** Last `lines` lines of a job's log. */
export function kitLogTail(job: KitJob, lines = 15): string {
  if (!existsSync(job.logFile)) return "";
  const text = readFileSync(job.logFile, "utf8").trimEnd().split("\n");
  return text.slice(-lines).join("\n");
}

/**
 * Launch a kit run in the background. Its runs file into the world ledger, so
 * `benchmark runs` / `compare` / `replicates` read them like any run. `onExit`
 * fires once with the finished job.
 */
export function startKitJob(opts: {
  setup: string;
  argv: string[];
  owner: string;
  onExit?: (job: KitJob) => void;
  env?: NodeJS.ProcessEnv;
}): KitJob {
  const env = opts.env ?? process.env;
  const id = `kit_${opts.setup}_${Date.now().toString(36)}`;
  const runDir = join(kitRunRoot(env), id);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const logFile = join(runDir, "kit.log");
  const argv = [...opts.argv, "--run-dir", runDir, "--ledger", worldLedgerPath(env)];
  const job: KitJob = {
    id,
    setup: opts.setup,
    owner: opts.owner,
    argv,
    runDir,
    logFile,
    startedAt: Date.now(),
    status: "running",
  };
  jobs.set(id, job);
  const fd = openSync(logFile, "a");
  const proc = Bun.spawn(["bun", "run", "scripts/repro.ts", ...argv], {
    cwd: REPO,
    env,
    stdout: fd,
    stderr: fd,
  });
  void proc.exited.then((code) => {
    closeSync(fd);
    job.exitCode = code;
    job.finishedAt = Date.now();
    job.status = code === 0 ? "completed" : "failed";
    opts.onExit?.(job);
  });
  return job;
}

/** Test seam. */
export function resetKitJobsForTests(): void {
  jobs.clear();
}
