#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mind2Web 2 (live-web agentic search, agent-as-a-judge) — a thin adapter over
 * Marina's live-web research agent (`src/research/`). Operator tool only:
 * nothing here runs unless invoked, and NOTHING IS SENT anywhere.
 *
 *   bun run mind2web2 run   --official <checkout> --out <dir> --arm single|lead
 *                           [--split tune|heldout|all] [--task <id>]… [--runs 1,2]
 *                           [--tasks <task-list.csv>] [--cap-usd 20] [--concurrency 3] [--browser]
 *   bun run mind2web2 cache --out <dir> --arm single|lead
 *                           export what each run read into cache/<agent>/<task>/
 *   bun run mind2web2 judge --official <checkout> --out <dir> --arm … --cap-usd 10
 *                           [--python <venv python>] [--eval-version dev_set] [--task <id>]…
 *                           run the official judge (o4-mini) under a hard spend cap
 *   bun run mind2web2 score --out <dir> --arm … [--compare <arm>] [--split …]
 *   bun run mind2web2 record --out <dir> --arm … --split …   ledger (ids + scores) + judged lessons
 *
 * `--official` is a checkout of github.com/OSU-NLP-Group/Mind2Web-2 (its
 * `eval_scripts/dev_set/*.py` supply the dev tasks; a test run passes the task
 * list CSV with `--tasks`). Answers go to `<out>/answers/<agent>/<task>/answer_<k>.md`
 * — the submission layout. Model and search spend count toward the daily cap of
 * the DB_PATH world (default marina.db); `--cap-usd` stops this batch earlier.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CallSpendGuard } from "../benchmarks/call-spend-guard";
import { exportTaskCache } from "../benchmarks/mind2web2/cache-export";
import { answerOutcome, recordJudgedRun } from "../benchmarks/mind2web2/ledger";
import { ARMS, type Arm, answerPath, runBatch } from "../benchmarks/mind2web2/run";
import {
  metrics,
  pairedDifference,
  readRunRecords,
  scoredAnswers,
} from "../benchmarks/mind2web2/score";
import {
  type M2W2Task,
  splitTasks,
  tasksFromCsv,
  tasksFromScripts,
} from "../benchmarks/mind2web2/tasks";
import { attachCliSpendLedger } from "../src/engine/cli-spend-ledger";
import { enableOutcomeLearning, noteOutcome, settleOutcomes } from "../src/learning/service";
import { MarinaDB } from "../src/persistence/database";
import { openBrowser } from "../src/research/browser-reader";
import { citedUrls } from "../src/research/cited-answer";
import { ProvenanceCache } from "../src/research/provenance-cache";

/** The pre-registered dev split (plan 2026-10-05): the first three by hash are tune-only. */
const SPLIT_SALT = "m2w2-2026-10";
const TUNE_COUNT = 3;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    official: { type: "string" },
    out: { type: "string" },
    arm: { type: "string", default: "single" },
    compare: { type: "string" },
    split: { type: "string", default: "all" },
    task: { type: "string", multiple: true },
    tasks: { type: "string" },
    runs: { type: "string", default: "1" },
    "cap-usd": { type: "string" },
    concurrency: { type: "string", default: "3" },
    python: { type: "string" },
    "eval-version": { type: "string", default: "dev_set" },
    today: { type: "string" },
    browser: { type: "boolean" },
  },
});
const [cmd] = positionals;

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

function armOf(name: string | undefined): Arm {
  const arm = ARMS[name ?? ""];
  if (!arm) fail(`unknown arm ${name} (${Object.keys(ARMS).join(", ")})`);
  return arm;
}

function outDir(): string {
  if (!values.out) fail("--out <dir> is required");
  return resolve(values.out);
}

function loadTasks(): M2W2Task[] {
  let all: M2W2Task[];
  if (values.tasks) all = tasksFromCsv(readFileSync(values.tasks, "utf8"));
  else {
    if (!values.official) fail("--official <Mind2Web-2 checkout> or --tasks <csv> is required");
    all = tasksFromScripts(join(resolve(values.official), "eval_scripts", "dev_set"));
  }
  const { tune, heldOut } = splitTasks(all, TUNE_COUNT, SPLIT_SALT);
  let picked =
    values.split === "tune"
      ? tune
      : values.split === "heldout"
        ? heldOut
        : values.split === "all"
          ? all
          : fail(`--split tune|heldout|all`);
  if (values.task?.length) picked = picked.filter((t) => values.task!.includes(t.id));
  return picked;
}

function splitIds(): Set<string> | undefined {
  if (values.split === "all" && !values.task?.length) return undefined;
  return new Set(loadTasks().map((t) => t.id));
}

