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
  /** 95% interval on the difference (Agresti–Caffo), when both completed. */
  deltaCi?: [number, number];
}

/**
 * One arm's score, split: how often it answered, and how good the answers
 * were. The overall score counts an unanswered item as wrong (a role that does
 * not answer IS worse), but a reviewer needs to see which of the two moved.
 */
export function armBreakdown(a: { score?: number; answered?: number; total?: number }):
  | {
      correct: number;
      answered: number;
      total: number;
      answerRate: number;
      answeredAccuracy: number;
    }
  | undefined {
  if (a.score === undefined || !a.total) return undefined;
  const answered = a.answered ?? a.total;
  const correct = Math.round(a.score * a.total);
  return {
    correct,
    answered,
    total: a.total,
    answerRate: answered / a.total,
    answeredAccuracy: answered > 0 ? correct / answered : 0,
  };
}

/**
 * 95% interval on p1 − p2 for two independent proportions (Agresti–Caffo: add
 * one success and one failure to each arm). Well-behaved for small n and for
 * scores of 0% or 100%, where the plain Wald interval collapses to zero width
 * and would call a 15-item tie-break "certain".
 */
export function differenceInterval(
  p1: number,
  n1: number,
  p2: number,
  n2: number,
): [number, number] {
  const a1 = (p1 * n1 + 1) / (n1 + 2);
  const a2 = (p2 * n2 + 1) / (n2 + 2);
  const se = Math.sqrt((a1 * (1 - a1)) / (n1 + 2) + (a2 * (1 - a2)) / (n2 + 2));
  const d = a1 - a2;
  // A difference of two proportions lives in [-1, 1].
  return [Math.max(-1, d - 1.96 * se), Math.min(1, d + 1.96 * se)];
}

const JOIN_TIMEOUT_MS = 60_000;

/**
 * Model calls a trial agent may spend. An agent takes several turns per item
 * (read the request, think, reply, sometimes a tool), so a fixed budget runs
 * dry on a large set and every later item times out — measuring the budget,
 * not the role. Live: 300 calls lasted ~70 of 100 ARC items.
 */
export function trialCallBudget(items: number): number {
  return 60 + 8 * Math.max(1, items);
}

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
  if (!done(cand) || !done(inc)) return { arms: results };
  return {
    arms: results,
    delta: cand!.score! - inc!.score!,
    deltaCi: differenceInterval(cand!.score!, cand!.total || 1, inc!.score!, inc!.total || 1),
  };
}
