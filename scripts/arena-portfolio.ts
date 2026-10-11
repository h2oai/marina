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
import {
  freezePortfolioResearch,
  validatePortfolioResearch,
} from "../src/arena/portfolio-research";
import { recordPortfolioShadow, scorePortfolioShadows } from "../src/arena/portfolio-shadow";
import { buildResearchBrief } from "../src/arena/research/briefs";
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
import { researchHypotheses } from "../src/research/hypotheses";
import { researchRetriever } from "../src/research/retriever";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    models: { type: "string" },
    plan: { type: "string", default: "parallel" },
    "plan-file": { type: "string" },
    "research-paths": { type: "string", default: "off" },
    "research-queries": { type: "string", default: "6" },
    "research-save": { type: "string" },
    "research-replay": { type: "string" },
    retriever: { type: "string", default: "search" },
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
      "bun run arena:portfolio <round_id|score> --db <shadow.db> --models <provider/model,...> [--plan control|parallel|layered|independent|auto] [--research-paths off|shared|independent] [--research-queries 6] [--research-save capture.json] [--research-replay capture.json] [--selector jev|decisions|none] [--plan-file plan.json] [--evidence evidence.json] [--max-calls 32] [--concurrency 4] [--timeout-ms 300000] [--max-tokens 2000] [--out report.json]",
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
    if (!["control", "parallel", "layered", "independent", "auto"].includes(values.plan))
      throw new Error("invalid --plan");
    if (!["off", "shared", "independent"].includes(values["research-paths"]))
      throw new Error("invalid --research-paths");
    if (
      (values["research-save"] || values["research-replay"]) &&
      values["research-paths"] === "off"
    )
      throw new Error("research capture/replay requires --research-paths shared|independent");
    if (
      values["research-paths"] !== "off" &&
      (values.plan !== "independent" || values["plan-file"])
    )
      throw new Error("research-path comparison requires --plan independent without a custom plan");
    const models = values.models?.split(",").map((s) => s.trim()) ?? [];
    const plans = Object.fromEntries(
      (["control", "parallel", "layered", "independent"] as const).map((kind) => [
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
    const replay = values["research-replay"]
      ? validatePortfolioResearch(
          await Bun.file(values["research-replay"]).json(),
          round,
          new Date().toISOString(),
        )
      : undefined;
    const lock =
      replay?.lock ?? (await lockForModels(data, round, await data.lock(round.round_id)));
    const audit = auditForecastInputs(round, lock);
    if (!audit.ok) throw new Error(`input audit failed: ${audit.issues.join("; ")}`);
    const start =
      replay?.start ??
      (await nowcastForecaster(data, forecastRound, {
        daily: 21,
        horizon: horizonOptionsFromEnv(process.env),
      })(round, lock));
    const lookup = withProvidedText(
      withDataLookups(retrieverFromSpec("closed-book", {}), arenaResearchLookups(process.env)),
      async () => undefined,
    );
    let dossier =
      values["research-paths"] === "off"
        ? await buildDossier(round, lock, start, lookup.retriever, lookup.pageText)
        : { since: "", verified: "", sources: 0, costUsd: 0 };
    let dossiersByStep: import("../src/arena/portfolio").PortfolioInputs["dossiersByStep"];
    let paths: Awaited<ReturnType<typeof researchHypotheses>> | undefined;
    if (values["research-paths"] !== "off") {
      const brief = buildResearchBrief(round, lock);
      const retriever = researchRetriever(
        retrieverFromSpec(
          values.retriever,
          {
            openrouter: process.env.OPENROUTER_API_KEY,
            tavily: process.env.TAVILY_API_KEY,
            exa: process.env.EXA_API_KEY,
          },
          { env: process.env },
        ),
        { ...process.env, MARINA_RESEARCH_EVIDENCE: "on", MARINA_RESEARCH_LOOP_ROUNDS: "1" },
      );
      paths =
        replay?.paths ??
        (await researchHypotheses(
          brief,
          retriever,
          new WorkBudget({ calls: 3, concurrency: 3, timeoutMs: Number(values["timeout-ms"]) }),
          Number(values["research-queries"]),
        ));
      if (values["research-save"]) {
        const captured = freezePortfolioResearch({
          round,
          lock,
          start,
          paths,
          capturedAt: new Date().toISOString(),
        });
        validatePortfolioResearch(captured, round, new Date().toISOString());
        await Bun.write(values["research-save"], `${JSON.stringify(captured, null, 2)}\n`);
      }
      const combine = async (ids: import("../src/research/hypotheses").ResearchHypothesis[]) => {
        const reports = ids.flatMap((id) => paths!.paths[id]?.report ?? []);
        return buildDossier(
          round,
          lock,
          start,
          async () => ({
            report: reports.map((r) => r.report).join("\n"),
            sources: reports.flatMap((r) => r.sources),
            costUsd: reports.reduce((sum, r) => sum + r.costUsd, 0),
            searches: reports.reduce((sum, r) => sum + r.searches, 0),
            retriever: "independent-hypotheses",
          }),
          async () => undefined,
        );
      };
      dossier = await combine(["measurement", "mechanism", "challenge"]);
      if (values["research-paths"] === "independent")
        dossiersByStep = {
          control: await combine(["measurement", "mechanism"]),
          complement: await combine(["challenge"]),
        };
    }
    const capturedAt = new Date().toISOString();
    const budget = new WorkBudget({
      calls: Number(values["max-calls"]),
      concurrency: Number(values.concurrency),
      timeoutMs: Number(values["timeout-ms"]),
    });
    if (paths && (!paths.complete || paths.budget.active > 0))
      budget.cancel(new Error("independent research incomplete; retained as failed experiment"));
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
      { round, lock, start, dossier, ...(dossiersByStep ? { dossiersByStep } : {}) },
      budget,
      backend.complete,
    );
    const costUsd =
      backend.usage.costUsd + (replay ? 0 : dossier.costUsd) + (selection?.decision?.costUsd ?? 0);
    const metadata = {
      ...(paths ? { researchAudit: paths } : {}),
      ...(replay ? { researchReplayed: replay.hash, originalResearchCostUsd: paths!.costUsd } : {}),
      capturedAt,
      completedAt: new Date().toISOString(),
      costUsd,
      costFinal: run.budget.active === 0,
      selection,
      settings: {
        researchPaths: values["research-paths"],
        researchQueries: Number(values["research-queries"]),
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
