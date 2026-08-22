// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { TraceCohortComparison } from "./trace-dataset";

export interface TraceRoutingAdvice {
  schema: "marina.routing.shadow.v1";
  dimension: "model" | "route";
  mode: "pareto" | "explore" | "insufficient";
  candidates: string[];
  reasons: string[];
  advisoryOnly: true;
}

export interface AdaptiveSelection {
  target: string;
  advice: TraceRoutingAdvice;
  applied: boolean;
  reason: string;
}

/** Apply explicit shadow advice only within the caller's already-eligible candidate set. */
export function selectAdaptiveCandidate(
  eligible: readonly string[],
  advice: TraceRoutingAdvice,
  fallback: () => string,
): AdaptiveSelection {
  const candidate = advice.candidates.find((name) => eligible.includes(name));
  if (candidate) {
    return {
      target: candidate,
      advice,
      applied: true,
      reason: `${advice.mode} candidate selected from the already-eligible set`,
    };
  }
  return {
    target: fallback(),
    advice,
    applied: false,
    reason: `${advice.mode} advice had no eligible candidate; fell back to least-busy`,
  };
}

/**
 * Produce weight-free shadow advice from observed mechanics.
 * This pure function has no access to the live router and cannot alter execution.
 */
export function adviseTraceRouting(
  cohorts: readonly TraceCohortComparison[],
  dimension: "model" | "route",
): TraceRoutingAdvice {
  if (cohorts.length < 2) {
    return advice(dimension, "insufficient", [], ["Fewer than two observed cohorts."]);
  }
  const comparable = cohorts.filter(
    (row) => row.mechanics.successRate !== undefined && row.mechanics.latency.p50Ms !== undefined,
  );
  if (comparable.length >= 2) {
    const frontier = comparable.filter(
      (candidate) =>
        !comparable.some((other) => other !== candidate && dominates(other, candidate)),
    );
    if (frontier.length === 1) {
      const candidate = frontier[0]!;
      return advice(
        dimension,
        "pareto",
        [candidate.name],
        [
          "One cohort is nondominated on observed terminal success and p50 terminal latency.",
          `Its eligible/observed sample count is ${candidate.mechanics.eligible}/${candidate.mechanics.observed}.`,
          "Judgments are shown separately and are not collapsed into this mechanical relation.",
        ],
      );
    }
  }
  const leastObserved = Math.min(...cohorts.map((row) => row.mechanics.observed));
  const candidates = cohorts
    .filter((row) => row.mechanics.observed === leastObserved)
    .map((row) => row.name)
    .sort();
  return advice(dimension, "explore", candidates, [
    "No unique Pareto-nondominated mechanical cohort was observed.",
    `Least-observed cohorts have n=${leastObserved}; sampling them counters popularity feedback.`,
    "Exploration is advisory and does not override the caller's selected model or route.",
  ]);
}

function dominates(a: TraceCohortComparison, b: TraceCohortComparison): boolean {
  const aSuccess = a.mechanics.successRate!;
  const bSuccess = b.mechanics.successRate!;
  const aLatency = a.mechanics.latency.p50Ms!;
  const bLatency = b.mechanics.latency.p50Ms!;
  return (
    aSuccess >= bSuccess && aLatency <= bLatency && (aSuccess > bSuccess || aLatency < bLatency)
  );
}

function advice(
  dimension: "model" | "route",
  mode: TraceRoutingAdvice["mode"],
  candidates: string[],
  reasons: string[],
): TraceRoutingAdvice {
  return {
    schema: "marina.routing.shadow.v1",
    dimension,
    mode,
    candidates,
    reasons,
    advisoryOnly: true,
  };
}
