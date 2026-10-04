#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * ForecastBench — a thin adapter over Marina's general typed forecaster
 * (benchmarks/forecastbench/, docs/guides/forecastbench.md).
 *
 *   bun run forecastbench fetch [--due YYYY-MM-DD|latest]   save the round's question set
 *   bun run forecastbench estimate [--due …]                questions, forecasts, estimated cost
 *   bun run forecastbench run [--due …] [--set 1] …         forecast every question (resumable), then write
 *   bun run forecastbench write [--due …] [--set 1]         assemble + validate the set file, record it
 *   bun run forecastbench upload [--due …] [--set 1] --yes  copy the file to the operator's bucket folder
 *   bun run forecastbench resolve [--due …]                 score resolved questions, learn from them
 *   bun run forecastbench select … [--resume]               choose up to 3 configurations by backtest
 *   bun run forecastbench status
 *
 * Flags: --dir data/forecastbench, --set N (1–3: set N files with the selection's pick N),
 * --config <label> (override), --configs <file.json>, --concurrency 6, --limit N (first N
 * questions), --sample N (N per source), --budget <usd> (stop starting new questions),
 * --dry-run (write the file, never record it; implied by --limit/--sample), --model <name>.
 *
 * Selection flags: --rounds <due,due> (default the newest resolved rounds), --sources <a,b>,
 * --include <model> (repeatable), --crew <name>, --ablate, --replicates 2, --items 40,
 * --min-items 20, --select-budget <usd> (default 15), --live-per-question <usd> (default 0.1),
 * --retriever asof.
 *
 * Upload is an operator act: it needs FORECASTBENCH_GCS_FOLDER (the gs:// folder ForecastBench
 * assigns at registration), an authenticated `gcloud`, and --yes. Without them the file is
 * written locally and the command prints what to upload (or email). DB_PATH selects the ledger.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { backtestItems, resolvedRounds } from "../benchmarks/forecastbench/backtest";
import {
  type FbQuestion,
  type FbQuestionSet,
  fetchQuestionSet,
  fetchResolutionSet,
  isMarket,
  resolutionDates,
} from "../benchmarks/forecastbench/dataset";
import { assemble, meanCost, resolveRound, runRound } from "../benchmarks/forecastbench/run";
import {
  coverage,
  DEFAULT_SET_IDENTITY,
  setBody,
  setFileName,
  sha256,
  validateForecasts,
} from "../benchmarks/forecastbench/submission";
import {
  candidates,
  liveConfig,
  printSelection,
  runSelection,
} from "../benchmarks/forecasting/cli";
import { depsForConfig, forecasterFor } from "../benchmarks/forecasting/configs";
import { attachWorldSpend, learnedLessons } from "../benchmarks/forecasting/shared";
import { enableOutcomeLearning, noteOutcome, settleOutcomes } from "../src/learning/service";
import { MarinaDB } from "../src/persistence/database";

const BENCHMARK = "forecastbench";
/** $/question assumed before any of this round is measured. */
const PRIOR_COST = 0.08;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: "string", default: "data/forecastbench" },
    due: { type: "string", default: "latest" },
    set: { type: "string", default: "1" },
    config: { type: "string" },
    configs: { type: "string" },
    selection: { type: "string" },
    rounds: { type: "string" },
    sources: { type: "string" },
    include: { type: "string", multiple: true },
    crew: { type: "string", multiple: true },
    ablate: { type: "boolean" },
    replicates: { type: "string", default: "2" },
    items: { type: "string", default: "40" },
    "min-items": { type: "string", default: "20" },
    "select-budget": { type: "string", default: "15" },
    "live-per-question": { type: "string", default: "0.1" },
    // select: continue a stopped selection from its journals (same configuration only).
    resume: { type: "boolean" },
    retriever: { type: "string" },
    concurrency: { type: "string", default: "6" },
    limit: { type: "string" },
    sample: { type: "string" },
    budget: { type: "string" },
    model: { type: "string" },
    yes: { type: "boolean" },
    "dry-run": { type: "boolean" },
  },
});
const cmd = positionals[0] ?? "status";
const log = (s: string) => console.log(s);

const roundDir = (due: string) => join(values.dir!, due);
const journalPath = (due: string, n: string) => join(roundDir(due), `set-${n}.jsonl`);
const selectionPath = () => values.selection ?? join(values.dir!, "selection.json");

/** Set N files with the selection's pick N (or the named configuration), always disclosed. */
function chosenConfig() {
  return liveConfig({
    selectionPath: selectionPath(),
    rank: Number(values.set),
    ...(values.config ? { label: values.config } : {}),
    ...(values.configs ? { configsFile: values.configs } : {}),
  });
}

async function loadSet(): Promise<FbQuestionSet> {
  if (values.due !== "latest") {
    const path = join(roundDir(values.due!), "question-set.json");
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as FbQuestionSet;
  }
  const set = await fetchQuestionSet(values.due!);
  mkdirSync(roundDir(set.forecast_due_date), { recursive: true });
  writeFileSync(join(roundDir(set.forecast_due_date), "question-set.json"), JSON.stringify(set));
  return set;
}

