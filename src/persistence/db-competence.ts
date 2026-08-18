// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

// ─── Entity Competence Persistence ──────────────────────────────────────────
//
// One row per (entity, gate). `demonstrations` accumulates each successful
// supervised use; `supervised_only` flips to 0 once enough demonstrations
// have been recorded. Rows are inserted lazily on first attempt at a gated
// operation (see src/engine/safety-gates.ts).

export interface CompetenceRow {
  entity_id: string;
  gate: string;
  demonstrations: number;
  last_demo_at: number | null;
  supervised_only: number;
}

export function getCompetence(
  db: Database,
  entityId: string,
  gate: string,
): CompetenceRow | undefined {
  return (
    (db
      .query(
        "SELECT entity_id, gate, demonstrations, last_demo_at, supervised_only FROM entity_competence WHERE entity_id = ? AND gate = ?",
      )
      .get(entityId, gate) as CompetenceRow | null) ?? undefined
  );
}

export function listCompetenceForEntity(db: Database, entityId: string): CompetenceRow[] {
  return db
    .query(
      "SELECT entity_id, gate, demonstrations, last_demo_at, supervised_only FROM entity_competence WHERE entity_id = ? ORDER BY gate",
    )
    .all(entityId) as CompetenceRow[];
}

export function recordDemonstration(
  db: Database,
  entityId: string,
  gate: string,
  unlockAt: number,
  now: number,
): void {
  // The CASE on the INSERT side matters for gates with unlockAt === 1
  // (e.g. admin.destructive): the very first demo must flip supervised_only
  // to 0, but a plain INSERT would never run the ON CONFLICT branch.
  const initialSupervised = unlockAt <= 1 ? 0 : 1;
  db.run(
    `INSERT INTO entity_competence (entity_id, gate, demonstrations, last_demo_at, supervised_only)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(entity_id, gate) DO UPDATE SET
       demonstrations = demonstrations + 1,
       last_demo_at = excluded.last_demo_at,
       supervised_only = CASE
         WHEN demonstrations + 1 >= ? THEN 0
         ELSE supervised_only
       END`,
    [entityId, gate, now, initialSupervised, unlockAt],
  );
}

/** Force-grant a gate (for admin overrides, world seeds). */
export function grantCompetence(db: Database, entityId: string, gate: string): void {
  db.run(
    `INSERT INTO entity_competence (entity_id, gate, demonstrations, supervised_only)
     VALUES (?, ?, 999, 0)
     ON CONFLICT(entity_id, gate) DO UPDATE SET
       demonstrations = MAX(demonstrations, 999),
       supervised_only = 0`,
    [entityId, gate],
  );
}

/** Force-revoke a gate. */
export function revokeCompetence(db: Database, entityId: string, gate: string): void {
  db.run("DELETE FROM entity_competence WHERE entity_id = ? AND gate = ?", [entityId, gate]);
}
