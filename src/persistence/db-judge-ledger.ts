// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The judge ledger (migration 179): every judge opinion and, once it is
 * known, the ground truth it is checked against — one row per (surface,
 * judge, subject). The policy (surfaces, the earned rule, modes) lives in
 * `src/decisions/judges.ts`; this module is the SQL.
 *
 * A row's `truth_key` names the mechanical result that settles it: an exact
 * outcome subject, or — ending in `:` — a task attempt's prefix
 * (`task:<id>:<claimant>:`), settled by the first verdict on that attempt at
 * or after the opinion. A truth is set once; a new opinion on the same
 * subject (a resubmission judged again) replaces the opinion and clears it.
 */

import type { Database } from "bun:sqlite";
import { JUDGE_LEDGER_BACKFILL_179 } from "./schema";

export type JudgeVerdict = "pass" | "fail";

export interface JudgeOpinionInput {
  surface: string;
  /** The question within a surface that agreement is counted per (a challenge class); '' for one. */
  question?: string;
  /** `<kind>:<model>`. */
  judge: string;
  subject: string;
  truthKey?: string;
  opinion: JudgeVerdict | "none";
  /** Compared with the truth's value instead of pass/fail (a judged forecast resolution). */
  opinionValue?: string;
  calibrated?: boolean;
  /** Known at once (a challenge answer, a resolved overrule). */
  truth?: JudgeVerdict;
  /** Overrides `opinion === truth` (an overrule that beat the majority). */
  agreed?: boolean;
  opinedAt: number;
  truthAt?: number;
}

export interface JudgeLedgerRow {
  id: number;
  surface: string;
  question: string;
  judge: string;
  subject: string;
  truth_key: string | null;
  opinion: JudgeVerdict | "none";
  opinion_value: string | null;
  calibrated: number | null;
  truth: JudgeVerdict | null;
  agreed: number | null;
  opined_at: number;
  truth_at: number | null;
  origin: string;
}

/** Counts per (surface, judge[, question]). */
export interface JudgeLedgerTally {
  surface: string;
  judge: string;
  question: string;
  /** Opinions recorded. */
  opinions: number;
  /** Opinions with no usable answer (an outage). */
  noOpinion: number;
  /** Opinions still waiting for their ground truth. */
  awaiting: number;
  /** Opinions with a ground truth. */
  compared: number;
  agreed: number;
  falsePass: number;
  falseFail: number;
  /** Pass opinions with a truth, and those the truth confirmed (precision of pass). */
  passCompared: number;
  passAgreed: number;
  /** 1 when every opinion came from a calibrated backend, 0 when any did not, null unknown. */
  calibrated: number | null;
  lastAt: number;
}

export function recordJudgeOpinion(db: Database, row: JudgeOpinionInput): void {
  const agreed =
    row.truth === undefined || row.opinion === "none"
      ? null
      : (row.agreed ?? row.opinion === row.truth)
        ? 1
        : 0;
  db.query(
    `INSERT INTO judge_ledger
       (surface, question, judge, subject, truth_key, opinion, opinion_value, calibrated,
        truth, agreed, opined_at, truth_at, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')
     ON CONFLICT (surface, judge, subject) DO UPDATE SET
       question = excluded.question, truth_key = excluded.truth_key,
       opinion = excluded.opinion, opinion_value = excluded.opinion_value,
       calibrated = excluded.calibrated, truth = excluded.truth, agreed = excluded.agreed,
       opined_at = excluded.opined_at, truth_at = excluded.truth_at, origin = 'live'`,
  ).run(
    row.surface,
    row.question ?? "",
    row.judge,
    row.subject,
    row.truthKey ?? null,
    row.opinion,
    row.opinionValue ?? null,
    row.calibrated === undefined ? null : row.calibrated ? 1 : 0,
    row.truth ?? null,
    agreed,
    row.opinedAt,
    row.truth === undefined ? null : (row.truthAt ?? row.opinedAt),
  );
}

/** A task attempt's prefix for a verdict subject `task:<id>:<claimant>:<at>`. */
export function attemptKeyOf(subject: string): string | undefined {
  const submission = subject.match(/^(task:\d+:.+):submission:\d+$/);
  if (submission) return `${submission[1]}:`;
  const m = subject.match(/^(task:\d+:.+:)\d+$/);
  return m?.[1];
}

/**
 * Settle the unsettled opinions a mechanical result answers: those keyed on
 * its exact subject, and — for a task verdict — those on its attempt opined at
 * or before it. Returns the rows settled.
 */
