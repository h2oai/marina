#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Explicit shadow experiment. No signing, submission, route writes or timers. */
import { parseArgs } from "node:util";
import { forecastRound } from "../src/arena/forecast";
import { forecastSettings } from "../src/arena/forecast-config";
import { buildDossier } from "../src/arena/formations";
import { auditForecastInputs } from "../src/arena/input-audit";
import {
  type ArenaPlan,
  arenaPortfolioPlan,
  portfolioHash,
  portfolioModels,
  runArenaPortfolio,
  validateArenaPlan,
} from "../src/arena/portfolio";
import { recordPortfolioShadow, scorePortfolioShadows } from "../src/arena/portfolio-shadow";
import { horizonOptionsFromEnv } from "../src/arena/research/civiqs-horizon";
import { nowcastForecaster } from "../src/arena/research/civiqs-nowcast";
import { arenaResearchLookups, withDataLookups } from "../src/arena/research/data-evidence";
import { retrieverFromSpec, withProvidedText } from "../src/arena/research/retrieve";
import { arenaData, lockForModels } from "../src/arena/service";
import { parseRouteEvidence, selectTaskRoute } from "../src/coordination/task-routing";
import { WorkBudget } from "../src/coordination/work-budget";
import { researchJudge } from "../src/decisions/config";
import { attachCliSpendLedger } from "../src/engine/cli-spend-ledger";
import { getErrorMessage } from "../src/engine/errors";
import { MarinaDB } from "../src/persistence/database";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    models: { type: "string" },
    plan: { type: "string", default: "parallel" },
    "plan-file": { type: "string" },
    selector: { type: "string", default: "none" },
    evidence: { type: "string" },
    "max-calls": { type: "string", default: "32" },
    concurrency: { type: "string", default: "4" },
    "timeout-ms": { type: "string", default: "300000" },
    "max-tokens": { type: "string", default: "2000" },
    db: { type: "string" },
    out: { type: "string" },
    help: { type: "boolean" },
  },
});

