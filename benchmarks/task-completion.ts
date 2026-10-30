// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

const citation = z.strictObject({ doc_id: z.string().min(1), quote: z.string().min(12) });
const scalar = z.union([z.string(), z.number().finite(), z.boolean()]);
const submission = z.strictObject({
  case_id: z.string(),
  phase: z.number().int(),
  coordinator: z.string(),
  decisions: z.array(
    z.strictObject({
      id: z.string(),
      value: scalar,
      reason: z.string().trim().min(20),
      citations: z.array(citation).min(1),
    }),
  ),
  dependencies: z.array(z.strictObject({ before: z.string(), after: z.string() })),
  unresolved: z.array(z.string()),
  superseded: z.array(
    z.strictObject({
      old_doc_id: z.string(),
      new_doc_id: z.string(),
      impact: z.string().trim().min(20),
    }),
  ),
});

export type CompletionSubmission = z.infer<typeof submission>;
export interface CompletionContract {
  caseId: string;
  phase: number;
  coordinator: string;
  /** A versioned, externally authored contract, never inferred from the worker's checks. */
  decisions: Array<{
    id: string;
    value: z.infer<typeof scalar>;
    /** OR of sufficient bundles; each bundle is an AND of material facts. */
    support: string[][];
  }>;
  facts: Array<{
    id: string;
    description: string;
    /** Any listed passage establishes this fact. Map alternatives before execution. */
    passages: Array<z.infer<typeof citation>>;
  }>;
  sources: Record<string, { statements: string[] }>;
  dependencies: CompletionSubmission["dependencies"];
  unresolved: string[];
  superseded: Array<{ old_doc_id: string; new_doc_id: string }>;
  /** Visible journal requirements (e.g. phase markers and an explicit handoff section). */
  journalMarkers: string[];
}

export interface CompletionFinding {
  path: string;
  kind: "schema" | "value" | "support" | "citation" | "contract" | "journal";
  message: string;
}

function sourceStatements(contract: CompletionContract, docId: string): string[] {
  return Object.hasOwn(contract.sources, docId) ? contract.sources[docId]!.statements : [];
}

function sameSet(actual: unknown[], expected: unknown[]): boolean {
  const keys = (values: unknown[]) => values.map((value) => JSON.stringify(value)).sort();
  const a = keys(actual);
  const e = keys(expected);
  return new Set(a).size === a.length && JSON.stringify(a) === JSON.stringify(e);
}

/** Invalid or vacuous rubrics are configuration errors, never successful qualifications. */
export function validateCompletionContract(contract: CompletionContract): void {
  const require = (ok: boolean, message: string) => {
    if (!ok) throw new Error(`Invalid completion contract: ${message}`);
  };
  require(Boolean(contract.caseId && contract.coordinator), "identity is required");
  require(Number.isSafeInteger(contract.phase) && contract.phase > 0, "phase is required");
  require(contract.decisions.length > 0, "decisions must not be empty");
  require(new Set(contract.decisions.map((d) => d.id)).size ===
    contract.decisions.length, "duplicate decisions");
  require(new Set(contract.facts.map((f) => f.id)).size ===
    contract.facts.length, "duplicate facts");
  for (const fact of contract.facts) {
    require(Boolean(fact.id && fact.description.trim() && fact.passages.length), "fact is empty");
    for (const passage of fact.passages)
      require(citation.safeParse(passage).success &&
        Boolean(
          sourceStatements(contract, passage.doc_id).some((s) => s.includes(passage.quote)),
        ), `fact ${fact.id} has a passage absent from its original source`);
  }
  for (const decision of contract.decisions) {
    require(Boolean(decision.id) && scalar.safeParse(decision.value).success, "invalid decision");
    require(decision.support.length > 0, `${decision.id} has no support bundles`);
    for (const bundle of decision.support)
      require(bundle.length > 0 &&
        new Set(bundle).size === bundle.length &&
        bundle.every((id) =>
          contract.facts.some((fact) => fact.id === id),
        ), `${decision.id} has an empty, duplicate or unknown supporting fact`);
  }
  require(contract.journalMarkers.length > 0 &&
    contract.journalMarkers.every((m) => m.trim().length > 0), "journal requirements are empty");
  for (const [name, values] of Object.entries({
    dependencies: contract.dependencies.map((d) => [d.before, d.after]),
    unresolved: contract.unresolved,
    superseded: contract.superseded.map((d) => [d.old_doc_id, d.new_doc_id]),
  }))
    require(sameSet(values, values), `duplicate ${name}`);
}

