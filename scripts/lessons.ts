#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator script for the judged lesson pool (src/learning/).
 *
 *   DB_PATH=marina.db bun run lessons backfill [--dry-run] [--limit N]
 *
 * `backfill` feeds every valid, scored ledger run that has no lesson yet
 * through the judged outcome loop once (`backfillLedgerLessons`): ids, scores,
 * counts and category labels only, never item text; `resolvedAt` = the run's
 * completion, baselines only from runs completed by then. Re-running it is a
 * no-op for runs already taught. Invalid runs are skipped.
 *
 * The writer and judge are the server's (`MARINA_LESSONS_WRITER`, the decision
 * backend, else `marina/default` through this Marina's `/v1` at `WS_PORT`).
 * With no model reachable the lessons are recorded `unverified`, never trusted.
 * Judge spend goes to the world's daily ledger (`DB_PATH`). Back up the
 * database first; `--dry-run` lists what would be learned without writing.
 */

import { parseArgs } from "node:util";
import { attachDbSpendLedger } from "../src/engine/spend-ledger";
import { backfillLedgerLessons } from "../src/learning/backfill";
import {
  lessonJudgeFromEnv,
  lessonRecallSinkFor,
  lessonSinkFor,
  lessonsMetaMode,
  lessonsMode,
  lessonWriterFromEnv,
} from "../src/learning/service";
import { MarinaDB } from "../src/persistence/database";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean" },
    limit: { type: "string" },
  },
});

function fail(msg: string): never {
  console.error(`lessons: ${msg}`);
  process.exit(2);
}

if (positionals[0] !== "backfill") fail("usage: bun run lessons backfill [--dry-run] [--limit N]");
if (lessonsMode() === "off") fail("MARINA_LESSONS=off: nothing is learned");
const limit = values.limit === undefined ? undefined : Number(values.limit);
if (limit !== undefined && (!Number.isInteger(limit) || limit < 0))
  fail("--limit must be a non-negative integer");

const db = new MarinaDB(process.env.DB_PATH || "marina.db");
const release = attachDbSpendLedger(db);
try {
  const writer = lessonWriterFromEnv();
  const report = await backfillLedgerLessons(
    db,
    {
      // A dry run never creates the lessons account or a space.
      sink: values["dry-run"] ? lessonRecallSinkFor(db) : lessonSinkFor(db),
      ...(writer ? { writer } : {}),
      judge: lessonJudgeFromEnv(),
      meta: lessonsMetaMode() !== "off",
    },
    {
      ...(values["dry-run"] ? { dryRun: true } : {}),
      ...(limit !== undefined ? { limit } : {}),
      onRecord: (r) => console.log(`  ${r.trust}${r.metaId ? " +meta" : ""} — ${r.lesson.source}`),
    },
  );
  console.log(
    [
      `${values["dry-run"] ? "would learn" : "learned"} ${report.learned} run(s) of ${report.runs}`,
      `already taught ${report.existing}`,
      `skipped ${report.skipped} (invalid, failed or unscored)`,
      ...(values["dry-run"]
        ? []
        : [
            `trusted ${report.trust.trusted}, unverified ${report.trust.unverified}, rejected ${report.trust.rejected}`,
            `mirrored to lessons:meta ${report.mirrored}`,
            `failed ${report.failed}`,
          ]),
    ].join("; "),
  );
  if (report.failed) process.exitCode = 1;
} finally {
  release();
  db.close();
}
