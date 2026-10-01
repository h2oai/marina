#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Import harness results into a world's benchmark ledger (operator script —
 * reading local files is never an in-world command).
 *
 *   DB_PATH=marina.db bun run benchmark:import <file.json | tier0-dir> ... \
 *     --target-kind model|crew|population --target '<json or model id>' \
 *     [--label name] [--judge "<model> @ <route>"] [--cost-usd N] [--dry-run]
 *
 * A file is one `benchmarks/harness.ts` result; a directory is a Tier-0 output
 * (`summary.json` plus one result per set). Credentials in the result's config
 * are dropped, case content (questions, answers, responses) is never read into
 * the ledger, and re-importing the same file is a no-op (content hash).
 * `--cost-usd` (the target's total spend, e.g. a crew server's `spend_daily`)
 * is accepted with a single result file only.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type HarnessResultFile,
  ledgerFromHarnessResult,
  TARGET_KINDS,
} from "../src/engine/benchmark-ledger";
import { MarinaDB } from "../src/persistence/database";
import type { BenchmarkTargetKind } from "../src/persistence/db-benchmarks";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    "target-kind": { type: "string" },
    target: { type: "string" },
    label: { type: "string" },
    judge: { type: "string" },
    "cost-usd": { type: "string" },
    "dry-run": { type: "boolean" },
  },
});

function fail(msg: string): never {
  console.error(`benchmark-import: ${msg}`);
  process.exit(2);
}

const kind = values["target-kind"] as BenchmarkTargetKind | undefined;
if (!kind || !TARGET_KINDS.includes(kind)) {
  fail(`--target-kind must be one of ${TARGET_KINDS.join(", ")}`);
}
if (!values.target) fail("--target is required (a model id or a JSON spec)");
let target: unknown = values.target;
try {
  target = JSON.parse(values.target);
} catch {
  target = values.target; // a bare model id
}
if (positionals.length === 0) fail("give at least one result file or Tier-0 directory");

/** Result files under the given paths; a Tier-0 directory contributes every set file. */
function resultFiles(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) fail(`not found: ${p}`);
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) {
        if (f.endsWith(".json") && f !== "summary.json") out.push(join(p, f));
      }
    } else {
      out.push(p);
    }
  }
  return out;
}

const files = resultFiles(positionals);
const costUsd = values["cost-usd"] === undefined ? undefined : Number(values["cost-usd"]);
if (costUsd !== undefined && (!Number.isFinite(costUsd) || costUsd < 0)) {
  fail("--cost-usd must be a non-negative number");
}
if (costUsd !== undefined && files.length !== 1) {
  fail("--cost-usd applies to exactly one result file");
}

const db = values["dry-run"] ? undefined : new MarinaDB(process.env.DB_PATH || "marina.db");
let failed = 0;
try {
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    let parsed: HarnessResultFile;
    try {
      parsed = JSON.parse(raw) as HarnessResultFile;
    } catch {
      console.log(`${file}: not JSON — skipped`);
      failed++;
      continue;
    }
    try {
      const { run, items } = ledgerFromHarnessResult(parsed, {
        targetKind: kind,
        target,
        label: values.label,
        judge: values.judge,
        costUsd,
        raw,
        id: `bench_${randomUUID().slice(0, 12)}`,
        now: Date.now(),
      });
      const acc = `${(run.score * 100).toFixed(1)}% (${items.filter((i) => i.correct).length}/${run.n})`;
      if (!db) {
        console.log(`${file}: would record ${run.benchmark} ${acc} slice ${run.slice_hash}`);
        continue;
      }
      const res = db.recordBenchmarkLedgerRun(run, items);
      console.log(
        res.created
          ? `${file}: recorded ${res.id} — ${run.benchmark} ${acc}`
          : `${file}: already recorded as ${res.id}`,
      );
    } catch (e) {
      console.log(`${file}: ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }
} finally {
  db?.close();
}
process.exit(failed ? 1 : 0);