export function evaluateCompletionPhase(
  contract: CompletionContract,
  artifact: unknown,
  journal: string | undefined,
) {
  validateCompletionContract(contract);
  const findings: CompletionFinding[] = [];
  const fail = (kind: CompletionFinding["kind"], path: string, message: string) =>
    findings.push({ kind, path, message });
  const parsed = submission.safeParse(artifact);
  const decisions: Array<{ id: string; correct: boolean; supported: boolean; passed: boolean }> =
    [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      fail("schema", `/${issue.path.join("/")}`, issue.message);
  } else {
    const value = parsed.data;
    for (const [key, expected] of Object.entries({
      case_id: contract.caseId,
      phase: contract.phase,
      coordinator: contract.coordinator,
    }))
      if (value[key as "case_id" | "phase" | "coordinator"] !== expected)
        fail("contract", `/${key}`, `Expected ${JSON.stringify(expected)}`);
    if (
      !sameSet(
        value.decisions.map((d) => d.id),
        contract.decisions.map((d) => d.id),
      )
    )
      fail(
        "contract",
        "/decisions",
        "Every required decision must occur exactly once, with no extras",
      );
    for (const required of contract.decisions) {
      const matches = value.decisions.filter((d) => d.id === required.id);
      const decision = matches.length === 1 ? matches[0] : undefined;
      const path = `/decisions/${required.id}`;
      const correct = decision?.value === required.value;
      if (!correct) fail("value", path, `Expected current value ${JSON.stringify(required.value)}`);
      let valid = Boolean(decision);
      const quotes =
        decision?.citations.filter((c, index) => {
          const found = sourceStatements(contract, c.doc_id).some((s) => s.includes(c.quote));
          if (!found) {
            valid = false;
            fail(
              "citation",
              `${path}/citations/${index}`,
              "Quotation is absent from its original source",
            );
          }
          return found;
        }) ?? [];
      const supportedFacts = new Set(
        contract.facts
          .filter((fact) =>
            fact.passages.some((passage) =>
              quotes.some((q) => q.doc_id === passage.doc_id && q.quote.includes(passage.quote)),
            ),
          )
          .map((fact) => fact.id),
      );
      const supported =
        valid && required.support.some((bundle) => bundle.every((id) => supportedFacts.has(id)));
      if (!supported)
        fail(
          "support",
          path,
          `Missing a sufficient fact bundle: ${JSON.stringify(required.support.map((bundle) => bundle.filter((id) => !supportedFacts.has(id))))}`,
        );
      decisions.push({ id: required.id, correct, supported, passed: correct && supported });
    }
    for (const [key, actual, expected] of [
      [
        "dependencies",
        value.dependencies.map((d) => [d.before, d.after]),
        contract.dependencies.map((d) => [d.before, d.after]),
      ],
      ["unresolved", value.unresolved, contract.unresolved],
      [
        "superseded",
        value.superseded.map((d) => [d.old_doc_id, d.new_doc_id]),
        contract.superseded.map((d) => [d.old_doc_id, d.new_doc_id]),
      ],
    ] as const)
      if (!sameSet(actual, expected))
        fail(
          "contract",
          `/${key}`,
          "The current list must match exactly, without duplicates or obsolete entries",
        );
  }
  for (const marker of contract.journalMarkers)
    if (!journal?.includes(marker))
      fail("journal", "/JOURNAL.md", `Missing required marker ${marker}`);
  return {
    caseId: contract.caseId,
    phase: contract.phase,
    passed: findings.length === 0,
    decisions,
    findings,
    scope:
      "All externally declared requirements must pass. Quotation validity and mapped fact coverage are separate from value correctness. This finite rubric is not a general semantic judge.",
  };
}

export interface CompletionAttempt {
  id: string;
  /** Infrastructure evidence is verified by the runner/auditor, not worker assertions. */
  evidence: {
    firstAttempt: boolean;
    freshDatabase: boolean;
    sourceIntegrity: boolean;
    restart: boolean;
    handoff: boolean;
    executionComplete: boolean;
  };
  phases: Array<
    ReturnType<typeof evaluateCompletionPhase> & {
      /** External source-based review of reasons, obsolete claims and actionable handoff prose. */
      review?: { status: "passed" | "failed" | "pending"; findings: string[] };
    }
  >;
}

/** Every predeclared attempt stays in the denominator. No averaging, retries or missing phases. */
export function qualifyTaskCompletion(
  planned: Array<{ id: string; caseId: string; phases: number[] }>,
  attempts: CompletionAttempt[],
) {
  if (
    !planned.length ||
    new Set(planned.map((p) => p.id)).size !== planned.length ||
    planned.some(
      (p) =>
        !p.id ||
        !p.caseId ||
        !p.phases.length ||
        new Set(p.phases).size !== p.phases.length ||
        p.phases.some((n) => !Number.isSafeInteger(n) || n < 1),
    )
  )
    throw new Error("Qualification needs a nonempty, unique predeclared run/phase manifest");
  const extraAttempts = attempts
    .filter((a) => !planned.some((p) => p.id === a.id))
    .map((a) => a.id);
  const runs = planned.map((plan) => {
    const candidates = attempts.filter((a) => a.id === plan.id);
    const attempt = candidates.length === 1 ? candidates[0] : undefined;
    const evidence = attempt?.evidence;
    const infrastructure = Boolean(
      evidence &&
        [
          evidence.firstAttempt,
          evidence.freshDatabase,
          evidence.sourceIntegrity,
          evidence.restart,
          evidence.handoff,
          evidence.executionComplete,
        ].every((v) => v === true),
    );
    const phases = plan.phases.map((phase) => {
      const matches =
        attempt?.phases.filter((p) => p.caseId === plan.caseId && p.phase === phase) ?? [];
      const result = matches.length === 1 ? matches[0] : undefined;
      const reviewed = result?.review?.status === "passed" && result.review.findings.length === 0;
      return { phase, passed: Boolean(result?.passed && reviewed), reviewed };
    });
    return {
      id: plan.id,
      infrastructure,
      phases,
      passed:
        infrastructure &&
        attempt?.phases.length === plan.phases.length &&
        phases.every((p) => p.passed),
    };
  });
  return {
    qualified: extraAttempts.length === 0 && runs.every((r) => r.passed),
    runsPassed: runs.filter((r) => r.passed).length,
    runsPlanned: planned.length,
    phasesPassed: runs.flatMap((r) => r.phases).filter((p) => p.passed).length,
    phasesPlanned: planned.reduce((n, p) => n + p.phases.length, 0),
    extraAttempts,
    runs,
    scope:
      "Complete success on this frozen fresh-task suite only; not a population reliability or productivity claim.",
  };
}
