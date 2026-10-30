// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import {
  type CompletionAttempt,
  type CompletionContract,
  type CompletionSubmission,
  evaluateCompletionPhase,
  qualifyTaskCompletion,
} from "../benchmarks/task-completion";
import { scoreTaskCompletionInput } from "../scripts/qualify-task-completion";

const policy = "Selection means a currently authorized and technically eligible replacement.";
const permission = "The team may investigate replacement-r2, but no replacement is approved.";
const technical = "No replacement meets the compatibility requirement; keep the installed unit.";
const alternative =
  "Every proposed replacement failed compatibility; the installed unit must remain.";
const hardware = "The active unit requires the 48-volt supply; the delivered supply is 24-volt.";
function fixture() {
  const contract: CompletionContract = {
    caseId: "completion-regression",
    phase: 2,
    coordinator: "Ada",
    decisions: [
      {
        id: "current_selection",
        value: "none",
        support: [["selection-policy", "approval", "compatibility"]],
      },
      { id: "parts_plan", value: "await-48v", support: [["hardware"]] },
    ],
    facts: [
      {
        id: "selection-policy",
        description: "Current selection is not a proposed fix",
        passages: [{ doc_id: "policy", quote: policy }],
      },
      {
        id: "approval",
        description: "No replacement approved",
        passages: [{ doc_id: "approval", quote: permission }],
      },
      {
        id: "compatibility",
        description: "No eligible replacement",
        passages: [
          { doc_id: "technical", quote: technical },
          { doc_id: "summary", quote: alternative },
        ],
      },
      {
        id: "hardware",
        description: "Required voltage and incompatible received part",
        passages: [{ doc_id: "technical", quote: hardware }],
      },
    ],
    sources: {
      policy: { statements: [policy] },
      approval: { statements: [permission] },
      technical: { statements: [technical, hardware] },
      summary: { statements: [alternative] },
    },
    dependencies: [{ before: "receive-48v", after: "repair" }],
    unresolved: ["48v-receipt"],
    superseded: [{ old_doc_id: "technical-old", new_doc_id: "technical" }],
    journalMarkers: ["[phase-2]", "[handoff]"],
  };
  const artifact: CompletionSubmission = {
    case_id: contract.caseId,
    phase: 2,
    coordinator: "Ada",
    decisions: [
      {
        id: "current_selection",
        value: "none",
        reason: "Permission to investigate does not establish current approval or compatibility.",
        citations: [
          { doc_id: "policy", quote: policy },
          { doc_id: "approval", quote: permission },
          { doc_id: "technical", quote: technical },
        ],
      },
      {
        id: "parts_plan",
        value: "await-48v",
        reason: "The delivered voltage does not meet the technical requirement.",
        citations: [{ doc_id: "technical", quote: hardware }],
      },
    ],
    dependencies: structuredClone(contract.dependencies),
    unresolved: [...contract.unresolved],
    superseded: [
      {
        ...contract.superseded[0]!,
        impact: "Updated compatibility evidence invalidates the previous replacement plan.",
      },
    ],
  };
  const journal =
    "[phase-2] Keep installed unit; await 48v receipt. [handoff] Compatibility and approval remain unresolved.";
  return {
    contract,
    artifact,
    journal,
    score: () => evaluateCompletionPhase(contract, artifact, journal),
  };
}

test("prospective remediation cannot pass as current approved selection even with valid sources", () => {
  const f = fixture();
  expect(f.score().passed).toBe(true);
  f.artifact.decisions[0]!.value = "replacement-r2";
  const score = f.score();
  expect(score.decisions[0]).toMatchObject({ correct: false, supported: true, passed: false });
  expect(score.passed).toBe(false);
});

test("real quotations and a correct value cannot compensate for missing material technical evidence", () => {
  const f = fixture();
  f.artifact.decisions[1]!.citations = [{ doc_id: "approval", quote: permission }];
  expect(f.score().decisions[1]).toMatchObject({ correct: true, supported: false, passed: false });
  expect(f.score().passed).toBe(false);
});

