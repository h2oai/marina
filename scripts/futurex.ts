#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * FutureX, the weekly future-prediction benchmark — a thin adapter over
 * Marina's general typed forecaster (`src/forecast/typed.ts`).
 *
 *   bun run futurex fetch [--past]                 download the batch (Hugging Face) at its commit sha
 *   bun run futurex run [--variant cheap] …        forecast every row, write the submission file
 *   bun run futurex backtest [--limit 40] …        resolved rows: forecast with an early cutoff, score, ledger
 *   bun run futurex watch [--once] [--run cheap]   poll the dataset sha; on a new batch, fetch (and run)
 *         [--daily] [--learn]                    …re-forecast OPEN rows daily + a final run before the
 *                                                Wed 16:00 UTC deadline; feed resolved weeks to lessons
 *   bun run futurex learn                          resolved rows of filed batches → outcome lessons
 *   bun run futurex status                         what has been filed (external_submissions)
 *
 * Common flags: --dir data/futurex (outside the repo's tracked tree), --variant <name> (repeatable;
 * built-ins cheap, frontier, crew), --variants <file.json> (Variant[]), --concurrency N,
 * --limit N, --org h2o.ai, --agent Marina, --model <segment>.
 *
 * NOTHING IS SENT. `run` prints the file path and the email fields; the operator (or an approved
 * connector) sends it. Answers are frozen before each row's end time. Re-forecasts keep a standing
 * answer per row and revise it only on a material change (`src/forecast/revision.ts`); every
 * decision goes to `revisions.jsonl` and a revised file is a new `external_submissions` row (an
 * unchanged file is already recorded). DB_PATH selects the ledger
 * (default marina.db). Needs OPENROUTER_API_KEY (as `bun run forecast`).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { ReferenceScores } from "../benchmarks/futurex/clean";
import { cleanBacktest } from "../benchmarks/futurex/clean-run";
import {
  datasetSha,
  type FuturexBatch,
  fetchBatch,
  ONLINE_REPO,
  PAST_REPO,
} from "../benchmarks/futurex/dataset";
import {
  ONLINE_BENCHMARK,
  PAST_BENCHMARK,
  recordScoredRun,
  recordSubmission,
} from "../benchmarks/futurex/ledger";
import { endTimeIso } from "../benchmarks/futurex/map";
import {
  type BatchRun,
  BUILTIN_VARIANTS,
  type RowResult,
  runBatch,
  type Variant,
} from "../benchmarks/futurex/run";
import { scoreBatch, scoreItem } from "../benchmarks/futurex/score";
import {
  DEFAULT_IDENTITY,
  emailFields,
  sha256,
  submissionBody,
  submissionFileName,
} from "../benchmarks/futurex/submission";
import { durableLessonStore, type LessonStore, retryingMemoryRun } from "../src/forecast/lessons";
import {
  dueRun,
  nextWeeklyDeadline,
  reviseStanding,
  type StandingAnswer,
} from "../src/forecast/revision";
import { modelPart, typedForecastDeps } from "../src/forecast/service";
import { enableOutcomeLearning, noteOutcome, settleOutcomes } from "../src/learning/service";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { MarinaDB } from "../src/persistence/database";
import type { MemoryOperationRequest } from "../src/sdk/memory-operations";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: "string", default: "data/futurex" },
    past: { type: "boolean" },
    variant: { type: "string", multiple: true },
    variants: { type: "string" },
    batch: { type: "string" },
    limit: { type: "string" },
    concurrency: { type: "string", default: "4" },
    org: { type: "string", default: DEFAULT_IDENTITY.org },
    agent: { type: "string", default: DEFAULT_IDENTITY.agent },
    model: { type: "string" },
    "horizon-days": { type: "string", default: "7" },
    since: { type: "string" },
    sigma: { type: "string", default: "relative" },
    once: { type: "boolean" },
    run: { type: "string" },
    interval: { type: "string", default: "3600" },
    daily: { type: "boolean" },
    learn: { type: "boolean" },
    "final-lead-hours": { type: "string", default: "4" },
    "daily-hour": { type: "string", default: "6" },
    "no-ledger": { type: "boolean" },
    // Clean (non-leaking) backtest — see benchmarks/futurex/clean.ts.
    clean: { type: "boolean" },
    after: { type: "string" },
    until: { type: "string" },
    // A file of row ids (one per line, or an answers.json) — run exactly those rows.
    rows: { type: "string" },
    isolation: { type: "string", default: "post-filtered" },
    "allow-contaminated": { type: "boolean" },
    retriever: { type: "string" },
    replicates: { type: "string", default: "1" },
    "first-replicate": { type: "string" },
    lessons: { type: "string" },
    "lessons-account": { type: "string", default: "Forecaster" },
    "lesson-writer": { type: "string", default: "openrouter/deepseek/deepseek-v4-pro-0813" },
    reference: { type: "string" },
    judge: { type: "string" },
  },
});
const [cmd] = positionals;
const dir = values.dir!;

