// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { BASE_SCHEMA, MIGRATIONS } from "../src/persistence/schema";

/**
 * Bring an EMPTY raw database to exactly `version` through the real upgrade
 * history — each migration's SQL and data conversion, as `MarinaDB` runs it —
 * so a test can seed rows an older release would have held. Independent of
 * where the fresh-install baseline currently sits. One transaction: a single
 * durable commit, not one fsync per migration.
 */
export function migrateEmptyTo(db: Database, version: number): void {
  if (!MIGRATIONS.some((migration) => migration.version === version))
    throw new Error(`No migration ${version}`);
  db.transaction(() => {
    db.exec(BASE_SCHEMA);
    for (const migration of MIGRATIONS.filter((m) => m.version <= version)) {
      db.exec(migration.sql);
      migration.apply?.(db);
      db.run("INSERT OR REPLACE INTO schema_version (version) VALUES (?)", [migration.version]);
    }
  })();
}
