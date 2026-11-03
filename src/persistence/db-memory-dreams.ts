// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dream records (migration 189, `memory_dreams`): one append-only row per
 * dream pass — the region's hash and size, the accepted ops (ids, relations,
 * a supersede text's hash and length — never its text), the rejected ops
 * with the check that failed each, the probe set (ids and hashes), the
 * checks' counts, spend and model. The history a later dream learns from and
 * `memory dream log|show` reads. Never pruned.
 */

import type { Database } from "bun:sqlite";
import type {
  DreamChecks,
  DreamMode,
  DreamProbe,
  DreamTrigger,
  RejectedOp,
  StoredDreamOp,
} from "../memory/dream/types";

export type DreamState = "observed" | "applied" | "rolled_back";

export interface DreamRow {
  id: number;
  entity_name: string;
  trigger: DreamTrigger;
  mode: DreamMode;
  state: DreamState;
  region_hash: string;
  region_count: number;
  region_new: number;
  region_bytes: number;
  ops_json: string;
  rejected_json: string;
  probes_json: string;
  checks_json: string;
  model: string | null;
  spend_usd: number;
  created_at: number;
  applied_at: number | null;
  rolled_back_at: number | null;
}

export interface DreamInsert {
  entityName: string;
  trigger: DreamTrigger;
  mode: DreamMode;
  state: DreamState;
  regionHash: string;
  regionCount: number;
  regionNew: number;
  regionBytes: number;
  ops: StoredDreamOp[];
  rejected: RejectedOp[];
  probes: DreamProbe[];
  checks: DreamChecks;
  model?: string | null;
  spendUsd?: number;
  createdAt?: number;
}

export function recordDream(db: Database, input: DreamInsert): number {
  const result = db.run(
    `INSERT INTO memory_dreams
       (entity_name, trigger, mode, state, region_hash, region_count, region_new, region_bytes,
        ops_json, rejected_json, probes_json, checks_json, model, spend_usd, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      input.entityName,
      input.trigger,
      input.mode,
      input.state,
      input.regionHash,
      input.regionCount,
      input.regionNew,
      input.regionBytes,
      JSON.stringify(input.ops),
      JSON.stringify(input.rejected),
      JSON.stringify(input.probes),
      JSON.stringify(input.checks),
      input.model ?? null,
      input.spendUsd ?? 0,
      input.createdAt ?? Date.now(),
    ],
  );
  return Number(result.lastInsertRowid);
}

/** What apply and rollback change on a dream row: its state, stamps and the ops' footprint. */
export interface DreamUpdate {
  state?: DreamState;
  ops?: StoredDreamOp[];
  probes?: DreamProbe[];
  checks?: DreamChecks;
  appliedAt?: number;
  rolledBackAt?: number;
}

/** The row is append-only as history; only its state, stamps and footprint columns move. */
export function updateDream(db: Database, id: number, patch: DreamUpdate): boolean {
  const sets: string[] = [];
  const args: (string | number)[] = [];
  const set = (column: string, value: string | number) => {
    sets.push(`${column} = ?`);
    args.push(value);
  };
  if (patch.state) set("state", patch.state);
  if (patch.ops) set("ops_json", JSON.stringify(patch.ops));
  if (patch.probes) set("probes_json", JSON.stringify(patch.probes));
  if (patch.checks) set("checks_json", JSON.stringify(patch.checks));
  if (patch.appliedAt !== undefined) set("applied_at", patch.appliedAt);
  if (patch.rolledBackAt !== undefined) set("rolled_back_at", patch.rolledBackAt);
  if (!sets.length) return false;
  args.push(id);
  return db.run(`UPDATE memory_dreams SET ${sets.join(", ")} WHERE id = ?`, args).changes > 0;
}

export function getDream(db: Database, id: number): DreamRow | undefined {
  return (
    (db.query("SELECT * FROM memory_dreams WHERE id = ?").get(id) as DreamRow | null) ?? undefined
  );
}

/** An entity's dreams, newest first. */
export function listDreams(db: Database, entityName: string, limit = 20): DreamRow[] {
  return db
    .query("SELECT * FROM memory_dreams WHERE entity_name = ? ORDER BY id DESC LIMIT ?")
    .all(entityName, Math.max(1, limit)) as DreamRow[];
}

/** The newest dreams of every entity (or of one), newest first — the dashboard's list. */
export function listRecentDreams(db: Database, limit = 30, entityName?: string): DreamRow[] {
  const bounded = Math.min(Math.max(1, limit), 200);
  return entityName
    ? listDreams(db, entityName, bounded)
    : (db.query("SELECT * FROM memory_dreams ORDER BY id DESC LIMIT ?").all(bounded) as DreamRow[]);
}

/** When the entity last dreamed (any state), or undefined. */
export function lastDreamAt(db: Database, entityName: string): number | undefined {
  const row = db
    .query<{ at: number | null }, [string]>(
      "SELECT max(created_at) AS at FROM memory_dreams WHERE entity_name = ?",
    )
    .get(entityName);
  return row?.at ?? undefined;
}

export function parseDreamJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
