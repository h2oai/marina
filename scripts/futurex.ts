#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * FutureX, the weekly future-prediction benchmark — a thin adapter over
 * Marina's general typed forecaster (`src/forecast/typed.ts`).
 *
 *   bun run futurex fetch [--past]                 download the batch (Hugging Face) at its commit sha
 *   bun run futurex run [--variant earned] …       forecast every row, write the submission file
 *                                                (default `earned`: the board's earned configuration
 *                                                through the forecast surface; a named variant is a
 *                                                fixed override for controlled experiments)
 *   bun run futurex backtest [--limit 40] …        resolved rows: forecast with an early cutoff, score, ledger
 *   bun run futurex watch [--once] [--run earned]  poll the dataset sha; on a new batch, fetch (and run)
 *         [--daily] [--learn]                    …re-forecast OPEN rows daily + a final run before the
 *                                                batch's deadline; --learn feeds resolved weeks to
 *                                                lessons on EVERY tick (idempotent: once per row)
 *         [--daily-rows all|stale]               which open rows a daily run re-forecasts (default all;
 *         [--near-end-hours 48]                  stale = missing/fallback answers + rows ending soon)
 *         [--in-progress-hours 6]                a started, unfinished run blocks new ones this long
 *         [--answer early|late]                  early (default): a new batch is forecast at once;
 *                                                late: each open row is answered ONCE, within
 *                                                --final-lead-hours of its own cutoff (no dailies)
 *   bun run futurex schedule [--answer late] …     PRINT a systemd user service + hourly timer for
 *         [--run earned] [--out <dir>]           `watch --once` (default answers late); nothing is
 *         [--scope-cap 25] [--repo] [--bun]      installed or enabled — the operator copies it to
 *         [--env-file] [--db-path] [--name]      ~/.config/systemd/user and runs systemctl
 *   bun run futurex learn                          resolved rows of filed batches → outcome lessons
 *   bun run futurex migrate-lessons                copy the retired forecast-lesson store into the pool
 *   bun run futurex status                         what has been filed (external_submissions)
 *
 * Common flags: --dir data/futurex (outside the repo's tracked tree), --variant <name> (repeatable;
 * built-ins earned (live default), cheap (backtest default), frontier, crew), --variants
 * <file.json> (Variant[]), --concurrency N,
 * --limit N, --org h2o.ai, --agent Marina, --model <segment>, --format-line keep|strip (the row
 * prompt's "IMPORTANT: End with …" line; default strip — keep it to let MARINA_FORECAST_CONTRACT=on
 * read it).
 *
 * Every finished row is appended to `rows.jsonl` beside the run's output as it lands. A run
 * stopped by a spend cap keeps them (labelled partial, never filed); `--resume` continues it
 * under the same configuration (a different one is refused).
 *
 * NOTHING IS SENT. `run` prints the file path and the email fields; the operator (or an approved
 * connector) sends it. Answers are frozen before each row's end time. Re-forecasts keep a standing
 * answer per row and revise it only on a material change (`src/forecast/revision.ts`); every
 * decision goes to `revisions.jsonl` and a revised file is a new `external_submissions` row (an
 * unchanged file is already recorded).
 *
 * Watch cadence (`benchmarks/futurex/schedule.ts`): a batch's deadline is the first Wednesday
 * 16:00 UTC after the batch was PUBLISHED (its Hugging Face commit time; the first fetch for a
 * batch saved before that was recorded), never later than its last row's end time — so a batch
 * first seen after its deadline gets no dailies — and only the batch that is still `latest` is
 * re-forecast. The first pass of a new batch forecasts every row. Each run is written to
 * `out/<sha>/schedule.json` when it STARTS (`running`) and marked `done`/`failed` when it ends;
 * a check while a run is in progress starts nothing. A variant's `groundingFollowUp`
 * (`all` | `one` | `off`) bounds the forecaster's follow-up after ungrounded runs. DB_PATH selects the ledger
 * (default marina.db). Needs OPENROUTER_API_KEY (as `bun run forecast`).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BOARD_EXCLUSIONS } from "../benchmarks/forecasting/barred";
