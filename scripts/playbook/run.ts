#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `bun run playbook` — run Marina's use cases (scripts/playbook/catalog.ts)
 * against a real, isolated server and say, per step, whether it held, how long
 * it took and what it cost. The model-free slice also runs in-process on every
 * test run (test/playbook.test.ts); this runner adds the steps that need a
 * model, the network or a long wait.
 *
 *   bun run playbook --env-file ~/.marina/.env                 # model + network use cases
 *   bun run playbook --env-file keys.env --only forecast,research
 *   bun run playbook --env-file keys.env --long                # + long runs (schedules, teams)
 *   bun run playbook --free                                    # model-free + network, no keys needed
 *
 * Each world gets its own server: a fresh database under the output folder,
 * the `local` trust profile, its own port, a daily spend cap (`--cap`, default
 * $10) and no room agents. The server reads only the env file you name, never
 * the checkout `.env`. Results go to `--out` (default
 * ~/.marina/playbook/<timestamp>/): report.json and report.md. Nothing is
 * written into the repository. Exit 1 when any step fails.
 *
 * A step's cost is the world's spend while it ran (background agents count).
 */

import { Database } from "bun:sqlite";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CommandError, MarinaClient, type Perception } from "../../src/sdk/client";
import { PLAYBOOK, type PlaybookNeed, type PlaybookStep, type PlaybookUseCase } from "./catalog";
import { judgeStep, type StepOutcome, stepCommand, stripAnsi } from "./step";

const ROOT = resolve(import.meta.dir, "../..");

interface Options {
  envFile?: string;
  only?: Set<string>;
  allow: Set<PlaybookNeed>;
  out: string;
  port: number;
  cap: number;
}

interface StepRecord {
  command: string;
  ok: boolean;
  seconds: number;
  usd: number;
  problems: string[];
  excerpt: string;
}

interface UseCaseRecord {
  id: string;
  title: string;
  world: string;
  status: "passed" | "failed" | "skipped";
  reason?: string;
  seconds: number;
  usd: number;
  steps: StepRecord[];
}

function usage(): never {
  console.log(`Usage: bun run playbook [--env-file <path>] [--only a,b] [--long] [--free]
                         [--out <dir>] [--port <n>] [--cap <usd>]

  --env-file <path>  provider keys for the servers (required unless --free)
  --only a,b         run only these use cases (ids in scripts/playbook/catalog.ts)
  --long             include long runs (scheduled briefings, model comparison, analyst teams)
  --free             only steps that need no model (network allowed)
  --out <dir>        report folder (default ~/.marina/playbook/<timestamp>)
  --port <n>         first server port (default 3460; each world takes the next +3)
  --cap <usd>        each server's daily spend cap (default 10)`);
  process.exit(0);
}

function parseArgs(argv: string[]): Options {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes("-h") || argv.includes("--help")) usage();
  const free = argv.includes("--free");
  const allow = new Set<PlaybookNeed>(["network", "world"]);
  if (!free) allow.add("model");
  if (argv.includes("--long")) allow.add("long");
  const envFile = value("--env-file");
  if (!free && !envFile) {
    console.error("playbook: --env-file <path> names the provider keys (or run --free).");
    process.exit(2);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    ...(envFile ? { envFile: resolve(envFile) } : {}),
    ...(value("--only") ? { only: new Set(value("--only")!.split(",")) } : {}),
    allow,
    out: resolve(value("--out") ?? join(homedir(), ".marina", "playbook", stamp)),
    port: Number(value("--port") ?? 3460),
    cap: Number(value("--cap") ?? 10),
  };
}

// ─── An isolated server per world ───────────────────────────────────────────

interface Server {
  port: number;
  dbPath: string;
  child: ChildProcess;
}

async function startServer(
  world: string,
  port: number,
  dir: string,
  opts: Options,
  env: Record<string, string>,
): Promise<Server> {
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "marina.db");
  const childEnv: Record<string, string> = {
    HOME: process.env.HOME ?? homedir(),
    PATH: process.env.PATH ?? "",
    WS_PORT: String(port),
    TELNET_PORT: "0",
    DB_PATH: dbPath,
    MARINA_DATA_DIR: join(dir, "data"),
    MARINA_PROFILE: "local",
    MARINA_ROOM_AGENTS: "false",
    AGENT_AUTORESPAWN: "false",
    MARINA_DAILY_SPEND_CAP_USD: String(opts.cap),
    ...(world === "default" ? {} : { MARINA_WORLD: world }),
    ...env,
  };
  const envArg = opts.envFile ? `--env-file=${opts.envFile}` : "--no-env-file";
  const log = Bun.file(join(dir, "server.log")).writer();
  const child = spawn(process.execPath, [envArg, "run", "src/main.ts"], {
    cwd: ROOT,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => log.write(d));
  child.stderr?.on("data", (d) => log.write(d));
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`server for ${world} exited; see ${dir}/server.log`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return { port, dbPath, child };
    } catch {
      // allow-empty-catch: not listening yet
    }
    await Bun.sleep(500);
  }
  child.kill("SIGTERM");
  throw new Error(`server for ${world} did not answer /health in 90 s; see ${dir}/server.log`);
}

