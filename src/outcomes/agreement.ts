// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * How far a judge can be trusted, measured on the outcome path: each judged
 * outcome (`judged:<subject>`) against the mechanical outcome for the same
 * subject once it exists — a creator's verdict on the same task attempt, a
 * market's resolution of the same answer. A judge earns the right to settle
 * results on its own only from this record (`earned`), never from its own
 * confidence; until then its outcomes are opinions that teach nothing.
 */

import {
  EARNED_JUDGE_MIN_LOWER,
  EARNED_JUDGE_MIN_N,
  earnedJudge,
  emptyTally,
  tallyComparison,
} from "../decisions/earned-judge";
import type { MarinaDB } from "../persistence/database";
import type { OutcomeRow } from "../persistence/db-outcomes";

/** Comparisons a judge needs before it can be trusted on its own (`earnedJudge`). */
export const EARNED_MIN_COMPARED = EARNED_JUDGE_MIN_N;
/** Wilson 95 % lower bound on agreement a judge needs (`earnedJudge`). */
export const EARNED_MIN_LOWER = EARNED_JUDGE_MIN_LOWER;

export interface JudgeAgreement {
  judge: string;
  /** Judged outcomes in all. */
  judged: number;
  /** Those with a mechanical outcome to compare against. */
  compared: number;
  agreed: number;
  /** Judged pass/yes where the mechanical result was a failure (the costly error). */
  falsePass: number;
  lower: number;
  earned: boolean;
}

/** The mechanical outcome a judged one is compared with, if it exists yet. */
function counterpart(
  db: Pick<MarinaDB, "getOutcomeBySubject" | "listOutcomes">,
  judged: OutcomeRow,
): OutcomeRow | undefined {
  const base = judged.subject.slice("judged:".length);
  if (base.startsWith("task:")) {
    const attempt = base.split(":").slice(0, 3).join(":");
    const verdicts = db.listOutcomes({
      subjectPrefix: `${attempt}:`,
      basis: "mechanical",
      limit: 50,
    });
    const submission = base.match(/:submission:(\d+)$/)?.[1];
    if (submission) {
      // A delayed verifier may finish after approval. Match its actual submission,
      // never the first verdict of a later replacement attempt.
      return verdicts.find((o) => {
        try {
          const refs: unknown = JSON.parse(o.refs_json ?? "[]");
          return Array.isArray(refs) && refs.includes(`task-submission:${submission}`);
        } catch {
          return false;
        }
      });
    }
    // Historical subjects contain only judgment time, without a submission identity.
    return verdicts
      .filter((o) => o.resolved_at >= judged.resolved_at)
      .sort((a, b) => a.resolved_at - b.resolved_at)[0];
  }
  const exact = db.getOutcomeBySubject(base);
  return exact?.basis === "mechanical" ? exact : undefined;
}

/** Whether the judge's outcome says the same as the mechanical one. */
function agrees(judged: OutcomeRow, mechanical: OutcomeRow): boolean {
  if (judged.kind === "forecast") return judged.truth_json === mechanical.truth_json;
  return judged.succeeded === mechanical.succeeded;
}

export function judgeAgreement(
  db: Pick<MarinaDB, "getOutcomeBySubject" | "listOutcomes">,
  opts: { judge?: string; limit?: number } = {},
): JudgeAgreement[] {
  const by = new Map<string, { judged: number; tally: ReturnType<typeof emptyTally> }>();
  for (const j of db.listOutcomes({ basis: "judged", limit: opts.limit ?? 10_000 })) {
    if (!j.subject.startsWith("judged:")) continue;
    const judge = j.judge ?? "unknown";
    if (opts.judge && judge !== opts.judge) continue;
    const a = by.get(judge) ?? { judged: 0, tally: emptyTally() };
    a.judged++;
    const m = counterpart(db, j);
    if (m) tallyComparison(a.tally, j.succeeded === 1, m.succeeded === 1, agrees(j, m));
    by.set(judge, a);
  }
  return [...by.entries()].map(([judge, { judged, tally }]) => ({
    judge,
    judged,
    compared: tally.compared,
    agreed: tally.agreed,
    falsePass: tally.falsePass,
    ...earnedJudge(tally.agreed, tally.compared),
  }));
}

/** True when `judge` has earned agreement on the outcome path. */
export function judgeEarned(
  db: Pick<MarinaDB, "getOutcomeBySubject" | "listOutcomes">,
  judge: string,
): boolean {
  return judgeAgreement(db, { judge })[0]?.earned ?? false;
}
