#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Import harness results into a world's benchmark ledger (operator script —
 * reading local files is never an in-world command).
 *
 *   DB_PATH=marina.db bun run benchmark:import <file.json | tier0-dir> ... \
 *     --target-kind model|crew|population --target '<json or model id>' \
 *     [--label name] [--judge "<model> @ <route>"] [--cost-usd N] [--dry-run] \
 *     [--group key | --replicate-of <runId>] [--no-learn]
 *   DB_PATH=marina.db bun run benchmark:import --attach-to <runId> \
 *     --source-db <original-world.db> --source-run <original-runId> [--dry-run]
 *   DB_PATH=marina.db bun run benchmark:import --regroup <runId,runId,…> --group key --reason "<why>"
 *   DB_PATH=marina.db bun run benchmark:import --invalidate <runId> --reason "<why>"
 *   DB_PATH=marina.db bun run benchmark:import --revalidate <runId> --reason "<why>"
 *
 * A file is one `benchmarks/harness.ts` result; a directory is a Tier-0 output
 * (`summary.json` plus one result per set). Credentials in the result's config
 * are dropped, case content (questions, answers, responses) is never read into
 * the ledger, and re-importing the same file is a no-op (content hash).
 * `--cost-usd` (the target's total spend, e.g. a crew server's `spend_daily`)
 * is accepted with a single result file only.
 *
 * Replicates (migration 148): `--group` files the runs into a named replicate
 * group; `--replicate-of <runId>` joins that run's group. Without either, a run
 * joins the automatic group of its target, item slice and judge. `--regroup`
 * moves already-recorded runs into one group (e.g. replicates whose recorded
 * targets differ only in a label) — item outcomes are never touched, and every
 * move is an append-only audit row (migration 155: from, to, operator, reason).
 * A promotion still pools only runs of the identical configuration (benchmark,
 * target, slice, judge): regrouping relabelled runs serves comparison, not promotion.
 *
 * `--invalidate` retires a completed run that measured the infrastructure
 * rather than the target (spend cap, provider outage): its status becomes
 * `invalid`, so no ledger reader ranks, pools, compares or promotes it, and an
 * append-only audit row records the operator, the time and the reason (migration
 * 153). Item outcomes are kept. `--revalidate` reverses it, with its own row.
 * This is the operator path; in-world it is `benchmark invalidate|revalidate`
 * (role.edit). A result whose items are more than
 * `MARINA_BENCHMARK_MAX_FALLBACK_RATE` fallbacks is recorded invalid on import.
 *
 * Every newly recorded valid run also feeds the outcome-learning loop
 * (src/learning/): a judged lesson about which configuration won or lost on
 * that benchmark (ids, scores and counts only — never item text). It uses this
 * Marina's own model and decision backend when reachable; otherwise the lesson
 * is recorded unverified, never trusted. `--no-learn` opts out (as does
 * `MARINA_LESSONS=off`); `--learn` is accepted and is the default.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { benchmarkExecution, formatBenchmarkExecution } from "../src/engine/benchmark-execution";
import {
  type HarnessResultFile,
  ledgerFromHarnessResult,
  MAX_VALIDITY_REASON,
  TARGET_KINDS,
} from "../src/engine/benchmark-ledger";
import { replicateGroupOf, validReplicateGroup } from "../src/engine/benchmark-replicates";
import { retireOutcomeNotesForRun } from "../src/engine/benchmark-runner";
import { noteBenchmarkRun, retireLessonsForRun } from "../src/learning/intake";
import { enableOutcomeLearning, settleOutcomes } from "../src/learning/service";
import { MarinaDB } from "../src/persistence/database";
import type { BenchmarkTargetKind } from "../src/persistence/db-benchmarks";
import {
  getBenchmarkRun,
  previewBenchmarkSourceEvidence,
  readBenchmarkSourceEvidence,
} from "../src/persistence/db-benchmarks";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    "source-db": { type: "string" },
    "source-run": { type: "string" },
    "attach-to": { type: "string" },
    "target-kind": { type: "string" },
    target: { type: "string" },
    label: { type: "string" },
    judge: { type: "string" },
    "cost-usd": { type: "string" },
    "dry-run": { type: "boolean" },
    learn: { type: "boolean" },
    "no-learn": { type: "boolean" },
    group: { type: "string" },
    "replicate-of": { type: "string" },
    regroup: { type: "string" },
    invalidate: { type: "string" },
    revalidate: { type: "string" },
    reason: { type: "string" },
  },
});

