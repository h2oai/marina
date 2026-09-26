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
