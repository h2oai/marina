#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Metaculus bot — a thin adapter over Marina's general typed forecaster
 * (benchmarks/metaculus/, docs/guides/metaculus.md).
 *
 *   bun run metaculus select … [--resume] choose the configuration by held-out backtest
 *   bun run metaculus pass [--dry-run] …  forecast new open questions, then learn from resolved ones
 *   bun run metaculus forecast …          only the forecasting half
 *   bun run metaculus resolve             only the learning half
 *   bun run metaculus status              what has been filed and resolved
 *   bun run metaculus timer               write the systemd user units (never enables them)
 *
 * Live flags: --tournament <id|slug> (repeatable; default fall2026 + minibench; `test` = the
 * practice area), --config <label> (default: the earned `forecast-config:metaculus` slot that
 * `select` files through earned promotion, else the selection's pick, else a disclosed fallback),
 * --configs <file.json>, --daily-cap <usd> (default 10), --limit N, --fixture <posts.json>
 * (read-only offline questions; implies --dry-run), --out <dir> (dry-run output).
 *
 * Selection flags: --backtest-tournament <id|slug> (repeatable; resolved questions, forecast as
 * of their opening), --include <model> (repeatable; default the current top tiers), --crew <name>,
 * --ablate, --replicates 2, --items 40, --min-items 20, --budget <usd> (default 15),
 * --live-per-question <usd>, --retriever asof.
 *
 * Credentials come from the environment only: METACULUS_TOKEN (the bot account's API token) and
 * the forecaster's model key (OPENROUTER_API_KEY or a local provider). DB_PATH selects the ledger.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  candidates,
  liveConfig,
  printSelection,
  runSelection,
} from "../benchmarks/forecasting/cli";
import { depsForConfig, forecasterFor } from "../benchmarks/forecasting/configs";
import { attachWorldSpend } from "../benchmarks/forecasting/shared";
import {
  fixtureClient,
  type MetaculusClient,
  type MetaculusPost,
  metaculusClient,
  TOURNAMENTS,
} from "../benchmarks/metaculus/api";
import { backtestItems } from "../benchmarks/metaculus/backtest";
import {
  BENCHMARK,
  forecastPass,
  OUTCOME_BENCHMARK,
  resolvePass,
  spentToday,
} from "../benchmarks/metaculus/bot";
import { timerUnits } from "../benchmarks/metaculus/timer";
import { forecastLessonsFor } from "../src/learning/forecast-bridge";
import { enableOutcomeLearning, noteOutcome, settleOutcomes } from "../src/learning/service";
import { MarinaDB } from "../src/persistence/database";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    tournament: { type: "string", multiple: true },
    config: { type: "string" },
    configs: { type: "string" },
    "daily-cap": { type: "string", default: "10" },
    limit: { type: "string" },
    "dry-run": { type: "boolean" },
    fixture: { type: "string" },
    out: { type: "string", default: "data/metaculus/dry-run" },
    selection: { type: "string", default: "data/metaculus/selection.json" },
    "backtest-tournament": { type: "string", multiple: true },
    include: { type: "string", multiple: true },
    crew: { type: "string", multiple: true },
    ablate: { type: "boolean" },
    replicates: { type: "string", default: "2" },
    items: { type: "string", default: "40" },
    "min-items": { type: "string", default: "20" },
    budget: { type: "string", default: "15" },
    "live-per-question": { type: "string" },
    // select: continue a stopped selection from its journals (same configuration only).
    resume: { type: "boolean" },
    retriever: { type: "string" },
    "timer-dir": { type: "string", default: join(homedir(), ".local/share/marina-metaculus") },
  },
});
const cmd = positionals[0] ?? "pass";

const tournamentId = (t: string) =>
  t in TOURNAMENTS ? TOURNAMENTS[t as keyof typeof TOURNAMENTS] : /^\d+$/.test(t) ? Number(t) : t;
const tournaments = (values.tournament?.length ? values.tournament : ["fall2026", "minibench"]).map(
  tournamentId,
);
const dryRun = !!values["dry-run"] || !!values.fixture;
const log = (line: string) => console.log(line);

function client(): MetaculusClient {
  if (values.fixture) {
    const raw = JSON.parse(readFileSync(values.fixture, "utf8")) as
      | MetaculusPost[]
      | { results: MetaculusPost[] };
    return fixtureClient(Array.isArray(raw) ? raw : raw.results);
  }
  const token = process.env.METACULUS_TOKEN?.trim();
  if (!token) {
    console.error(
      "METACULUS_TOKEN is not set (the bot account's API token; every Metaculus API call needs it). Use --fixture <posts.json> for an offline dry run.",
    );
    process.exit(2);
  }
  return metaculusClient({ token });
}

