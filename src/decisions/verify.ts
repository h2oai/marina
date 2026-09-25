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
import type { Evidence } from "./evidence";
import { maskSensitiveText } from "./gate";
import {
  DEFAULT_VERIFY_POLICY,
  decideVerify,
  VERIFY_QUESTIONS,
  type VerifyVerdict,
} from "./policy";
import { choice, noul, score } from "./questions";
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

/** The `grounded` question, reused for submissions that cite evidence. */
const GROUNDED = VERIFY_QUESTIONS.grounded!;

/**
 * A submission that cites in-world evidence (`note:N`, `task:N`, `chronicle:N`)
 * is also checked for grounding against it; an uncited one is judged on
 * quality and delivery alone — citing is rewarded, never required.
 */
export async function verifySubmission(
  provider: DecisionProvider,
  task: { title: string; description?: string },
  submission: string,
  attempt: number,
  evidence: Evidence[] = [],
): Promise<SubmissionVerdict> {
  const keys = evidence.length ? ["delivered", "grounded"] : ["delivered"];
  try {
    const result = await provider.ask({
      state: {
        task: { title: task.title, description: (task.description ?? "").slice(0, MAX_CHARS) },
        submission: submission.slice(0, MAX_CHARS),
        ...(evidence.length ? { evidence } : {}),
      },
      questions: evidence.length
        ? { ...TASK_VERIFY_QUESTIONS, grounded: GROUNDED }
        : TASK_VERIFY_QUESTIONS,
    });
    return {
      ...decideVerify(result.answers, attempt, undefined, keys),
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
      ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
    };
  } catch (err) {
    return {
      ...decideVerify(undefined, attempt, undefined, keys),
      provider: provider.kind,
      model: provider.model,
      error: getErrorMessage(err),
    };
  }
}

/**
 * Self-check for an agent's OWN draft (`decision check`): the article's answer
 * verifier, offered as a tool rather than imposed. The agent decides what to do
 * with the numbers; nothing is blocked or recorded on its behalf.
 */
export async function checkDraft(
  provider: DecisionProvider,
  draft: string,
  evidence: Evidence[],
  request?: string,
): Promise<SubmissionVerdict> {
  const keys = evidence.length ? ["grounded"] : [];
  try {
    const result = await provider.ask({
      state: {
        ...(request ? { request: maskSensitiveText(request, MAX_CHARS) } : {}),
        answer: maskSensitiveText(draft, MAX_CHARS),
        ...(evidence.length ? { evidence } : {}),
      },
      questions: evidence.length ? VERIFY_QUESTIONS : { quality: VERIFY_QUESTIONS.quality! },
    });
    return {
      // attempt 1 of 2 and no unsure-judge waiver: "retry" here just means
      // "below the bar" — the agent reads the numbers and decides.
      ...decideVerify(result.answers, 1, { ...DEFAULT_VERIFY_POLICY, minJudgeConfidence: 0 }, keys),
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
      ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
    };
  } catch (err) {
    return {
      action: "accept",
      reason: "Checker unavailable.",
      signals: {},
      provider: provider.kind,
      model: provider.model,
      error: getErrorMessage(err),
    };
  }
}

export interface ChoiceResult {
  choice?: string;
  confidence?: number;
  provider?: string;
  model?: string;
  latencyMs?: number;
  costUsd?: number;
  error?: string;
}

/** Pick among options (`decision choose`). The caller decides what to do with the pick. */
export async function chooseOption(
  provider: DecisionProvider,
  question: string,
  options: string[],
  context?: string,
): Promise<ChoiceResult> {
  // Option keys are positional so free text never has to be a valid id.
  const criteria = Object.fromEntries(
    options.map((option, i) => [`o${i + 1}`, maskSensitiveText(option, 500)]),
  );
  try {
    const result = await provider.ask({
      state: context ? { context: maskSensitiveText(context, MAX_CHARS) } : {},
      questions: { pick: choice(maskSensitiveText(question, 500), criteria) },
    });
    const answer = result.answers.pick;
    const picked = answer?.type === "choice" ? answer : undefined;
    const index = picked ? Number(picked.choice.slice(1)) - 1 : -1;
    return {
      ...(index >= 0 && index < options.length ? { choice: options[index] } : {}),
      ...(picked?.confidence === undefined ? {} : { confidence: picked.confidence }),
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
      ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
    };
  } catch (err) {
    return { provider: provider.kind, model: provider.model, error: getErrorMessage(err) };
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
