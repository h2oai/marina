#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marina State Export
 * Usage: bun scripts/state-export.ts [db_path] [output_path] [--skip-events] [--skip-connectors]
 */
import { exportState } from "../src/persistence/export-import";

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const positional = args.filter((a) => !a.startsWith("--"));

const dbPath = positional[0] ?? process.env.DB_PATH ?? "marina.db";
const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outputPath = positional[1] ?? `marina-export-${timestamp}.json`;

const skipEventLog = flags.includes("--skip-events");
// Secrets (api_keys, mem_api_keys, users, connectors, gateways) omitted by
// default so the snapshot is safe to share; pass --include-secrets for a full backup.
const includeSecrets = flags.includes("--include-secrets");

console.log(`Exporting from: ${dbPath}`);
console.log(
  `Options: ${skipEventLog ? "skip-events " : ""}${includeSecrets ? "include-secrets" : "secrets-excluded"}`,
);

const snapshot = exportState(dbPath, { skipEventLog, includeSecrets });

const tableNames = Object.keys(snapshot.tables);
let totalRows = 0;
for (const name of tableNames) {
  const count = snapshot.tables[name]!.length;
  totalRows += count;
  console.log(`  ${name}: ${count} rows`);
}

await Bun.write(outputPath, JSON.stringify(snapshot, null, 2));

console.log(`\nExported ${totalRows} rows across ${tableNames.length} tables`);
console.log(`Output: ${outputPath}`);
console.log(`Size: ${(new Blob([JSON.stringify(snapshot)]).size / 1024).toFixed(1)} KB`);