function openDb(): MarinaDB {
  return new MarinaDB(process.env.DB_PATH || "marina.db");
}

function variantsFromFlags(): Variant[] {
  const file: Variant[] = values.variants ? JSON.parse(readFileSync(values.variants, "utf8")) : [];
  const byName = new Map<string, Variant>([
    ...Object.entries(BUILTIN_VARIANTS),
    ...file.map((v) => [v.label, v] as const),
  ]);
  const names = values.variant?.length
    ? values.variant
    : file.length
      ? file.map((v) => v.label)
      : ["cheap"];
  return names.map((n) => {
    const v = byName.get(n);
    if (!v)
      throw new Error(
        `unknown variant ${n} (built-ins: ${Object.keys(BUILTIN_VARIANTS).join(", ")})`,
      );
    return values.model && names.length === 1 ? { ...v, model: values.model } : v;
  });
}

const batchDir = (repo: string) => join(dir, repo.split("/")[1]!.toLowerCase());

function saveBatch(b: FuturexBatch): string {
  const d = batchDir(b.repo);
  mkdirSync(d, { recursive: true });
  const path = join(d, `${b.sha}.json`);
  writeFileSync(path, JSON.stringify(b));
  writeFileSync(join(d, "latest.json"), JSON.stringify({ sha: b.sha, fetchedAt: b.fetchedAt }));
  return path;
}

