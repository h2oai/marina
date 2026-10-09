// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live work on the outcome path: a task creator's verdict on a submission and
 * a Code Mode verification run are resolved results like any forecast. Each is
 * recorded once (`recordResolved`) with who did the work and on what model and
 * role, so lessons (scoped to whose work it was) and selection evidence learn
 * from what agents actually get done, not only from benchmarks.
 *
 * Only labels and numbers are recorded; the task text and command output stay
 * on their own rows and are read back as private context when a lesson is
 * judged.
 */

import type { MarinaDB } from "../persistence/database";
import type { EngineEvent } from "../types";
import { recordResolved } from "./record";

/** Who did the work, and on what (an agent's model and role; a person's name only). */
export function participantOf(
  db: Pick<MarinaDB, "getAgentConfig">,
  name: string,
): { agent: string; model?: string; role?: string } {
  const config = db.getAgentConfig(name);
  return {
    agent: name,
    ...(config?.model ? { model: config.model } : {}),
    ...(config?.role ? { role: config.role } : {}),
  };
}

/** The subject a task attempt's outcomes share: `task:<id>:<claimant>`. */
export const taskBase = (taskId: number, claimant: string) => `task:${taskId}:${claimant}`;

/**
 * A creator's verdict on a task submission as one outcome. Each verdict is its
 * own subject (a resubmission after a rejection is a new attempt).
 */
export function recordTaskVerdict(
  db: MarinaDB,
  input: { taskId: number; claimant: string; approved: boolean; at: number; detail?: string },
): void {
  recordResolved(db, {
    subject: `${taskBase(input.taskId, input.claimant)}:${input.at}`,
    kind: "task",
    source: "task:verdict",
    domain: "tools",
    owner: input.claimant,
    succeeded: input.approved,
    quality: input.approved ? 1 : 0,
    metric: "creator-verdict",
    detail:
      input.detail ??
      (input.approved
        ? "submission approved by the task's creator"
        : "submission rejected by the task's creator"),
    basis: "mechanical",
    participants: [participantOf(db, input.claimant)],
    refs: [`task:${input.taskId}`],
    resolvedAt: input.at,
  });
}

/** `task_approved` / `task_rejected` as a verdict outcome; no-op for any other event. */
export function observeOutcomeEvent(db: MarinaDB | undefined, event: EngineEvent): void {
  if (!db || (event.type !== "task_approved" && event.type !== "task_rejected")) return;
  if (!event.claimantName) return;
  recordTaskVerdict(db, {
    taskId: event.taskId,
    claimant: event.claimantName,
    approved: event.type === "task_approved",
    at: event.timestamp,
  });
}

/**
 * A judge's opinion of a task submission (the submission verifier, any
 * decision backend) as a JUDGED outcome: recorded, never delivered — an
 * opinion teaches nothing until its judge has earned agreement with creators'
 * verdicts (`judgeAgreement`). `none` (outage, missing signals) is no outcome.
 */
export function recordTaskOpinion(
  db: MarinaDB,
  input: {
    taskId: number;
    claimant: string;
    judge: string;
    opinion: "pass" | "fail" | "none";
    at?: number;
  },
): void {
  if (input.opinion === "none") return;
  const at = input.at ?? Date.now();
  recordResolved(db, {
    subject: `judged:${taskBase(input.taskId, input.claimant)}:${at}`,
    kind: "task",
    source: "task:verdict",
    domain: "tools",
    owner: input.claimant,
    succeeded: input.opinion === "pass",
    metric: "judge-opinion",
    basis: "judged",
    judge: input.judge,
    participants: [participantOf(db, input.claimant)],
    refs: [`task:${input.taskId}`],
    resolvedAt: at,
  });
}

/**
 * A Code Mode verification that ran (passed or failed) as one outcome. Its
 * subject is the verification artifact, whose steps' output is the private
 * context a lesson is judged with.
 */
export function recordVerification(
  db: MarinaDB,
  input: {
    artifactId: string;
    actor: string;
    passed: boolean;
    commands: string[][];
    detail: string;
    sessionId?: string;
    at?: number;
  },
): void {
  recordResolved(db, {
    subject: `artifact:${input.artifactId}`,
    kind: "task",
    source: "code:verify",
    domain: "code",
    owner: input.actor,
    succeeded: input.passed,
    quality: input.passed ? 1 : 0,
    metric: "checks",
    detail: input.detail,
    basis: "mechanical",
    participants: [participantOf(db, input.actor)],
    truth: { commands: input.commands.map((c) => c[0] ?? "") },
    refs: [
      `artifact:${input.artifactId}`,
      ...(input.sessionId ? [`coding:${input.sessionId}`] : []),
    ],
    resolvedAt: input.at ?? Date.now(),
  });
}
