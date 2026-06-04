#!/usr/bin/env bun
/**
 * Marina State Import
 * Usage: bun scripts/state-import.ts <snapshot_path> [db_path] [--merge] [--skip-events]
 */
import { importState, validateSnapshot } from "../src/persistence/export-import";

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const positional = args.filter((a) => !a.startsWith("--"));

if (positional.length < 1) {
  console.log("Usage: bun scripts/state-import.ts <snapshot.json> [db_path] [--merge] [--skip-events]");
  console.log("");
  console.log("Options:");
  console.log("  --merge         Merge data instead of replacing (INSERT OR REPLACE)");
  console.log("  --skip-events   Skip importing event_log (can be very large)");
  console.log("");
  console.log("WARNING: Without --merge, all existing data in the target DB will be replaced.");
  process.exit(1);
}

const snapshotPath = positional[0]!;
const dbPath = positional[1] ?? process.env.DB_PATH ?? "marina.db";
const merge = flags.includes("--merge");
const skipEventLog = flags.includes("--skip-events");

// Read and validate snapshot
console.log(`Reading snapshot: ${snapshotPath}`);
const raw = await Bun.file(snapshotPath).text();
let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch {
  console.error("Error: Invalid JSON file.");
  process.exit(1);
}

const validation = validateSnapshot(parsed);
if (!validation.valid) {
  console.error(`Error: ${validation.error}`);
  process.exit(1);
}

const snapshot = validation.snapshot;
console.log(`Snapshot: schema v${snapshot.schema_version}, exported ${snapshot.exported_at}`);
console.log(`Tables: ${Object.keys(snapshot.tables).length}`);
console.log(`Mode: ${merge ? "merge" : "replace"}`);
console.log(`Target: ${dbPath}`);
console.log("");

// Import
const result = importState(dbPath, snapshot, { merge, skipEventLog });

console.log(`Imported ${result.rowsImported} rows across ${result.tablesImported} tables`);

if (result.tablesSkipped.length > 0) {
  console.log(`Skipped tables: ${result.tablesSkipped.join(", ")}`);
}

if (result.errors.length > 0) {
  console.log(`\nErrors (${result.errors.length}):`);
  for (const err of result.errors.slice(0, 20)) {
    console.log(`  - ${err}`);
  }
  if (result.errors.length > 20) {
    console.log(`  ... and ${result.errors.length - 20} more`);
  }
}

console.log("\nRestart the Marina server to use the imported data.");