import type { ReferenceScores } from "../benchmarks/futurex/clean";
import { cleanBacktest, truthOutcome } from "../benchmarks/futurex/clean-run";
import {
  datasetSha,
  type FuturexBatch,
  type FuturexRow,
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
import { futurexOutcome, futurexResolvedAt } from "../benchmarks/futurex/lessons";
import { endTimeIso, FORMAT_LINE_MODES, type FormatLineMode } from "../benchmarks/futurex/map";
import {
  type BatchRun,
  BUILTIN_VARIANTS,
  describeEarned,
  earnedForecaster,
  type RowResult,
  runBatch,
  type Variant,
} from "../benchmarks/futurex/run";
import {
  ANSWER_TIMINGS,
  type AnswerTiming,
  batchDeadline,
  DAILY_ROWS_MODES,
  type DailyRowsMode,
  dailyRows,
  futurexSystemdUnits,
  lateRows,
  type Schedule,
  type ScheduleEntry,
  scheduleState,
} from "../benchmarks/futurex/schedule";
import { parseTruth, scoreBatch, scoreItem } from "../benchmarks/futurex/score";
import { settleRowShadow, startAdoptedShadows } from "../benchmarks/futurex/shadow";
import {
  DEFAULT_IDENTITY,
  emailFields,
  sha256,
  submissionBody,
  submissionFileName,
} from "../benchmarks/futurex/submission";
import { stamped } from "../benchmarks/run-version";
import { attachCliSpendLedger } from "../src/engine/cli-spend-ledger";
import { memoryHistory } from "../src/forecast/history";
import type { LessonStore } from "../src/forecast/lessons";
import { dueRun, reviseStanding, type StandingAnswer } from "../src/forecast/revision";
import { modelPart, typedForecastDeps } from "../src/forecast/service";
import { forecastLessonsFor } from "../src/learning/forecast-bridge";
import { migrateLegacyForecastLessons } from "../src/learning/legacy-forecast";
import { enableOutcomeLearning, noteOutcome, settleOutcomes } from "../src/learning/service";
import { fileTypedAnswer, resolveFiled } from "../src/outcomes/filing";
import { settleDelivery } from "../src/outcomes/record";
import { MarinaDB } from "../src/persistence/database";

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
    // early: forecast a new batch at once (+ --daily); late: answer each row once near its cutoff.
    answer: { type: "string", default: "early" },
    // `schedule`: where to write the units (default: print), and what they run.
    out: { type: "string" },
    repo: { type: "string" },
    bun: { type: "string" },
    "env-file": { type: "string" },
    "scope-cap": { type: "string", default: "25" },
    "db-path": { type: "string" },
    name: { type: "string", default: "marina-futurex-late" },
    "daily-hour": { type: "string", default: "6" },
    // Which open rows a daily re-forecast touches: every one, or only stale ones.
    "daily-rows": { type: "string", default: "all" },
    "near-end-hours": { type: "string", default: "48" },
    // A started run with no recorded end counts as in progress this long.
    "in-progress-hours": { type: "string", default: "6" },
    "no-ledger": { type: "boolean" },
    // Continue a stopped run from the rows it finished (rows.jsonl), same configuration only.
    resume: { type: "boolean" },
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
    "lesson-writer": { type: "string", default: "openrouter/deepseek/deepseek-v4-pro-0813" },
    reference: { type: "string" },
    judge: { type: "string" },
    // Keep or strip the row prompt's "IMPORTANT: End with …" line (default: the variant's, strip).
    "format-line": { type: "string" },
  },
});
const [cmd] = positionals;
const dir = values.dir!;

function openDb(): MarinaDB {
  return new MarinaDB(process.env.DB_PATH || "marina.db");
}

/**
 * The variants a command runs. A live run (`run`, `watch`) defaults to
 * `earned` — the configuration the futurex board has earned, resolved through
 * the forecast surface (`earnedForecaster`); `--variant` / `--run` /
 * `--variants` name fixed configurations instead (the override for controlled
 * experiments). Backtests default to the fixed `cheap` control.
 */
