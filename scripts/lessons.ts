#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator script for the judged lesson pool (src/learning/).
 *
 *   DB_PATH=marina.db bun run lessons backfill [--dry-run] [--limit N] [--relearn-rejected]
 *   DB_PATH=marina.db bun run lessons rank [--domain d[,d…]] [--limit N] [--out rows.jsonl]
 *   DB_PATH=marina.db bun run lessons replay --ranks rows.jsonl [--domain d[,d…]] [--cutoff ISO]
 *
 * `backfill` feeds every valid, scored ledger run that has no lesson yet
 * through the judged outcome loop once (`backfillLedgerLessons`): ids, scores,
 * counts and category labels only, never item text; `resolvedAt` = the run's
 * completion, baselines only from runs completed by then. Re-running it is a
 * no-op for runs already taught. Invalid runs are skipped. Admission ranking
 * (`MARINA_MEMORY_RANKING`, src/memory/admission.ts) applies to each write as
 * on the server. `--relearn-rejected`
 * also re-learns runs whose lessons an EARLIER learner wrote and the judge
 * rejected (they stay as audit records); still idempotent.
 *
 * `rank` is the observe-mode admission pass over the EXISTING pool: every
 * current lesson is compared with the lessons of its pool written before it,
 * one decision call each (duplicates need none). It writes nothing to the
 * database; it prints the actions admission would take (merges, supersedes,
 * contradictions) and, with `--out`, one JSONL row per lesson.
 *
 * `replay` is the offline recall replay (src/learning/replay.ts): held-out
 * tasks over a frozen snapshot, today's order vs ranked serving with the
 * observed merges, reporting distractor, duplicate, contradiction-exposure and
 * useful-hit rates. No model calls.
 *
 * The writer and judge are the server's (`MARINA_LESSONS_WRITER`, the decision
 * backend, else `marina/default` through this Marina's `/v1` at `WS_PORT`).
 * With no judge verdict (no model reachable, the daily spend cap) a run is
 * deferred, never written `unverified`; the pass stops at the cap.
 * Judge spend goes to the world's daily ledger (`DB_PATH`). Back up the
 * database first; `--dry-run` lists what would be learned without writing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { harnessDecisionProvider } from "../src/decisions/engines";
import { attachDbSpendLedger, dailyCapRefusal, spentTodayUsd } from "../src/engine/spend-ledger";
import { lessonAdmission } from "../src/learning/admission";
import { backfillLedgerLessons } from "../src/learning/backfill";
import { OUTCOME_DOMAINS, type OutcomeDomain } from "../src/learning/outcomes";
import { type RankRow, rankPass } from "../src/learning/rank-pass";
import { replayRecall } from "../src/learning/replay";
import {
  lessonJudgeFromEnv,
  lessonRecallSinkFor,
  lessonSinkFor,
  lessonsMetaMode,
  lessonsMode,
  lessonWriterFromEnv,
} from "../src/learning/service";
import { memoryRankingMode } from "../src/memory/admission";
import { MarinaDB } from "../src/persistence/database";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean" },
    limit: { type: "string" },
    "relearn-rejected": { type: "boolean" },
    domain: { type: "string" },
    out: { type: "string" },
    ranks: { type: "string" },
    cutoff: { type: "string" },
    concurrency: { type: "string" },
  },
});

const USAGE =
  "usage: bun run lessons backfill [--dry-run] [--limit N] [--relearn-rejected] | rank [--domain d] [--limit N] [--out f.jsonl] | replay --ranks f.jsonl [--domain d] [--cutoff ISO]";

function fail(msg: string): never {
  console.error(`lessons: ${msg}`);
  process.exit(2);
}

const command = positionals[0];
if (command !== "backfill" && command !== "rank" && command !== "replay") fail(USAGE);
if (lessonsMode() === "off") fail("MARINA_LESSONS=off: nothing is learned");
const intArg = (name: string, raw: string | undefined) => {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) fail(`--${name} must be a non-negative integer`);
  return n;
};
const limit = intArg("limit", values.limit);
const concurrency = intArg("concurrency", values.concurrency);
const domains = (values.domain?.split(",").map((d) => d.trim().toLowerCase()) ??
  OUTCOME_DOMAINS) as OutcomeDomain[];
for (const d of domains) if (!OUTCOME_DOMAINS.includes(d)) fail(`unknown domain ${d}`);

const db = new MarinaDB(process.env.DB_PATH || "marina.db");
const release = attachDbSpendLedger(db);
try {
  if (command === "backfill") await backfill();
  else if (command === "rank") await rank();
  else await replay();
} finally {
  release();
  db.close();
}

