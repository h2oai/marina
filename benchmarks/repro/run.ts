// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Executes a reproduction `Plan`: boots isolated Marina servers (each with its
 * own database under the run directory), runs the commands with scratch on disk,
 * stops servers, and prints pooled comparisons from the ledger. A fresh random
 * key replaces `$LEDGER_KEY` everywhere and is never printed.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Subprocess, spawn, spawnSync } from "bun";
import {
  comparePooledGroups,
  loadReplicateGroup,
  replicateGroupOf,
} from "../../src/engine/benchmark-replicates";
import { MarinaDB } from "../../src/persistence/database";
import type { CompareStep, Plan, ServerStep, Step } from "./types";

const REPO = resolve(import.meta.dir, "../..");

/** Plan as text — the dry run, and the header of a real run. Never prints key values. */
export function renderPlan(plan: Plan, budgetUsd: number): string {
  const lines = [
    `Setup: ${plan.setup}   tier: ${plan.tier}   arms: ${plan.arms.join(", ")}`,
    `Items per arm and replicate: ${plan.limit || "all resolved"}   replicates: ${plan.replicates}`,
    `Estimated spend: $${plan.estimateUsd.toFixed(2)} (budget $${budgetUsd.toFixed(2)})`,
    ...plan.armNotes.map((n) => `  - ${n}`),
  ];
  if (plan.labels.length) lines.push(`Labels: ${plan.labels.join("; ")}`);
  lines.push("", "Steps:");
  for (const [i, s] of plan.steps.entries()) lines.push(`  ${i + 1}. ${describeStep(s)}`);
  return lines.join("\n");
}

function describeStep(s: Step): string {
  switch (s.kind) {
    case "server":
      return `server ${s.id} :${s.port} (world ${s.world}${s.operator?.length ? `, ${s.operator.length} operator command(s)` : ""})`;
    case "command":
      return `${s.label}\n       $ ${s.argv.map(redactArg).join(" ")}`;
    case "compare":
      return `compare ${s.a} vs ${s.b} (${s.benchmark}, pooled)`;
    case "stop":
      return `stop ${s.id}`;
  }
}

function redactArg(a: string): string {
  return a.replaceAll("$LEDGER_KEY", "<ledger key>");
}

/** Refuse when the estimate exceeds the budget (a dry run still prints). */
export function budgetRefusal(plan: Plan, budgetUsd: number): string | undefined {
  if (!(budgetUsd >= 0)) return "budget must be a non-negative number of USD";
  if (plan.estimateUsd > budgetUsd) {
    return `estimated $${plan.estimateUsd.toFixed(2)} exceeds --budget-usd ${budgetUsd.toFixed(2)}; lower --limit/--replicates or raise the budget`;
  }
  return undefined;
}

function expand(value: string, vars: Record<string, string>): string {
  return value.replace(/\$(LEDGER_KEY|TAU2_HOME)\b/g, (_, k: string) => vars[k] ?? "");
}

async function waitFor(url: string, key: string, want: string | undefined, seconds: number) {
  for (let i = 0; i < seconds; i++) {
    try {
      const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      if (health.ok) {
        if (!want) return true;
        const models = await fetch(`${url}/v1/models`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(2000),
        });
        if (models.ok && (await models.text()).includes(`"${want}"`)) return true;
      }
    } catch {
      // allow-empty-catch: not up yet; retried until the deadline
    }
    await Bun.sleep(1000);
  }
  return false;
}

export interface RunOptions {
  runDir: string;
  ledgerDb: string;
  /** Inherited environment (the operator's .env); keys stay in the child env only. */
  env: Record<string, string | undefined>;
  log?: (line: string) => void;
}

