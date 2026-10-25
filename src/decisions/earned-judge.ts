// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one rule for when a judge has EARNED the right to act on its own, and
 * the one way its agreement with people (or with mechanical results) is
 * counted. Every surface that measures a judge uses these:
 *
 *  - the outcome judges (`src/outcomes/agreement.ts`): judged outcomes against
 *    the mechanical outcome for the same subject;
 *  - the challenge judge (`src/engine/challenges.ts`): its `allow` calls
 *    against what people answered (precision of allow);
 *  - `decision agreement`: judge opinions on task submissions against the
 *    creators' verdicts.
 *
 * Every surface reaches it through the one judge ledger (`judgeEarned` in
 * `src/decisions/judges.ts`), never a tally of its own.
 *
 * Earned = at least `EARNED_JUDGE_MIN_N` comparisons and a Wilson 95 % lower
 * bound on the agreement rate of at least `EARNED_JUDGE_MIN_LOWER`. A judge's
 * own confidence never counts. Pure.
 */

import { wilsonInterval } from "../stats";

/** Comparisons a judge needs before it can be trusted on its own. */
export const EARNED_JUDGE_MIN_N = 25;
/** Wilson 95 % lower bound on agreement a judge needs. */
export const EARNED_JUDGE_MIN_LOWER = 0.85;

export interface EarnedJudge {
  /** Wilson 95 % lower bound on `agreed / compared` (0 with nothing compared). */
  lower: number;
  earned: boolean;
}

/** Whether `agreed` of `compared` comparisons earn a judge its autonomy. */
export function earnedJudge(agreed: number, compared: number): EarnedJudge {
  const lower = compared > 0 ? wilsonInterval(agreed, compared).low : 0;
  return {
    lower,
    earned: compared >= EARNED_JUDGE_MIN_N && lower >= EARNED_JUDGE_MIN_LOWER,
  };
}
