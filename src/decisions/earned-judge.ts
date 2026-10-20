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
 *  - `decision agreement` (`src/decisions/agreement.ts`): judge opinions on
 *    task submissions against the creators' verdicts.
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

/** A running count of a judge's opinions against the truth they are checked by. */
export interface AgreementTally {
  compared: number;
  agreed: number;
  /** Judge said pass, the truth was a failure (the costly error). */
  falsePass: number;
  /** Judge said fail, the truth was a pass. */
  falseFail: number;
}

export function emptyTally(): AgreementTally {
  return { compared: 0, agreed: 0, falsePass: 0, falseFail: 0 };
}

/**
 * Count one comparison. `same` decides agreement when the judgement is not a
 * plain pass/fail (a forecast's resolved truth); otherwise agreement is
 * `judgePassed === truthPassed`. A disagreement is a false pass or a false
 * fail by which way the judge erred.
 */
export function tallyComparison(
  t: AgreementTally,
  judgePassed: boolean,
  truthPassed: boolean,
  same: boolean = judgePassed === truthPassed,
): AgreementTally {
  t.compared++;
  if (same) t.agreed++;
  else if (judgePassed && !truthPassed) t.falsePass++;
  else if (!judgePassed && truthPassed) t.falseFail++;
  return t;
}
