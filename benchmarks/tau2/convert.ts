// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * τ²-bench results → Marina's benchmark ledger. A thin adapter: τ²-bench runs
 * unmodified (its own CLI, agent scaffold, user simulator and evaluator) with
 * its agent and user models pointed at a Marina `/v1`; this module only reads
 * the official `results.json` it writes.
 *
 * Each (task, trial) simulation becomes one ledger item `<task>#<trial>`:
 * correct when the official reward is 1, score = the reward. Conversation text,
 * task instructions and simulator prompts are never copied — ids and outcomes
 * only, like every ledger import.
 */

import type { HarnessResultFile } from "../../src/engine/benchmark-ledger";

/** The subset of τ²'s `results.json` this adapter reads. */
export interface Tau2Results {
  timestamp?: string;
  info?: {
    git_commit?: string;
    num_trials?: number;
    seed?: number;
    agent_info?: { llm?: string; implementation?: string };
    user_info?: { llm?: string; implementation?: string };
    environment_info?: { domain_name?: string };
  };
  simulations?: Array<{
    task_id?: string | number;
    trial?: number;
    duration?: number;
    agent_cost?: number | null;
    user_cost?: number | null;
    termination_reason?: string;
    reward_info?: { reward?: number } | null;
  }>;
}

/** Strip LiteLLM's `openai/` routing prefix so the ledger names the model Marina served. */
export function servedModel(llm: string | undefined): string {
  if (!llm) return "unknown";
  return llm.startsWith("openai/") ? llm.slice("openai/".length) : llm;
}

/** pass^k: mean over tasks of C(c, k) / C(n, k) (c successes in n trials), as τ² defines it. */
export function passHatK(results: Tau2Results, k: number): number | undefined {
  const byTask = new Map<string, { n: number; c: number }>();
  for (const s of results.simulations ?? []) {
    const id = String(s.task_id);
    const t = byTask.get(id) ?? { n: 0, c: 0 };
    t.n += 1;
    if ((s.reward_info?.reward ?? 0) >= 1 - 1e-9) t.c += 1;
    byTask.set(id, t);
  }
  const comb = (n: number, r: number): number => {
    if (r < 0 || r > n) return 0;
    let v = 1;
    for (let i = 1; i <= r; i++) v = (v * (n - r + i)) / i;
    return v;
  };
  const vals = [...byTask.values()].filter((t) => t.n >= k).map((t) => comb(t.c, k) / comb(t.n, k));
  if (vals.length === 0) return undefined;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/**
 * Convert to the harness result shape `bun run benchmark:import` reads.
 * `benchmark` defaults to `tau2-<domain>`.
 */
export function tau2ToHarness(
  results: Tau2Results,
  opts: { benchmark?: string } = {},
): HarnessResultFile {
  const domain = results.info?.environment_info?.domain_name ?? "unknown";
  const sims = results.simulations ?? [];
  const items = sims.map((s) => {
    const reward = s.reward_info?.reward ?? 0;
    const cost = (s.agent_cost ?? 0) + (s.user_cost ?? 0);
    return {
      id: `${String(s.task_id)}#${s.trial ?? 0}`,
      correct: reward >= 1 - 1e-9,
      score: reward,
      ...(typeof s.duration === "number" ? { latencyMs: Math.round(s.duration * 1000) } : {}),
      ...(s.agent_cost != null || s.user_cost != null ? { usage: { costUsd: cost } } : {}),
    };
  });
  const totalMs = sims.reduce((t, s) => t + (s.duration ?? 0) * 1000, 0);
  return {
    config: {
      dataset: opts.benchmark ?? `tau2-${domain}`,
      model: servedModel(results.info?.agent_info?.llm),
      ...(results.info?.seed !== undefined ? { seed: results.info.seed } : {}),
      judge: {
        model: `tau2 official evaluator; user ${servedModel(results.info?.user_info?.llm)}`,
      },
      tau2Commit: results.info?.git_commit,
      trials: results.info?.num_trials,
    },
    timestamp: results.timestamp ? Date.parse(results.timestamp) || Date.now() : Date.now(),
    duration_ms: Math.round(totalMs),
    items,
  };
}