function loadBatch(repo: string, which?: string): FuturexBatch | undefined {
  const d = batchDir(repo);
  let sha = which;
  if (!sha || sha === "latest") {
    if (!existsSync(join(d, "latest.json"))) return undefined;
    sha = (JSON.parse(readFileSync(join(d, "latest.json"), "utf8")) as { sha: string }).sha;
  }
  const path = join(d, `${sha}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as FuturexBatch) : undefined;
}

/** Row ids from a plain list (one per line) or an answers.json (`{ results: [{ id }] }`). */
function readRowIds(path: string): Set<string> {
  const text = readFileSync(path, "utf8").trim();
  if (text.startsWith("{")) {
    const parsed = JSON.parse(text) as { results: Array<{ id: string }> };
    return new Set(parsed.results.map((r) => String(r.id)));
  }
  return new Set(
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

/**
 * The durable lesson memory for `account` (created as a world account when
 * missing), in the named space — canonical memory records through the
 * resident memory service.
 */
async function lessonStoreFor(db: MarinaDB, account: string, space: string): Promise<LessonStore> {
  if (!db.getUserByName(account)) db.createUser({ id: crypto.randomUUID(), name: account });
  const run = retryingMemoryRun(
    (request: MemoryOperationRequest) =>
      residentMemoryOperation(db, account, request) as Promise<{ ok: true; result: unknown }>,
  );
  const spaces = (await run({ operation: "spaces" })).result as {
    spaces?: Array<{ id: string; name: string }>;
  };
  const found = spaces.spaces?.find((s) => s.name === space)?.id;
  const id =
    found ??
    ((await run({ operation: "create_space", input: { name: space } })).result as { id: string })
      .id;
  return durableLessonStore(run, { spaceId: id });
}

function depsFor(v: Variant, lessons?: LessonStore) {
  return () => {
    const made = typedForecastDeps(process.env, {
      analysts: v.analysts,
      ...(v.planner ? { planner: v.planner } : {}),
      ...(v.critic ? { critic: v.critic } : {}),
      ...(v.verifier ? { verifier: v.verifier } : {}),
      ...(v.verify ? { verify: true } : {}),
      ...(lessons ? { lessons } : {}),
      ...(v.runs !== undefined ? { runs: v.runs } : {}),
      ...(v.researchRounds !== undefined ? { researchRounds: v.researchRounds } : {}),
      ...(v.critique === false ? { critique: false } : {}),
    });
    if ("error" in made) throw new Error(made.error);
    return made;
  };
}

function describe(b: FuturexBatch): string {
  const levels = [1, 2, 3, 4].map((l) => `L${l} ${b.rows.filter((r) => r.level === l).length}`);
  const ends = b.rows
    .map((r) => endTimeIso(r.end_time))
    .filter((x): x is string => !!x)
    .sort();
  return `${b.repo} @ ${b.sha} · ${b.rows.length} rows (${levels.join(", ")}) · end times ${ends[0] ?? "?"} → ${ends.at(-1) ?? "?"}`;
}

async function fetchCmd(): Promise<number> {
  const repo = values.past ? PAST_REPO : ONLINE_REPO;
  const b = await fetchBatch(repo);
  const path = saveBatch(b);
  console.log(`${describe(b)}\nsaved ${path}`);
  return 0;
}

/** FutureX's weekly submission deadline: Wednesday 16:00 UTC. */
const DEADLINE_WEEKDAY = 3;
const DEADLINE_HOUR_UTC = 16;

/** Per batch and variant: the standing answer per row and the result that produced it. */
interface Standing {
  answers: Record<string, StandingAnswer>;
  results: Record<string, RowResult>;
}

function loadStanding(out: string): Standing {
  const path = join(out, "standing.json");
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Standing)
    : { answers: {}, results: {} };
}

interface Schedule {
  runs: Array<{ at: string; kind: string; variants: string[] }>;
}

const schedulePath = (sha: string) => join(dir, "out", sha, "schedule.json");
function loadSchedule(sha: string): Schedule {
  const path = schedulePath(sha);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Schedule) : { runs: [] };
}

async function runCmd(opts: { kind?: string; openOnly?: boolean } = {}): Promise<number> {
  const batch = loadBatch(ONLINE_REPO, values.batch) ?? (await fetchBatch(ONLINE_REPO));
  if (!loadBatch(ONLINE_REPO, batch.sha)) saveBatch(batch);
  const kind = opts.kind ?? "run";
  const startedAt = new Date();
  const limited = values.limit ? batch.rows.slice(0, Number(values.limit)) : batch.rows;
  // A re-forecast touches only rows still open; closed rows keep their standing answer.
  const rows = opts.openOnly
    ? limited.filter((r) => (Date.parse(endTimeIso(r.end_time) ?? "") || 0) > startedAt.getTime())
    : limited;
  console.log(`${describe(batch)}\n${kind}: ${rows.length} rows`);
  if (rows.length === 0) return 0;
  // Live forecasts read every lesson learned so far (now is after every resolution).
  let lessons: LessonStore | undefined;
  if (values.lessons !== "off" && !values["no-ledger"]) {
    const ldb = openDb();
    if (ldb.getUserByName(values["lessons-account"]!)) {
      lessons = await lessonStoreFor(ldb, values["lessons-account"]!, SHARED_LESSONS);
      console.log(`lessons: recalling from ${values["lessons-account"]}/${SHARED_LESSONS}`);
    }
  }
  for (const v of variantsFromFlags()) {
    console.log(`\n── variant ${v.label} (${v.analysts.join(", ")}) · ${rows.length} rows`);
    const run = await runBatch(rows, v, depsFor(v, lessons), {
      concurrency: Number(values.concurrency),
      onRow: (r, done, total) =>
        console.log(
          `  [${done}/${total}] L${r.level} ${r.spec} ${r.id} → ${r.prediction || "(empty)"}${r.fallback ? " (fallback)" : ""}${r.late ? " (late)" : ""} · $${r.costUsd.toFixed(3)}`,
        ),
    });
    const identity = {
      org: values.org!,
      agent: values.agent!,
      model: v.model,
      framework: "Marina",
    };
    const name = submissionFileName(identity);
    const out = join(dir, "out", batch.sha, v.label);
    mkdirSync(out, { recursive: true });
    // Revise standing answers only on a material change; log every decision.
    const prior = loadStanding(out);
    const { standing, entries } = reviseStanding(
      prior.answers,
      run.results.map((r) => ({
        id: r.id,
        answer: {
          prediction: r.prediction,
          ...(r.confidence !== undefined ? { confidence: r.confidence } : {}),
          ...(r.fallback ? { fallback: true } : {}),
          ...(r.evidence !== undefined ? { evidence: r.evidence } : {}),
          at: run.finishedAt,
        },
      })),
    );
    const results = { ...prior.results };
    for (const r of run.results) if (standing[r.id] !== prior.answers[r.id]) results[r.id] = r;
    writeFileSync(
      join(out, "standing.json"),
      JSON.stringify({ answers: standing, results } satisfies Standing),
    );
    const log = entries.map((e) => JSON.stringify({ ...e, kind, variant: v.label }));
    writeFileSync(join(out, "revisions.jsonl"), `${log.join("\n")}\n`, { flag: "a" });
    const revised = entries.filter((e) => e.revised).length;
    const filed: BatchRun = {
      ...run,
      results: limited.flatMap((row) => (results[row.id] ? [results[row.id]!] : [])),
    };
    const body = submissionBody(filed.results.map((r) => ({ id: r.id, prediction: r.prediction })));
    const file = join(out, name);
    writeFileSync(file, body);
    writeFileSync(join(out, "answers.json"), JSON.stringify(run, null, 1));
    const hash = sha256(body);
    console.log(`  ${revised} revised · ${entries.length - revised} kept (revisions.jsonl)`);
    if (!values["no-ledger"]) {
      const db = openDb();
      try {
        const rec = recordSubmission(db, {
          batchSha: batch.sha,
          variant: v,
          identity,
          fileName: name,
          fileSha256: hash,
          run: filed,
        });
        console.log(`  recorded submission #${rec.id}${rec.created ? "" : " (already recorded)"}`);
      } finally {
        db.close();
      }
    }
    const fb = filed.results.filter((r) => r.fallback).length;
    const late = filed.results.filter((r) => r.late).length;
    console.log(
      `  wrote ${file}\n  ${filed.results.length} predictions · ${fb} fallback · ${late} late · cost $${run.costUsd.toFixed(2)}`,
    );
    if (revised === 0) continue; // the filed answers did not change: nothing new to send
    const mail = emailFields(identity, batch.sha, file, new Date().toISOString().slice(0, 10));
    console.log(
      `\n  To submit (operator — Marina never sends):\n    To: ${mail.to}\n    Subject: ${mail.subject}\n    Attach: ${mail.attachment}\n${mail.body
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n")}`,
    );
  }
  const sched = loadSchedule(batch.sha);
  sched.runs.push({
    at: startedAt.toISOString(),
    kind,
    variants: variantsFromFlags().map((v) => v.label),
  });
  mkdirSync(join(dir, "out", batch.sha), { recursive: true });
  writeFileSync(schedulePath(batch.sha), JSON.stringify(sched, null, 1));
  return 0;
}