function variantsFromFlags(live = false): Variant[] {
  const file: Variant[] = values.variants ? JSON.parse(readFileSync(values.variants, "utf8")) : [];
  const byName = new Map<string, Variant>([
    ...Object.entries(BUILTIN_VARIANTS),
    ...file.map((v) => [v.label, v] as const),
  ]);
  const formatLine = formatLineFlag();
  const names = values.variant?.length
    ? values.variant
    : file.length
      ? file.map((v) => v.label)
      : [live ? "earned" : "cheap"];
  return names.map((n) => {
    const v = byName.get(n);
    if (!v)
      throw new Error(
        `unknown variant ${n} (built-ins: ${Object.keys(BUILTIN_VARIANTS).join(", ")})`,
      );
    const withLine = formatLine ? { ...v, formatLine } : v;
    return values.model && names.length === 1 ? { ...withLine, model: values.model } : withLine;
  });
}

/** `--format-line keep|strip`: overrides every variant's `formatLine` (unset = the variant's own). */
function formatLineFlag(): FormatLineMode | undefined {
  const v = values["format-line"]?.trim().toLowerCase();
  if (v === undefined) return undefined;
  if (!(FORMAT_LINE_MODES as readonly string[]).includes(v)) {
    throw new Error(`--format-line ${v}: expected ${FORMAT_LINE_MODES.join("|")}`);
  }
  return v as FormatLineMode;
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
      ...(v.budgetMs ? { budgetMs: v.budgetMs } : {}),
      ...(v.selection ? { selection: v.selection } : {}),
      ...(v.groundingFollowUp ? { groundingFollowUp: v.groundingFollowUp } : {}),
      exclude: BOARD_EXCLUSIONS.futurex!,
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

const schedulePath = (sha: string) => join(dir, "out", sha, "schedule.json");
function loadSchedule(sha: string): Schedule {
  const path = schedulePath(sha);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Schedule) : { runs: [] };
}

/** Append one schedule entry, or replace the one with the same start time and kind. */
function writeScheduleEntry(sha: string, entry: ScheduleEntry): void {
  const sched = loadSchedule(sha);
  const i = sched.runs.findIndex((r) => r.at === entry.at && r.kind === entry.kind);
  if (i >= 0) sched.runs[i] = entry;
  else sched.runs.push(entry);
  mkdirSync(join(dir, "out", sha), { recursive: true });
  writeFileSync(schedulePath(sha), JSON.stringify(sched, null, 1));
}

function dailyRowsMode(): DailyRowsMode {
  const m = values["daily-rows"] as DailyRowsMode;
  if (!DAILY_ROWS_MODES.includes(m)) {
    throw new Error(`--daily-rows ${values["daily-rows"]}: expected ${DAILY_ROWS_MODES.join("|")}`);
  }
  return m;
}

/**
 * Forecast a batch. `openOnly` (a re-forecast) touches only rows still open;
 * closed rows keep their standing answer. A `daily` re-forecast under
 * `--daily-rows stale` re-runs only open rows whose standing answer (per
 * variant) is missing or a fallback, or that end within `--near-end-hours`.
 * The run is recorded in schedule.json when it STARTS (`running`) and marked
 * `done` or `failed` when it ends, so an overlapping or later check sees it.
 */
