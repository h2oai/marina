// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  type ArtifactCheckReport,
  type ArtifactFeedback,
  artifactAt,
  type TaskArtifact,
} from "./task-artifact";
import { artifactValueType } from "./task-artifact-review";

/** Explain only declared, mechanically checked obligations; never invent missing answers. */
export function artifactFeedback(
  artifact: TaskArtifact,
  report: ArtifactCheckReport,
): ArtifactFeedback {
  const findings: ArtifactFeedback["findings"] = [];
  const notices: NonNullable<ArtifactFeedback["notices"]> = [];
  for (const check of report.checks) {
    const rule = artifact.rules.find((entry) => entry.id === check.id)!;
    const label = rule.requirement ?? rule.id;
    if (check.status === "inactive" && rule.when) {
      const context = contextType(artifact, rule.when.path);
      if (context && context !== artifactValueType(rule.when.equals))
        findings.push({
          id: `type:${rule.id}`,
          path: rule.when.path,
          message: `${label}: this condition is inactive because the context is ${context}, but when.equals is ${artifactValueType(rule.when.equals)}. Use the JSON type required by the task (1 and false are not "1" and "false"). No value was coerced; an inactive check supplies no verification.`,
        });
    }
    if (
      check.status === "discrepancy" &&
      check.actual !== undefined &&
      rule.op === "eq" &&
      rule.expected !== undefined &&
      artifactValueType(check.actual) !== artifactValueType(rule.expected)
    )
      findings.push({
        id: `type:${rule.id}`,
        path: rule.path,
        message: `${label}: actual is ${artifactValueType(check.actual)} but expected is ${artifactValueType(rule.expected)}. Check the task's declared type and supply that JSON type explicitly. A required check tests presence only; an inactive condition supplies no verification. No coercion or edit was applied.`,
      });
    if (
      check.status === "matches" &&
      Array.isArray(check.actual) &&
      ["eq", "oneOf", "setEquals"].includes(rule.op)
    )
      notices.push({
        id: `membership:${rule.id}`,
        path: rule.path,
        message: `${label}: the list matches an authored expectation; each member's eligibility is still an interpretation. Independently derive included AND excluded members from the task criterion and current sources. For current requests, a future prerequisite or known failure is not itself an unanswered request. Optional artifact-review/ artifact-review-fresh questions can use answerType:"array" and set:{ref,criterionPath,candidatesPath} to select the criterion and all candidates from the task contract; include that ref and relevant evidence in refs. Review never edits or approves.`,
      });
    if (check.needsRenewal) {
      findings.push({
        id: rule.id,
        path: rule.path,
        message: `${label}: context changed. Attach evidence for the current context with this coverage ID, or retire this requirement with a reason.`,
      });
    } else if (check.status === "unverified") {
      findings.push({
        id: rule.id,
        path: rule.path,
        message: `${label}: evidence is ${check.evidence}. Review the current accessible source before renewing this requirement.`,
      });
    } else if (check.status === "discrepancy") {
      findings.push({
        id: rule.id,
        path: rule.path,
        message: rule.selection
          ? `${label}: the declared exact source selection is missing. The suggested append preserves existing citations; review any separately authored quotations as well.`
          : `${label}: the artifact does not satisfy the declared ${rule.op} check. Reconsider the value and the requirement using evidence.`,
        ...(rule.selection && check.evidence === "current"
          ? { edits: [{ op: "source" as const, path: rule.path, ...rule.selection }] }
          : {}),
      });
    }
  }
  for (const projection of report.projections ?? []) {
    if (projection.status === "matches") continue;
    findings.push({
      id: `scope:${projection.path}`,
      path: projection.path,
      message:
        projection.status === "unverified"
          ? `No entries were declared for the current ${projection.scopePath}. Supply the current list (including [] if explicitly empty); history alone does not establish current completeness.`
          : `The output differs from its declared current-context list. Inspect extra or missing entries; earlier contexts remain in history.`,
      ...(projection.status === "discrepancy"
        ? {
            edits: [
              {
                op: "project" as const,
                path: projection.path,
                scopePath: projection.scopePath,
                reason:
                  "Restore the declared current-context list after reviewing the discrepancy.",
              },
            ],
          }
        : {}),
    });
  }
  for (const finding of report.evidence?.findings ?? [])
    findings.push({ ...finding, id: `evidence:${finding.id}` });
  if (
    !report.evidence &&
    !report.checks.some((check) => check.status !== "inactive") &&
    !report.projections?.length
  )
    findings.push({
      id: "undeclared",
      path: "",
      message:
        "No active requirements were checked. Declare requirements from the task brief; an empty check set is unverified.",
    });
  if (!report.evidence && !report.coverage?.active)
    findings.push({
      id: "coverage-undeclared",
      path: "",
      message:
        "No current evidence coverage was checked. A source edit can attach exact evidence and declare coverage together: coverage:{id,requirement,scopePath?}.",
    });
  return {
    advisory: true,
    checkedRevision: report.revision,
    outcome: report.outcome,
    findings,
    ...(notices.length ? { notices } : {}),
    scope:
      "Only declared requirements and context bindings were checked. These suggestions do not prove semantic support or complete task coverage, apply edits, or block submission. A source-based fresh review remains optional.",
  };
}

function contextType(artifact: TaskArtifact, path: string) {
  try {
    const context = artifactAt(artifact.value, path);
    return context.present ? artifactValueType(context.value) : undefined;
  } catch {
    return undefined;
  }
}
