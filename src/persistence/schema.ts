// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { upgradeNumericMemory } from "./db-memory-upgrade";
import { SCHEMA_BASELINE_VERSION } from "./schema-baseline";
import {
  MIGRATIONS as HISTORICAL_MIGRATIONS,
  type Migration as HistoricalMigration,
} from "./schema-history";

export { SCHEMA_BASELINE, SCHEMA_BASELINE_VERSION } from "./schema-baseline";
/** Historical definitions stay immutable for upgrades and data-rewrite fixtures. */
export {
  BASE_SCHEMA,
  JUDGE_LEDGER_BACKFILL_179,
  type Migration as HistoricalMigration,
} from "./schema-history";

/** Append new versions after the baseline here. Do not rewrite the baseline or history. */
export interface Migration extends HistoricalMigration {
  apply?: (db: Database) => void;
}

/** Data conversions of migrations folded into the baseline, keyed by version.
 * They run with that version's SQL when an EXISTING database upgrades through
 * it, and once on an empty database when the baseline is generated (138 drops
 * the historical outbox; 143 finds no rows; 172 adds the known-at columns and
 * triggers). */
const MIGRATION_HOOKS: Readonly<Partial<Record<number, (db: Database) => void>>> = {
  138: upgradeNumericMemory,
  143: hashMemApiKeySecrets,
  172: installMemoryKnownAt,
};

export const FORWARD_MIGRATIONS: Migration[] = [];

/** Migration 172 body — self-contained so later edits elsewhere never change it. */
function installMemoryKnownAt(db: Database): void {
  const addColumn = (table: string, column: string) => {
    const columns = db.query(`PRAGMA table_info("${table}")`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER`);
  };
  addColumn("memory_record_versions", "known_at");
  addColumn("memory_sources", "known_at");
  addColumn("memory_assistance_jobs", "completed_known_at");
  db.exec(`
CREATE TRIGGER IF NOT EXISTS memory_known_at_version AFTER INSERT ON memory_service_events
WHEN new.operation IN ('memory.created','memory.revised') AND new.reference_id IS NOT NULL BEGIN
  UPDATE memory_record_versions SET known_at = max(coalesce(known_at, 0), new.created_at)
   WHERE record_id = new.reference_id AND version = new.version;
END;
CREATE TRIGGER IF NOT EXISTS memory_known_at_source AFTER INSERT ON memory_service_events
WHEN new.operation = 'source.captured' AND new.reference_id IS NOT NULL BEGIN
  UPDATE memory_sources SET known_at = max(coalesce(known_at, 0), new.created_at)
   WHERE id = new.reference_id;
END;
CREATE TRIGGER IF NOT EXISTS memory_known_at_proposal AFTER INSERT ON memory_service_events
WHEN new.operation = 'assistance.completed' AND new.reference_id IS NOT NULL BEGIN
  UPDATE memory_assistance_jobs SET completed_known_at = max(coalesce(completed_known_at, 0), new.created_at)
   WHERE id = new.reference_id;
END;
`);
  // Everything at or below today's last event is the backfill's; later events
  // are dated by the triggers above. An empty log has nothing to backfill.
  db.run(
    `INSERT OR IGNORE INTO memory_known_at_backfill (id, cursor, upto)
     SELECT 1, 0, coalesce(max(seq), 0) FROM memory_service_events`,
  );
}

/** Migration 143 body — self-contained so later edits to db-notes never change it. */
function hashMemApiKeySecrets(db: Database): void {
  const rows = db.query("SELECT id, secret FROM mem_api_keys").all() as {
    id: string;
    secret: string;
  }[];
  const update = db.prepare("UPDATE mem_api_keys SET secret = ? WHERE id = ?");
  for (const row of rows) {
    if (row.secret.startsWith("sha256:")) continue;
    const digest = createHash("sha256").update(row.secret, "utf8").digest("hex");
    update.run(`sha256:${digest}`, row.id);
  }
}
export const SCHEMA_VERSION = FORWARD_MIGRATIONS.at(-1)?.version ?? SCHEMA_BASELINE_VERSION;

/** Full upgrade history; fresh databases use SCHEMA_BASELINE in one transaction. */
export const MIGRATIONS: Migration[] = [
  ...HISTORICAL_MIGRATIONS.map((migration) => {
    const apply = MIGRATION_HOOKS[migration.version];
    return apply ? { ...migration, apply } : migration;
  }),
  ...FORWARD_MIGRATIONS,
];