async function runCmd(opts: { kind?: string; openOnly?: boolean } = {}): Promise<number> {
  const batch = loadBatch(ONLINE_REPO, values.batch) ?? (await fetchBatch(ONLINE_REPO));
  if (!loadBatch(ONLINE_REPO, batch.sha)) saveBatch(batch);
  const kind = opts.kind ?? "run";
  const startedAt = new Date();
  const limited = values.limit ? batch.rows.slice(0, Number(values.limit)) : batch.rows;
  const variants = variantsFromFlags(true);
  const mode: DailyRowsMode = opts.openOnly && kind === "daily" ? dailyRowsMode() : "all";
  const nearEndMs = Number(values["near-end-hours"]) * 3_600_000;
  const lateLeadMs = Number(values["final-lead-hours"]) * 3_600_000;
  const rowsFor = (v: Variant): FuturexRow[] => {
    if (!opts.openOnly) return limited;
    const standing = loadStanding(join(dir, "out", batch.sha, v.label)).answers;
    return kind === "late"
      ? lateRows(limited, standing, startedAt, {
          deadline: batchDeadline(batch).deadline,
          leadMs: lateLeadMs,
        })
      : dailyRows(limited, standing, startedAt, { mode, nearEndMs });
  };
  const planned = Object.fromEntries(variants.map((v) => [v.label, rowsFor(v).length]));
  console.log(
    `${describe(batch)}\n${kind}: ${Object.entries(planned)
      .map(([l, n]) => `${l} ${n} rows`)
      .join(" · ")}${mode === "stale" ? " (stale rows only)" : ""}`,
  );
  if (Object.values(planned).every((n) => n === 0)) return 0;
  const entry: ScheduleEntry = {
    at: startedAt.toISOString(),
    kind,
    variants: variants.map((v) => v.label),
    status: "running",
    rows: planned,
  };
  writeScheduleEntry(batch.sha, entry);
  try {
    await runVariants(batch, kind, limited, variants, rowsFor);
  } catch (err) {
    writeScheduleEntry(batch.sha, {
      ...entry,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
    throw err;
  }
  writeScheduleEntry(batch.sha, { ...entry, status: "done", finishedAt: new Date().toISOString() });
  return 0;
}

async function runVariants(
  batch: FuturexBatch,
  kind: string,
  limited: FuturexRow[],
  variants: Variant[],
  rowsFor: (v: Variant) => FuturexRow[],
): Promise<void> {
  // Live forecasts read every lesson learned so far (now is after every resolution),
  // from the one judged pool (MARINA_LESSONS on / observe / off).
  let lessons: LessonStore | undefined;
  // The earned variant resolves through the forecast surface (its own lesson recall).
  const earnedDb = values["no-ledger"] ? undefined : openDb();
  if (variants.some((v) => v.earned))
    console.log(`earned live configuration: ${describeEarned(earnedDb ? { db: earnedDb } : {})}`);
  if (values.lessons !== "off" && !values["no-ledger"]) {
    const ldb = openDb();
    await migrateLessons(ldb);
    // Live: the batch resolves in the future, so every lesson may be used (rule 2 lifted).
    lessons = forecastLessonsFor(ldb, { eval: { benchmark: "futurex", mode: "live" } });
    console.log("lessons: recalling from the lesson pool (forecast, arena)");
  }
  for (const v of variants) {
    const rows = rowsFor(v);
    if (rows.length === 0) {
      console.log(`\n── variant ${v.label}: no rows to re-forecast`);
      continue;
    }
    console.log(
      `\n── variant ${v.label} (${v.earned ? "earned configuration" : v.analysts.join(", ")}) · ${rows.length} rows`,
    );
    const out = join(dir, "out", batch.sha, v.label);
    const run = await runBatch(rows, v, depsFor(v, lessons), {
      concurrency: Number(values.concurrency),
      ...(v.earned
        ? {
            forecastRow: earnedForecaster({
              ...(earnedDb ? { db: earnedDb } : {}),
              ...(values.lessons === "off" ? { lessons: false } : {}),
            }),
          }
        : {}),
      journal: {
        path: join(out, "rows.jsonl"),
        config: {
          benchmark: ONLINE_BENCHMARK,
          batchSha: batch.sha,
          lessons: lessons ? "on" : "off",
        },
        ...(values.resume ? { resume: true } : {}),
      },
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
          ...(r.evidenceIndex ? { evidenceIndex: r.evidenceIndex } : {}),
          at: run.finishedAt,
        },
      })),
    );
    const results = { ...prior.results };
    const adopted = run.results.filter((r) => standing[r.id] !== prior.answers[r.id]);
    for (const r of adopted) results[r.id] = r;
    // Shadow challengers for the adopted answers (MARINA_FORECAST_SHADOW; earned only).
    if (v.earned && earnedDb && process.env.MARINA_FORECAST_SHADOW?.trim()) {
      const sh = await startAdoptedShadows(earnedDb, out, v.label, adopted);
      if (sh.started) console.log(`  shadows: ${sh.filed}/${sh.started} filed`);
    }
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
  // The resolved dataset is re-read only when its commit moved (learn runs every watch tick).
  const saved = loadBatch(PAST_REPO, "latest");
  const past =
    saved && saved.sha === (await datasetSha(PAST_REPO)) ? saved : await fetchBatch(PAST_REPO);
  if (past !== saved) saveBatch(past);
  const truth = new Map(
    past.rows.filter((r) => r.ground_truth !== undefined).map((r) => [r.id, r]),
  );
  const db = openDb();
  enableOutcomeLearning(db);
  let queued = 0;
  try {
    await migrateLessons(db);
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
          // Known only after the end time plus the settlement margin: rows of a
          // week share one end time, and a replay's cutoff is that end time.
          const resolvedAt = futurexResolvedAt(row);
          if (!resolvedAt) continue;
          // A filed answer resolves on the one outcome path (scoring, lessons,
          // history). A fallback is an infrastructure outcome, never learned;
          // a result with no answer object (older runs) keeps the board lesson.
          if (r.answer && !r.fallback) {
            const filing = {
              owner: `marina:futurex/${label}`,
              source: "futurex",
              externalId: `futurex:${r.id}`,
              evalMode: "live" as const,
            };
            fileTypedAnswer(db, r.answer, filing);
            const value = truthOutcome(row, r.answer.answer) ?? {
              value: parseTruth(row.ground_truth),
            };
            resolveFiled(db, filing.owner, filing.externalId, value, Date.parse(resolvedAt), [
              `batch:${sha.slice(0, 10)}`,
            ]);
            // Its shadow challenger, if one ran, settles on the same resolution.
            settleRowShadow(db, out, r.id, { value, resolvedAt: Date.parse(resolvedAt) });
          } else if (!r.fallback) {
            settleRowShadow(db, out, r.id, "unfiled");
            noteOutcome(
              db,
              futurexOutcome({
                row,
                result: r,
                item,
                label,
                resolvedAt,
                refs: [`batch:${sha.slice(0, 10)}`],
              }),
            );
          }
          if (r.fallback) settleRowShadow(db, out, r.id, "unfiled");
          learned.add(r.id);
          queued++;
        }
        writeFileSync(learnedPath, JSON.stringify([...learned]));
      }
    }
    await settleOutcomes(db);
    await settleDelivery(db);
  } finally {
    db.close();
  }
  console.log(`learn: ${queued} resolved answers handed to the lesson loop`);
  return 0;
}

