// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Verifier for task submissions (`task submit`, MARINA_DECISION_VERIFY=on): before
 * a deliverable is recorded, ask whether it answers the task and reports work
 * actually done. Below the bar on the FIRST attempt the submission is bounced
 * back once with the numbers; the second attempt is always recorded. The judge
 * is advisory — the task creator's approve/reject still decides, and standing
 * still flows only through approval. An outage accepts (never blocks work).
 */

import { getErrorMessage } from "../engine/errors";
import { decideVerify, type VerifyVerdict } from "./policy";
import { noul, score } from "./questions";
import type { DecisionProvider, DecisionQuestions } from "./types";

export const TASK_VERIFY_QUESTIONS: DecisionQuestions = {
  quality: score("How well does the submission satisfy the task?", [
    "Does not address the task.",
    "Partly addresses it, with a gap the task creator would notice.",
    "Fully addresses the task.",
  ]),
  delivered: noul("The submission reports work actually done, not only a plan or an intention.", {
    true: "Describes results, findings, artifacts, links or evidence of completed work.",
    false: "Only says what will be done, restates the task, or asks for more time.",
  }),
};

const MAX_CHARS = 4_000;

export interface SubmissionVerdict extends VerifyVerdict {
  provider?: string;
  model?: string;
  latencyMs?: number;
  costUsd?: number;
  error?: string;
}

export async function verifySubmission(
  provider: DecisionProvider,
  task: { title: string; description?: string },
  submission: string,
  attempt: number,
): Promise<SubmissionVerdict> {
  try {
    const result = await provider.ask({
      state: {
        task: { title: task.title, description: (task.description ?? "").slice(0, MAX_CHARS) },
        submission: submission.slice(0, MAX_CHARS),
      },
      questions: TASK_VERIFY_QUESTIONS,
    });
    return {
      ...decideVerify(result.answers, attempt, undefined, "delivered"),
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
      ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
    };
  } catch (err) {
    return {
      ...decideVerify(undefined, attempt, undefined, "delivered"),
      provider: provider.kind,
      model: provider.model,
      error: getErrorMessage(err),
    };
  }
}

/** Submission attempts per (task, claimant), so the bounce happens at most once. Bounded. */
const attempts = new Map<string, number>();
const MAX_TRACKED = 2_000;

export function nextSubmissionAttempt(taskId: number, entityId: string): number {
  const key = `${taskId}:${entityId}`;
  const n = (attempts.get(key) ?? 0) + 1;
  attempts.delete(key);
  attempts.set(key, n);
  if (attempts.size > MAX_TRACKED) attempts.delete(attempts.keys().next().value as string);
  return n;
}

export function clearSubmissionAttempts(taskId: number, entityId: string): void {
  attempts.delete(`${taskId}:${entityId}`);
}

export function decisionVerifyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MARINA_DECISION_VERIFY?.trim().toLowerCase() === "on";
}