test("sufficient alternative source passages count without a hidden preferred sentence", () => {
  const f = fixture();
  f.artifact.decisions[0]!.citations[2] = { doc_id: "summary", quote: alternative };
  expect(f.score().passed).toBe(true);
  f.contract.decisions[0]!.support.push(["selection-policy", "approval", "hardware"]);
  f.artifact.decisions[0]!.citations[2] = { doc_id: "technical", quote: hardware };
  expect(f.score().passed).toBe(true);
});

test("a forged extra quotation fails despite otherwise sufficient support", () => {
  const f = fixture();
  f.artifact.decisions[0]!.citations.push({
    doc_id: "approval",
    quote: "Replacement-r2 is now fully approved.",
  });
  expect(f.score().findings.some((finding) => finding.kind === "citation")).toBe(true);
  expect(f.score().passed).toBe(false);
  for (const doc_id of ["constructor", "__proto__", "unknown-document"]) {
    f.artifact.decisions[0]!.citations = [{ doc_id, quote: technical }];
    expect(f.score().passed).toBe(false);
    expect(f.score().findings.some((finding) => finding.kind === "citation")).toBe(true);
  }
});

test("valid fragments cannot drop a decisive negation or borrow authority from an obsolete source", () => {
  const f = fixture();
  f.artifact.decisions[0]!.citations[2] = {
    doc_id: "technical",
    quote: "replacement meets the compatibility requirement",
  };
  expect(f.score().findings.some((finding) => finding.kind === "citation")).toBe(false);
  expect(f.score().decisions[0]!.supported).toBe(false);
  f.contract.sources["obsolete-technical"] = { statements: [technical] };
  f.artifact.decisions[0]!.citations[2] = { doc_id: "obsolete-technical", quote: technical };
  expect(f.score().findings.some((finding) => finding.kind === "citation")).toBe(false);
  expect(f.score().decisions[0]!.supported).toBe(false);
});

test("removed valid citations, stale supersessions and missing prerequisites fail independently", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.artifact.decisions[0]!.citations.pop();
    },
    (f: ReturnType<typeof fixture>) => {
      f.artifact.superseded.push({
        old_doc_id: "older",
        new_doc_id: "technical-old",
        impact: "This obsolete transition belongs to the previous phase only.",
      });
    },
    (f: ReturnType<typeof fixture>) => {
      f.artifact.dependencies = [];
    },
    (f: ReturnType<typeof fixture>) => {
      f.artifact.unresolved = [];
    },
    (f: ReturnType<typeof fixture>) => {
      f.artifact.coordinator = "retired-owner";
    },
    (f: ReturnType<typeof fixture>) => {
      f.artifact.decisions.push(f.artifact.decisions[0]!);
    },
  ]) {
    const f = fixture();
    mutate(f);
    expect(f.score().passed).toBe(false);
  }
});

test("matching actor checks cannot shrink the externally specified task contract", () => {
  const f = fixture();
  f.artifact.decisions.pop();
  expect(f.score().passed).toBe(false);
  expect(evaluateCompletionPhase(f.contract, undefined, f.journal).passed).toBe(false);
  expect(
    evaluateCompletionPhase(f.contract, f.artifact, "A long but unactionable journal").passed,
  ).toBe(false);
  for (const support of [[], [[]], [["unknown-fact"]]]) {
    const invalid = structuredClone(f.contract);
    invalid.decisions[0]!.support = support;
    expect(() => evaluateCompletionPhase(invalid, f.artifact, f.journal)).toThrow(
      "Invalid completion contract",
    );
  }
});

