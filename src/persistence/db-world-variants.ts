// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

export type WorldVariantStatus =
  | "draft"
  | "starting"
  | "running"
  | "stopped"
  | "failed"
  | "promoted"
  | "archived";

export interface WorldVariantRow {
  id: string;
  name: string;
  world_template: string;
  hypothesis: string;
  status: WorldVariantStatus;
  parent_variant_id: string | null;
  source_root: string;
  db_path: string;
  ws_port: number;
  pid: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  promoted_at: number | null;
  promotion_rationale: string | null;
  promotion_evidence: string | null;
  promoted_by: string | null;
  last_error: string | null;
}

export function createWorldVariant(
  db: Database,
  input: {
    name: string;
    worldTemplate: string;
    hypothesis?: string;
    parentVariantId?: string;
    sourceRoot: string;
    dbPath: string;
    wsPort: number;
    createdBy: string;
  },
): WorldVariantRow {
  const now = Date.now();
  const row: WorldVariantRow = {
    id: randomUUID(),
    name: input.name,
    world_template: input.worldTemplate,
    hypothesis: input.hypothesis ?? "",
    status: "draft",
    parent_variant_id: input.parentVariantId ?? null,
    source_root: input.sourceRoot,
    db_path: input.dbPath,
    ws_port: input.wsPort,
    pid: null,
    created_by: input.createdBy,
    created_at: now,
    updated_at: now,
    promoted_at: null,
    promotion_rationale: null,
    promotion_evidence: null,
    promoted_by: null,
    last_error: null,
  };
  db.run(
    `INSERT INTO world_variants
     (id,name,world_template,hypothesis,status,parent_variant_id,source_root,db_path,ws_port,pid,
      created_by,created_at,updated_at,promoted_at,promotion_rationale,promotion_evidence,promoted_by,last_error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.id,
      row.name,
      row.world_template,
      row.hypothesis,
      row.status,
      row.parent_variant_id,
      row.source_root,
      row.db_path,
      row.ws_port,
      row.pid,
      row.created_by,
      row.created_at,
      row.updated_at,
      row.promoted_at,
      row.promotion_rationale,
      row.promotion_evidence,
      row.promoted_by,
      row.last_error,
    ],
  );
  return row;
}

export function getWorldVariant(reader: Database, id: string): WorldVariantRow | undefined {
  return (
    (reader.query("SELECT * FROM world_variants WHERE id=?").get(id) as WorldVariantRow | null) ??
    undefined
  );
}

export function listWorldVariants(reader: Database): WorldVariantRow[] {
  return reader
    .query("SELECT * FROM world_variants ORDER BY created_at DESC")
    .all() as WorldVariantRow[];
}

export function updateWorldVariant(
  db: Database,
  id: string,
  patch: {
    status?: WorldVariantStatus;
    pid?: number | null;
    lastError?: string | null;
    promotedAt?: number | null;
  },
): WorldVariantRow | undefined {
  const sets = ["updated_at=?"];
  const values: Array<string | number | null> = [Date.now()];
  if (patch.status !== undefined) {
    sets.push("status=?");
    values.push(patch.status);
  }
  if (patch.pid !== undefined) {
    sets.push("pid=?");
    values.push(patch.pid);
  }
  if (patch.lastError !== undefined) {
    sets.push("last_error=?");
    values.push(patch.lastError);
  }
  if (patch.promotedAt !== undefined) {
    sets.push("promoted_at=?");
    values.push(patch.promotedAt);
  }
  values.push(id);
  db.run(`UPDATE world_variants SET ${sets.join(",")} WHERE id=?`, values);
  return getWorldVariant(db, id);
}

export function promoteWorldVariant(
  db: Database,
  id: string,
  input: { rationale: string; evidenceRefs: string[]; promotedBy: string },
): WorldVariantRow | undefined {
  const current = getWorldVariant(db, id);
  if (!current || (current.status !== "running" && current.status !== "stopped")) return undefined;
  const now = Date.now();
  const promote = db.transaction(() => {
    db.run(
      "UPDATE world_variants SET promoted_at=NULL,updated_at=? WHERE promoted_at IS NOT NULL",
      [now],
    );
    db.run(
      `UPDATE world_variants SET promoted_at=?,promotion_rationale=?,promotion_evidence=?,promoted_by=?,updated_at=?
       WHERE id=? AND status IN ('running','stopped')`,
      [now, input.rationale, JSON.stringify(input.evidenceRefs), input.promotedBy, now, id],
    );
    return getWorldVariant(db, id);
  });
  return promote();
}