async function stopServer(server: Server): Promise<void> {
  server.child.kill("SIGTERM");
  const deadline = Date.now() + 60_000;
  while (server.child.exitCode === null && Date.now() < deadline) await Bun.sleep(250);
  if (server.child.exitCode === null) server.child.kill("SIGKILL");
}

/** The world's total spend today, from its own ledger (0 before the table exists). */
function spentUsd(dbPath: string): number {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const day = new Date().toISOString().slice(0, 10);
      const row = db
        .query("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM spend_daily WHERE day = ?")
        .get(day) as { usd: number } | null;
      return row?.usd ?? 0;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

// ─── Running a use case ─────────────────────────────────────────────────────

function textOf(perceptions: Perception[]): string {
  return stripAnsi(
    perceptions
      .map((p) => p.data?.text ?? p.data?.message)
      .filter((t): t is string => typeof t === "string")
      .join("\n"),
  );
}

async function runCommand(
  client: MarinaClient,
  command: string,
  timeoutMs: number,
): Promise<StepOutcome> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return { ok: true, text: textOf(await client.command(command, signal)) };
  } catch (error) {
    if (error instanceof CommandError)
      return { ok: false, text: textOf(error.perceptions), error: error.message };
    return { ok: false, text: "", error: (error as Error).message };
  }
}

async function runStep(
  client: MarinaClient,
  step: PlaybookStep,
  command: string,
  dbPath: string,
): Promise<StepRecord> {
  const t0 = Date.now();
  const usd0 = spentUsd(dbPath);
  const limitMs = ((step.untilSeconds ?? 0) + (step.maxSeconds ?? 600) + 60) * 1000;
  let outcome = await runCommand(client, command, limitMs);
  let problems = judgeStep(step, outcome);
  if (step.untilSeconds) {
    const until = t0 + step.untilSeconds * 1000;
    while (problems.length > 0 && Date.now() < until) {
      await Bun.sleep((step.everySeconds ?? 15) * 1000);
      outcome = await runCommand(client, command, 120_000);
      problems = judgeStep(step, outcome);
    }
  }
  const seconds = (Date.now() - t0) / 1000;
  const usd = Math.max(0, spentUsd(dbPath) - usd0);
  const budgetSeconds = (step.maxSeconds ?? Number.POSITIVE_INFINITY) + (step.untilSeconds ?? 0);
  if (seconds > budgetSeconds)
    problems.push(`took ${seconds.toFixed(0)} s, over its ${budgetSeconds} s ceiling`);
  if (step.maxUsd !== undefined && usd > step.maxUsd)
    problems.push(`cost $${usd.toFixed(3)}, over its $${step.maxUsd} ceiling`);
  return {
    command,
    ok: problems.length === 0,
    seconds,
    usd,
    problems,
    excerpt: outcome.text.slice(0, 600),
  };
}

async function runUseCase(
  useCase: PlaybookUseCase,
  server: Server,
  dir: string,
): Promise<UseCaseRecord> {
  const t0 = Date.now();
  const usd0 = spentUsd(server.dbPath);
  for (const [name, content] of Object.entries(useCase.files ?? {}))
    writeFileSync(join(dir, name), content);
  const clients = new Map<string, MarinaClient>();
  const clientFor = async (name: string) => {
    let client = clients.get(name);
    if (!client) {
      client = new MarinaClient(`ws://127.0.0.1:${server.port}`, {
        principal: "person",
        autoReconnect: false,
        commandTimeout: 60 * 60_000,
      });
      await client.connect(name);
      clients.set(name, client);
    }
    return client;
  };
  const person = `pb_${useCase.id.replace(/[^a-z0-9]/gi, "").slice(0, 17)}`;
  const steps: StepRecord[] = [];
  try {
    for (const step of useCase.steps) {
      const client = await clientFor(step.as ?? person);
      const record = await runStep(client, step, stepCommand(step, dir), server.dbPath);
      steps.push(record);
      const mark = record.ok ? "ok  " : "FAIL";
      console.log(
        `  ${mark} ${record.seconds.toFixed(1).padStart(6)} s  $${record.usd.toFixed(3)}  ${record.command.slice(0, 90)}`,
      );
      for (const p of record.problems) console.log(`         ${p}`);
    }
  } catch (error) {
    steps.push({
      command: "(connect)",
      ok: false,
      seconds: 0,
      usd: 0,
      problems: [(error as Error).message],
      excerpt: "",
    });
  } finally {
    for (const client of clients.values()) client.disconnect();
  }
  return {
    id: useCase.id,
    title: useCase.title,
    world: useCase.world ?? "default",
    status: steps.every((s) => s.ok) ? "passed" : "failed",
    seconds: (Date.now() - t0) / 1000,
    usd: Math.max(0, spentUsd(server.dbPath) - usd0),
    steps,
  };
}