export async function executePlan(plan: Plan, opts: RunOptions): Promise<number> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const key = randomBytes(24).toString("base64url");
  const vars = { LEDGER_KEY: key, TAU2_HOME: opts.env.TAU2_HOME ?? "" };
  const scratch = join(opts.runDir, "tmp");
  mkdirSync(scratch, { recursive: true });
  mkdirSync(join(opts.runDir, "servers"), { recursive: true });
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env)) if (v !== undefined) baseEnv[k] = v;
  // Scratch on disk, never a tmpfs.
  baseEnv.TMPDIR = scratch;
  const servers = new Map<string, Subprocess>();
  let failures = 0;
  const stop = async (id: string) => {
    const proc = servers.get(id);
    if (!proc) return;
    proc.kill();
    await Promise.race([proc.exited, Bun.sleep(30_000)]);
    if (proc.exitCode === null) proc.kill(9);
    servers.delete(id);
  };
  try {
    for (const step of plan.steps) {
      if (step.kind === "server") {
        if (!(await startServer(step, baseEnv, vars, opts, servers, log))) {
          failures++;
          log(`! server ${step.id} did not come up; skipping its commands`);
        }
      } else if (step.kind === "command") {
        if (step.needs?.some((id) => !servers.has(id))) {
          log(`- skip ${step.label} (server not running)`);
          failures++;
          continue;
        }
        log(`> ${step.label}`);
        const env = { ...baseEnv };
        for (const [k, v] of Object.entries(step.env ?? {})) env[k] = expand(v, vars);
        const res = spawnSync(
          step.argv.map((a) => expand(a, vars)),
          {
            cwd: step.cwd ? expand(step.cwd, vars) : REPO,
            env,
            stdout: "inherit",
            stderr: "inherit",
          },
        );
        if (res.exitCode !== 0) {
          failures++;
          log(`! ${step.label} exited ${res.exitCode}`);
        }
      } else if (step.kind === "stop") {
        await stop(step.id);
      } else {
        log(renderComparison(step, opts.ledgerDb));
      }
    }
  } finally {
    for (const id of [...servers.keys()]) await stop(id);
  }
  return failures ? 1 : 0;
}

async function startServer(
  step: ServerStep,
  baseEnv: Record<string, string>,
  vars: Record<string, string>,
  opts: RunOptions,
  servers: Map<string, Subprocess>,
  log: (l: string) => void,
): Promise<boolean> {
  const db = join(opts.runDir, "servers", `${step.id}.db`);
  const env: Record<string, string> = {
    ...baseEnv,
    WS_PORT: String(step.port),
    MCP_PORT: "0",
    LOG_PORT: "0",
    TELNET_PORT: "0",
    DB_PATH: db,
    ASSETS_DIR: join(opts.runDir, "servers", `${step.id}-assets`),
  };
  for (const [k, v] of Object.entries(step.env)) env[k] = expand(v, vars);
  const out = openSync(join(opts.runDir, "servers", `${step.id}.log`), "a");
  log(`> server ${step.id} :${step.port}`);
  const proc = spawn(["bun", "run", "src/main.ts"], { cwd: REPO, env, stdout: out, stderr: out });
  servers.set(step.id, proc);
  const url = `http://localhost:${step.port}`;
  if (!(await waitFor(url, vars.LEDGER_KEY ?? "", step.waitModel, step.waitModel ? 240 : 90))) {
    return false;
  }
  for (const cmd of step.operator ?? []) {
    spawnSync(["bun", "run", "scripts/connect.ts", "Operator", "-c", cmd, "--wait", "8"], {
      cwd: REPO,
      env: { ...env, MARINA_URL: `ws://localhost:${step.port}` },
      stdout: "ignore",
      stderr: "ignore",
    });
  }
  return true;
}

/** Pooled A − B comparison of two replicate groups in the ledger. */
export function renderComparison(step: CompareStep, ledgerDb: string): string {
  const db = new MarinaDB(ledgerDb);
  try {
    const runs = db.queryBenchmarkRuns({ limit: 10_000 });
    const pick = (group: string) => runs.find((r) => replicateGroupOf(r) === group);
    const a = pick(step.a);
    const b = pick(step.b);
    if (!a || !b) return `compare ${step.a} vs ${step.b}: missing runs in the ledger`;
    const ga = loadReplicateGroup(db, a);
    const gb = loadReplicateGroup(db, b);
    const c = comparePooledGroups(ga, gb);
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    return [
      `Compare ${step.a} (A) vs ${step.b} (B) on ${c.items} shared items`,
      `  A ${pct(c.a.meanAccuracy)} over ${c.a.replicates} run(s)   B ${pct(c.b.meanAccuracy)} over ${c.b.replicates} run(s)`,
      `  A − B ${pct(c.delta)}  95% [${pct(c.low)}, ${pct(c.high)}]  p=${c.p.toFixed(3)}${c.replicated ? "" : "  (not replicated — run --replicates 2+)"}`,
    ].join("\n");
  } finally {
    db.close();
  }
}
