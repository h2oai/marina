// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { assessEvolutionQualification } from "../src/engine/evolution-qualification";

const soundSession = {
  status: "completed",
  protocol: {
    automaticContinuation: false,
    automaticPromotion: false,
    metricsAreAdvisory: true,
    independentReview: true,
  },
  budget: { exhausted: false },
  runs: [
    {
      status: "accepted",
      proposed_by: "Alice",
      evaluator_name: "Bob",
      reviewer_name: "Cara",
      evidence: "benchmark:trial-1",
    },
  ],
};

describe("evolution qualification", () => {
  it("qualifies attributed, independently reviewed, constitutionally passive evidence", () => {
    expect(assessEvolutionQualification([soundSession])).toMatchObject({
      qualified: true,
      sessions: 1,
      runs: 1,
      decidedRuns: 1,
      failures: [],
    });
  });

  it("fails closed for missing evidence and decisions", () => {
    const report = assessEvolutionQualification([{ ...soundSession, status: "draft", runs: [] }]);
    expect(report.qualified).toBe(false);
    expect(report.failures.join(" ")).toContain("no proposal");
    expect(report.failures.join(" ")).toContain("no session has started");
  });

  it("detects collapsed review roles and constitutional corruption", () => {
    const report = assessEvolutionQualification([
      {
        ...soundSession,
        protocol: { ...soundSession.protocol, automaticPromotion: true },
        runs: [
          {
            ...soundSession.runs[0]!,
            evaluator_name: "Alice",
            reviewer_name: "Alice",
          },
        ],
      },
    ]);
    expect(report.qualified).toBe(false);
    expect(report.checks.independentReviewHonored).toBe(false);
    expect(report.checks.constitutionalDefaultsIntact).toBe(false);
  });
});