test("correct supported decisions cannot compensate for an obsolete present-tense journal claim", () => {
  const f = fixture();
  const journal = `${f.journal}\nThe old memo's claim that every replacement is approved is still true but moot after approval was withdrawn.`;
  const phase = evaluateCompletionPhase(f.contract, f.artifact, journal);
  expect(phase.passed).toBe(true); // Mechanical checks do not interpret prose.
  const report = qualifyTaskCompletion(
    [{ id: "journal-regression", caseId: f.contract.caseId, phases: [2] }],
    [
      {
        id: "journal-regression",
        evidence: {
          firstAttempt: true,
          freshDatabase: true,
          sourceIntegrity: true,
          restart: true,
          handoff: true,
          executionComplete: true,
        },
        phases: [
          {
            ...phase,
            review: {
              status: "failed",
              findings: [
                "The journal reasserts a superseded approval claim as currently true, contradicting the current authority source.",
              ],
            },
          },
        ],
      },
    ],
  );
  expect(report).toMatchObject({ qualified: false, runsPassed: 0, phasesPassed: 0 });
});

test("qualification requires every first-attempt fresh run and phase, including infrastructure evidence", () => {
  const f = fixture();
  const planned = [
    { id: "run-1", caseId: f.contract.caseId, phases: [2] },
    { id: "run-2", caseId: f.contract.caseId, phases: [2] },
  ];
  const attempt: CompletionAttempt = {
    id: "run-1",
    phases: [{ ...f.score(), review: { status: "passed", findings: [] } }],
    evidence: {
      firstAttempt: true,
      freshDatabase: true,
      sourceIntegrity: true,
      restart: true,
      handoff: true,
      executionComplete: true,
    },
  };
  const second = { ...structuredClone(attempt), id: "run-2" };
  expect(qualifyTaskCompletion(planned, [attempt, second]).qualified).toBe(true);
  const unreviewed = structuredClone(second);
  delete unreviewed.phases[0]!.review;
  expect(qualifyTaskCompletion(planned, [attempt, unreviewed]).qualified).toBe(false);
  expect(qualifyTaskCompletion(planned, [attempt]).qualified).toBe(false);
  expect(qualifyTaskCompletion(planned, [attempt, attempt, second]).qualified).toBe(false);
  expect(
    qualifyTaskCompletion(planned, [attempt, second, { ...attempt, id: "retry" }]).qualified,
  ).toBe(false);
  for (const key of Object.keys(attempt.evidence) as Array<keyof CompletionAttempt["evidence"]>) {
    const failed = structuredClone(second);
    failed.evidence[key] = false;
    expect(qualifyTaskCompletion(planned, [attempt, failed]).qualified).toBe(false);
  }
  f.artifact.decisions[1]!.citations = [{ doc_id: "approval", quote: permission }];
  second.phases = [f.score()];
  expect(qualifyTaskCompletion(planned, [attempt, second])).toMatchObject({
    qualified: false,
    runsPassed: 1,
    runsPlanned: 2,
  });
  second.phases = [];
  expect(qualifyTaskCompletion(planned, [attempt, second]).qualified).toBe(false);
  expect(() => qualifyTaskCompletion([], [])).toThrow();
});

test("saved-evidence qualification recomputes scores and refuses missing or duplicate contracts", () => {
  const f = fixture();
  const input = {
    planned: [{ id: "first", caseId: f.contract.caseId, phases: [2] }],
    contracts: [f.contract],
    attempts: [
      {
        id: "first",
        evidence: {
          firstAttempt: true,
          freshDatabase: true,
          sourceIntegrity: true,
          restart: true,
          handoff: true,
          executionComplete: true,
        },
        phases: [
          {
            caseId: f.contract.caseId,
            phase: 2,
            submission: f.artifact,
            journal: f.journal,
            review: { status: "passed", findings: [] },
          },
        ],
      },
    ],
  };
  expect(scoreTaskCompletionInput(input).qualified).toBe(true);
  f.artifact.decisions[0]!.value = "replacement-r2";
  expect(scoreTaskCompletionInput(input).qualified).toBe(false);
  expect(() => scoreTaskCompletionInput({ ...input, contracts: [] })).toThrow(
    "Missing planned contract",
  );
  expect(() => scoreTaskCompletionInput({ ...input, contracts: [f.contract, f.contract] })).toThrow(
    "Duplicate phase contract",
  );
  expect(() => scoreTaskCompletionInput({ ...input, passed: true })).toThrow();
});