/**
 * Resolved weeks → outcome lessons: every filed standing answer whose row now
 * has a ground truth in the past dataset is scored and handed to `noteOutcome`
 * (judged before it becomes a lesson; the question, truth and answer travel
 * only as private context, never stored). Each (variant, row) is learned once.
 */
async function learnCmd(): Promise<number> {
  const outRoot = join(dir, "out");
  if (!existsSync(outRoot)) return 0;
  const past = await fetchBatch(PAST_REPO);
  saveBatch(past);
  const truth = new Map(
    past.rows.filter((r) => r.ground_truth !== undefined).map((r) => [r.id, r]),
  );
  const db = openDb();
  enableOutcomeLearning(db);
  let queued = 0;
  try {
    for (const sha of readdirSync(outRoot)) {
      if (!existsSync(schedulePath(sha))) continue;
      for (const label of readdirSync(join(outRoot, sha))) {
        const out = join(outRoot, sha, label);
        if (!existsSync(join(out, "standing.json"))) continue;
        const { results } = loadStanding(out);
        const learnedPath = join(out, "learned.json");
        const learned = new Set<string>(
          existsSync(learnedPath)
            ? (JSON.parse(readFileSync(learnedPath, "utf8")) as string[])
            : [],
        );
        for (const r of Object.values(results)) {
          const row = truth.get(r.id);
          if (!row || learned.has(r.id)) continue;
          const item = scoreItem(row, r.prediction);
          noteOutcome(db, {
            domain: "forecast",
            source: `futurex:${label}`,
            succeeded: item.score >= 0.5,
            score: item.score,
            resolvedAt: endTimeIso(row.end_time) ?? past.fetchedAt,
            attempted: `forecast a level-${row.level} ${r.spec} question (variant ${label})`,
            detail: `${item.metric} score ${item.score.toFixed(2)}${r.fallback ? " (fallback answer)" : ""}`,
            signals: [
              `variant:${label}`,
              ...(r.confidence !== undefined ? [`confidence:${r.confidence.toFixed(2)}`] : []),
            ],
            refs: [`futurex:${r.id}`, `batch:${sha.slice(0, 10)}`],
            privateContext: `${row.prompt}\n${JSON.stringify(row.ground_truth)}\n${r.prediction}`,
          });
          learned.add(r.id);
          queued++;
        }
        writeFileSync(learnedPath, JSON.stringify([...learned]));
      }
    }
    await settleOutcomes(db);
  } finally {
    db.close();
  }
  console.log(`learn: ${queued} resolved answers handed to the lesson loop`);
  return 0;
}

