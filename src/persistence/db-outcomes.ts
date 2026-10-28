// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The outcome path's tables (migration 162): one append-only `outcomes` row
 * per resolved subject, and each consumer's durable delivery state for it.
 * Rows hold numbers and labels only; private context stays on the subject.
 */

import type { Database } from "bun:sqlite";
import { MemoryError } from "../memory/service-types";

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

export function assertOutcomeLearningActive(db: Database, outcomeId: number): void {
  const state = db
    .query("SELECT erased_at FROM outcome_learning_state WHERE outcome_id=?")
    .get(outcomeId) as { erased_at: number | null } | null;
  if (
    state?.erased_at != null ||
    (!state && !db.query("SELECT 1 FROM outcomes WHERE id=?").get(outcomeId))
  )
    throw new MemoryError(
      410,
      "learning_erased",
      "Learning delivery was cancelled by explicit erasure",
    );
}

export function bindOutcomeLearningSpace(db: Database, outcomeId: number, space: string): void {
  db.transaction(() => {
    assertOutcomeLearningActive(db, outcomeId);
    const active = db
      .query("SELECT 1 FROM memory_spaces WHERE id=? AND status='active'")
      .get(space);
    if (!active)
      throw new MemoryError(410, "space_forgotten", "Learning space is no longer active");
    db.run("INSERT OR IGNORE INTO outcome_learning_state(outcome_id) VALUES (?)", [outcomeId]);
    db.run("INSERT OR IGNORE INTO outcome_learning_spaces(outcome_id,space_id) VALUES (?,?)", [
      outcomeId,
      space,
    ]);
  })();
}

/** Opaque journal context cannot be safely separated after explicit forgetting. */
export function eraseOutcomeLearning(db: Database, ids: number[]): void {
  for (const id of ids) {
    db.run(
      "INSERT INTO outcome_learning_state(outcome_id,erased_at) VALUES (?,?) ON CONFLICT(outcome_id) DO UPDATE SET erased_at=excluded.erased_at",
      [id, Date.now()],
    );
    db.run("DELETE FROM outcome_learning_steps WHERE outcome_id=?", [id]);
    db.run(
      "UPDATE outcome_deliveries SET state='skipped',reason='learning cancelled by explicit erasure',updated_at=? WHERE outcome_id=? AND consumer='lessons' AND state='pending'",
      [Date.now(), id],
    );
    db.run(
      "UPDATE memory_requests SET response=json_object('id',space_id,'retired',1),retired_at=? WHERE request_key LIKE ? AND retired_at IS NULL",
      [Date.now(), `outcome:${id}:%`],
    );
  }
}

export function eraseSpaceOutcomeLearning(db: Database, space: string): void {
  eraseOutcomeLearning(
    db,
    (
      db.query("SELECT outcome_id FROM outcome_learning_spaces WHERE space_id=?").all(space) as {
        outcome_id: number;
      }[]
    ).map((r) => r.outcome_id),
  );
}

export function getOutcomeLearningStep(
  db: Database,
  outcomeId: number,
  step: string,
): { value_json: string } | undefined {
  assertOutcomeLearningActive(db, outcomeId);
  return (
    (db
      .query("SELECT value_json FROM outcome_learning_steps WHERE outcome_id=? AND step=?")
      .get(outcomeId, step) as { value_json: string } | null) ?? undefined
  );
}

export function saveOutcomeLearningStep(
  db: Database,
  outcomeId: number,
  step: string,
  valueJson: string,
): void {
  db.transaction(() => {
    assertOutcomeLearningActive(db, outcomeId);
    db.run(
      "INSERT OR IGNORE INTO outcome_learning_steps(outcome_id,step,value_json,created_at) VALUES (?,?,?,?)",
      [outcomeId, step, valueJson, Date.now()],
    );
  })();
}

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

export interface OutcomeFilter {
  kind?: OutcomeKind;
  /** A source, or a prefix ending in `:` (`code:` matches `code:verify`). */
  source?: string;
  owner?: string;
  basis?: OutcomeBasis;
  /** Resolved at or after this time (ms). */
  since?: number;
  /** Subjects starting with this (`task:7:Ada:` — every verdict on that attempt). */
  subjectPrefix?: string;
  limit?: number;
}

/** Newest first, at most `limit` (default 50, at most 10 000). */
export function listOutcomes(db: Database, opts: OutcomeFilter = {}): OutcomeRow[] {
  // General outcome/strategy readers have no case ACL. Private case results are
  // read through their authorized case projection, never pooled into method selection.
  const where: string[] = ["source NOT LIKE 'investigation:%'"];
  const args: Array<string | number> = [];
  if (opts.kind) {
    where.push("kind = ?");
    args.push(opts.kind);
  }
  if (opts.source) {
    if (opts.source.endsWith(":")) {
      where.push("substr(source, 1, ?) = ?");
      args.push(opts.source.length, opts.source);
    } else {
      where.push("source = ?");
      args.push(opts.source);
    }
  }
  if (opts.owner) {
    where.push("owner = ?");
    args.push(opts.owner);
  }
  if (opts.basis) {
    where.push("basis = ?");
    args.push(opts.basis);
  }
  if (opts.since !== undefined) {
    where.push("resolved_at >= ?");
    args.push(opts.since);
  }
  if (opts.subjectPrefix) {
    where.push("substr(subject, 1, ?) = ?");
    args.push(opts.subjectPrefix.length, opts.subjectPrefix);
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 10_000));
  return db
    .query(
      `SELECT * FROM outcomes${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
       ORDER BY id DESC LIMIT ?`,
    )
    .all(...args, limit) as OutcomeRow[];
}

/** Pending outcomes, least recently attempted first so unavailable rows cannot starve new work. */
export function pendingOutcomes(db: Database, consumer: string, limit: number): OutcomeRow[] {
  return db
    .query(
      `SELECT o.* FROM outcome_deliveries d JOIN outcomes o ON o.id = d.outcome_id
       WHERE d.consumer = ? AND d.state = 'pending' ORDER BY d.updated_at, d.outcome_id LIMIT ?`,
    )
    .all(consumer, Math.max(0, limit)) as OutcomeRow[];
}

/** Settle or retry a pending delivery. Unavailable verdicts do not spend the error-attempt budget. */
export function setOutcomeDelivery(
  db: Database,
  outcomeId: number,
  consumer: string,
  state: DeliveryState,
  reason?: string,
  now = Date.now(),
  countAttempt = true,
): void {
  db.run(
    `UPDATE outcome_deliveries SET state = ?, reason = ?, attempts = attempts + ?, updated_at = ?
     WHERE outcome_id = ? AND consumer = ? AND state = 'pending'`,
    [state, reason ?? null, countAttempt ? 1 : 0, now, outcomeId, consumer],
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