async function backfill() {
  const writer = lessonWriterFromEnv();
  const rankingJudge = harnessDecisionProvider();
  const admit = values["dry-run"]
    ? undefined
    : lessonAdmission({ db, ...(rankingJudge ? { judge: rankingJudge } : {}) });
  const report = await backfillLedgerLessons(
    db,
    {
      // A dry run never creates the lessons account or a space.
      sink: values["dry-run"] ? lessonRecallSinkFor(db) : lessonSinkFor(db),
      ...(writer ? { writer } : {}),
      judge: lessonJudgeFromEnv(),
      meta: lessonsMetaMode() !== "off",
      ...(admit ? { admit } : {}),
    },
    {
      ...(values["dry-run"] ? { dryRun: true } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(values["relearn-rejected"] ? { relearnRejected: true } : {}),
      refuse: () => dailyCapRefusal(),
      onRecord: (r) =>
        console.log(
          `  ${r.deferred ? `deferred (${r.reason})` : r.trust}${r.metaId ? " +meta" : ""}${r.admission && r.admission !== "new" ? ` [${r.admission}]` : ""} — ${r.lesson.source}`,
        ),
    },
  );
  console.log(
    [
      `${values["dry-run"] ? "would learn" : "learned"} ${report.learned} run(s) of ${report.runs}`,
      `already taught ${report.existing}`,
      ...(values["relearn-rejected"]
        ? [`re-learned (earlier rejections) ${report.relearned}`]
        : []),
      `skipped ${report.skipped} (invalid, failed or unscored)`,
      ...(values["dry-run"]
        ? []
        : [
            `trusted ${report.trust.trusted}, unverified ${report.trust.unverified}, rejected ${report.trust.rejected}`,
            `mirrored to lessons:meta ${report.mirrored}`,
            `deferred (no verdict) ${report.deferred}`,
            `merged into existing lessons ${report.merged}`,
            `failed ${report.failed}`,
            `admission ${admit ? memoryRankingMode() : "off"}`,
          ]),
    ].join("; "),
  );
  if (report.stopped) console.log(`stopped early: ${report.stopped}`);
  if (report.failed || report.stopped) process.exitCode = 1;
}

async function rank() {
  const judge = harnessDecisionProvider();
  if (!judge)
    console.error("lessons: no decision backend configured; only mechanical duplicates are found");
  const before = spentTodayUsd();
  const rows: RankRow[] = [];
  const report = await rankPass(lessonRecallSinkFor(db), {
    domains,
    ...(judge ? { judge } : {}),
    db,
    ...(limit !== undefined ? { limit } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    onRow: (row) => rows.push(row),
  });
  if (values.out) writeFileSync(values.out, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  for (const [domain, c] of Object.entries(report.domains)) {
    if (!c || c.lessons === 0) continue;
    console.log(
      [
        `${domain}: ${c.lessons} lesson(s), ${c.rejected} rejected (unranked), ${c.ranked} ranked`,
        `duplicates: ${c.mechanicalMerges} mechanical + ${c.judgedMerges} judged merges`,
        `supersedes ${c.supersedes}`,
        `contradictions of trusted lessons ${c.contests} (auto-resolvable ${c.autoResolvable})`,
        `new ${c.new}`,
        `below floor ${c.belowFloor}`,
        ...(c.ranked ? [`mean rank ${(c.rankSum / c.ranked).toFixed(3)}`] : []),
        ...(Object.keys(c.skipped).length
          ? [
              `skipped ${Object.entries(c.skipped)
                .map(([k, v]) => `${k}=${v}`)
                .join(",")}`,
            ]
          : []),
      ].join("; "),
    );
  }
  console.log(
    `judge ${judge ? `${judge.kind}:${judge.model}${judge.calibrated === false ? " (uncalibrated)" : ""}` : "none"}; spend recorded today +$${(spentTodayUsd() - before).toFixed(4)}; nothing written${values.out ? `; rows → ${values.out}` : ""}`,
  );
}

async function replay() {
  if (!values.ranks) fail("replay needs --ranks <rows.jsonl> from `lessons rank --out`");
  const rows = readFileSync(values.ranks, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RankRow);
  const wanted = new Set(domains);
  const sink = lessonRecallSinkFor(db);
  const lessons = [];
  for (const d of wanted) lessons.push(...((await sink.find?.(d, {}, 100_000)) ?? []));
  const report = replayRecall(
    lessons,
    rows.filter((r) => wanted.has(r.domain)),
    values.cutoff ? { cutoff: values.cutoff } : {},
  );
  console.log(JSON.stringify(report, null, 2));
}