/**
 * Copy the retired forecast-lesson store (a `Forecaster` account's
 * `forecast-lessons` space) into the pool once; a no-op after it has run.
 */
async function migrateLessons(db: MarinaDB): Promise<number> {
  const m = await migrateLegacyForecastLessons(db);
  if (m.account) {
    console.log(
      `lessons: ${m.copied}/${m.found} legacy forecast lessons in the pool (from ${m.account})${m.renamed ? "; the script account is now server-owned" : ""}${m.failed ? ` · ${m.failed} failed: ${m.errors.join("; ")}` : ""}`,
    );
  }
  return m.failed;
}

async function migrateLessonsCmd(): Promise<number> {
  const db = openDb();
  try {
    const failed = await migrateLessons(db);
    return failed ? 1 : 0;
  } finally {
    db.close();
  }
}

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
  // With lessons on, each scored row of a valid filed run also feeds the judged pool.
  const learning = db && lessons === "on" ? enableOutcomeLearning(db) : false;
  try {
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
      // Each run recalls only its own in-run lessons (an honest ablation).
      ...(db && learning ? { learn: (o) => noteOutcome(db, o) } : {}),
      // Each run also learns calibration and prior weights from its own resolved
      // rows only (a fresh in-memory history), never the shared history file.
      history: async () => memoryHistory(),
      ...(writer ? { lessonWriter: writer } : {}),
      ...(values.judge ? { judge: modelPart(values.judge) } : {}),
      ...(values.reference
        ? { reference: JSON.parse(readFileSync(values.reference, "utf8")) as ReferenceScores }
        : {}),
      outDir: join(dir, "clean", batch.sha),
      ...(values.resume ? { resume: true } : {}),
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
    if (db && learning) await settleOutcomes(db);
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
    const out = join(dir, "backtest", batch.sha, v.label);
    const run = await runBatch(rows, v, depsFor(v), {
      horizonDays,
      concurrency: Number(values.concurrency),
      journal: {
        path: join(out, "rows.jsonl"),
        config: { benchmark: PAST_BENCHMARK, batchSha: batch.sha },
        ...(values.resume ? { resume: true } : {}),
      },
      onRow: (r, done, total) =>
        console.log(
          `  [${done}/${total}] L${r.level} ${r.spec} → ${r.prediction || "(empty)"} · $${r.costUsd.toFixed(3)}`,
        ),
    });
    const score = scoreBatch(rows, new Map(run.results.map((r) => [r.id, r.prediction])), {
      sigma: values.sigma === "dataset" ? "dataset" : "relative",
    });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "answers.json"), JSON.stringify(run, null, 1));
    writeFileSync(join(out, "score.json"), JSON.stringify(stamped(score), null, 1));
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

