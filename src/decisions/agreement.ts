// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * How far to trust a judge: its recorded opinions of task submissions against
 * the verdicts the task creators gave afterwards (approve / reject). Pure.
 *
 * One judge per `evaluator` (`<provider kind>:<model>`), so Jev on OpenRouter,
 * a local OpenJev and a chat-model classifier are measured separately — a
 * number earned by one never vouches for another. Only the latest opinion per
 * (task, claimant, evaluator) counts: a bounced first draft is not what the
 * creator later approved. No opinion (an outage) and no verdict yet are
 * counted apart, never as agreement.
 */

import type { JudgeObservationRow } from "../persistence/db-decisions";

export interface JudgeAgreement {
  evaluator: string;
  calibrated: boolean;
  /** Opinions with a human verdict to compare against. */
  compared: number;
  agreed: number;
  /** Judge passed, creator rejected. */
  falsePass: number;
  /** Judge failed, creator approved. */
  falseFail: number;
  /** Judge gave no usable opinion (outage, unparseable reply). */
  noOpinion: number;
  /** Opinion recorded; the creator has not decided yet. */
  awaitingVerdict: number;
}

export function judgeAgreement(rows: readonly JudgeObservationRow[]): JudgeAgreement[] {
  const latest = new Map<string, JudgeObservationRow>();
  for (const r of rows) {
    const key = `${r.evaluator}\u0000${r.task_id}\u0000${r.claimant_name}`;
    const prior = latest.get(key);
    if (!prior || r.id > prior.id) latest.set(key, r);
  }
  const by = new Map<string, JudgeAgreement>();
  for (const r of latest.values()) {
    const a = by.get(r.evaluator) ?? {
      evaluator: r.evaluator,
      calibrated: r.calibrated === 1,
      compared: 0,
      agreed: 0,
      falsePass: 0,
      falseFail: 0,
      noOpinion: 0,
      awaitingVerdict: 0,
    };
    by.set(r.evaluator, a);
    if (r.opinion === "none") {
      a.noOpinion++;
      continue;
    }
    if (r.outcome !== "approved" && r.outcome !== "rejected") {
      a.awaitingVerdict++;
      continue;
    }
    a.compared++;
    const approved = r.outcome === "approved";
    if ((r.opinion === "pass") === approved) a.agreed++;
    else if (r.opinion === "pass") a.falsePass++;
    else a.falseFail++;
  }
  return [...by.values()].sort((x, y) => y.compared - x.compared);
}
