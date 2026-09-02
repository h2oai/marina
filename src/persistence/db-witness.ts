// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Witness ledger — durable storage for the earnable path through safety gates.
 *
 * Row kinds:
 * - `request`: an agent asked for supervision on a gate ("I'm ready to try —
 *   will someone watch?"). Informational; qualified witnesses see it in
 *   `witness queue`.
 * - `window`:  a qualified witness granted ONE supervised demonstration
 *   (TTL-bounded). The enforcement site consumes it at execution time and
 *   records a witnessed demonstration attributed to the granting witness.
 * - `pending`: under the `earned` autonomy posture, a supervised operation ran
 *   optimistically; the demonstration is recorded here and counts toward the
 *   unsupervised flip only when a qualified witness attests it afterwards.
 */

import type { Database } from "bun:sqlite";

export type WitnessKind = "request" | "window" | "pending";
export type WitnessStatus = "open" | "attested" | "rejected" | "expired" | "consumed";

export interface WitnessRow {
  id: number;
  entity_id: string;
  gate: string;
  kind: WitnessKind;
  status: WitnessStatus;
  evidence: string | null;
  witness_id: string | null;
  reason: string | null;
  created_at: number;
  expires_at: number | null;
  resolved_at: number | null;
}

export function createWitnessRow(
  db: Database,
  input: {
    entityId: string;
    gate: string;
    kind: WitnessKind;
    evidence?: string;
    witnessId?: string;
    expiresAt?: number;
    now?: number;
  },
): WitnessRow {
  const now = input.now ?? Date.now();
  const result = db.run(
    `INSERT INTO witness_attestations
     (entity_id, gate, kind, status, evidence, witness_id, created_at, expires_at)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?)`,
    [
      input.entityId,
      input.gate,
      input.kind,
      input.evidence ?? null,
      input.witnessId ?? null,
      now,
      input.expiresAt ?? null,
    ],
  );
  return getWitnessRow(db, Number(result.lastInsertRowid))!;
}

export function getWitnessRow(db: Database, id: number): WitnessRow | undefined {
  return (
    (db.query("SELECT * FROM witness_attestations WHERE id = ?").get(id) as WitnessRow | null) ??
    undefined
  );
}

/** The open supervision window for (entity, gate), if one is live. Expired
 *  windows are lazily marked on read. */
export function getOpenWindow(
  db: Database,
  entityId: string,
  gate: string,
  now = Date.now(),
): WitnessRow | undefined {
  expireStale(db, now);
  return (
    (db
      .query(
        `SELECT * FROM witness_attestations
         WHERE entity_id = ? AND gate = ? AND kind = 'window' AND status = 'open'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(entityId, gate) as WitnessRow | null) ?? undefined
  );
}

/** Consume a live window (one window = one supervised demonstration). Returns
 *  the granting witness id, or undefined when no live window exists. */
export function consumeWindow(
  db: Database,
  entityId: string,
  gate: string,
  now = Date.now(),
): string | undefined {
  const window = getOpenWindow(db, entityId, gate, now);
  if (!window) return undefined;
  db.run("UPDATE witness_attestations SET status = 'consumed', resolved_at = ? WHERE id = ?", [
    now,
    window.id,
  ]);
  return window.witness_id ?? undefined;
}

export function resolveWitnessRow(
  db: Database,
  id: number,
  status: Extract<WitnessStatus, "attested" | "rejected" | "expired">,
  input: { witnessId?: string; reason?: string; now?: number } = {},
): void {
  db.run(
    `UPDATE witness_attestations
     SET status = ?, witness_id = COALESCE(?, witness_id), reason = COALESCE(?, reason), resolved_at = ?
     WHERE id = ? AND status = 'open'`,
    [status, input.witnessId ?? null, input.reason ?? null, input.now ?? Date.now(), id],
  );
}

/** Open rows a witness could act on: requests + pending demonstrations,
 *  oldest first, bounded. */
export function listOpenWitnessRows(
  db: Database,
  opts: { kind?: WitnessKind; gate?: string; entityId?: string; limit?: number } = {},
): WitnessRow[] {
  expireStale(db);
  const clauses = ["status = 'open'"];
  const params: Array<string | number> = [];
  if (opts.kind) {
    clauses.push("kind = ?");
    params.push(opts.kind);
  }
  if (opts.gate) {
    clauses.push("gate = ?");
    params.push(opts.gate);
  }
  if (opts.entityId) {
    clauses.push("entity_id = ?");
    params.push(opts.entityId);
  }
  params.push(Math.max(1, Math.min(opts.limit ?? 50, 200)));
  return db
    .query(
      `SELECT * FROM witness_attestations WHERE ${clauses.join(" AND ")}
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(...params) as WitnessRow[];
}

/** Count attested demonstrations for (entity, gate) — the earned-posture
 *  progress that has passed external review. */
export function countAttested(db: Database, entityId: string, gate: string): number {
  return (
    db
      .query(
        `SELECT COUNT(*) AS n FROM witness_attestations
         WHERE entity_id = ? AND gate = ? AND kind = 'pending' AND status = 'attested'`,
      )
      .get(entityId, gate) as { n: number }
  ).n;
}

function expireStale(db: Database, now = Date.now()): void {
  db.run(
    `UPDATE witness_attestations SET status = 'expired', resolved_at = ?
     WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at < ?`,
    [now, now],
  );
}