export function settleJudgeTruth(
  db: Database,
  truth: { subject: string; succeeded: boolean; truthJson?: string | null; resolvedAt: number },
): number {
  const verdict: JudgeVerdict = truth.succeeded ? "pass" : "fail";
  const attempt = attemptKeyOf(truth.subject) ?? null;
  return db
    .query(
      `UPDATE judge_ledger SET
         truth = ?1, truth_at = ?2,
         agreed = CASE WHEN opinion = 'none' THEN NULL
                       WHEN opinion_value IS NOT NULL THEN opinion_value = ?3
                       ELSE opinion = ?1 END
       WHERE truth IS NULL AND (truth_key = ?4 OR (truth_key = ?5 AND opined_at <= ?2))`,
    )
    .run(verdict, truth.resolvedAt, truth.truthJson ?? "", truth.subject, attempt).changes;
}

/** The first mechanical outcome that settles `key` (for an opinion recorded after its truth). */
export function findJudgeTruth(
  db: Database,
  key: string,
  opinedAt: number,
): { subject: string; succeeded: number; truth_json: string | null; resolved_at: number } | null {
  type Row = { subject: string; succeeded: number; truth_json: string | null; resolved_at: number };
  if (!key.endsWith(":"))
    return db
      .query(
        "SELECT subject, succeeded, truth_json, resolved_at FROM outcomes WHERE subject = ? AND basis = 'mechanical'",
      )
      .get(key) as Row | null;
  return db
    .query(
      `SELECT subject, succeeded, truth_json, resolved_at FROM outcomes
        WHERE subject BETWEEN ?1 AND ?1 || '~' AND basis = 'mechanical' AND resolved_at >= ?2
        ORDER BY resolved_at LIMIT 1`,
    )
    .get(key, opinedAt) as Row | null;
}

export function listJudgeLedger(
  db: Database,
  opts: { surface?: string; judge?: string; limit?: number } = {},
): JudgeLedgerRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.surface) {
    where.push("surface = ?");
    params.push(opts.surface);
  }
  if (opts.judge) {
    where.push("judge = ?");
    params.push(opts.judge);
  }
  params.push(Math.max(1, Math.min(10_000, Math.floor(opts.limit ?? 500))));
  return db
    .query(
      `SELECT * FROM judge_ledger ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY id DESC LIMIT ?`,
    )
    .all(...params) as JudgeLedgerRow[];
}

/**
 * Tallies per (surface, judge) — and per question with `byQuestion`. A
 * surface ending in `:` is a prefix (`attention:` is every attention judge).
 */
export function judgeLedgerTallies(
  db: Database,
  opts: { surface?: string; judge?: string; question?: string; byQuestion?: boolean } = {},
): JudgeLedgerTally[] {
  const where: string[] = [];
  const params: string[] = [];
  if (opts.surface?.endsWith(":")) {
    where.push("surface BETWEEN ? AND ? || '~'");
    params.push(opts.surface, opts.surface);
  } else if (opts.surface) {
    where.push("surface = ?");
    params.push(opts.surface);
  }
  if (opts.judge) {
    where.push("judge = ?");
    params.push(opts.judge);
  }
  if (opts.question !== undefined) {
    where.push("question = ?");
    params.push(opts.question);
  }
  const question = opts.byQuestion ? "question" : "''";
  return db
    .query(
      `SELECT surface, judge, ${question} AS question,
         count(*) AS opinions,
         sum(opinion = 'none') AS noOpinion,
         sum(opinion <> 'none' AND truth IS NULL) AS awaiting,
         sum(opinion <> 'none' AND truth IS NOT NULL) AS compared,
         sum(opinion <> 'none' AND truth IS NOT NULL AND agreed = 1) AS agreed,
         sum(opinion = 'pass' AND truth IS NOT NULL AND agreed = 0 AND truth = 'fail') AS falsePass,
         sum(opinion = 'fail' AND truth IS NOT NULL AND agreed = 0 AND truth = 'pass') AS falseFail,
         sum(opinion = 'pass' AND truth IS NOT NULL) AS passCompared,
         sum(opinion = 'pass' AND truth IS NOT NULL AND agreed = 1) AS passAgreed,
         min(calibrated) AS calibrated,
         max(opined_at) AS lastAt
       FROM judge_ledger ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       GROUP BY surface, judge${opts.byQuestion ? ", question" : ""}
       ORDER BY surface, compared DESC, judge`,
    )
    .all(...params) as JudgeLedgerTally[];
}

/** Re-run migration 179's copy of older judge rows (idempotent). */
export function backfillJudgeLedger(db: Database): void {
  db.exec(JUDGE_LEDGER_BACKFILL_179);
}