// ─── Report ─────────────────────────────────────────────────────────────────

function markdown(records: UseCaseRecord[], startedAt: string): string {
  const passed = records.filter((r) => r.status === "passed").length;
  const run = records.filter((r) => r.status !== "skipped").length;
  const lines = [
    `# Playbook run ${startedAt}`,
    "",
    `${passed} of ${run} use cases passed.`,
    "",
    "| Use case | World | Status | Time (s) | Cost (USD) |",
    "| --- | --- | --- | --- | --- |",
    ...records.map(
      (r) =>
        `| ${r.title} (\`${r.id}\`) | ${r.world} | ${r.status}${r.reason ? `: ${r.reason}` : ""} | ${r.seconds.toFixed(0)} | ${r.usd.toFixed(3)} |`,
    ),
  ];
  for (const r of records.filter((x) => x.status === "failed")) {
    lines.push("", `## ${r.title} — failed`, "");
    for (const s of r.steps.filter((x) => !x.ok))
      lines.push(`- \`${s.command}\`: ${s.problems.join("; ")}`);
  }
  return `${lines.join("\n")}\n`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  mkdirSync(opts.out, { recursive: true });
  const records: UseCaseRecord[] = [];
  const chosen = PLAYBOOK.filter((u) => !opts.only || opts.only.has(u.id));
  const runnable = (u: PlaybookUseCase) => u.needs.every((n) => opts.allow.has(n));
  for (const u of chosen.filter((x) => !runnable(x)))
    records.push({
      id: u.id,
      title: u.title,
      world: u.world ?? "default",
      status: "skipped",
      reason: `needs ${u.needs.filter((n) => !opts.allow.has(n)).join(", ")}`,
      seconds: 0,
      usd: 0,
      steps: [],
    });

  // One server per (world, env) group, run one after another.
  const groups = new Map<string, PlaybookUseCase[]>();
  for (const u of chosen.filter(runnable)) {
    const key = `${u.world ?? "default"}|${JSON.stringify(u.env ?? {})}`;
    groups.set(key, [...(groups.get(key) ?? []), u]);
  }
  let port = opts.port;
  for (const [key, cases] of groups) {
    const world = key.split("|")[0]!;
    const dir = join(opts.out, `${world}-${port}`);
    console.log(`\n▶ ${world} (port ${port}) — ${cases.map((c) => c.id).join(", ")}`);
    let server: Server | undefined;
    try {
      server = await startServer(world, port, dir, opts, cases[0]!.env ?? {});
      for (const useCase of cases) {
        console.log(`\n${useCase.title} (${useCase.id})`);
        records.push(await runUseCase(useCase, server, dir));
      }
    } catch (error) {
      for (const useCase of cases.filter((c) => !records.some((r) => r.id === c.id)))
        records.push({
          id: useCase.id,
          title: useCase.title,
          world,
          status: "failed",
          reason: (error as Error).message,
          seconds: 0,
          usd: 0,
          steps: [],
        });
    } finally {
      if (server) await stopServer(server);
    }
    port += 3;
  }

  writeFileSync(
    join(opts.out, "report.json"),
    `${JSON.stringify({ startedAt, cap: opts.cap, records }, null, 2)}\n`,
  );
  writeFileSync(join(opts.out, "report.md"), markdown(records, startedAt));
  const failed = records.filter((r) => r.status === "failed");
  const total = records.reduce((sum, r) => sum + r.usd, 0);
  console.log(
    `\n${records.length - failed.length - records.filter((r) => r.status === "skipped").length} passed · ${failed.length} failed · ${records.filter((r) => r.status === "skipped").length} skipped · $${total.toFixed(2)} · report ${opts.out}/report.md`,
  );
  process.exit(failed.length > 0 ? 1 : 0);
}

await main();
