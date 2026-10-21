#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Explicitly opt-in, bounded pilot using the production executor and HTTP/SDK/CLI paths.
 * Dry run prints the concrete plan; --live permits paid work. Never opens an existing DB.
 * bun scripts/qualify-investigations-live.ts --model openai/MODEL --budget-usd 2 [--live]
 * Reports and captured evidence are kept outside this repository. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const value = (key: string) => args[args.indexOf(key) + 1];
const model = args.includes("--model") ? value("--model") : undefined;
const budgetUsd = args.includes("--budget-usd") ? Number(value("--budget-usd")) : Number.NaN;
const retriever = args.includes("--retriever") ? value("--retriever")! : "tavily:basic";
if (
  !/^(tavily:(basic|advanced)|search:openrouter|openrouter-web:[a-zA-Z0-9._/-]+@(exa|native)|sonar:[a-zA-Z0-9._/-]+)$/.test(
    retriever,
  )
) {
  throw new Error("Use one explicit Tavily, OpenRouter web or Sonar retriever for the pilot");
}
if (
  !model ||
  !/^[a-z0-9-]+\/[a-zA-Z0-9._/-]+$/.test(model) ||
  !Number.isFinite(budgetUsd) ||
  budgetUsd <= 0 ||
  budgetUsd > 10
) {
  throw new Error(
    "Provide --model provider/model and --budget-usd greater than 0 and at most 10; --live explicitly permits paid calls.",
  );
}
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const plan = {
  model,
  retriever,
  spendTargetUsd: budgetUsd,
  billing:
    "Best-effort admission limit, not a hard provider billing cap; cancellation may incur late charges",
  runs: [
    {
      kind: "prediction" as const,
      question: `Will NASA publish an Astronomy Picture of the Day entry dated ${tomorrow}?`,
      horizon: `${tomorrow}T23:59:59Z`,
      calls: 12,
    },
    {
      kind: "research" as const,
      question:
        "In one concise section, explain what NASA's Astronomy Picture of the Day archive contains and how its entries are dated. Use official NASA sources.",
      calls: 24,
    },
  ],
  cancellation:
    "One additional prediction, cancelled after its first live stage begins; drain late settlement before closing",
  isolation: "Fresh temporary database and loopback-only HTTP server; existing worlds unchanged",
  reads:
    "SDK, CLI JSON/text and private world chat, then database reopen; reads must not admit work or change spend",
};
if (!args.includes("--live")) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}
if (retriever.startsWith("tavily:") && !process.env.TAVILY_API_KEY?.trim())
  throw new Error("TAVILY_API_KEY is required for this pilot");
if (!retriever.startsWith("tavily:") && !process.env.OPENROUTER_API_KEY?.trim())
  throw new Error("OPENROUTER_API_KEY is required for this pilot");

