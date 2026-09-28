// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Database } from "bun:sqlite";

const installed = new WeakMap<Database, number>();
const worldDependencies = new Set([
  "users",
  "principals",
  "principal_credentials",
  "notes",
  "note_links",
  "note_sources",
  "note_verifications",
  "entity_standing",
  "entity_standing_cache",
]);

/** Connection-local invalidation: canonical memory, identity, authority and ranking.
 * TEMP triggers never change the persisted schema or migration history. Other
 * connections are covered by data_version; new memory tables are included after DDL.
 * https://www.sqlite.org/lang_createtrigger.html#temp_triggers_on_non_temp_tables */
export function contextRevision(db: Database): string {
  const schema = (db.query("PRAGMA main.schema_version").get() as { schema_version: number })
    .schema_version;
  if (installed.get(db) !== schema) {
    db.exec("CREATE TEMP TABLE IF NOT EXISTS marina_context_revision (revision INTEGER NOT NULL)");
    db.exec(
      "INSERT INTO temp.marina_context_revision SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM temp.marina_context_revision)",
    );
    const tables = db
      .query("SELECT name FROM pragma_table_list WHERE schema='main' AND type='table'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      if (!worldDependencies.has(name) && !name.startsWith("memory_")) continue;
      // Identifiers come from SQLite, but quote them even for locally installed extensions.
      const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
      for (const event of ["INSERT", "UPDATE", "DELETE"]) {
        db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${quote(`marina_context_${name}_${event}`)}
          AFTER ${event} ON main.${quote(name)} BEGIN
          UPDATE marina_context_revision SET revision=revision+1; END`);
      }
    }
    installed.set(db, schema);
  }
  // Read on this same connection. data_version is not comparable across connections.
  const row = db
    .query(`SELECT revision, (SELECT data_version FROM pragma_data_version) AS external
    FROM temp.marina_context_revision`)
    .get() as { revision: number; external: number };
  return `${schema}:${row.external}:${row.revision}`;
}

/** Time can withdraw authority without a write. Bound a cache entry by the next
 * credential, evidence or delegation transition, even if that item was not returned. */
export function contextDeadline(db: Database, now: number): number {
  const row = db
    .query(`SELECT min(deadline) AS deadline FROM (
    SELECT min(expires_at) AS deadline FROM principal_credentials WHERE expires_at > ? AND revoked_at IS NULL
    UNION ALL SELECT min(valid_from) FROM memory_records WHERE valid_from > ?
    UNION ALL SELECT min(valid_until) FROM memory_records WHERE valid_until > ?
    UNION ALL SELECT min(deadline) FROM memory_assistance_jobs WHERE deadline > ?
    UNION ALL SELECT min(lease_until) FROM memory_assistance_jobs WHERE lease_until > ?
  )`)
    .get(now, now, now, now, now) as { deadline: number | null };
  return row.deadline ?? Number.POSITIVE_INFINITY;
}
