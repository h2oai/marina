// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { choice } from "../decisions/questions";
import type { DecisionProvider } from "../decisions/types";
import { getErrorMessage } from "../engine/errors";

// Not the spawn-time model router: `model:route` prefers candidates from benchmark
// ledger evidence in src/engine/benchmark-evidence.ts. This module scores
// formation/strategy routes from portable paired evidence (arena portfolio, task
// adapters); keep the two separate.

/** Portable paired evidence; native CRPS skill, pass/fail and other metrics must
 * retain their benchmark/cohort identity. Never clamp a negative score to zero. */
export interface RouteEvidence {
  version: 1;
  id: string;
  benchmark: string;
  cohort: string;
  item: string;
  skills: string[];
  candidate: string;
  /** Shared policy lineage across task adapters, not interchangeable scores. */
  strategy?: string;
  control: string;
  metric: string;
  higherIsBetter: boolean;
  controlValue: number;
  candidateValue?: number;
  status: "completed" | "failed";
  predictedAt: string;
  availableAt: string;
  prospective: boolean;
}

export interface RoutingTask {
  benchmark: string;
  item: string;
  skills: string[];
  asOf: string;
  features: Record<string, string | number | boolean>;
}
export interface RouteOption {
  id: string;
  fingerprint: string;
  description: string;
  strategy?: string;
}

/** Reject malformed imports rather than admitting unverifiable priors. */
export function parseRouteEvidence(input: unknown): RouteEvidence[] {
  if (!Array.isArray(input) || input.length > 10_000)
    throw new Error("evidence must be an array of at most 10000 observations");
  return input.map((row) => {
    if (!row || typeof row !== "object") throw new Error("invalid route evidence");
    const r = row as RouteEvidence;
    const names = [r.id, r.benchmark, r.cohort, r.item, r.candidate, r.control, r.metric];
    if (
      r.version !== 1 ||
      names.some((s) => typeof s !== "string" || !s.trim()) ||
      !Array.isArray(r.skills) ||
      r.skills.some((s) => typeof s !== "string") ||
      typeof r.higherIsBetter !== "boolean" ||
      typeof r.prospective !== "boolean" ||
      !Number.isFinite(r.controlValue) ||
      !Number.isFinite(Date.parse(r.predictedAt)) ||
      !Number.isFinite(Date.parse(r.availableAt)) ||
      Date.parse(r.predictedAt) >= Date.parse(r.availableAt) ||
      (r.status !== "completed" && r.status !== "failed") ||
      (r.status === "completed" && !Number.isFinite(r.candidateValue))
    )
      throw new Error("invalid route evidence");
    return structuredClone(r);
  });
}

/** Time-safe, deduplicated, separately labelled native-metric summaries. Evidence
 * from another benchmark is a transfer hypothesis, never promotion evidence. */
export function routingEvidence(
  task: RoutingTask,
  evidence: RouteEvidence[],
  options: RouteOption[],
) {
  const at = Date.parse(task.asOf);
  if (!Number.isFinite(at)) throw new Error("invalid routing cutoff");
  const seen = new Set<string>();
  const groups = new Map<
    string,
    {
      benchmark: string;
      cohort: string;
      candidate: string;
      control: string;
      metric: string;
      higherIsBetter: boolean;
      transferHypothesis: boolean;
      completed: number;
      failed: number;
      delta: number;
    }
  >();
  for (const r of parseRouteEvidence(evidence)) {
    if (
      !r.prospective ||
      Date.parse(r.availableAt) >= at ||
      (r.benchmark === task.benchmark && r.item === task.item) ||
      !options.some(
        (o) =>
          o.fingerprint === r.candidate ||
          (r.benchmark !== task.benchmark && !!r.strategy && o.strategy === r.strategy),
      ) ||
      !r.skills.some((s) => task.skills.includes(s))
    )
      continue;
    const key = JSON.stringify([
      r.benchmark,
      r.cohort,
      r.candidate,
      r.control,
      r.metric,
      r.higherIsBetter,
    ]);
    const observation = JSON.stringify([key, r.item]);
    if (seen.has(observation))
      throw new Error("duplicate paired evidence for the same item and cohort");
    seen.add(observation);
    const g = groups.get(key) ?? {
      benchmark: r.benchmark,
      cohort: r.cohort,
      candidate: r.candidate,
      control: r.control,
      metric: r.metric,
      higherIsBetter: r.higherIsBetter,
      transferHypothesis: r.benchmark !== task.benchmark,
      completed: 0,
      failed: 0,
      delta: 0,
    };
    if (r.status === "failed") g.failed++;
    else {
      g.completed++;
      g.delta += (r.candidateValue! - r.controlValue) * (r.higherIsBetter ? 1 : -1);
    }
    groups.set(key, g);
  }
  return [...groups.values()].map(({ delta, ...g }) => ({
    ...g,
    meanImprovement: g.completed ? delta / g.completed : null,
  }));
}

/** Select only among prevalidated plans. A missing/malformed decision preserves
 * the caller's control. This returns advice; it cannot change deployed routes. */
export async function selectTaskRoute(
  task: RoutingTask,
  options: RouteOption[],
  control: string,
  evidence: RouteEvidence[],
  provider?: DecisionProvider,
  signal?: AbortSignal,
) {
  if (
    !options.some((o) => o.id === control) ||
    new Set(options.map((o) => o.id)).size !== options.length
  )
    throw new Error("routing options require a unique control");
  const priors = routingEvidence(task, evidence, options);
  if (!provider || options.length < 2)
    return { selected: control, reason: "control (no selector)", priors };
  try {
    signal?.throwIfAborted();
    const result = await provider.ask(
      {
        state: { task, options, evidence: priors },
        questions: {
          route: choice(
            "Choose a bounded plan for this task. Extra calls are not inherently better. Prefer the control without credible task-relevant evidence. Other-benchmark results are transfer hypotheses, not proof. Confidence is not a probability of benchmark success.",
            Object.fromEntries(options.map((o) => [o.id, o.description])),
          ),
        },
      },
      signal,
    );
    signal?.throwIfAborted();
    const a = result.answers.route;
    if (a?.type !== "choice" || !options.some((o) => o.id === a.choice))
      throw new Error("selector returned an ineligible plan");
    return { selected: a.choice, reason: "decision", priors, decision: result };
  } catch (error) {
    signal?.throwIfAborted();
    return { selected: control, reason: `control: ${getErrorMessage(error)}`, priors };
  }
}
