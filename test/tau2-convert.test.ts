// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";
import {
  infrastructureErrors,
  passHatK,
  servedModel,
  type Tau2Results,
  tau2ToHarness,
} from "../benchmarks/tau2/convert";
import { ledgerFromHarnessResult } from "../src/engine/benchmark-ledger";

// Synthetic: 2 tasks × 2 trials; task 0 passes twice, task 1 once.
const results: Tau2Results = {
  timestamp: "2026-10-03T00:00:00Z",
  info: {
    git_commit: "abc",
    num_trials: 2,
    seed: 300,
    agent_info: { llm: "openai/marina/verify:openrouter/x/y" },
    user_info: { llm: "openai/openrouter/u/v" },
    environment_info: { domain_name: "airline" },
  },
  simulations: [
    {
      task_id: 0,
      trial: 0,
      duration: 2,
      agent_cost: 0.01,
      user_cost: 0.002,
      reward_info: { reward: 1 },
    },
    {
      task_id: 0,
      trial: 1,
      duration: 3,
      agent_cost: 0.01,
      user_cost: 0.002,
      reward_info: { reward: 1 },
    },
    {
      task_id: 1,
      trial: 0,
      duration: 4,
      agent_cost: 0.02,
      user_cost: 0.002,
      reward_info: { reward: 0 },
    },
    {
      task_id: 1,
      trial: 1,
      duration: 5,
      agent_cost: null,
      user_cost: null,
      reward_info: { reward: 1 },
    },
  ],
};

describe("tau2 adapter", () => {
  it("computes pass^k as τ² defines it", () => {
    expect(passHatK(results, 1)).toBeCloseTo(0.75, 9); // (1 + 0.5) / 2
    expect(passHatK(results, 2)).toBeCloseTo(0.5, 9); // (1 + 0) / 2
    expect(passHatK(results, 3)).toBeUndefined();
  });

  it("excludes infrastructure errors from pass^k and the ledger, as τ²'s metrics do", () => {
    const withErrors: Tau2Results = {
      ...results,
      simulations: [
        ...(results.simulations ?? []),
        { task_id: 2, trial: 0, termination_reason: "infrastructure_error", reward_info: null },
        { task_id: 2, trial: 1, termination_reason: "infrastructure_error", reward_info: null },
      ],
    };
    expect(infrastructureErrors(withErrors)).toBe(2);
    // Task 2 never ran: the score is the same as without it, not diluted by two zeros.
    expect(passHatK(withErrors, 1)).toBeCloseTo(0.75, 9);
    const h = tau2ToHarness(withErrors);
    expect(h.items?.length).toBe(4);
    expect(h.items?.some((i) => String(i.id).startsWith("2#"))).toBe(false);
    expect((h.config as Record<string, unknown>).infrastructureErrors).toBe(2);
  });

  it("--require-clean refuses to score or convert a run with infrastructure errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "tau2-clean-"));
    try {
      const dirty = join(dir, "dirty.json");
      const clean = join(dir, "clean.json");
      writeFileSync(
        dirty,
        JSON.stringify({
          ...results,
          simulations: [
            ...(results.simulations ?? []),
            { task_id: 2, trial: 0, termination_reason: "infrastructure_error", reward_info: null },
          ],
        }),
      );
      writeFileSync(clean, JSON.stringify(results));
      const script = join(import.meta.dir, "../scripts/tau2.ts");
      const run = (...args: string[]) =>
        spawnSync(["bun", script, ...args], { stdout: "pipe", stderr: "pipe" });
      for (const cmd of ["summary", "convert"]) {
        const out = join(dir, `${cmd}.ledger.json`);
        const r = run(cmd, dirty, "--out", out, "--require-clean");
        expect(r.exitCode).toBe(3);
        expect(r.stderr.toString()).toContain("INVALID: 1 infrastructure error(s)");
        expect(r.stdout.toString()).not.toContain("pass^");
        expect(existsSync(out)).toBe(false);
      }
      const ok = run("convert", clean, "--out", join(dir, "new", "ok.json"), "--require-clean");
      expect(ok.exitCode).toBe(0);
      expect(existsSync(join(dir, "new", "ok.json"))).toBe(true); // creates the directory
      // Without the flag the run still converts (errors excluded and reported).
      expect(run("summary", dirty).stdout.toString()).toContain("1 infrastructure error(s)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the model Marina served, not LiteLLM's routing prefix", () => {
    expect(servedModel("openai/marina/verify:openrouter/x/y")).toBe("marina/verify:openrouter/x/y");
    expect(servedModel("anthropic/claude")).toBe("anthropic/claude");
  });

  it("converts to ledger items (ids and outcomes only) that the ledger import accepts", () => {
    const h = tau2ToHarness(results);
    expect(h.config?.dataset).toBe("tau2-airline");
    expect(h.items?.map((i) => i.id)).toEqual(["0#0", "0#1", "1#0", "1#1"]);
    expect(h.items?.map((i) => i.correct)).toEqual([true, true, false, true]);
    expect(h.items?.[3]?.usage).toBeUndefined();
    const { run, items } = ledgerFromHarnessResult(h, {
      targetKind: "model",
      target: "marina/verify:openrouter/x/y",
      raw: JSON.stringify(h),
      id: "bench_test",
      now: 1,
    });
    expect(items.length).toBe(4);
    expect(run).toBeDefined();
    expect(JSON.stringify(h)).not.toContain("api_key");
  });
});
