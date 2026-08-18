// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

// ─── Standing Ledger Persistence ─────────────────────────────────────────────
//
// Every contribution (task complete, pool note, crew completion, helping act)
// becomes one row in `entity_standing`, idempotent on `(entity_id, kind, ref)`.
// The rollup cache `entity_standing_cache` holds the decayed civic-standing
// number that permission checks read.
//
// The decay function and credit amounts are policy in `src/agent/standing.ts`.
// This file is pure SQL.

export interface StandingLedgerRow {
  id: number;
  entity_id: string;
  entity_name: string;
  kind: string;
  ref: string;
  task_id: number | null;
  amount: number;
  decay_class: string;
  earned_at: number;
}

export interface StandingCacheRow {
  entity_id: string;
  standing: number;
  last_recomputed: number;
}

export function appendStandingEvent(
  db: Database,
  row: {
    entityId: string;
    entityName: string;
    kind: string;
    ref: string;
    amount: number;
    taskId?: number | null;
    decayClass?: string;
    earnedAt?: number;
  },
): void {
  db.run(
    `INSERT INTO entity_standing
       (entity_id, entity_name, kind, ref, task_id, amount, decay_class, earned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_id, kind, ref) DO NOTHING`,
    [
      row.entityId,
      row.entityName,
      row.kind,
      row.ref,
      row.taskId ?? null,
      row.amount,
      row.decayClass ?? "standard",
      row.earnedAt ?? Date.now(),
    ],
  );
  // Mark this entity's cache stale so the next read recomputes.
  db.run(
    `INSERT INTO entity_standing_cache (entity_id, standing, last_recomputed)
     VALUES (?, 0, 0)
     ON CONFLICT(entity_id) DO UPDATE SET last_recomputed = 0`,
    [row.entityId],
  );
}

/**
 * Compute decayed standing for an entity from the ledger. Pure SQL — no
 * in-process iteration. Decay is exponential with a configurable half-life;
 * the caller passes in `halfLifeMs` so the policy stays out of this module.
 */
export function computeStanding(
  db: Database,
  entityId: string,
  halfLifeMs: number,
  horizonMs: number,
  now: number,
): number {
  const cutoff = now - horizonMs;
  // SQLite EXP() gives natural exponentiation; 0.5 ** x = exp(x * ln 0.5).
  const row = db
    .query(
      `SELECT COALESCE(
         SUM(amount * EXP(((? - earned_at) / 1.0 / ?) * -0.6931471805599453)),
         0
       ) AS total
       FROM entity_standing
       WHERE entity_id = ? AND earned_at >= ?`,
    )
    .get(now, halfLifeMs, entityId, cutoff) as { total: number };
  return row.total;
}

export function getStandingCache(db: Database, entityId: string): StandingCacheRow | undefined {
  return (
    (db
      .query(
        "SELECT entity_id, standing, last_recomputed FROM entity_standing_cache WHERE entity_id = ?",
      )
      .get(entityId) as StandingCacheRow | null) ?? undefined
  );
}

export function setStandingCache(
  db: Database,
  entityId: string,
  standing: number,
  now: number,
): void {
  db.run(
    `INSERT INTO entity_standing_cache (entity_id, standing, last_recomputed)
     VALUES (?, ?, ?)
     ON CONFLICT(entity_id) DO UPDATE SET standing = ?, last_recomputed = ?`,
    [entityId, standing, now, standing, now],
  );
}

export function listStandingEntities(db: Database): string[] {
  return (
    db
      .query(
        `SELECT DISTINCT entity_id FROM (
           SELECT entity_id FROM entity_standing
           UNION
           SELECT entity_id FROM entity_standing_cache
         )`,
      )
      .all() as { entity_id: string }[]
  ).map((r) => r.entity_id);
}

/** Entity ids whose cached standing is stale (older than `cutoff`) or was just
 *  invalidated to last_recomputed=0 by a fresh ledger write — i.e. needs a
 *  recompute before being read on the leaderboard. */
export function staleStandingEntities(db: Database, cutoff: number): string[] {
  return (
    db
      .query("SELECT entity_id FROM entity_standing_cache WHERE last_recomputed < ?")
      .all(cutoff) as { entity_id: string }[]
  ).map((r) => r.entity_id);
}

export function standingLeaderboard(
  db: Database,
  limit: number,
): { entityId: string; standing: number }[] {
  return db
    .query(
      `SELECT entity_id AS entityId, standing
       FROM entity_standing_cache
       ORDER BY standing DESC
       LIMIT ?`,
    )
    .all(limit) as { entityId: string; standing: number }[];
}

export function ledgerForEntity(
  db: Database,
  entityId: string,
  limit: number,
): StandingLedgerRow[] {
  return db
    .query(
      `SELECT id, entity_id, entity_name, kind, ref, task_id, amount, decay_class, earned_at
       FROM entity_standing
       WHERE entity_id = ?
       ORDER BY earned_at DESC
       LIMIT ?`,
    )
    .all(entityId, limit) as StandingLedgerRow[];
}