/** The shared lesson space live runs read and every backtest also writes to. */
const SHARED_LESSONS = "forecast-lessons";

async function cleanBacktestCmd(batch: FuturexBatch): Promise<number> {
  const isolation = values.isolation as
    | "date-filtered"
    | "post-filtered"
    | "closed-book"
    | "contaminated";
  const allowed = ["date-filtered", "post-filtered", "closed-book"];
  if (values["allow-contaminated"]) allowed.push("contaminated");
  if (!allowed.includes(isolation)) {
    throw new Error(
      "--isolation date-filtered | post-filtered | closed-book (contaminated only with --allow-contaminated, as an upper bracket)",
    );
  }
  const lessons = values.lessons === "on" ? "on" : "off";
  const db = values["no-ledger"] ? undefined : openDb();
  try {
    const account = values["lessons-account"]!;
    const shared =
      db && lessons === "on" ? await lessonStoreFor(db, account, SHARED_LESSONS) : undefined;
    const writer = lessons === "on" ? modelPart(values["lesson-writer"]!) : undefined;
    const summaries = await cleanBacktest({
      rows: batch.rows,
      batchSha: batch.sha,
      variants: variantsFromFlags(),
      isolation,
      ...(values.retriever ? { retriever: values.retriever } : {}),
      ...(values.after ? { after: values.after } : {}),
      ...(values.until ? { until: values.until } : {}),
      ...(values.rows ? { onlyIds: readRowIds(values.rows) } : {}),
      ...(values["first-replicate"] ? { firstReplicate: Number(values["first-replicate"]) } : {}),
      limit: Number(values.limit ?? 80),
      horizonDays: Number(values["horizon-days"]),
      concurrency: Number(values.concurrency),
      replicates: Math.max(1, Number(values.replicates)),
      lessons,
      ...(db && lessons === "on"
        ? {
            // Each run recalls only its own lessons (an honest ablation); every
            // lesson is also kept in the shared space for live forecasts.
            lessonStore: async (label: string) => {
              const own = await lessonStoreFor(db, account, `${SHARED_LESSONS}-${label}`);
              return {
                write: async (l) => {
                  await shared?.write(l);
                  return own.write(l);
                },
                recall: (q, asOf, o) => own.recall(q, asOf, o),
              } satisfies LessonStore;
            },
          }
        : {}),
      ...(writer ? { lessonWriter: writer } : {}),
      ...(values.judge ? { judge: modelPart(values.judge) } : {}),
      ...(values.reference
        ? { reference: JSON.parse(readFileSync(values.reference, "utf8")) as ReferenceScores }
        : {}),
      outDir: join(dir, "clean", batch.sha),
      ...(db ? { ledger: db } : {}),
    });
    for (const s of summaries) {
      const run = s.ledgerId ? db?.getBenchmarkRun(s.ledgerId) : undefined;
      if (run?.status === "invalid") {
        const reason = db?.listBenchmarkRunValidity(run.id).at(-1)?.reason;
        console.log(`  ledger ${run.id} recorded INVALID: ${reason ?? "no reason recorded"}`);
      }
    }
    writeFileSync(
      join(dir, "clean", batch.sha, `summary-${Date.now()}.json`),
      JSON.stringify(summaries, null, 1),
    );
    return 0;
  } finally {
    db?.close();
  }
}

