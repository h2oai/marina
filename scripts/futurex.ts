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
 *   bun run futurex status                         what has been filed (external_submissions)
 *
 * Common flags: --dir data/futurex (outside the repo's tracked tree), --variant <name> (repeatable;
 * built-ins cheap, frontier, crew), --variants <file.json> (Variant[]), --concurrency N,
 * --limit N, --org h2o.ai, --agent Marina, --model <segment>.
 *
 * NOTHING IS SENT. `run` prints the file path and the email fields; the operator (or an approved
 * connector) sends it. Answers are frozen before each row's end time. DB_PATH selects the ledger
 * (default marina.db). Needs OPENROUTER_API_KEY (as `bun run forecast`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
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
import { BUILTIN_VARIANTS, runBatch, type Variant } from "../benchmarks/futurex/run";
import { scoreBatch } from "../benchmarks/futurex/score";
import {
  DEFAULT_IDENTITY,
  emailFields,
  sha256,
  submissionBody,
  submissionFileName,
} from "../benchmarks/futurex/submission";
import { typedForecastDeps } from "../src/forecast/service";
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
    "no-ledger": { type: "boolean" },
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

function depsFor(v: Variant) {
  return () => {
    const made = typedForecastDeps(process.env, {
      analysts: v.analysts,
      ...(v.planner ? { planner: v.planner } : {}),
      ...(v.critic ? { critic: v.critic } : {}),
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

async function runCmd(): Promise<number> {
  const batch = loadBatch(ONLINE_REPO, values.batch) ?? (await fetchBatch(ONLINE_REPO));
  if (!loadBatch(ONLINE_REPO, batch.sha)) saveBatch(batch);
  const rows = values.limit ? batch.rows.slice(0, Number(values.limit)) : batch.rows;
  console.log(describe(batch));
  for (const v of variantsFromFlags()) {
    console.log(`\n── variant ${v.label} (${v.analysts.join(", ")}) · ${rows.length} rows`);
    const run = await runBatch(rows, v, depsFor(v), {
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
    const body = submissionBody(run.results.map((r) => ({ id: r.id, prediction: r.prediction })));
    const file = join(out, name);
    writeFileSync(file, body);
    writeFileSync(join(out, "answers.json"), JSON.stringify(run, null, 1));
    const hash = sha256(body);
    if (!values["no-ledger"]) {
      const db = openDb();
      try {
        const rec = recordSubmission(db, {
          batchSha: batch.sha,
          variant: v,
          identity,
          fileName: name,
          fileSha256: hash,
          run,
        });
        console.log(`  recorded submission #${rec.id}${rec.created ? "" : " (already recorded)"}`);
      } finally {
        db.close();
      }
    }
    const fb = run.results.filter((r) => r.fallback).length;
    const late = run.results.filter((r) => r.late).length;
    console.log(
      `  wrote ${file}\n  ${run.results.length} predictions · ${fb} fallback · ${late} late · cost $${run.costUsd.toFixed(2)}`,
    );
    const mail = emailFields(identity, batch.sha, file, new Date().toISOString().slice(0, 10));
    console.log(
      `\n  To submit (operator — Marina never sends):\n    To: ${mail.to}\n    Subject: ${mail.subject}\n    Attach: ${mail.attachment}\n${mail.body
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n")}`,
    );
  }
  return 0;
}

async function backtestCmd(): Promise<number> {
  const batch = loadBatch(PAST_REPO, values.batch) ?? (await fetchBatch(PAST_REPO));
  if (!loadBatch(PAST_REPO, batch.sha)) saveBatch(batch);
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
        console.log(`  ledger ${rec.id}${rec.created ? "" : " (already recorded)"}`);
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
        await runCmd();
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
    default:
      console.error(
        "usage: bun run futurex fetch|run|backtest|watch|status [flags] (see scripts/futurex.ts)",
      );
      return 2;
  }
}

process.exit(await main());
