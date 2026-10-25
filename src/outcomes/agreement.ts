// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * How far a judge can be trusted, measured on the outcome path: each judged
 * outcome (`judged:<subject>`) against the mechanical outcome for the same
 * subject once it exists — a creator's verdict on the same task attempt, a
 * market's resolution of the same answer. A judge earns the right to settle
 * results on its own only from this record (`earned`), never from its own
 * confidence; until then its outcomes are opinions that teach nothing.
 *
 * A view over the one judge ledger (`src/decisions/judges.ts`): judged
 * outcomes are the `outcome` and `attention:<kind>` surfaces there, settled
 * when the mechanical outcome is recorded.
 */

import {
  EARNED_JUDGE_MIN_LOWER,
  EARNED_JUDGE_MIN_N,
  judgeEarned as earnedOn,
  judgeStandings,
} from "../decisions/judges";
import type { MarinaDB } from "../persistence/database";

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

type Db = Pick<MarinaDB, "judgeLedgerTallies">;

export function judgeAgreement(db: Db, opts: { judge?: string } = {}): JudgeAgreement[] {
  const judge = opts.judge ? { judge: opts.judge } : {};
  return [
    ...judgeStandings(db, { surface: "outcome", ...judge }),
    ...judgeStandings(db, { surface: "attention:", ...judge }),
  ].map((s) => ({
    judge: s.judge,
    judged: s.opinions,
    compared: s.compared,
    agreed: s.agreed,
    falsePass: s.falsePass,
    lower: s.lower,
    earned: s.earned,
  }));
}

/** True when `judge` has earned agreement on the outcome path (`outcome` surface). */
export function judgeEarned(db: Db, judge: string): boolean {
  return earnedOn(db, "outcome", judge);
}
