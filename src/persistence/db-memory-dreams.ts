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
