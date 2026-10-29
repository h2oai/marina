#!/usr/bin/env bun

// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
/** Reopen a completed live-pilot report on a disposable, credential-free world.
 * Exercise the same saved attempts in browser, dashboard, chat, CLI and native TUI.
 * bun --no-env-file scripts/qualify-investigation-replay.ts /path/to/live/report.json
 * Requires dashboard:build and Chromium. Never modifies the source pilot database. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { MarinaDB } from "../src/persistence/database";
import { MarinaInvestigationClient } from "../src/sdk/investigation-client";
import { investigationPlainText } from "../src/sdk/investigation-text";
import type { InvestigationSnapshot } from "../src/sdk/investigation-types";
import { until } from "../test/helpers";
import { InvestigationScreen } from "../test/investigation-screen";
import { InvestigationTerminal } from "./inquiry-terminal";

const input = resolve(process.argv[2] ?? "");
const pilot = JSON.parse(readFileSync(input, "utf8")) as {
  passed: boolean;
  dbPath: string;
  cases: InvestigationSnapshot[];
};
assert(
  pilot.passed && pilot.cases.length === 2,
  "Replay requires a completed prediction/research pilot",
);
const directory = mkdtempSync(join(dirname(input), "replay-"));
const dbPath = join(directory, "world.db");
// SQLite's snapshot includes committed WAL pages; copying the main file alone may omit them.
const source = new Database(pilot.dbPath, { readonly: true });
try {
  writeFileSync(dbPath, source.serialize());
} finally {
  source.close();
}
mkdirSync(join(directory, "assets"));
// Reserve candidate ports through the OS, then let the app bind them.
const ports = Array.from({ length: 4 }, () =>
  Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }),
);
const [ws, mcp, log, telnet] = ports.map((server) => String(server.port));
for (const server of ports) await server.stop(true);
const url = `http://127.0.0.1:${ws}`;
const serverLog = openSync(join(directory, "server.log"), "w");
const server = Bun.spawn([process.execPath, "--no-env-file", "src/main.ts"], {
  cwd: resolve(import.meta.dir, ".."),
  env: {
    PATH: process.env.PATH,
    DB_PATH: dbPath,
    ASSETS_DIR: join(directory, "assets"),
    WS_PORT: ws,
    MCP_PORT: mcp,
    LOG_PORT: log,
    TELNET_PORT: telnet,
    MARINA_ENDPOINTS: "none",
    MARINA_WORLD: "default",
    MARINA_OPEN_API: "true",
    AGENT_AUTORESPAWN: "false",
  },
  stdout: serverLog,
  stderr: serverLog,
});
const evidence: Record<string, unknown> = {
  source: input,
  directory,
  providerCredentials: false,
  cases: [],
};
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await until(
    async () => {
      if (server.exitCode !== null)
        throw new Error(`Replay server exited ${server.exitCode}; see ${directory}/server.log`);
      try {
        return (await fetch(`${url}/predict`)).ok;
      } catch {
        return false;
      } // allow-empty-catch: readiness polling retries until the server binds
    },
    { timeoutMs: 30_000 },
  );
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/chromium",
    args: ["--no-sandbox"],
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const errors: string[] = [];
  let starts = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/investigations")
      starts++;
  });
  await page.goto(`${url}/predict`);
  await page.getByPlaceholder("Enter your name...").fill("InvestigationPilot");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("heading", { name: "A clearer view of what comes next." }).waitFor();
  let token = await page.evaluate(() => localStorage.getItem("marina_chat_token"));
  assert(token);
  const client = new MarinaInvestigationClient({ url, token: () => token! });
  for (const snapshot of pilot.cases) {
    const route = snapshot.case.kind === "prediction" ? "predict" : "research";
    await page.goto(`${url}/${route}/${snapshot.case.id}`);
    await page.getByRole("tab", { name: "Why", exact: true }).waitFor();
    token = await page.evaluate(() => localStorage.getItem("marina_chat_token"));
    const restored = await client.get(snapshot.case.id);
    assert.deepEqual(restored, snapshot);
    const result = snapshot.attempt.result!;
    // Check answer, timeframe/limits and citation reachability without initiating work.
    // biome-ignore lint/performance/useDomNodeTextContent: the text a reader sees
    assert((await page.locator("body").innerText()).includes(result.summary));
    await page.getByRole("tab", { name: "Sources", exact: true }).click();
    await page.locator(`a[href="${result.sources[0]!.url}"]`).first().waitFor();
    await page.getByRole("tab", { name: "Why", exact: true }).click();
    await page.reload();
    await page.getByRole("tab", { name: "Why", exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: join(directory, `${route}-mobile.png`), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("link", { name: "Open as a dashboard panel" }).click();
    await page
      .getByRole("heading", { name: /Prediction & research/ })
      .first()
      .waitFor();
    const dismiss = page.getByRole("button", { name: "Dismiss getting-started guide" });
    if (await dismiss.isVisible()) await dismiss.click();
    await page.locator("#marina-command-input").fill(`inquiry show ${snapshot.case.id}`);
    await page.locator("#marina-command-input").press("Enter");
    const rich = page.getByRole("button", { name: "Rich view" });
    if (await rich.isVisible()) await rich.click();
    await page.getByRole("region", { name: "Private investigation card" }).last().waitFor();
    await page.screenshot({ path: join(directory, `${route}-dashboard.png`), fullPage: true });
    token = await page.evaluate(() => localStorage.getItem("marina_chat_token"));
    assert(token);
    const cli: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "scripts/marina.ts",
        "inquiry",
        "show",
        snapshot.case.id,
        "--url",
        url,
        "--json",
      ],
      {
        cwd: resolve(import.meta.dir, ".."),
        env: { PATH: process.env.PATH, MARINA_TOKEN: token, NO_COLOR: "1" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [output, error, code] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ]);
    assert.equal(code, 0, error);
    assert.deepEqual(JSON.parse(output), snapshot);
    const screen = new InvestigationScreen();
    const terminal = new InvestigationTerminal(client, url, screen);
    try {
      await terminal.start(undefined, undefined, snapshot.case.id);
      await terminal.command("/sources");
      await until(() => investigationPlainText(screen.output).includes(result.sources[0]!.url!));
      screen.columns = 34;
      screen.rows = 15;
      screen.resize();
      await terminal.command("/why");
      writeFileSync(
        join(directory, `${route}-terminal.txt`),
        investigationPlainText(screen.output),
      );
    } finally {
      terminal.close();
    }
    (evidence.cases as unknown[]).push({
      caseId: snapshot.case.id,
      attemptId: snapshot.attempt.id,
      surfaces: ["web", "dashboard", "private chat", "CLI JSON", "native TUI"],
      exactRevisionAndCitations: true,
      narrowScreen: true,
    });
  }
  assert.equal(starts, 0);
  assert.deepEqual(errors, []);
  const before = new MarinaDB(pilot.dbPath);
  const after = new MarinaDB(dbPath);
  try {
    for (const table of [
      "investigation_admissions",
      "investigation_attempts",
      "forecast_answers",
      "spend_daily",
    ]) {
      assert.deepEqual(
        after.memoryRepository().raw.query(`SELECT * FROM ${table}`).all(),
        before.memoryRepository().raw.query(`SELECT * FROM ${table}`).all(),
        `${table} changed while replaying`,
      );
    }
  } finally {
    before.close();
    after.close();
  }
  evidence.passed = true;
  evidence.newAdmissions = 0;
  evidence.newProviderSpend = 0;
} catch (error) {
  evidence.passed = false;
  evidence.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await server.exited;
  writeFileSync(join(directory, "report.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    JSON.stringify({
      passed: evidence.passed,
      report: join(directory, "report.json"),
      error: evidence.error,
    }),
  );
}