function capUsd(): number | undefined {
  if (values["cap-usd"] === undefined) return undefined;
  const v = Number(values["cap-usd"]);
  if (!(v >= 0)) fail("--cap-usd must be a number ≥ 0");
  return v;
}

async function run(): Promise<void> {
  const arm = armOf(values.arm);
  const out = outDir();
  const tasks = loadTasks();
  const runs = values
    .runs!.split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => n > 0);
  const cap = capUsd();
  if (cap === undefined) fail("--cap-usd is required for run (a hard stop for this batch)");
  const guard = new CallSpendGuard(cap);
  attachCliSpendLedger("bun run mind2web2 run");
  const browser = values.browser ? await openBrowser() : undefined;
  if (values.browser && !browser)
    fail(
      "--browser: playwright-core or its Chromium build is missing (bunx playwright-core install chromium-headless-shell)",
    );
  console.log(
    `${arm.agent}: ${tasks.length} task(s) × runs [${runs.join(",")}], cap $${cap}${browser ? ", rendered reads on" : ""}`,
  );
  const recs = await runBatch({
    arm,
    tasks,
    runs,
    out,
    guard,
    concurrency: Math.max(1, Number.parseInt(values.concurrency!, 10) || 1),
    ...(values.today ? { today: values.today } : {}),
    log: (l) => console.log(l),
    ...(browser ? { browser } : {}),
  });
  await browser?.close();
  const spent = recs.reduce((s, r) => s + r.costUsd, 0);
  const by = (st: string) => recs.filter((r) => r.status === st).length;
  console.log(
    `done: ${recs.length} run(s) — answered ${by("answered")}, empty ${by("empty")}, error ${by("error")}, budget ${by("budget")}; $${spent.toFixed(2)}${guard.stoppedBy ? ` (stopped: ${guard.stoppedBy})` : ""}`,
  );
}

function cache(): void {
  const arm = armOf(values.arm);
  const out = outDir();
  const ansRoot = join(out, "answers", arm.agent);
  if (!existsSync(ansRoot)) fail(`no answers under ${ansRoot}`);
  const records = readRunRecords(out, arm.agent);
  const tasks = [...new Set(records.map((r) => r.task))].sort();
  let total = { urls: 0, exported: 0, pdf: 0, present: 0, notRead: 0 };
  for (const task of tasks) {
    const ks = records.filter((r) => r.task === task).map((r) => r.k);
    const urls = ks.flatMap((k) => {
      const p = answerPath(out, arm.agent, task, k);
      return existsSync(p) ? citedUrls(readFileSync(p, "utf8")) : [];
    });
    const caches = ks
      .map((k) => join(out, "provenance", arm.agent, task, String(k)))
      .filter((d) => existsSync(join(d, "index.json")))
      .map((d) => new ProvenanceCache(d));
    const s = exportTaskCache(caches, urls, join(out, "cache", arm.agent, task));
    total = {
      urls: total.urls + s.urls,
      exported: total.exported + s.exported,
      pdf: total.pdf + s.pdf,
      present: total.present + s.present,
      notRead: total.notRead + s.notRead,
    };
    console.log(
      `${task}: ${s.urls} cited URL(s) — exported ${s.exported} (${s.pdf} pdf), already cached ${s.present}, not read by the agent ${s.notRead}`,
    );
  }
  console.log(
    `total: ${JSON.stringify(total)} — URLs not read by the agent are captured by the judge at evaluation time`,
  );
}

function judge(): void {
  const arm = armOf(values.arm);
  const out = outDir();
  if (!values.official) fail("--official <Mind2Web-2 checkout> is required");
  const official = resolve(values.official);
  const cap = capUsd();
  if (cap === undefined) fail("--cap-usd is required for judge");
  const python = values.python ?? join(official, ".venv", "bin", "python");
  const costFile = join(out, `judge-cost-${arm.agent}-${Date.now()}.json`);
  const args = [
    join(import.meta.dir, "..", "benchmarks", "mind2web2", "judge_capped.py"),
    "--official",
    official,
    "--cap-usd",
    String(cap),
    "--cost-file",
    costFile,
    "--",
    "--agent_name",
    arm.agent,
    "--answer_folder",
    join(out, "answers"),
    "--cache_root",
    join(out, "cache"),
    "--eval_results_root",
    join(out, "eval_results"),
    "--eval_scripts_root",
    join(official, "eval_scripts"),
    "--eval_version",
    values["eval-version"]!,
    "--max_concurrent_tasks",
    "3",
    "--max_webpage_retrieval",
    "4",
    ...(values.task?.length === 1 ? ["--task_id", values.task[0]!] : []),
  ];
  console.log(`judge ${arm.agent} (cap $${cap}); cost → ${costFile}`);
  const r = spawnSync(python, args, { stdio: "inherit", cwd: official, env: process.env });
  const cost = existsSync(costFile)
    ? (JSON.parse(readFileSync(costFile, "utf8")) as { usd: number; calls: number })
    : undefined;
  console.log(
    `judge exit ${r.status}; ${cost ? `$${cost.usd.toFixed(2)} over ${cost.calls} call(s)` : "no cost file"}`,
  );
  if (r.status === 3)
    console.log("stopped at the judge spend cap: unfinished answers have no result (not scored)");
}