function forecastCount(qs: FbQuestion[]): number {
  return qs.reduce((s, q) => s + (isMarket(q) ? 1 : resolutionDates(q).length), 0);
}

function selected(set: FbQuestionSet): FbQuestion[] {
  let qs = set.questions;
  if (values.sample) {
    const per = Number(values.sample);
    const counts = new Map<string, number>();
    qs = qs.filter((q) => {
      const n = counts.get(q.source) ?? 0;
      counts.set(q.source, n + 1);
      return n < per;
    });
  }
  if (values.limit) qs = qs.slice(0, Number(values.limit));
  return qs;
}

function describe(set: FbQuestionSet): string {
  const market = set.questions.filter(isMarket);
  const dataset = set.questions.filter((q) => !isMarket(q));
  return `${set.question_set} · due ${set.forecast_due_date} (by 23:59:59 UTC) · ${market.length} market + ${dataset.length} dataset questions · ${forecastCount(set.questions)} forecasts`;
}

async function fetchCmd(): Promise<number> {
  const set = await loadSet();
  log(`${describe(set)}\nsaved ${join(roundDir(set.forecast_due_date), "question-set.json")}`);
  return 0;
}

async function estimateCmd(): Promise<number> {
  const set = await loadSet();
  const qs = selected(set);
  const journal = journalPath(set.forecast_due_date, values.set!);
  const measured = meanCost(journal);
  const per = measured ?? PRIOR_COST;
  log(describe(set));
  log(
    `${qs.length} questions selected · one forecast call per question (dataset questions answer every date at once) · ≈ $${per.toFixed(3)}/question (${measured !== undefined ? "measured this round" : "prior"}) ⇒ ≈ $${(per * qs.length).toFixed(2)}`,
  );
  return 0;
}

async function runCmd(db: MarinaDB): Promise<number> {
  const set = await loadSet();
  const chosen = chosenConfig();
  const journal = journalPath(set.forecast_due_date, values.set!);
  mkdirSync(roundDir(set.forecast_due_date), { recursive: true });
  log(
    `${describe(set)}\nset ${values.set} · ${chosen.config.label}: ${chosen.description} · journal ${journal}`,
  );
  const r = await runRound({
    set,
    questions: selected(set),
    forecast: forecasterFor(
      chosen.config,
      depsForConfig(chosen.config, { lessons: learnedLessons(db) }),
    ),
    journal,
    concurrency: Number(values.concurrency),
    ...(values.budget ? { budgetUsd: Number(values.budget) } : {}),
    log,
  });
  log(
    `attempted ${r.attempted} · ok ${r.ok} · failed ${r.failed} · already done ${r.skippedDone} · $${r.costUsd.toFixed(2)}${r.stoppedBy ? ` · stopped: ${r.stoppedBy}` : ""}`,
  );
  return writeCmd(db, set);
}

async function writeCmd(db: MarinaDB, given?: FbQuestionSet): Promise<number> {
  const set = given ?? (await loadSet());
  const due = set.forecast_due_date;
  const n = Number(values.set);
  const chosen = chosenConfig();
  // Sets of one round must differ in `model`; set 1 is plain "Marina".
  const identity = {
    ...DEFAULT_SET_IDENTITY,
    model:
      values.model ??
      (n === 1 ? DEFAULT_SET_IDENTITY.model : `${DEFAULT_SET_IDENTITY.model} (${n})`),
  };
  const a = assemble(set, journalPath(due, values.set!));
  const errors = validateForecasts(set.questions, a.forecasts);
  if (errors.length) {
    log(`INVALID set: ${errors.slice(0, 5).join("; ")}`);
    return 1;
  }
  const cov = coverage(set, a.forecasts);
  const name = setFileName(due, identity, n);
  const path = join(roundDir(due), name);
  const body = setBody(set, identity, a.forecasts);
  writeFileSync(path, body);
  // The configuration behind the file, disclosed next to it.
  writeFileSync(
    `${path.replace(/\.json$/, "")}.configuration.json`,
    JSON.stringify(
      { set: n, configuration: chosen.config, disclosure: chosen.description },
      null,
      2,
    ),
  );
  const fileSha = sha256(body);
  // A dry run or a partial run (sample/limit) is never recorded as a submission.
  const partial = values["dry-run"] || values.sample || values.limit;
  if (!partial)
    db.recordExternalSubmission({
      benchmark: BENCHMARK,
      batch_ref: due,
      variant: chosen.config.label,
      identity_json: JSON.stringify(identity),
      file_name: name,
      file_sha256: fileSha,
      items: set.questions.length,
      answered: a.answered,
      cost_usd: a.costUsd,
      meta_json: JSON.stringify({
        set: n,
        fallback: a.fallback,
        coverage: cov,
        configuration: chosen.description,
      }),
      created_at: Date.now(),
    });
  log(`wrote ${path} (${(body.length / 1024).toFixed(0)} KB, sha256 ${fileSha.slice(0, 12)})`);
  log(
    `answered ${a.answered}/${set.questions.length} questions · fallback ${a.fallback} · market ${cov.market.given}/${cov.market.expected} · dataset ${cov.dataset.given}/${cov.dataset.expected} · $${a.costUsd.toFixed(2)}`,
  );
  if (a.fallback > set.questions.length * 0.05) {
    log(`WARNING: ${a.fallback} fallbacks — rerun \`run\` (it resumes) before the deadline`);
  }
  log(
    `to file it (by 23:59:59 UTC ${due}): upload ${name} to the ForecastBench bucket folder (\`bun run forecastbench upload --due ${due} --set ${n} --yes\` with FORECASTBENCH_GCS_FOLDER set), or email it to forecastbench@forecastingresearch.org`,
  );
  return 0;
}

