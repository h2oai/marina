// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The outcome path's tables (migration 162): one append-only `outcomes` row
 * per resolved subject, and each consumer's durable delivery state for it.
 * Rows hold numbers and labels only; private context stays on the subject.
 */

import type { Database } from "bun:sqlite";

export type OutcomeKind = "forecast" | "task" | "request" | "benchmark";
export type OutcomeBasis = "mechanical" | "judged";
export type OutcomeEvalMode = "live" | "measure";
export type DeliveryState = "pending" | "done" | "skipped" | "failed";

export interface OutcomeRow {
  id: number;
  /** What resolved: `forecast:<answer id>`, `task:<id>`, … (unique). */
  subject: string;
  kind: OutcomeKind;
  /** The producer (`forecast:choice`, `metaculus:binary`, …): lesson families key on it. */
  source: string;
  /** The lesson domain (`forecast`, `code`, `tools`, …). */
  domain: string;
  /** Whose work it was (an entity or account name). */
  owner: string | null;
  succeeded: 0 | 1;
  /** 0–1, higher is better. */
  quality: number | null;
  /** The stored loss, lower is better (Brier, CRPS, …). */
  loss: number | null;
  metric: string | null;
  truth_json: string | null;
  /** A short mechanical description (no private text). */
  detail: string | null;
  basis: OutcomeBasis;
  /** The judge (`<kind>:<model>`) when `basis` is `judged`. */
  judge: string | null;
  eval_mode: OutcomeEvalMode | null;
  participants_json: string | null;
  refs_json: string | null;
  resolved_at: number;
  created_at: number;
}

export interface OutcomeInput {
  subject: string;
  kind: OutcomeKind;
  source: string;
  domain: string;
  owner?: string;
  succeeded: boolean;
  quality?: number;
  loss?: number;
  metric?: string;
  truth?: unknown;
  detail?: string;
  basis: OutcomeBasis;
  judge?: string;
  evalMode?: OutcomeEvalMode;
  participants?: unknown;
  refs?: string[];
  resolvedAt: number;
  now?: number;
}

export interface DeliveryRow {
  outcome_id: number;
  consumer: string;
  state: DeliveryState;
  attempts: number;
  reason: string | null;
  updated_at: number;
}

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

/**
 * Record one resolved subject and a pending delivery per consumer, in one
 * transaction. A subject already recorded is never re-recorded (settle once):
 * `created` is false and the existing row's id is returned.
 */
export function recordOutcomeRow(
  db: Database,
  input: OutcomeInput,
  consumers: readonly string[],
): { id: number; created: boolean } {
  return db.transaction(() => {
    const now = input.now ?? Date.now();
    const result = db.run(
      `INSERT OR IGNORE INTO outcomes
         (subject, kind, source, domain, owner, succeeded, quality, loss, metric, truth_json,
          detail, basis, judge, eval_mode, participants_json, refs_json, resolved_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.subject,
        input.kind,
        input.source,
        input.domain,
        input.owner ?? null,
        input.succeeded ? 1 : 0,
        input.quality ?? null,
        input.loss ?? null,
        input.metric ?? null,
        json(input.truth),
        input.detail ?? null,
        input.basis,
        input.judge ?? null,
        input.evalMode ?? null,
        json(input.participants),
        input.refs?.length ? JSON.stringify(input.refs) : null,
        input.resolvedAt,
        now,
      ],
    );
    if (result.changes === 0) {
      const existing = db.query("SELECT id FROM outcomes WHERE subject = ?").get(input.subject) as {
        id: number;
      };
      return { id: existing.id, created: false };
    }
    const id = Number(result.lastInsertRowid);
    const add = db.prepare(
      `INSERT INTO outcome_deliveries (outcome_id, consumer, state, attempts, updated_at)
       VALUES (?, ?, 'pending', 0, ?)`,
    );
    for (const c of new Set(consumers)) add.run(id, c, now);
    return { id, created: true };
  })();
}

export function getOutcome(db: Database, id: number): OutcomeRow | undefined {
  return (
    (db.query("SELECT * FROM outcomes WHERE id = ?").get(id) as OutcomeRow | null) ?? undefined
  );
}

export function getOutcomeBySubject(db: Database, subject: string): OutcomeRow | undefined {
  return (
    (db.query("SELECT * FROM outcomes WHERE subject = ?").get(subject) as OutcomeRow | null) ??
    undefined
  );
}

export function listOutcomes(
  db: Database,
  opts: { kind?: OutcomeKind; limit?: number } = {},
): OutcomeRow[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 1000));
  return (
    opts.kind
      ? db
          .query("SELECT * FROM outcomes WHERE kind = ? ORDER BY id DESC LIMIT ?")
          .all(opts.kind, limit)
      : db.query("SELECT * FROM outcomes ORDER BY id DESC LIMIT ?").all(limit)
  ) as OutcomeRow[];
}

/** Outcomes still pending for `consumer`, oldest first. */
export function pendingOutcomes(db: Database, consumer: string, limit: number): OutcomeRow[] {
  return db
    .query(
      `SELECT o.* FROM outcome_deliveries d JOIN outcomes o ON o.id = d.outcome_id
       WHERE d.consumer = ? AND d.state = 'pending' ORDER BY d.outcome_id LIMIT ?`,
    )
    .all(consumer, Math.max(0, limit)) as OutcomeRow[];
}

/** Settle or retry one delivery; every call counts as one attempt. */
export function setOutcomeDelivery(
  db: Database,
  outcomeId: number,
  consumer: string,
  state: DeliveryState,
  reason?: string,
  now = Date.now(),
): void {
  db.run(
    `UPDATE outcome_deliveries SET state = ?, reason = ?, attempts = attempts + 1, updated_at = ?
     WHERE outcome_id = ? AND consumer = ?`,
    [state, reason ?? null, now, outcomeId, consumer],
  );
}

export function outcomeDeliveries(db: Database, outcomeId: number): DeliveryRow[] {
  return db
    .query("SELECT * FROM outcome_deliveries WHERE outcome_id = ? ORDER BY consumer")
    .all(outcomeId) as DeliveryRow[];
}

/** Delivery counts per consumer and state (operators: is learning keeping up?). */
export function outcomeDeliveryCounts(
  db: Database,
): Array<{ consumer: string; state: DeliveryState; n: number }> {
  return db
    .query(
      `SELECT consumer, state, COUNT(*) AS n FROM outcome_deliveries
       GROUP BY consumer, state ORDER BY consumer, state`,
    )
    .all() as Array<{ consumer: string; state: DeliveryState; n: number }>;
}