function fail(msg: string): never {
  console.error(`benchmark-import: ${msg}`);
  process.exit(2);
}

// An explicit local source is read in one readonly snapshot; it is never migrated.
const sourcePath = values["source-db"];
const sourceRun = values["source-run"];
if (!!sourcePath !== !!sourceRun) fail("--source-db and --source-run must be supplied together");
if (
  (sourcePath || values["attach-to"]) &&
  (values.regroup || values.invalidate || values.revalidate)
)
  fail("source attribution cannot be combined with regroup/validity changes");
const evidence =
  sourcePath && sourceRun
    ? (() => {
        const source = new Database(sourcePath, { readonly: true });
        try {
          source.exec("PRAGMA query_only = ON; BEGIN");
          return readBenchmarkSourceEvidence(source, sourceRun);
        } finally {
          source.close();
        }
      })()
    : undefined;
if (values["attach-to"]) {
  if (!evidence) fail("--attach-to requires --source-db and --source-run");
  if (
    positionals.length ||
    values.learn ||
    values["no-learn"] ||
    values.group ||
    values["replicate-of"] ||
    values["cost-usd"] ||
    values.target ||
    values["target-kind"] ||
    values.label ||
    values.judge
  )
    fail("--attach-to only restores existing item attribution; omit import/learning options");
  const path = process.env.DB_PATH || "marina.db";
  if (values["dry-run"]) {
    const target = new Database(path, { readonly: true });
    try {
      target.exec("PRAGMA query_only = ON; BEGIN");
      const run = getBenchmarkRun(target, values["attach-to"]);
      if (!run || !["completed", "invalid"].includes(run.status))
        fail("Target run must be completed or invalid");
      const updates = previewBenchmarkSourceEvidence(
        run.benchmark,
        readBenchmarkSourceEvidence(target, run.id).items.map((it) => ({
          ...it,
          participants_json: JSON.stringify(it.participants),
        })),
        evidence,
      );
      console.log(
        `would restore ${updates.length} item attributions on ${run.id}; scores unchanged`,
      );
    } finally {
      target.close();
    }
  } else {
    const target = new MarinaDB(path);
    try {
      const result = target.attachBenchmarkSourceEvidence(values["attach-to"], evidence);
      console.log(
        `restored ${result.changed} item attributions; sha256:${result.sourceHash}; scores unchanged`,
      );
      console.log(
        formatBenchmarkExecution(
          benchmarkExecution(target.getBenchmarkItems(values["attach-to"])),
        ).join("\n"),
      );
    } finally {
      target.close();
    }
  }
  process.exit(0);
}

if (values.group !== undefined && !validReplicateGroup(values.group)) {
  fail("--group must be a short label (letters, digits, : . _ @ / -; never auto:…)");
}
if (values.group !== undefined && values["replicate-of"] !== undefined) {
  fail("give --group or --replicate-of, not both");
}

// --regroup: move recorded runs into one replicate group, then stop.
if (values.regroup !== undefined) {
  if (!values.group) fail("--regroup needs --group <key>");
  const reason = values.reason?.trim();
  if (!reason) fail('--regroup needs --reason "<why>" (it is recorded in the audit row)');
  if (reason.length > MAX_VALIDITY_REASON)
    fail(`--reason is at most ${MAX_VALIDITY_REASON} characters`);
  const ids = values.regroup
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) fail("--regroup needs at least one run id");
  const db = new MarinaDB(process.env.DB_PATH || "marina.db");
  try {
    const missing = ids.filter((id) => !db.getBenchmarkRun(id));
    if (missing.length > 0) fail(`no such run(s): ${missing.join(", ")}`);
    const changed = db.setBenchmarkReplicateGroup(ids, values.group as string, {
      reason,
      actor: "operator",
      source: "operator",
      created_at: Date.now(),
    });
    console.log(`regrouped ${changed} run(s) into ${values.group} (audited)`);
  } finally {
    db.close();
  }
  process.exit(0);
}

