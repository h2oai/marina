#!/usr/bin/env bun

// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reproduce a published Marina benchmark setup with one command.
 *
 *   bun run repro doctor [setup]                 prerequisites, each with the exact fix
 *   bun run repro list                           setups, arms, smoke and full sizes
 *   bun run repro <setup> --dry-run              the plan and estimated spend, no model calls
 *   bun run repro <setup> [--arm a,b] [--replicates 2] [--limit N] [--budget-usd 10]
 *                         [--model m] [--checker m] [--judge m] [--domain d] [--env-image]
 *                         [--split test] [--effort high] [--user-effort low]   (τ²)
 *                         [--retrieval-config alltools]   (τ³ banking_knowledge)
 *                         [--task-ids a,b,c]   (τ²: a fixed task subset, ids only)
 *
 * Setups: hle-verified, swebench-verified, tau2, futurex-backtest, arena-backtest.
 * Runs live under --run-dir (default ~/.local/share/marina-repro/<setup>-<time>), on
 * disk; every run files into --ledger (default <run-dir>/ledger.db) and the
 * comparison is printed from it. Keys are read from .env and never printed.
 * Nothing is submitted to any leaderboard.
 */

import { existsSync, readFileSync, statfsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "bun";
import { blocking, doctor, type Probe, renderChecks } from "../benchmarks/repro/doctor";
import { budgetRefusal, executePlan, renderPlan } from "../benchmarks/repro/run";
import { SETUPS, setupNamed } from "../benchmarks/repro/setups";
import type { ReproFlags } from "../benchmarks/repro/types";
import { parseServerEnv } from "../src/engine/feature-env";

const FS_TYPES: Record<number, string> = { 16914836: "tmpfs", 2240043254: "ramfs" };

export function nodeProbe(env: Record<string, string | undefined>): Probe {
  return {
    env,
    which: (cmd) => spawnSync(["sh", "-c", `command -v ${cmd}`]).exitCode === 0,
    run(cmd) {
      try {
        const r = spawnSync(cmd, {
          stdout: "pipe",
          stderr: "ignore",
          env: env as Record<string, string>,
        });
        return r.exitCode === 0 ? r.stdout.toString() : undefined;
      } catch {
        return undefined;
      }
    },
    readFile(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    disk(path) {
      try {
        const s = statfsSync(path);
        return {
          freeBytes: s.bavail * s.bsize,
          fsType: FS_TYPES[s.type] ?? `0x${s.type.toString(16)}`,
        };
      } catch {
        return undefined;
      }
    },
    exists: existsSync,
    home: homedir(),
    user: userInfo().username,
  };
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      arm: { type: "string" },
      replicates: { type: "string", default: "2" },
      limit: { type: "string" },
      "budget-usd": { type: "string", default: "10" },
      model: { type: "string" },
      checker: { type: "string" },
      judge: { type: "string" },
      domain: { type: "string" },
      split: { type: "string" },
      effort: { type: "string" },
      "user-effort": { type: "string" },
      "retrieval-config": { type: "string" },
      "task-ids": { type: "string" },
      "env-image": { type: "boolean" },
      seed: { type: "string", default: "42" },
      "run-dir": { type: "string" },
      ledger: { type: "string" },
      "server-env": { type: "string", multiple: true },
      review: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const [cmd, arg] = positionals;
  if (!cmd || values.help) {
    console.log(
      "usage: bun run repro doctor [setup] | list | <setup> [--dry-run] … (see scripts/repro.ts)",
    );
    return cmd ? 0 : 2;
  }
  const env = process.env as Record<string, string | undefined>;
  const probe = nodeProbe(env);

  if (cmd === "list") {
    for (const s of SETUPS) {
      console.log(`${s.name} — ${s.summary}`);
      console.log(
        `  arms: ${s.arms.map((a) => (a.optIn ? `${a.name} (--arm only)` : a.name)).join(", ")}   smoke ${s.smoke || "all"} · full ${s.full || "all"}`,
      );
    }
    return 0;
  }

  if (cmd === "doctor") {
    const setup = arg ? setupNamed(arg) : undefined;
    if (arg && !setup) throw new Error(`unknown setup ${arg}`);
    const { tier, checks } = doctor(probe, {
      runDir: join(homedir(), ".local/share/marina-repro"),
      ...(setup ? { only: setup.requires } : {}),
    });
    console.log(renderChecks(tier, checks));
    return blocking(checks).length ? 1 : 0;
  }

  const setup = setupNamed(cmd);
  if (!setup) {
    throw new Error(`unknown setup ${cmd} — choose from ${SETUPS.map((s) => s.name).join(", ")}`);
  }
  const runDir =
    values["run-dir"] ??
    join(
      homedir(),
      ".local/share/marina-repro",
      `${setup.name}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    );
  const flags: ReproFlags = {
    ...(values.arm ? { arms: values.arm.split(",").map((s) => s.trim()) } : {}),
    replicates: Math.max(1, Number(values.replicates) || 1),
    ...(values.limit ? { limit: Math.max(1, Number(values.limit)) } : {}),
    budgetUsd: Number(values["budget-usd"]),
    ...(values.model ? { model: values.model } : {}),
    ...(values.checker ? { checker: values.checker } : {}),
    ...(values.judge ? { judge: values.judge } : {}),
    ...(values.domain ? { domain: values.domain } : {}),
    ...(values.split ? { split: values.split } : {}),
    ...(values.effort ? { effort: values.effort } : {}),
    ...(values["user-effort"] ? { userEffort: values["user-effort"] } : {}),
    ...(values["retrieval-config"] ? { retrievalConfig: values["retrieval-config"] } : {}),
    ...(values["task-ids"]
      ? {
          taskIds: values["task-ids"]
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        }
      : {}),
    ...(values["env-image"] ? { envImage: true } : {}),
    seed: Number(values.seed) || 42,
    runDir,
    ledgerDb: values.ledger ?? join(runDir, "ledger.db"),
    ...(values["server-env"]?.length ? { serverEnv: parseServerEnv(values["server-env"]) } : {}),
    ...(values.review ? { review: values.review } : {}),
  };
  const { tier } = doctor(probe, { runDir: homedir(), only: setup.requires });
  const plan = setup.plan(flags, tier);
  // A plan may need more than its setup's defaults (τ³ banking needs the shell sandbox).
  const { checks } = doctor(probe, { runDir: homedir(), only: plan.requires });
  console.log(renderPlan(plan, flags.budgetUsd));
  if (values["dry-run"]) return 0;
  const missing = blocking(checks);
  if (missing.length) {
    console.log(`\nMissing prerequisites:\n${renderChecks(tier, missing)}`);
    return 1;
  }
  const refusal = budgetRefusal(plan, flags.budgetUsd);
  if (refusal) {
    console.log(`\n${refusal}`);
    return 1;
  }
  return executePlan(plan, {
    runDir,
    ledgerDb: flags.ledgerDb,
    env,
    ...(flags.serverEnv ? { serverEnv: flags.serverEnv } : {}),
  });
}

if (import.meta.main) process.exit(await main());