function answerTiming(): AnswerTiming {
  const a = values.answer as AnswerTiming;
  if (!ANSWER_TIMINGS.includes(a)) {
    throw new Error(`--answer ${values.answer}: expected ${ANSWER_TIMINGS.join("|")}`);
  }
  return a;
}

/**
 * `--answer late`: answer each open row once, inside the lead window before
 * its own cutoff (benchmarks/futurex/schedule.ts `lateRows`). Runs against
 * the batch that is `latest` — fetched this tick or earlier.
 */
async function lateTick(sha: string): Promise<void> {
  const batch = loadBatch(ONLINE_REPO, sha);
  if (!batch || !values.run) return;
  const now = new Date();
  const { deadline } = batchDeadline(batch);
  const state = scheduleState(loadSchedule(sha));
  const inProgressMs = Number(values["in-progress-hours"]) * 3_600_000;
  if (state.inProgressSince && now.getTime() - Date.parse(state.inProgressSince) < inProgressMs) {
    console.log(`${now.toISOString()} a run started ${state.inProgressSince} is in progress`);
    return;
  }
  if (now >= deadline) {
    console.log(`${now.toISOString()} past the batch deadline (${deadline.toISOString()})`);
    return;
  }
  values.variant = values.run.split(",").map((s) => s.trim());
  values.batch = sha;
  await runCmd({ kind: "late", openOnly: true });
}

async function watchCmd(): Promise<number> {
  const interval = Math.max(60, Number(values.interval)) * 1000;
  const timing = answerTiming();
  if (timing === "late" && values.daily)
    console.log("--answer late answers each row once near its cutoff; --daily is ignored");
  for (;;) {
    const sha = await datasetSha(ONLINE_REPO);
    const have = loadBatch(ONLINE_REPO, "latest");
    if (have?.sha === sha) {
      console.log(`${new Date().toISOString()} no new batch (${sha.slice(0, 10)})`);
    } else {
      const b = await fetchBatch(ONLINE_REPO);
      saveBatch(b);
      console.log(`${new Date().toISOString()} NEW batch ${describe(b)}`);
      if (timing === "late") {
        console.log(
          `  answering late: each row within ${values["final-lead-hours"]} h of its cutoff (deadline ${batchDeadline(b).deadline.toISOString()})`,
        );
      } else if (values.run) {
        values.variant = values.run.split(",").map((s) => s.trim());
        values.batch = b.sha;
        await runCmd({ kind: "new" });
      }
    }
    // Dailies only ever run for the batch that is still `latest` (a newer batch
    // ends the older one's re-forecasts), against the batch's own deadline.
    if (timing === "late") await lateTick(sha);
    const current = have?.sha === sha ? have : undefined;
    if (timing === "early" && values.daily && values.run && current) {
      // Re-forecast open rows daily, plus one final run before the batch's deadline.
      const now = new Date();
      const { deadline, basis, boundedByEnd } = batchDeadline(current);
      const state = scheduleState(loadSchedule(sha));
      const inProgressMs = Number(values["in-progress-hours"]) * 3_600_000;
      const due = dueRun({
        now,
        deadline,
        ...state,
        inProgressMs,
        finalLeadMs: Number(values["final-lead-hours"]) * 3_600_000,
        dailyHourUtc: Number(values["daily-hour"]),
      });
      const deadlineNote = `deadline ${deadline.toISOString()} from ${basis} time${boundedByEnd ? ", bounded by the last end time" : ""}`;
      if (
        state.inProgressSince &&
        now.getTime() - Date.parse(state.inProgressSince) < inProgressMs
      ) {
        console.log(`${now.toISOString()} a run started ${state.inProgressSince} is in progress`);
      } else if (due) {
        console.log(`${now.toISOString()} ${due} re-forecast (${deadlineNote})`);
        values.variant = values.run.split(",").map((s) => s.trim());
        values.batch = sha;
        await runCmd({ kind: due, openOnly: true });
      } else if (now >= deadline) {
        console.log(`${now.toISOString()} past the batch deadline (${deadlineNote})`);
      }
    }
    // Learning is cheap and idempotent (each variant and row is learned once): every tick.
    if (values.learn) await learnCmd().catch((e) => console.error(`learn failed: ${e}`));
    if (values.once) return 0;
    await Bun.sleep(interval);
  }
}

