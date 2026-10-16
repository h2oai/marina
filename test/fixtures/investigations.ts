// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  INVESTIGATION_SCHEMA,
  type InvestigationResult,
  type InvestigationSnapshot,
} from "../../src/sdk/investigation-types";

export const binaryInvestigation: InvestigationResult = {
  schema: INVESTIGATION_SCHEMA,
  kind: "prediction",
  availability: "final",
  summary: "65% chance of shipping by Friday",
  estimate: { type: "binary", probability: 0.65 },
  reasons: [
    { actor: "analyst-a", text: "Integration remains the main uncertainty.", sourceIds: ["s1"] },
  ],
  sources: [{ id: "s1", title: "Release checklist", url: "https://example.org/release" }],
  limitations: ["Delivery depends on the outstanding integration checks."],
  capture: { status: "partial", gaps: ["Original source bytes unavailable"] },
  accounting: { knownUsd: 0.02, complete: false, outstanding: 0 },
};

export const investigationFixtures: Record<string, InvestigationResult> = {
  binary: binaryInvestigation,
  numeric: {
    ...binaryInvestigation,
    summary: "Approximately 120 units",
    estimate: { type: "number", value: 120, unit: "units" },
  },
  choice: {
    ...binaryInvestigation,
    summary: "Option A leads with 40%",
    estimate: {
      type: "choice",
      selected: "a",
      options: [
        { id: "a", label: "A", probability: 0.4 },
        { id: "b", label: "B", probability: 0.35 },
        { id: "c", label: "C", probability: 0.25 },
      ],
    },
  },
  research: {
    ...binaryInvestigation,
    kind: "research",
    estimate: undefined,
    summary: "Integration is unfinished [1].",
    report: "Integration is unfinished [1].\n\nFurther checks are required.",
  },
  partial: {
    ...binaryInvestigation,
    availability: "partial",
    limitations: ["One analyst failed; retained estimates disagree."],
  },
  unavailable: {
    ...binaryInvestigation,
    availability: "none",
    summary: "Insufficient evidence",
    estimate: { type: "binary" },
  },
};

export function investigationSnapshot(result = binaryInvestigation): InvestigationSnapshot {
  const actor = { key: "fixture-owner", name: "FixtureOwner" };
  const now = Date.UTC(2026, 9, 15);
  return {
    case: {
      schema: INVESTIGATION_SCHEMA,
      id: "fixture-case",
      instanceId: "fixture-instance",
      owner: actor,
      kind: result.kind,
      question: "Simulated: Will the release ship?",
      selectedAttemptId: "fixture-attempt",
      currentAttemptId: "fixture-attempt",
      createdAt: now,
      updatedAt: now,
      access: "owner",
    },
    attempt: {
      id: "fixture-attempt",
      caseId: "fixture-case",
      actor,
      rootAttemptId: "fixture-attempt",
      request: { kind: result.kind, question: "Simulated: Will the release ship?" },
      state: "completed",
      sequence: 3,
      createdAt: now,
      updatedAt: now,
      accounting: result.accounting,
      result,
    },
    attempts: [{ id: "fixture-attempt", state: "completed", createdAt: now, actor }],
    cursor: 3,
    children: [],
    grants: [],
  };
}
