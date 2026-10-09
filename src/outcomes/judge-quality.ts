// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Judged quality of work that has no verdict (`MARINA_OUTCOME_JUDGE`, the
 * same switch as judged resolution). A task submission its creator never
 * approved or rejected teaches nothing and counts for no one. After a grace
 * period, the decision backend (Jev or any Jev-like engine) judges whether
 * the submission completes the task — one yes/no, numbers only.
 *
 *   observe  the opinion is a judged outcome (`judged:task:<id>:<claimant>:<t>`):
 *            recorded, teaches nothing, and measured against the creator's
 *            verdict if one comes later (`outcome agreement`).
 *   on       as observe; when this judge has EARNED agreement and is
 *            confident (≥ 0.9), the opinion is also delivered — a lesson
 *            scoped to whose work it was, labelled judged, and live evidence
 *            (`outcome evidence judged`). A creator's verdict always wins:
 *            it records its own mechanical outcome whenever it comes.
 *
 * One opinion per submission (the verifier's, if it already judged it, counts).
 * Bounded per pass, stopped by the daily spend cap; no backend ⇒ nothing.
 */

import { harnessDecisionProvider } from "../decisions/engines";
import { noul } from "../decisions/questions";
import type { DecisionProvider, NoulAnswer } from "../decisions/types";
import { Logger } from "../engine/logger";
import { dailyCapRefusal } from "../engine/spend-ledger";
import type { MarinaDB } from "../persistence/database";
import { judgeEarned } from "./agreement";
import { JUDGE_MIN_CONFIDENCE, judgeResolutionMode } from "./judge-resolution";
import { participantOf, taskBase } from "./live";
import { recordResolved } from "./record";

const logger = new Logger();

/** Time a submission waits for its creator before a judge looks at it. */
export const QUALITY_GRACE_MS = 3 * 86_400_000;
/** Submissions judged per pass. */
export const QUALITY_MAX_PER_PASS = 5;

export interface JudgeQualityReport {
  judged: number;
  delivered: number;
  failed: number;
  stoppedBy?: string;
}

export async function judgeWaitingWork(
  db: MarinaDB,
  opts: {
    env?: NodeJS.ProcessEnv;
    judge?: DecisionProvider;
    now?: () => number;
    max?: number;
  } = {},
): Promise<JudgeQualityReport> {
  const env = opts.env ?? process.env;
  const report: JudgeQualityReport = { judged: 0, delivered: 0, failed: 0 };
  const mode = judgeResolutionMode(env);
  if (mode === "off") return report;
  const judge = opts.judge ?? harnessDecisionProvider(env);
  if (!judge) {
    report.stoppedBy = "no decision backend";
    return report;
  }
  const judgeId = `${judge.kind}:${judge.model}`;
  const now = opts.now ?? Date.now;
  for (const claim of db.waitingSubmissions(now() - QUALITY_GRACE_MS, 100)) {
    if (report.judged >= (opts.max ?? QUALITY_MAX_PER_PASS)) break;
    const base = taskBase(claim.task_id, claim.entity_name);
    // Already judged since this submission (by this pass or the verifier).
    const already = db
      .listOutcomes({ subjectPrefix: `judged:${base}:`, limit: 20 })
      .some((o) => o.resolved_at >= (claim.submitted_at ?? 0));
    if (already) continue;
    const task = db.getTask(claim.task_id);
    if (!task || !claim.submission_text?.trim()) continue;
    const capped = dailyCapRefusal(env);
    if (capped) {
      report.stoppedBy = capped;
      break;
    }
    report.judged++;
    try {
      const result = await judge.ask({
        state: {
          task: {
            title: task.title,
            ...(task.description ? { description: task.description } : {}),
            ...(task.deliverables ? { deliverables: task.deliverables } : {}),
          },
          submission: claim.submission_text.slice(0, 8_000),
        },
        questions: {
          complete: noul(
            "Does the submission complete the task as described, including its deliverables?",
            {
              true: "the task is done as asked",
              false: "the task is not done, only partly done, or done differently than asked",
            },
          ),
        },
      });
      const p = (result.answers.complete as NoulAnswer | undefined)?.noul;
      if (p === undefined) throw new Error("no answer");
      const confidence = Math.max(p, 1 - p);
      const deliver =
        mode === "on" && confidence >= JUDGE_MIN_CONFIDENCE && judgeEarned(db, judgeId);
      recordResolved(
        db,
        {
          subject: `judged:${base}:${now()}`,
          kind: "task",
          source: "task:verdict",
          domain: "tools",
          owner: claim.entity_name,
          succeeded: p >= 0.5,
          quality: p,
          metric: "judge-quality",
          detail: "no verdict from the task's creator; judged",
          basis: "judged",
          judge: judgeId,
          participants: [participantOf(db, claim.entity_name)],
          refs: [`task:${claim.task_id}`],
          resolvedAt: now(),
        },
        { deliverJudged: deliver },
      );
      if (deliver) report.delivered++;
    } catch (err) {
      // An outage is no opinion: nothing recorded; a later pass tries again.
      report.failed++;
      logger.warn("main", "judged quality failed", {
        task: claim.task_id,
        error: (err as Error).message,
      });
    }
  }
  return report;
}
