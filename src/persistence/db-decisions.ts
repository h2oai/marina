// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Judge observations (migration 129): what a decision backend thought of a
 * piece of work, kept so it can be compared with the human verdict that
 * follows. Backend-agnostic: `evaluator` is `<provider kind>:<model>` —
 * Jev on OpenRouter, a local OpenJev, TypeSafe or a chat model used as a
 * classifier all land here the same way, with `calibrated` saying whether its
 * probabilities are frequencies.
 */

import type { Database } from "bun:sqlite";
import type { DecisionReceipt } from "../sdk/decision-receipt";

export interface DecisionReceiptRow {
  id: string;
  owner: string;
  subject: string;
  family: string;
  receipt_json: string;
  created_at: number;
}

function receiptOwner(db: Database, name: string): string {
  const user = db.query("SELECT id FROM users WHERE name = ? COLLATE NOCASE").get(name) as {
    id: string;
  } | null;
  return user ? `user:${user.id}` : `name:${name}`;
}

export function recordDecisionReceipt(
  db: Database,
  owner: string,
  subject: string,
  receipt: DecisionReceipt,
): void {
  db.run(
    "INSERT OR IGNORE INTO decision_receipts (id, owner, subject, family, receipt_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [
      receipt.id,
      receiptOwner(db, owner),
      subject,
      receipt.family,
      JSON.stringify(receipt),
      receipt.createdAt,
    ],
  );
}

/** An explicit owner is mandatory: receipt inspection is never a global listing. */
export function listDecisionReceipts(
  db: Database,
  owner: string,
  limit = 50,
): DecisionReceiptRow[] {
  return db
    .query(
      "SELECT * FROM decision_receipts WHERE owner = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    )
    .all(
      receiptOwner(db, owner),
      Math.max(1, Math.min(500, Math.floor(limit) || 50)),
    ) as DecisionReceiptRow[];
}

/** Attribution is supplied by an outcome producer, never inferred from a judge's opinion. */
export function linkDecisionOutcome(
  db: Database,
  owner: string,
  decisionId: string,
  outcomeId: number,
): boolean {
  return (
    db.run(
      `INSERT OR IGNORE INTO decision_outcomes (decision_id, outcome_id)
    SELECT d.id, o.id FROM decision_receipts d JOIN outcomes o ON o.id = ?
    WHERE d.id = ? AND d.owner = ? AND o.owner = ? AND d.created_at <= o.resolved_at`,
      [outcomeId, decisionId, receiptOwner(db, owner), owner],
    ).changes > 0
  );
}

export function decisionOutcomeIds(db: Database, owner: string, decisionId: string): number[] {
  return (
    db
      .query(`SELECT x.outcome_id FROM decision_outcomes x
    JOIN decision_receipts d ON d.id = x.decision_id
    WHERE d.owner = ? AND d.id = ? ORDER BY x.outcome_id`)
      .all(receiptOwner(db, owner), decisionId) as { outcome_id: number }[]
  ).map((row) => row.outcome_id);
}

/** The judge's own opinion of the work — never the policy's accept/bounce. */
export type JudgeOpinion = "pass" | "fail" | "none";

export interface JudgeObservationInput {
  taskId: number;
  claimantName: string;
  evaluator: string;
  calibrated: boolean;
  /** `observe` (never acted on) or `on` (the verifier could bounce). */
  mode: "observe" | "on";
  opinion: JudgeOpinion;
  /** The judge's numbers (quality 0–2, delivered/grounded 0–1, confidence). */
  signals: Record<string, number>;
  error?: string;
}

export interface JudgeObservationRow {
  id: number;
  task_id: number;
  claimant_name: string;
  evaluator: string;
  calibrated: number;
  mode: string;
  opinion: JudgeOpinion;
  signals: string;
  error: string | null;
  created_at: number;
  /** The claim's status now (approved / rejected / submitted / …), via task_claims. */
  outcome: string | null;
}

export function recordJudgeObservation(db: Database, row: JudgeObservationInput): number {
  const result = db
    .query(
      `INSERT INTO judge_observations
         (task_id, claimant_name, evaluator, calibrated, mode, opinion, signals, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.taskId,
      row.claimantName,
      row.evaluator,
      row.calibrated ? 1 : 0,
      row.mode,
      row.opinion,
      JSON.stringify(row.signals),
      row.error ?? null,
      Date.now(),
    );
  return Number(result.lastInsertRowid);
}

/** Observations newest first, each joined to its claim's current outcome. */
export function listJudgeObservations(
  reader: Database,
  opts: { evaluator?: string; limit?: number } = {},
): JudgeObservationRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 2_000, 1), 10_000);
  const where = opts.evaluator ? "WHERE o.evaluator = ?" : "";
  const params: (string | number)[] = opts.evaluator ? [opts.evaluator, limit] : [limit];
  return reader
    .query(
      `SELECT o.*, c.status AS outcome
         FROM judge_observations o
         LEFT JOIN task_claims c ON c.task_id = o.task_id AND c.entity_name = o.claimant_name
         ${where}
        ORDER BY o.id DESC LIMIT ?`,
    )
    .all(...params) as JudgeObservationRow[];
}

// ─── Challenge outcomes (migration 139) ─────────────────────────────────

export type ChallengeOutcomeAnswer = "once" | "always" | "deny" | "expired";

export interface ChallengeOutcomeInput {
  token: string;
  kind: "gate" | "rank" | "tool";
  /** What the judge's agreement is measured per: the gate id, `rank:<n>`, or `tool:<name>`. */
  class: string;
  requesterName: string;
  creatorName?: string;
  toolName?: string;
  summary: string;
  reason: string;
  answer: ChallengeOutcomeAnswer;
  answeredBy?: string;
  answeredRole?: "creator" | "admin" | "judge";
  judgeOpinion?: "allow" | "hold" | "none";
  judgeSignals?: Record<string, number>;
  createdAt: number;
}

export interface ChallengeOutcomeRow {
  id: number;
  token: string;
  kind: string;
  class: string;
  requester_name: string;
  creator_name: string | null;
  tool_name: string | null;
  summary: string;
  reason: string;
  answer: ChallengeOutcomeAnswer;
  answered_by: string | null;
  answered_role: string | null;
  judge_opinion: string | null;
  judge_signals: string | null;
  created_at: number;
  answered_at: number;
}

export function recordChallengeOutcome(db: Database, row: ChallengeOutcomeInput): number {
  const result = db
    .query(
      `INSERT INTO challenge_outcomes
         (token, kind, class, requester_name, creator_name, tool_name, summary, reason, answer,
          answered_by, answered_role, judge_opinion, judge_signals, created_at, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.token,
      row.kind,
      row.class,
      row.requesterName,
      row.creatorName ?? null,
      row.toolName ?? null,
      row.summary,
      row.reason,
      row.answer,
      row.answeredBy ?? null,
      row.answeredRole ?? null,
      row.judgeOpinion ?? null,
      row.judgeSignals ? JSON.stringify(row.judgeSignals) : null,
      row.createdAt,
      Date.now(),
    );
  return Number(result.lastInsertRowid);
}

/** Outcomes newest first, optionally for one class. */
export function listChallengeOutcomes(
  reader: Database,
  opts: { class?: string; limit?: number } = {},
): ChallengeOutcomeRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 2_000, 1), 10_000);
  const where = opts.class ? "WHERE class = ?" : "";
  const params: (string | number)[] = opts.class ? [opts.class, limit] : [limit];
  return reader
    .query(`SELECT * FROM challenge_outcomes ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params) as ChallengeOutcomeRow[];
}