// This is a dedicated qualification process: do not inherit a local world's routing,
// autonomous research loops or budget overrides. Report the exact configuration used.
for (const key of Object.keys(process.env)) {
  if (/^MARINA_(FORECAST_|RESEARCH_|READ_SWARM_|DECISION|SPEND_|DAILY_SPEND)/.test(key))
    delete process.env[key];
}
Object.assign(process.env, {
  MARINA_FORECAST_ANALYSTS: model,
  MARINA_FORECAST_PLANNER: model,
  MARINA_FORECAST_RETRIEVER: plan.retriever,
  MARINA_FORECAST_JUDGE: "none",
  MARINA_FORECAST_RUNS: "1",
  MARINA_FORECAST_RESEARCH_ROUNDS: "1",
  MARINA_FORECAST_CRITIQUE: "off",
  MARINA_FORECAST_VERIFY: "off",
  MARINA_FORECAST_FOLLOWUP: "off",
  MARINA_FORECAST_LOOKUPS: "none",
  MARINA_FORECAST_FEATURES: "off",
  MARINA_FORECAST_ROUTE: "off",
  MARINA_RESEARCH_EVIDENCE: "off",
  MARINA_RESEARCH_LOOP_ROUNDS: "1",
  MARINA_RESEARCH_TARGET_EVIDENCE: "off",
  MARINA_RESEARCH_ADVICE: "off",
  MARINA_RESEARCH_MAX_PAGES: "6",
  MARINA_DECISIONS: "off",
  MARINA_DECISION_GATE: "off",
  MARINA_LESSONS: "off",
  MARINA_OPEN_API: "false",
  MARINA_DAILY_SPEND_CAP_USD: String(budgetUsd),
});
const directory = resolve(
  args.includes("--directory") ? value("--directory")! : "/tmp/marina-investigation-live",
);
mkdirSync(directory, { recursive: true });
const runDirectory = mkdtempSync(join(directory, "run-"));
const dbPath = join(runDirectory, "world.db");
const { Engine } = await import("../src/engine/engine");
const { attachDbSpendLedger, spentTodayUsd } = await import("../src/engine/spend-ledger");
const { investigationService } = await import("../src/investigations/service");
const { handleDashboardApi } = await import("../src/net/dashboard-api");
const { MarinaDB } = await import("../src/persistence/database");
const { MarinaInvestigationClient } = await import("../src/sdk/investigation-client");
const { roomId } = await import("../src/types");
const { MockConnection, makeTestRoom, until } = await import("../test/helpers");
const { InvestigationTerminal } = await import("./inquiry-terminal");
const { InvestigationScreen } = await import("../test/investigation-screen");
const { investigationPlainText } = await import("../src/sdk/investigation-text");
const db = new MarinaDB(dbPath);
const engine = new Engine({ db, startRoom: roomId("pilot/start"), tickInterval: 60_000 });
engine.registerRoom(roomId("pilot/start"), makeTestRoom());
const connection = new MockConnection("pilot-connection");
engine.addConnection(connection);
const login = engine.login(connection.id, "InvestigationPilot");
if ("error" in login) throw new Error(login.error);
const token = login.token;
const detachSpend = attachDbSpendLedger(db);
const service = investigationService(db);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    return (
      (await handleDashboardApi(request, new URL(request.url), request.method, engine, db)) ??
      new Response("Not found", { status: 404 })
    );
  },
});
const url = `http://127.0.0.1:${server.port}`;
const client = new MarinaInvestigationClient({ url, token });
const intruder = new MarinaInvestigationClient({ url, token: "invalid-pilot-session" });
const report: Record<string, unknown> = {
  at: new Date().toISOString(),
  plan,
  runDirectory,
  dbPath,
  cases: [],
};
const ids: string[] = [];

async function cli(action: string, caseId: string, json = true) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "scripts/marina.ts",
      "inquiry",
      action,
      caseId,
      "--url",
      url,
      ...(json ? ["--json"] : []),
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      env: { PATH: process.env.PATH, MARINA_TOKEN: token, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, `CLI ${action} failed: ${stderr}`);
  return json ? JSON.parse(stdout) : stdout;
}