async function main() {
  if (values.help || !positionals[0]) {
    console.log(
      "bun run arena:portfolio <round_id|score> --db <shadow.db> --models <provider/model,...> [--plan control|parallel|layered|auto] [--selector jev|decisions|none] [--plan-file plan.json] [--evidence evidence.json] [--max-calls 32] [--concurrency 4] [--timeout-ms 300000] [--max-tokens 2000] [--out report.json]",
    );
    return;
  }
  if (!values.db) throw new Error("--db is required: choose an explicit shadow ledger");
  // Spend counts against the WORLD's daily cap (DB_PATH), not the shadow ledger.
  attachCliSpendLedger("bun run arena:portfolio");
  const data = arenaData().frozen();
  const db = new MarinaDB(values.db);
  try {
    if (positionals[0] === "score")
      return await scorePortfolioShadows(
        data,
        db.listArenaShadow({ forecaster: "portfolio-v1", limit: 2000 }),
      );
    if (!["none", "jev", "decisions"].includes(values.selector))
      throw new Error("invalid --selector");
    if (!["control", "parallel", "layered", "auto"].includes(values.plan))
      throw new Error("invalid --plan");
    const models = values.models?.split(",").map((s) => s.trim()) ?? [];
    const plans = Object.fromEntries(
      (["control", "parallel", "layered"] as const).map((kind) => [
        kind,
        arenaPortfolioPlan(kind, models),
      ]),
    );
    const custom = values["plan-file"]
      ? ((await Bun.file(values["plan-file"]).json()) as ArenaPlan)
      : undefined;
    for (const plan of custom ? [custom] : Object.values(plans)) validateArenaPlan(plan);
    const imported = values.evidence ? await Bun.file(values.evidence).json() : [];
    const evidence = parseRouteEvidence(imported.evidence ?? imported);
    if (values.plan === "auto") {
      const local = await scorePortfolioShadows(
        data,
        db.listArenaShadow({ forecaster: "portfolio-v1", limit: 2000 }),
      );
      for (const e of local.evidence) if (!evidence.some((r) => r.id === e.id)) evidence.push(e);
    }
    const round = await data.round(positionals[0]!);
    if (!round) throw new Error("unknown round");
    if (round.target_type === "ranking_list")
      throw new Error("ranking formations are not supported");
    if (Date.now() >= Date.parse(round.lock_at) - 300_000)
      throw new Error("less than five minutes before lock");
    const lock = await lockForModels(data, round, await data.lock(round.round_id));
    const audit = auditForecastInputs(round, lock);
    if (!audit.ok) throw new Error(`input audit failed: ${audit.issues.join("; ")}`);
    const start = await nowcastForecaster(data, forecastRound, {
      daily: 21,
      horizon: horizonOptionsFromEnv(process.env),
    })(round, lock);
    const lookup = withProvidedText(
      withDataLookups(retrieverFromSpec("closed-book", {}), arenaResearchLookups(process.env)),
      async () => undefined,
    );
    const dossier = await buildDossier(round, lock, start, lookup.retriever, lookup.pageText);
    const capturedAt = new Date().toISOString();
    const budget = new WorkBudget({
      calls: Number(values["max-calls"]),
      concurrency: Number(values.concurrency),
      timeoutMs: Number(values["timeout-ms"]),
    });
    const backend = await portfolioModels(process.env, Number(values["max-tokens"]));
    const selector =
      values.plan === "auto"
        ? researchJudge(values.selector, process.env, process.env.OPENROUTER_API_KEY)
        : undefined;
    if (values.plan === "auto" && values.selector !== "none" && !selector)
      throw new Error("requested selector unavailable");
    let selection: Awaited<ReturnType<typeof selectTaskRoute>> | undefined;
    try {
      selection =
        values.plan === "auto" && !custom
          ? await selectTaskRoute(
              {
                benchmark: "social-simulation-arena",
                item: round.round_id,
                skills: ["forecasting", "uncertainty", "evidence-verification"],
                asOf: capturedAt,
                features: {
                  tracker: round.tracker,
                  shape: round.target_type,
                  question: round.question,
                  horizonDays: (Date.parse(round.release_at) - Date.parse(capturedAt)) / 86400000,
                  historyPoints: (lock.answer_history ?? lock.history ?? []).length,
                  verifiedSources: dossier.sources,
                },
              },
              Object.entries(plans).map(([id, plan]) => ({
                id,
                fingerprint: portfolioHash(plan),
                strategy: plan.score.id,
                description:
                  id === "control"
                    ? "Delphi control; smallest cost"
                    : id === "parallel"
                      ? "Delphi and symbiosis in parallel, then uncertainty-preserving mixture"
                      : "Parallel mixture followed by a verification formation; highest cost",
              })),
              "control",
              evidence,
              selector
                ? {
                    ...selector,
                    ask: (request, signal) => budget.run((s) => selector.ask(request, s), signal),
                  }
                : undefined,
              budget.signal,
            )
          : undefined;
    } catch (error) {
      // Retain an interrupted selection as a failed attempt in the same ledger.
      // The cancelled budget prevents the control placeholder from making calls.
      budget.cancel(error);
      selection = { selected: "control", reason: getErrorMessage(error), priors: [] };
    }
    const plan = custom ?? plans[selection?.selected ?? values.plan]!;
    const run = await runArenaPortfolio(
      plan,
      { round, lock, start, dossier },
      budget,
      backend.complete,
    );
    const costUsd = backend.usage.costUsd + dossier.costUsd + (selection?.decision?.costUsd ?? 0);
    const metadata = {
      capturedAt,
      completedAt: new Date().toISOString(),
      costUsd,
      costFinal: run.budget.active === 0,
      selection,
      settings: {
        ...forecastSettings(`portfolio:${run.planHash}`, {
          ...process.env,
          MARINA_ARENA_CIVIQS_LIVE: "off",
        }),
        maxTokens: Number(values["max-tokens"]),
        selector: values.selector,
        evidenceHash: portfolioHash(evidence),
        liveCiviqs: false,
        limits: budget.limits,
      },
    };
    const saved = recordPortfolioShadow(db, run, metadata);
    if (!run.complete) process.exitCode = 1;
    return { ...run, ...metadata, ...saved, usage: backend.usage };
  } finally {
    db.close();
  }
}

try {
  const report = await main();
  if (report) {
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (values.out) await Bun.write(values.out, output);
    console.log(output);
  }
} catch (error) {
  console.error(getErrorMessage(error));
  process.exitCode = 1;
}
