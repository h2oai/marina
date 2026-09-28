// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Export answered challenges as decision cases.
 *
 *   bun run scripts/challenge-labels.ts [--blind] [--out cases.json]
 *
 * Default: people-answered outcomes as `challenge-live` gate cases (NOT blind —
 * report them as their own family). `--blind`: the held actions without the
 * answers, in the Gate Label Desk's case shape, for independent labeling.
 * Reads DB_PATH (default marina.db). Output can contain operators' commands:
 * keep it out of public repositories.
 */

import { writeFileSync } from "node:fs";
import { blindPanelCases, liveGateCases } from "../src/decisions/challenge-labels";
import { MarinaDB } from "../src/persistence/database";

const args = process.argv.slice(2);
const blind = args.includes("--blind");
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1] : undefined;

const db = new MarinaDB(process.env.DB_PATH || "marina.db");
try {
  const rows = db.listChallengeOutcomes({ limit: 10_000 });
  const body = blind ? { cases: blindPanelCases(rows) } : { gate: liveGateCases(rows) };
  const json = `${JSON.stringify(body, null, 2)}\n`;
  if (out) {
    writeFileSync(out, json, { mode: 0o600 });
    process.stderr.write(`${blind ? body.cases?.length : body.gate?.length} case(s) → ${out}\n`);
  } else {
    process.stdout.write(json);
  }
} finally {
  db.close();
}