async function uploadCmd(): Promise<number> {
  const set = await loadSet();
  const name = setFileName(set.forecast_due_date, DEFAULT_SET_IDENTITY, Number(values.set));
  const path = join(roundDir(set.forecast_due_date), name);
  if (!existsSync(path)) {
    log(`no ${path}; run \`write\` first`);
    return 1;
  }
  const folder = process.env.FORECASTBENCH_GCS_FOLDER?.trim();
  if (!folder || !values.yes) {
    log(`not uploading. File: ${path}`);
    log(
      folder
        ? "pass --yes to upload"
        : "set FORECASTBENCH_GCS_FOLDER (the gs:// folder from the registration email) and pass --yes",
    );
    return 0;
  }
  const r = spawnSync("gcloud", ["storage", "cp", path, `${folder.replace(/\/+$/, "")}/${name}`], {
    stdio: "inherit",
  });
  return r.status ?? 1;
}

async function resolveCmd(db: MarinaDB): Promise<number> {
  const set = await loadSet();
  const resolutions = await fetchResolutionSet(set.forecast_due_date);
  enableOutcomeLearning(db);
  const r = await resolveRound({
    set,
    journal: journalPath(set.forecast_due_date, values.set!),
    resolutions,
    db,
    config: chosenConfig().config.label,
    learn: (o) => noteOutcome(db, o),
  });
  await settleOutcomes(db);
  log(
    `resolved ${r.resolved} · learned ${r.learned}${r.meanBrier !== undefined ? ` · mean Brier ${r.meanBrier.toFixed(4)}` : ""}`,
  );
  return 0;
}

async function selectCmd(db: MarinaDB): Promise<number> {
  const rounds = values.rounds
    ? values.rounds.split(",").map((s) => s.trim())
    : (await resolvedRounds()).slice(0, 3);
  const sources = values.sources?.split(",").map((s) => s.trim());
  const items = [];
  for (const due of rounds) {
    const set = await fetchQuestionSet(due);
    const resolutions = await fetchResolutionSet(due);
    items.push(...backtestItems(set, resolutions, sources ? { sources } : {}));
  }
  const { configs, catalogue } = await candidates({
    ...(values.include?.length ? { include: values.include } : {}),
    ...(values.crew?.length ? { crews: values.crew } : {}),
    ...(values.ablate ? { ablate: true } : {}),
    ...(values.configs ? { configsFile: values.configs } : {}),
  });
  log(
    `rounds ${rounds.join(", ")} · ${items.length} resolved questions · ${configs.length} candidate configurations`,
  );
  const saved = await runSelection({
    benchmark: BENCHMARK,
    db,
    items,
    configs,
    catalogue,
    pick: 3,
    replicates: Number(values.replicates),
    maxItems: Number(values.items),
    minItems: Number(values["min-items"]),
    budgetUsd: Number(values["select-budget"]),
    livePerItemUsd: Number(values["live-per-question"]),
    ...(values.retriever ? { retriever: values.retriever } : {}),
    concurrency: Number(values.concurrency),
    out: selectionPath(),
    ...(values.resume ? { resume: true } : {}),
    log,
  });
  printSelection(saved, log);
  log(`saved ${selectionPath()} — set N files with pick N`);
  return 0;
}

function statusCmd(db: MarinaDB): number {
  for (const r of db.listExternalSubmissions(BENCHMARK, 20)) {
    log(
      `${new Date(r.created_at).toISOString().slice(0, 16)} ${r.file_name} · ${r.variant} · answered ${r.answered}/${r.items} · $${(r.cost_usd ?? 0).toFixed(2)}`,
    );
  }
  return 0;
}

async function main(): Promise<number> {
  if (cmd === "fetch") return fetchCmd();
  if (cmd === "estimate") return estimateCmd();
  if (cmd === "upload") return uploadCmd();
  const db = new MarinaDB(process.env.DB_PATH || "marina.db");
  const detach = attachWorldSpend(db);
  try {
    switch (cmd) {
      case "run":
        return await runCmd(db);
      case "write":
        return await writeCmd(db);
      case "resolve":
        return await resolveCmd(db);
      case "select":
        return await selectCmd(db);
      case "status":
        return statusCmd(db);
      default:
        console.error(
          `unknown command ${cmd} (fetch | estimate | run | write | upload | resolve | select | status)`,
        );
        return 2;
    }
  } finally {
    detach();
    db.close();
  }
}

process.exit(await main());