function score(): void {
  const arm = armOf(values.arm);
  const out = outDir();
  const ids = splitIds();
  const a = scoredAnswers(out, arm.agent, ids);
  const recs = readRunRecords(out, arm.agent).filter((r) => !ids || ids.has(r.task));
  const m = metrics(a);
  const cost = recs.reduce((s, r) => s + r.costUsd, 0);
  const report: Record<string, unknown> = {
    arm: arm.agent,
    split: values.split,
    ...m,
    generationUsd: Number(cost.toFixed(4)),
    usdPerRun: recs.length ? Number((cost / recs.length).toFixed(4)) : 0,
    meanSeconds: recs.length
      ? Math.round(recs.reduce((s, r) => s + r.seconds, 0) / recs.length)
      : 0,
    runs: recs.length,
    statuses: Object.fromEntries(
      ["answered", "empty", "error", "budget"].map((s) => [
        s,
        recs.filter((r) => r.status === s).length,
      ]),
    ),
    perTask: Object.fromEntries(
      [...new Set(a.map((x) => x.task))]
        .sort()
        .map((t) => [t, a.filter((x) => x.task === t).map((x) => Number(x.score.toFixed(3)))]),
    ),
  };
  if (values.compare) {
    const other = armOf(values.compare);
    const b = scoredAnswers(out, other.agent, ids);
    report.compare = { arm: other.agent, ...metrics(b), diffVsCompare: pairedDifference(b, a) };
  }
  console.log(JSON.stringify(report, null, 1));
}

async function record(): Promise<void> {
  const arm = armOf(values.arm);
  const out = outDir();
  if (values.split === "all")
    fail("--split tune|heldout is required for record (one ledger run per split)");
  const ids = splitIds();
  const scores = scoredAnswers(out, arm.agent, ids).filter(
    (s) => s.source === "judge" || s.score === 0,
  );
  const records = readRunRecords(out, arm.agent).filter((r) => !ids || ids.has(r.task));
  if (scores.length === 0) fail("nothing judged to record");
  const answers = new Map<string, string>();
  for (const s of scores) {
    const p = answerPath(out, arm.agent, s.task, s.k);
    if (existsSync(p)) answers.set(`${s.task}#${s.k}`, readFileSync(p, "utf8"));
  }
  const db = new MarinaDB(process.env.DB_PATH || "marina.db");
  const learning = enableOutcomeLearning(db);
  try {
    const rec = recordJudgedRun(db, { arm, split: values.split!, scores, records, answers });
    console.log(
      `ledger run ${rec.id}${rec.created ? "" : " (already recorded)"} — ${scores.length} item(s)`,
    );
    if (!learning) {
      console.log("lessons are off (MARINA_LESSONS=off): no outcomes queued");
      return;
    }
    const tasks = new Map(loadTasks().map((t) => [t.id, t.description]));
    const byItem = new Map(records.map((r) => [`${r.task}#${r.k}`, r]));
    const resolvedAt = new Date().toISOString();
    for (const s of scores) {
      const id = `${s.task}#${s.k}`;
      noteOutcome(
        db,
        answerOutcome({
          arm,
          score: s,
          ...(byItem.get(id) ? { record: byItem.get(id)! } : {}),
          resolvedAt,
          ledgerRunId: rec.id,
          privateContext: `${tasks.get(s.task) ?? ""}\n${answers.get(id) ?? ""}`,
        }),
      );
    }
    await settleOutcomes(db);
    console.log(`${scores.length} outcome(s) judged into lessons`);
  } finally {
    db.close();
  }
}

switch (cmd) {
  case "run":
    await run();
    break;
  case "cache":
    cache();
    break;
  case "judge":
    judge();
    break;
  case "score":
    score();
    break;
  case "record":
    await record();
    break;
  default:
    fail(
      "usage: bun run mind2web2 run|cache|judge|score|record … (see the header of scripts/mind2web2.ts)",
    );
}
