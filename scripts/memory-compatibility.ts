#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { getErrorMessage } from "../src/engine/errors";
import { MarinaDB } from "../src/persistence/database";
import { acquireDatabaseLease } from "../src/persistence/database-lease";
import { numericMemoryIntegrity } from "../src/persistence/db-memory-projections";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/persistence/schema";

const USAGE =
  "Usage: memory:compatibility status|upgrade DB. `status` only reads; `upgrade` applies pending migrations. Backfill/retry were retired; database upgrades convert memory atomically.";

type Integrity = ReturnType<typeof numericMemoryIntegrity>;

export interface CompatibilityStatus {
  schemaVersion: number;
  latestVersion: number;
  pendingMigrations: number;
  /** Null while migrations are pending: the counts describe the converted schema. */
  integrity: Integrity | null;
  /** Set when the report is incomplete or the database needs action. */
  action?: string;
}

/** True when the report shows nothing for an operator to do. */
export function statusIsClean(status: CompatibilityStatus): boolean {
  const integrity = status.integrity;
  return (
    status.pendingMigrations === 0 &&
    status.schemaVersion <= status.latestVersion &&
    integrity !== null &&
    !integrity.unconverted &&
    !integrity.broken &&
    !integrity.duplicateBodies
  );
}

/**
 * Report a database's schema version, pending migrations and numeric-memory
 * integrity WITHOUT changing it: the file is opened read-only, no migration
 * runs and no lease file is created. Integrity counts need the converted
 * schema, so a database with pending migrations reports the count and the
 * command that applies them instead.
 */
export function compatibilityStatus(path: string): CompatibilityStatus {
  if (!existsSync(path)) throw new Error(`Database not found: ${path}`);
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query("SELECT MAX(version) AS version FROM schema_version").get() as {
      version: number | null;
    } | null;
    const schemaVersion = row?.version ?? 0;
    const pendingMigrations = MIGRATIONS.filter((m) => m.version > schemaVersion).length;
    const base = { schemaVersion, latestVersion: SCHEMA_VERSION, pendingMigrations };
    if (schemaVersion > SCHEMA_VERSION)
      return {
        ...base,
        integrity: null,
        action: `schema ${schemaVersion} is newer than this binary supports (${SCHEMA_VERSION}); use the newer binary`,
      };
    if (pendingMigrations > 0)
      return {
        ...base,
        integrity: null,
        action: `${pendingMigrations} migrations pending; stop the server and run \`bun run memory:compatibility upgrade ${path}\` to apply them`,
      };
    return { ...base, integrity: numericMemoryIntegrity(db) };
  } finally {
    db.close();
  }
}

/** Apply pending migrations under the database lease, then report integrity. */
function upgrade(path: string): Integrity {
  const release = acquireDatabaseLease(path);
  try {
    const db = new MarinaDB(path);
    try {
      return numericMemoryIntegrity(db.memoryRepository().raw);
    } finally {
      db.close();
    }
  } finally {
    release();
  }
}

if (import.meta.main) {
  try {
    const [operation, path] = process.argv.slice(2);
    if (!path || !["status", "upgrade"].includes(operation ?? "")) throw new Error(USAGE);
    if (operation === "status") {
      const status = compatibilityStatus(path);
      console.log(JSON.stringify(status));
      if (!statusIsClean(status)) process.exitCode = 1;
    } else {
      const result = upgrade(path);
      console.log(JSON.stringify(result));
      if (result.unconverted || result.broken || result.duplicateBodies) process.exitCode = 1;
    }
  } catch (error) {
    console.error(getErrorMessage(error));
    process.exitCode = 1;
  }
}
