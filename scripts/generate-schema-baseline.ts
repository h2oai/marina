#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SCHEMA_BASELINE_VERSION } from "../src/persistence/schema-baseline";
import { BASE_SCHEMA, MIGRATIONS } from "../src/persistence/schema-history";

// Replay only in a disposable database, never against an operator's world.
const db = new Database(":memory:");
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
try {
  db.exec(BASE_SCHEMA);
  for (const migration of MIGRATIONS.filter((m) => m.version <= SCHEMA_BASELINE_VERSION))
    db.exec(migration.sql);
  const shadows = new Set(
    (db.query("PRAGMA table_list").all() as { name: string; type: string }[])
      .filter((table) => table.type === "shadow")
      .map((table) => table.name),
  );
  const objects = (
    db
      .query(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid",
      )
      .all() as { type: string; name: string; tbl_name: string; sql: string }[]
  ).filter((object) => !object.name.startsWith("sqlite_") && !shadows.has(object.tbl_name));
  const statements: string[] = [];
  for (const type of ["table", "index", "view", "trigger"])
    for (const object of objects.filter((o) => o.type === type)) statements.push(`${object.sql};`);
  // Migrations seed the command allowlist. Preserve every seed row, not just DDL.
  for (const table of objects.filter((o) => o.type === "table" && o.name !== "schema_version")) {
    const rows = db.query(`SELECT * FROM ${quote(table.name)}`).all() as Record<string, unknown>[];
    for (const row of rows) {
      const columns = Object.keys(row);
      const values = columns.map((column) => {
        // These are installation timestamps, not generation timestamps.
        if (table.name === "shell_allowlist" && column === "added_at")
          return "(strftime('%s','now') * 1000)";
        const value = row[column];
        if (value === null) return "NULL";
        if (typeof value === "number" || typeof value === "bigint") return String(value);
        if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
        throw new Error(`Unsupported baseline seed value in ${table.name}.${column}`);
      });
      statements.push(
        `INSERT INTO ${quote(table.name)} (${columns.map(quote).join(", ")}) VALUES (${values.join(", ")});`,
      );
    }
  }
  statements.push(`INSERT INTO schema_version(version) VALUES (${SCHEMA_BASELINE_VERSION});`);
  const sql = statements
    .join("\n\n")
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("${", "\\${");
  const source = `// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Generated from immutable migration history by scripts/generate-schema-baseline.ts.
// Fresh databases install this atomically; existing databases replay pending upgrades.
export const SCHEMA_BASELINE_VERSION = ${SCHEMA_BASELINE_VERSION};
export const SCHEMA_BASELINE = \`
${sql}
\`;
`;
  const path = resolve(import.meta.dir, "../src/persistence/schema-baseline.ts");
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== source)
      throw new Error("Schema baseline differs from historical replay");
    console.log(`Schema baseline ${SCHEMA_BASELINE_VERSION} matches historical replay.`);
  } else {
    writeFileSync(path, source);
    console.log(`Generated schema baseline ${SCHEMA_BASELINE_VERSION}.`);
  }
} finally {
  db.close();
}