/**
 * Print (or write to `--out`) a systemd user service + hourly timer that runs
 * `watch --once`. Default `--answer late`. Nothing is installed, enabled or
 * started: activating it is the operator's decision.
 */
function scheduleCmd(): number {
  const given = (flag: string) =>
    process.argv.some((a) => a === `--${flag}` || a.startsWith(`--${flag}=`));
  // `watch` defaults to early; a scheduled watcher defaults to answering late.
  const timing: AnswerTiming = given("answer") ? answerTiming() : "late";
  const repo = resolve(values.repo ?? process.cwd());
  const name = values.name ?? "marina-futurex-late";
  const units = futurexSystemdUnits({
    repo,
    bun: values.bun ?? process.execPath,
    ...(values["env-file"] ? { envFile: resolve(values["env-file"]) } : {}),
    dir: resolve(repo, dir),
    run: values.run ?? "earned",
    ...(values.variants ? { variantsFile: resolve(values.variants) } : {}),
    answer: timing,
    // A scheduled late answer leaves a few hourly checks of slack before each cutoff.
    finalLeadHours: given("final-lead-hours") ? Number(values["final-lead-hours"]) : 6,
    scopeCapUsd: Number(values["scope-cap"]),
    ...(values["db-path"] ? { dbPath: resolve(values["db-path"]) } : {}),
    learn: values.learn === true,
    name,
  });
  if (values.out) {
    mkdirSync(values.out, { recursive: true });
    writeFileSync(join(values.out, `${name}.service`), units.service);
    writeFileSync(join(values.out, `${name}.timer`), units.timer);
    console.log(`wrote ${join(values.out, `${name}.service`)} and ${name}.timer (not enabled)`);
  } else {
    console.log(`# ${name}.service\n${units.service}\n# ${name}.timer\n${units.timer}`);
  }
  console.log(
    `# Nothing was installed or started. To activate (operator only):\n` +
      `#   cp ${name}.service ${name}.timer ~/.config/systemd/user/ && systemctl --user daemon-reload\n` +
      `#   systemctl --user enable --now ${name}.timer`,
  );
  return 0;
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
  // Every model call counts in the world database's daily spend ledger (and
  // MARINA_SPEND_SCOPE's), shared with the server and every other run on it,
  // so an hourly timer cannot spend a fresh cap each invocation.
  if (cmd !== "fetch" && cmd !== "status" && cmd !== "migrate-lessons" && cmd !== "schedule") {
    attachCliSpendLedger(`bun run futurex ${cmd}`, {
      dbPath: process.env.DB_PATH || (values["no-ledger"] ? undefined : "marina.db"),
    });
  }
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
    case "schedule":
      return scheduleCmd();
    case "learn":
      return learnCmd();
    case "migrate-lessons":
      return migrateLessonsCmd();
    default:
      console.error(
        "usage: bun run futurex fetch|run|backtest|watch|schedule|learn|migrate-lessons|status [flags] (see scripts/futurex.ts)",
      );
      return 2;
  }
}

process.exit(await main());