// --invalidate / --revalidate: change one run's validity with an audit row, then stop.
if (values.invalidate !== undefined || values.revalidate !== undefined) {
  if (values.invalidate !== undefined && values.revalidate !== undefined) {
    fail("give --invalidate or --revalidate, not both");
  }
  const action = values.invalidate !== undefined ? "invalidate" : "revalidate";
  const runId = (values.invalidate ?? values.revalidate ?? "").trim();
  const reason = values.reason?.trim();
  if (!runId) fail(`--${action} needs a run id`);
  if (!reason) fail(`--${action} needs --reason "<why>" (it is recorded in the audit row)`);
  if (reason.length > MAX_VALIDITY_REASON)
    fail(`--reason is at most ${MAX_VALIDITY_REASON} characters`);
  const db = new MarinaDB(process.env.DB_PATH || "marina.db");
  try {
    const res = db.setBenchmarkRunValidity({
      run_id: runId,
      action,
      reason,
      actor: "operator",
      source: "operator",
      created_at: Date.now(),
    });
    if (!res.ok) fail(res.error);
    console.log(`${runId}: ${res.status} (audit row ${res.id}) — ${reason}`);
    if (action === "invalidate") {
      // Lessons citing the run are retired through the audited revise path.
      const r = await retireLessonsForRun(db, runId, { reason, by: "operator" });
      console.log(
        `  lessons citing it: ${r.retired.length} retired${r.failed.length ? `, ${r.failed.length} failed` : ""}${r.error ? ` (${r.error})` : ""}`,
      );
      const n = retireOutcomeNotesForRun(db, runId);
      console.log(
        `  outcome notes citing it: ${n.retired} retired${n.ambiguous ? `, ${n.ambiguous} left (legacy prefix shared with another run)` : ""}${n.error ? ` (${n.error})` : ""}`,
      );
    }
  } finally {
    db.close();
  }
  process.exit(0);
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
if (evidence && files.length !== 1) fail("source attribution applies to exactly one result file");
const costUsd = values["cost-usd"] === undefined ? undefined : Number(values["cost-usd"]);
if (costUsd !== undefined && (!Number.isFinite(costUsd) || costUsd < 0)) {
  fail("--cost-usd must be a non-negative number");
}
if (costUsd !== undefined && files.length !== 1) {
  fail("--cost-usd applies to exactly one result file");
}

const db = values["dry-run"] ? undefined : new MarinaDB(process.env.DB_PATH || "marina.db");
if (values.learn && values["no-learn"]) fail("give --learn or --no-learn, not both");
// Imports teach by default (every scored outcome teaches); --no-learn opts out.
const learn = db && !values["no-learn"] ? enableOutcomeLearning(db) : false;
let replicateGroup = values.group;
if (values["replicate-of"] !== undefined) {
  const peer = db?.getBenchmarkRun(values["replicate-of"]);
  if (!db) fail("--replicate-of needs the database (not with --dry-run)");
  if (!peer) fail(`no such run: ${values["replicate-of"]}`);
  replicateGroup = replicateGroupOf(peer);
  if (replicateGroup.startsWith("run:")) {
    // A run with no group of its own: name one after it and move it in too.
    replicateGroup = `rep:${peer.id}`;
    db.setBenchmarkReplicateGroup([peer.id], replicateGroup, {
      reason: "named a group for --replicate-of",
      actor: "operator",
      source: "operator",
      created_at: Date.now(),
    });
  }
}
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
        ...(replicateGroup ? { replicateGroup } : {}),
        raw,
        id: `bench_${randomUUID().slice(0, 12)}`,
        now: Date.now(),
      });
      if (evidence)
        previewBenchmarkSourceEvidence(
          run.benchmark,
          items.map((it) => ({ ...it, correct: it.correct ? 1 : 0 })),
          evidence,
        );
      const acc = `${(run.score * 100).toFixed(1)}% (${items.filter((i) => i.correct).length}/${run.n})`;
      const invalid = run.invalid_reason ? ` — INVALID: ${run.invalid_reason}` : "";
      if (!db) {
        console.log(
          `${file}: would record ${run.benchmark} ${acc} slice ${run.slice_hash}${invalid}`,
        );
        continue;
      }
      const res = db.recordBenchmarkLedgerRun(run, items, evidence);
      console.log(
        formatBenchmarkExecution(benchmarkExecution(db.getBenchmarkItems(res.id))).join("\n"),
      );
      if (res.created && learn) noteBenchmarkRun(db, { ...run, id: res.id });
      console.log(
        res.created
          ? `${file}: recorded ${res.id} — ${run.benchmark} ${acc}${replicateGroup ? ` (group ${replicateGroup})` : ""}${invalid}`
          : `${file}: already recorded as ${res.id}`,
      );
    } catch (e) {
      console.log(`${file}: ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }
} finally {
  if (db && learn) await settleOutcomes(db);
  db?.close();
}
process.exit(failed ? 1 : 0);