try {
  for (const entry of plan.runs) {
    console.log(`Starting ${entry.kind} pilot`);
    const request = {
      kind: entry.kind,
      question: entry.question,
      ...(entry.horizon ? { horizon: entry.horizon } : {}),
      runs: 1,
      limits: { calls: entry.calls, concurrency: 1, timeoutMs: 600_000 },
    };
    const admitted = await client.start(request, `pilot-${entry.kind}`);
    ids.push(admitted.attempt.id);
    await service.wait(admitted.attempt.id);
    const snapshot = await client.get(admitted.attempt.caseId);
    (report.cases as unknown[]).push(snapshot);
    writeFileSync(
      join(runDirectory, `${entry.kind}.json`),
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
    console.log(
      JSON.stringify({
        kind: entry.kind,
        state: snapshot.attempt.state,
        availability: snapshot.attempt.result?.availability,
        knownUsd: snapshot.attempt.accounting.knownUsd,
        spentUsd: spentTodayUsd(),
      }),
    );
    assert.equal(snapshot.attempt.state, "completed", snapshot.attempt.error ?? "Pilot failed");
    assert(
      snapshot.attempt.result && snapshot.attempt.result.availability !== "none",
      "Pilot produced no usable answer",
    );
    assert(snapshot.attempt.result.sources.length > 0, "Pilot did not capture citations");
    const spentBefore = spentTodayUsd();
    assert.equal((await client.start(request, `pilot-${entry.kind}`)).created, false);
    assert.deepEqual(await cli("show", snapshot.case.id), snapshot);
    const sources = await cli("sources", snapshot.case.id, false);
    assert(sources.includes(snapshot.attempt.result.sources[0]!.url!));
    const screen = new InvestigationScreen();
    const terminal = new InvestigationTerminal(client, url, screen);
    try {
      await terminal.start(undefined, undefined, snapshot.case.id);
      await terminal.command("/sources");
      await until(() =>
        investigationPlainText(screen.output).includes(snapshot.attempt.result!.sources[0]!.url!),
      );
      screen.columns = 34;
      screen.rows = 15;
      screen.resize();
      await terminal.command("/why");
      writeFileSync(
        join(runDirectory, `${entry.kind}-terminal.txt`),
        investigationPlainText(screen.output),
      );
    } finally {
      terminal.close();
    }
    connection.clear();
    await engine.dispatchCommand(login.entityId, `inquiry show ${snapshot.case.id}`);
    assert(
      connection.messages.some((message) => {
        const ref = message.data?.investigation as { attemptId?: string } | undefined;
        return ref?.attemptId === snapshot.attempt.id;
      }),
      "Private chat did not reference the same saved attempt",
    );
    await assert.rejects(intruder.get(snapshot.case.id));
    const page = await client.events(snapshot.attempt.id);
    assert(page.events.some((event) => event.kind === "stage_completed" && event.actor === model));
    const captured = page.events.find((event) => event.outputId)?.outputId;
    assert(captured);
    await client.content(captured);
    assert.equal(spentTodayUsd(), spentBefore, "Reading/replaying changed the spend ledger");
  }
  console.log("Starting cancellation pilot");
  const cancelled = (
    await client.start(
      {
        kind: "prediction",
        question: plan.runs[0]!.question,
        runs: 1,
        limits: { calls: 4, concurrency: 1, timeoutMs: 600_000 },
      },
      "pilot-cancel",
    )
  ).attempt;
  ids.push(cancelled.id);
  await until(
    () => db.getInvestigationAttempt(cancelled.actor.key, cancelled.id).accounting.outstanding > 0,
    { timeoutMs: 30_000 },
  );
  const stopAt = performance.now();
  await client.cancel(cancelled.id);
  await service.wait(cancelled.id);
  const detachedMs = performance.now() - stopAt;
  assert(detachedMs < 5000, "Cancellation did not detach promptly");
  await until(
    () =>
      db.getInvestigationAttempt(cancelled.actor.key, cancelled.id).accounting.outstanding === 0,
    { timeoutMs: 210_000, intervalMs: 200 },
  );
  const final = await client.attempt(cancelled.id);
  assert.equal(final.state, "cancelled");
  assert.equal(final.result, undefined);
  report.cancellation = { detachedMs, final };
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  for (const id of ids) {
    const attempt = await client.attempt(id);
    if (["running", "queued"].includes(attempt.state)) await client.cancel(id);
    await service.wait(id);
  }
  report.knownSpendUsd = spentTodayUsd();
  report.accountingComplete = false;
  await server.stop(true);
  service.close();
  await engine.shutdown();
  detachSpend();
  db.close();
  const reopened = new MarinaDB(dbPath);
  try {
    report.reopen = (
      report.cases as Array<{
        case: { id: string; owner: { key: string } };
        attempt: { id: string };
      }>
    ).map((snapshot) => {
      const restored = reopened.getInvestigation(snapshot.case.owner.key, snapshot.case.id);
      assert.equal(restored.attempt.id, snapshot.attempt.id);
      assert.deepEqual(restored, snapshot);
      return { caseId: snapshot.case.id, attemptId: restored.attempt.id, persisted: true };
    });
  } finally {
    reopened.close();
  }
  const path = join(runDirectory, "report.json");
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      passed: report.passed,
      knownSpendUsd: report.knownSpendUsd,
      report: path,
      error: report.error,
    }),
  );
}
