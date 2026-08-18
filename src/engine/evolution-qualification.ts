// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface EvolutionQualificationRun {
  status: string;
  proposed_by?: string;
  evaluator_name?: string | null;
  reviewer_name?: string | null;
  evidence?: string | null;
}

export interface EvolutionQualificationSession {
  status: string;
  protocol?: {
    automaticContinuation?: boolean;
    automaticPromotion?: boolean;
    metricsAreAdvisory?: boolean;
    independentReview?: boolean;
  };
  budget?: { exhausted?: boolean };
  runs?: EvolutionQualificationRun[];
}

export interface EvolutionQualificationReport {
  qualified: boolean;
  sessions: number;
  runs: number;
  decidedRuns: number;
  checks: Record<string, boolean>;
  failures: string[];
}

/** Assess durable protocol evidence without mutating, continuing, or promoting a session. */
export function assessEvolutionQualification(
  sessions: EvolutionQualificationSession[],
): EvolutionQualificationReport {
  const runs = sessions.flatMap((session) => session.runs ?? []);
  const decided = runs.filter((run) => run.status === "accepted" || run.status === "rejected");
  const hasIndependentAttribution = (run: EvolutionQualificationRun): boolean => {
    if (!run.proposed_by || !run.evaluator_name || !run.reviewer_name) return false;
    return new Set([run.proposed_by, run.evaluator_name, run.reviewer_name]).size === 3;
  };
  const checks = {
    hasSession: sessions.length > 0,
    hasActiveOrCompletedSession: sessions.some(
      (session) => session.status === "active" || session.status === "completed",
    ),
    hasProposal: runs.length > 0,
    hasAttributedEvidence: runs.some((run) =>
      Boolean(run.proposed_by && run.evaluator_name && run.evidence?.trim()),
    ),
    hasDecision: decided.length > 0,
    independentReviewHonored: sessions.every((session) => {
      if (!session.protocol?.independentReview) return true;
      const sessionDecisions = (session.runs ?? []).filter(
        (run) => run.status === "accepted" || run.status === "rejected",
      );
      return sessionDecisions.every(hasIndependentAttribution);
    }),
    constitutionalDefaultsIntact: sessions.every(
      (session) =>
        session.protocol?.automaticContinuation === false &&
        session.protocol?.automaticPromotion === false &&
        session.protocol?.metricsAreAdvisory === true,
    ),
  };
  const labels: Record<keyof typeof checks, string> = {
    hasSession: "no evolution session is visible",
    hasActiveOrCompletedSession: "no session has started",
    hasProposal: "no proposal has been recorded",
    hasAttributedEvidence: "no proposal has attributed evaluation evidence",
    hasDecision: "no attributed decision has been recorded",
    independentReviewHonored: "an independent-review session lacks three-party attribution",
    constitutionalDefaultsIntact: "a session violates passive, advisory protocol defaults",
  };
  const failures = (Object.keys(checks) as Array<keyof typeof checks>)
    .filter((key) => !checks[key])
    .map((key) => labels[key]);
  return {
    qualified: failures.length === 0,
    sessions: sessions.length,
    runs: runs.length,
    decidedRuns: decided.length,
    checks,
    failures,
  };
}
