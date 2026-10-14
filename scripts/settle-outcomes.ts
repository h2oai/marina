#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Settle every measured result onto the one outcome path (operator script):
 * one idempotent command a person or a schedule can run, instead of one
 * producer-specific step each.
 *
 *   DB_PATH=marina.db bun run outcomes:settle [--futurex-dir <dir>]… [--arena] [--metaculus]
 *
 *   always          benchmark runs in the ledger with no outcome yet (ids and
 *                   numbers only; src/outcomes/benchmark.ts) — the server's
 *                   hourly sweep does the same
 *   --futurex-dir   `futurex learn --dir <dir>`: filed FutureX answers whose
 *                   truth the past dataset now publishes (repeatable)
 *   --arena         `arena settle`: resolved arena filings (needs the arena env)
 *   --metaculus     `metaculus resolve`: one rate-limit-aware resolve pass
 *                   against the live site (needs the Metaculus token)
 *
 * Nothing is filed or submitted anywhere; a step that fails is reported and
 * the others still run. Settled outcomes reach lessons through the server's
 * `outcome-delivery` job (or the producer's own delivery when it runs here).
 */

import { parseArgs } from "node:util";
import { settleBenchmarkRuns } from "../src/outcomes/benchmark";
import { MarinaDB } from "../src/persistence/database";

const { values } = parseArgs({
  options: {
    "futurex-dir": { type: "string", multiple: true },
    arena: { type: "boolean" },
    metaculus: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(
    "usage: DB_PATH=marina.db bun run outcomes:settle [--futurex-dir <dir>]… [--arena] [--metaculus]",
  );
  process.exit(0);
}

const dbPath = process.env.DB_PATH ?? "marina.db";
let failed = 0;

const db = new MarinaDB(dbPath);
try {
  const b = settleBenchmarkRuns(db);
  console.log(`benchmark runs: ${b.recorded} recorded · ${b.skipped} already or not scored`);
} catch (err) {
  failed++;
  console.error(`benchmark runs: ${(err as Error).message}`);
} finally {
  db.close();
}

/** Run one producer's own settle step as a child process (argv only, never a shell). */
async function step(label: string, argv: string[]): Promise<void> {
  const child = Bun.spawn(["bun", ...argv], { stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) {
    failed++;
    console.error(`${label}: exited ${code}`);
  }
}

for (const dir of values["futurex-dir"] ?? []) {
  await step(`futurex ${dir}`, ["scripts/futurex.ts", "learn", "--dir", dir]);
}
if (values.arena) await step("arena", ["scripts/arena.ts", "settle"]);
if (values.metaculus) await step("metaculus", ["scripts/metaculus.ts", "resolve"]);

process.exit(failed ? 1 : 0);