async function backtestCmd(): Promise<number> {
  const batch = loadBatch(PAST_REPO, values.batch) ?? (await fetchBatch(PAST_REPO));
  if (!loadBatch(PAST_REPO, batch.sha)) saveBatch(batch);
  if (values.clean) return cleanBacktestCmd(batch);
  const since = values.since ? Date.parse(values.since) : Number.NEGATIVE_INFINITY;
  const limit = Number(values.limit ?? 40);
  // The most recent resolved rows, balanced across levels.
  const sorted = batch.rows
    .filter((r) => (Date.parse(endTimeIso(r.end_time) ?? "") || 0) >= since)
    .sort((a, b) => (endTimeIso(b.end_time) ?? "").localeCompare(endTimeIso(a.end_time) ?? ""));
  const perLevel = Math.max(1, Math.floor(limit / 4));
  const rows = [1, 2, 3, 4].flatMap((l) => sorted.filter((r) => r.level === l).slice(0, perLevel));
  const horizonDays = Number(values["horizon-days"]);
  console.log(
    `${describe(batch)}\nbacktest: ${rows.length} rows, cutoff ${horizonDays} days before each end time\n` +
      "CAVEAT: these outcomes are public; web search without a date filter can still surface them. A smoke test, not a skill estimate.",
  );
  for (const v of variantsFromFlags()) {
    const run = await runBatch(rows, v, depsFor(v), {
      horizonDays,
      concurrency: Number(values.concurrency),
      onRow: (r, done, total) =>
        console.log(
          `  [${done}/${total}] L${r.level} ${r.spec} → ${r.prediction || "(empty)"} · $${r.costUsd.toFixed(3)}`,
        ),
    });
    const score = scoreBatch(rows, new Map(run.results.map((r) => [r.id, r.prediction])), {
      sigma: values.sigma === "dataset" ? "dataset" : "relative",
    });
    const out = join(dir, "backtest", batch.sha, v.label);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "answers.json"), JSON.stringify(run, null, 1));
    writeFileSync(join(out, "score.json"), JSON.stringify(score, null, 1));
    console.log(
      `\n  ${v.label}: overall ${score.overall} · ${Object.entries(score.byLevel)
        .map(([l, s]) => `L${l} ${s.mean} (n=${s.n})`)
        .join(
          " · ",
        )} · cost $${run.costUsd.toFixed(2)} ($${(run.costUsd / Math.max(1, rows.length)).toFixed(3)}/row)`,
    );
    if (!values["no-ledger"]) {
      const db = openDb();
      try {
        const rec = recordScoredRun(db, {
          benchmark: PAST_BENCHMARK,
          batchSha: batch.sha,
          variant: v,
          run,
          score,
          horizonDays,
        });
        console.log(
          `  ledger ${rec.id}${rec.created ? "" : " (already recorded)"}${rec.invalidReason ? ` — recorded INVALID: ${rec.invalidReason}` : ""}`,
        );
      } finally {
        db.close();
      }
    }
  }
  return 0;
}

