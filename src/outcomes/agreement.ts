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

import { wilsonInterval } from "../../benchmarks/stats";
import type { MarinaDB } from "../persistence/database";
import type { OutcomeRow } from "../persistence/db-outcomes";

/** Comparisons a judge needs before it can be trusted on its own. */
export const EARNED_MIN_COMPARED = 25;
/** Wilson 95 % lower bound on agreement a judge needs. */
export const EARNED_MIN_LOWER = 0.85;

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
    // `task:<id>:<claimant>:<time>` → the first creator verdict on that attempt after the opinion.
    const attempt = base.split(":").slice(0, 3).join(":");
    return db
      .listOutcomes({ subjectPrefix: `${attempt}:`, basis: "mechanical", limit: 50 })
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
  const by = new Map<string, JudgeAgreement>();
  for (const j of db.listOutcomes({ basis: "judged", limit: opts.limit ?? 10_000 })) {
    if (!j.subject.startsWith("judged:")) continue;
    const judge = j.judge ?? "unknown";
    if (opts.judge && judge !== opts.judge) continue;
    const a = by.get(judge) ?? {
      judge,
      judged: 0,
      compared: 0,
      agreed: 0,
      falsePass: 0,
      lower: 0,
      earned: false,
    };
    a.judged++;
    const m = counterpart(db, j);
    if (m) {
      a.compared++;
      if (agrees(j, m)) a.agreed++;
      else if (j.succeeded === 1 && m.succeeded === 0) a.falsePass++;
    }
    by.set(judge, a);
  }
  return [...by.values()].map((a) => {
    const lower = a.compared ? wilsonInterval(a.agreed, a.compared).low : 0;
    return {
      ...a,
      lower,
      earned: a.compared >= EARNED_MIN_COMPARED && lower >= EARNED_MIN_LOWER,
    };
  });
}

/** True when `judge` has earned agreement on the outcome path. */
export function judgeEarned(
  db: Pick<MarinaDB, "getOutcomeBySubject" | "listOutcomes">,
  judge: string,
): boolean {
  return judgeAgreement(db, { judge })[0]?.earned ?? false;
}