async function selectCmd(db: MarinaDB): Promise<number> {
  const from = (values["backtest-tournament"] ?? []).map(tournamentId);
  if (!from.length) {
    console.error("name the resolved questions to backtest on: --backtest-tournament <id|slug>");
    return 2;
  }
  const c = client();
  const posts = (await Promise.all(from.map((t) => c.posts(t, "resolved")))).flat();
  const items = backtestItems(posts);
  const { configs, catalogue } = await candidates({
    ...(values.include?.length ? { include: values.include } : {}),
    ...(values.crew?.length ? { crews: values.crew } : {}),
    ...(values.ablate ? { ablate: true } : {}),
    ...(values.configs ? { configsFile: values.configs } : {}),
  });
  log(`${items.length} resolved questions · ${configs.length} candidate configurations`);
  const saved = await runSelection({
    benchmark: BENCHMARK,
    db,
    items,
    configs,
    catalogue,
    pick: 1,
    replicates: Number(values.replicates),
    maxItems: Number(values.items),
    minItems: Number(values["min-items"]),
    budgetUsd: Number(values.budget),
    ...(values["live-per-question"] ? { livePerItemUsd: Number(values["live-per-question"]) } : {}),
    ...(values.retriever ? { retriever: values.retriever } : {}),
    out: values.selection!,
    ...(values.resume ? { resume: true } : {}),
    log,
  });
  printSelection(saved, log);
  log(`saved ${values.selection}`);
  return 0;
}

async function forecastCmd(db: MarinaDB): Promise<number> {
  const chosen = liveConfig({
    selectionPath: values.selection!,
    board: BENCHMARK,
    db,
    ...(values.config ? { label: values.config } : {}),
    ...(values.configs ? { configsFile: values.configs } : {}),
  });
  const forecast = forecasterFor(
    chosen.config,
    depsForConfig(chosen.config, { lessons: forecastLessonsFor(db) }),
  );
  log(
    `metaculus ${dryRun ? "DRY RUN " : ""}· tournaments ${tournaments.join(", ")} · ${chosen.config.label}: ${chosen.description} · spent today $${spentToday(db, new Date()).toFixed(2)} of $${values["daily-cap"]}`,
  );
  const r = await forecastPass({
    client: client(),
    db,
    forecast,
    tournaments,
    config: { label: chosen.config.label, description: chosen.description },
    dryRun,
    outDir: values.out!,
    dailyCapUsd: Number(values["daily-cap"]),
    ...(values.limit ? { limit: Number(values.limit) } : {}),
    log,
  });
  log(
    `open ${r.open} · forecast ${r.forecast} · skipped ${r.skipped.length} · failed ${r.failed.length} · $${r.costUsd.toFixed(3)}${r.stoppedBy ? ` · stopped: ${r.stoppedBy}` : ""}`,
  );
  for (const f of r.failed) log(`  failed q${f.questionId}: ${f.error}`);
  return r.failed.length && !r.forecast ? 1 : 0;
}

async function resolveCmd(db: MarinaDB): Promise<number> {
  if (values.fixture) return 0;
  enableOutcomeLearning(db);
  const r = await resolvePass({ client: client(), db, learn: (o) => noteOutcome(db, o), log });
  await settleOutcomes(db);
  log(
    `resolve: checked ${r.checked} · resolved ${r.resolved} · learned ${r.learned} · failed ${r.failed}`,
  );
  return 0;
}

function statusCmd(db: MarinaDB): number {
  const filed = db.listExternalSubmissions(BENCHMARK, 10_000);
  const outcomes = db.listExternalSubmissions(OUTCOME_BENCHMARK, 10_000);
  const scores = outcomes
    .map((o) => (o.meta_json ? (JSON.parse(o.meta_json) as { score: number | null }).score : null))
    .filter((s): s is number => typeof s === "number");
  const cost = filed.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  log(
    `filed ${filed.length} · spent $${cost.toFixed(2)} (today $${spentToday(db, new Date()).toFixed(2)}) · resolved ${outcomes.length}${scores.length ? ` · mean score ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(3)}` : ""}`,
  );
  return 0;
}

function timerCmd(): number {
  const dir = join(values["timer-dir"]!, "systemd");
  mkdirSync(dir, { recursive: true });
  const envFile = join(homedir(), ".config/marina-metaculus/env");
  const units = timerUnits({
    repoDir: resolve("."),
    bun: process.execPath,
    envFile,
    tournaments,
    dailyCapUsd: Number(values["daily-cap"]),
  });
  writeFileSync(join(dir, "marina-metaculus.service"), units.service);
  writeFileSync(join(dir, "marina-metaculus.timer"), units.timer);
  log(`wrote ${dir}/marina-metaculus.{service,timer} (NOT enabled)`);
  log(
    `credentials: create ${envFile} (chmod 600) with METACULUS_TOKEN=…, OPENROUTER_API_KEY=…, DB_PATH=…`,
  );
  log("to enable after review:");
  log(
    `  ln -s ${dir}/marina-metaculus.service ${dir}/marina-metaculus.timer ~/.config/systemd/user/`,
  );
  log("  systemctl --user daemon-reload && systemctl --user enable --now marina-metaculus.timer");
  return 0;
}

async function main(): Promise<number> {
  if (cmd === "timer") return timerCmd();
  const db = new MarinaDB(process.env.DB_PATH || "marina.db");
  const detach = attachWorldSpend(db);
  try {
    switch (cmd) {
      case "select":
        return await selectCmd(db);
      case "pass": {
        const code = await forecastCmd(db);
        if (!dryRun) await resolveCmd(db);
        return code;
      }
      case "forecast":
        return await forecastCmd(db);
      case "resolve":
        return await resolveCmd(db);
      case "status":
        return statusCmd(db);
      default:
        console.error(
          `unknown command ${cmd} (select | pass | forecast | resolve | status | timer)`,
        );
        return 2;
    }
  } finally {
    detach();
    db.close();
  }
}

process.exit(await main());