async function watchCmd(): Promise<number> {
  const interval = Math.max(60, Number(values.interval)) * 1000;
  for (;;) {
    const sha = await datasetSha(ONLINE_REPO);
    const have = loadBatch(ONLINE_REPO, "latest");
    if (have?.sha === sha) {
      console.log(`${new Date().toISOString()} no new batch (${sha.slice(0, 10)})`);
    } else {
      const b = await fetchBatch(ONLINE_REPO);
      saveBatch(b);
      console.log(`${new Date().toISOString()} NEW batch ${describe(b)}`);
      if (values.run) {
        values.variant = values.run.split(",").map((s) => s.trim());
        values.batch = b.sha;
        await runCmd({ kind: "new" });
      }
    }
    if (values.daily && values.run && have?.sha === sha) {
      // Re-forecast open rows daily, plus one final run before the batch's deadline.
      const now = new Date();
      const deadline = nextWeeklyDeadline(
        new Date(have.fetchedAt),
        DEADLINE_WEEKDAY,
        DEADLINE_HOUR_UTC,
      );
      const last = loadSchedule(sha).runs.at(-1);
      const due = dueRun({
        now,
        deadline,
        ...(last ? { lastRunAt: last.at } : {}),
        finalLeadMs: Number(values["final-lead-hours"]) * 3_600_000,
        dailyHourUtc: Number(values["daily-hour"]),
      });
      if (due) {
        console.log(`${now.toISOString()} ${due} re-forecast (deadline ${deadline.toISOString()})`);
        values.variant = values.run.split(",").map((s) => s.trim());
        values.batch = sha;
        await runCmd({ kind: due, openOnly: true });
        if (values.learn) await learnCmd().catch((e) => console.error(`learn failed: ${e}`));
      }
    }
    if (values.once) return 0;
    await Bun.sleep(interval);
  }
}

function statusCmd(): number {
  const db = openDb();
  try {
    const rows = db.listExternalSubmissions(ONLINE_BENCHMARK, 50);
    if (rows.length === 0) console.log("No FutureX submissions recorded.");
    for (const r of rows) {
      console.log(
        `#${r.id} ${new Date(r.created_at).toISOString().slice(0, 16)} batch ${r.batch_ref.slice(0, 10)} ${r.variant} ${r.file_name} · ${r.answered}/${r.items} answered · $${(r.cost_usd ?? 0).toFixed(2)}`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

async function main(): Promise<number> {
  switch (cmd) {
    case "fetch":
      return fetchCmd();
    case "run":
      return runCmd();
    case "backtest":
      return backtestCmd();
    case "watch":
      return watchCmd();
    case "status":
      return statusCmd();
    case "learn":
      return learnCmd();
    default:
      console.error(
        "usage: bun run futurex fetch|run|backtest|watch|learn|status [flags] (see scripts/futurex.ts)",
      );
      return 2;
  }
}

process.exit(await main());
