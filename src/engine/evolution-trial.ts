// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `evolve trial` — measure a candidate role against the incumbent, side by
 * side, without adopting anything:
 *
 *   1. spawn a temporary agent on each role (same model, same budget)
 *   2. give each its own model channel (`model-trial-<run>-<arm>`), joined in
 *      code — nothing depends on the agent choosing to join
 *   3. run the same benchmark on both (same items, same seed); each run records
 *      the agent, role and system-prompt hash it measured (#140)
 *   4. wait with a deadline — a stalled or spend-capped arm fails, never hangs
 *   5. tear both agents and channels down, and report the two run ids, which
 *      an evaluator then cites: `evolve evaluate <exp> <run> | … benchmark:<id>`
 *
 * Pure orchestration over injected parts, so it is testable without an LLM.
 * Trials run only in a child or parallel world (the command enforces it), where
 * the world's daily spend cap bounds what they cost.
 */

import type { BenchmarkSubject } from "./benchmark-runner";

export interface TrialArm {
  label: "candidate" | "incumbent";
  role: string;
}

export interface TrialDeps {
  spawn(name: string, role: string): Promise<void>;
  /** The spawned agent's entity id once it is in the world, else undefined. */
  entityIdOf(name: string): string | undefined;
  subjectOf(name: string): BenchmarkSubject;
  createModelChannel(name: string, memberEntityId: string): void;
  deleteModelChannel(name: string): void;
  startBenchmark(model: string, subjects: BenchmarkSubject[]): string;
  runStatus(
    id: string,
  ): { status: string; score: number | null; answered: number; total: number } | undefined;
  stop(name: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface TrialArmResult {
  label: TrialArm["label"];
  role: string;
  agent: string;
  runId?: string;
  status: string;
  score?: number;
  answered?: number;
  total?: number;
  error?: string;
}

export interface TrialResult {
  arms: TrialArmResult[];
  /** candidate − incumbent score, when both completed. */
  delta?: number;
}

const JOIN_TIMEOUT_MS = 60_000;

export async function runTrial(
  deps: TrialDeps,
  spec: { runId: number; arms: TrialArm[]; timeoutMs: number },
): Promise<TrialResult> {
  const results: TrialArmResult[] = [];
  const started: Array<{ agent: string; channel: string }> = [];
  try {
    // Spawn and wire every arm first, so both benchmarks run concurrently.
    for (const arm of spec.arms) {
      const agent = `trial${spec.runId}${arm.label === "candidate" ? "c" : "i"}`;
      const channel = `model-trial-${spec.runId}-${arm.label === "candidate" ? "cand" : "inc"}`;
      const r: TrialArmResult = { label: arm.label, role: arm.role, agent, status: "starting" };
      results.push(r);
      try {
        await deps.spawn(agent, arm.role);
        started.push({ agent, channel: "" });
        const joinBy = deps.now() + JOIN_TIMEOUT_MS;
        let entityId = deps.entityIdOf(agent);
        while (!entityId && deps.now() < joinBy) {
          await deps.sleep(500);
          entityId = deps.entityIdOf(agent);
        }
        if (!entityId) throw new Error("agent did not come online within 60 s");
        deps.createModelChannel(channel, entityId);
        started[started.length - 1]!.channel = channel;
        r.runId = deps.startBenchmark(`marina:${channel.slice("model-".length)}`, [
          deps.subjectOf(agent),
        ]);
        r.status = "running";
      } catch (err) {
        r.status = "failed";
        r.error = err instanceof Error ? err.message : String(err);
      }
    }

    const deadline = deps.now() + spec.timeoutMs;
    const pending = () => results.filter((r) => r.runId && r.status === "running");
    while (pending().length > 0 && deps.now() < deadline) {
      for (const r of pending()) {
        const s = deps.runStatus(r.runId!);
        if (s && s.status !== "running") {
          r.status = s.status;
          if (s.score !== null) r.score = s.score;
          r.answered = s.answered;
          r.total = s.total;
        }
      }
      if (pending().length > 0) await deps.sleep(2_000);
    }
    for (const r of pending()) {
      r.status = "timeout";
      r.error = `no result within ${Math.round(spec.timeoutMs / 60_000)} min`;
    }
  } finally {
    for (const s of started) {
      await deps.stop(s.agent).catch(() => undefined);
      if (s.channel) deps.deleteModelChannel(s.channel);
    }
  }
  const cand = results.find((r) => r.label === "candidate");
  const inc = results.find((r) => r.label === "incumbent");
  const done = (r?: TrialArmResult) => r?.status === "completed" && typeof r.score === "number";
  return {
    arms: results,
    ...(done(cand) && done(inc) ? { delta: cand!.score! - inc!.score! } : {}),
  };
}
