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
