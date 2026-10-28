#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnvironment } from "../src/config/environment";
import { chatClassifierProvider } from "../src/decisions/providers";
import { getErrorMessage } from "../src/engine/errors";
import { judgeLesson, type Lesson, type Outcome } from "../src/learning/outcomes";
import { MarinaClient } from "../src/sdk/client";
import { type CoverageInventory, coverageMatrix, fullyQualified } from "./capabilities/coverage";
import { exerciseRecords } from "./capabilities/exercise";
import {
  exerciseAliases,
  exerciseChildWorld,
  exerciseObjects,
} from "./capabilities/exercise-aliases";
import { exerciseAssets, exerciseSandboxPrerequisites } from "./capabilities/exercise-assets";
import { exerciseBoundaries } from "./capabilities/exercise-boundaries";
import { exerciseCodeDelivery } from "./capabilities/exercise-code-delivery";
import { exerciseCoding } from "./capabilities/exercise-coding";
import { exerciseComparison } from "./capabilities/exercise-comparison";
import { exerciseCoordination } from "./capabilities/exercise-coordination";
import { exerciseDependent } from "./capabilities/exercise-dependent";
import { exerciseFinalRecords } from "./capabilities/exercise-final-records";
import {
  exerciseConnectors,
  exerciseMiscellaneous,
  exerciseTrace,
} from "./capabilities/exercise-integrations";
import { exerciseLineage } from "./capabilities/exercise-lineage";
import { exerciseMediaAdmission } from "./capabilities/exercise-media-admission";
import { exerciseMediaLive } from "./capabilities/exercise-media-live";
import { exerciseMemory } from "./capabilities/exercise-memory";
import {
  exerciseAssistance,
  exerciseMemoryAdvanced,
} from "./capabilities/exercise-memory-advanced";
import {
  exerciseAgents,
  exerciseBenchmarks,
  exerciseInquiry,
} from "./capabilities/exercise-models";
import { exerciseProductiveCoding } from "./capabilities/exercise-productive";
import { exerciseRecruitment } from "./capabilities/exercise-recruitment";
import { exerciseResidentForecasts } from "./capabilities/exercise-resident-forecasts";
import {
  exerciseCrew,
  exerciseOperator,
  exerciseShell,
  exerciseUtilities,
} from "./capabilities/exercise-utilities";
import { exerciseWorld } from "./capabilities/exercise-world";

/** Fresh production server, real WebSocket clients, durable evidence, no inherited settings.
 * Report every inventory item, including gaps. Never call an unasserted probe 'works'. */
const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const directory = resolve(option("--directory") ?? "/tmp/marina-capability-qualification");
const inventoryPath = option("--inventory");
if (!inventoryPath) throw new Error("--inventory <generated JSON> is required");
const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as CoverageInventory;
const model = option("--model");
const budget = Number(option("--budget-usd") ?? 0);
if (
  model &&
  (!args.includes("--live") ||
    !/^openrouter\/[\w./:-]+$/.test(model) ||
    !(Number.isFinite(budget) && budget > 0))
)
  throw new Error(
    "Live mode requires --live --model openrouter/<id> --budget-usd <positive finite total>",
  );
const root = resolve(import.meta.dir, "..");
function assertInventoryCurrent() {
  if (!args.includes("--execute-snapshot")) {
    const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
    assert.equal(
      commit.stdout.toString().trim(),
      inventory.provenance.commit,
      "Inventory commit is stale",
    );
  }
  for (const source of inventory.provenance.sources) {
    if (
      args.includes("--execute-snapshot") &&
      source.file
        .split("/")
        .some((part) => part === ".env" || (part.startsWith(".env.") && part !== ".env.example"))
    )
      continue;
    assert.equal(
      createHash("sha256")
        .update(readFileSync(join(root, source.file)))
        .digest("hex"),
      source.sha256,
      `Inventory source changed: ${source.file}; regenerate it before running`,
    );
  }
}
if (!args.includes("--diagnostic")) assertInventoryCurrent();
mkdirSync(directory, { recursive: true, mode: 0o700 });
const snapshot = args.includes("--execute-snapshot");
const runDirectory = snapshot ? dirname(root) : mkdtempSync(join(directory, "run-"));
writeFileSync(join(runDirectory, "inventory.json"), readFileSync(inventoryPath));
// A child-world process starts from MARINA_ROOT and Bun auto-loads that cwd's
// .env. Copy the inventoried code to a root with no .env before exercising it.
// Dependencies are shared read-only; generated data stays under the run directory.
const runtimeRoot = snapshot ? root : join(runDirectory, "source");
if (!snapshot) {
  mkdirSync(runtimeRoot);
  for (const source of inventory.provenance.sources) {
    assert(!source.file.startsWith("/") && !source.file.split("/").includes(".."));
    if (
      source.file
        .split("/")
        .some((part) => part === ".env" || (part.startsWith(".env.") && part !== ".env.example"))
    )
      continue;
    const target = join(runtimeRoot, source.file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, source.file), target);
  }
  symlinkSync(join(root, "node_modules"), join(runtimeRoot, "node_modules"), "dir");
  // Freeze the harness as well as the server: ongoing development cannot change either arm.
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(runtimeRoot, "scripts/qualify-capabilities.ts"),
      ...args,
      "--execute-snapshot",
    ],
    { cwd: root, env: process.env, stdout: "inherit", stderr: "inherit" },
  );
  process.exit(await child.exited);
}

interface Evidence {
  id: string;
  status: "works" | "failed" | "observed" | "blocked" | "untested";
  detail: string;
  commands?: string[];
  capabilities?: string[];
}
interface Transcript {
  actor: string;
  input: string;
  completion: string;
  output: string;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Condition not reached within ${timeoutMs}ms`);
    await Bun.sleep(25);
  }
}

function textOf(value: unknown): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal SGR from evidence
  return (typeof value === "string" ? value : JSON.stringify(value)).replace(/\x1b\[[0-9;]*m/g, "");
}

async function runArm(name: "no-provider" | "cheap-model") {
  const dir = join(runDirectory, name);
  mkdirSync(dir, { mode: 0o700 });
  symlinkSync(join(runtimeRoot, "benchmarks"), join(dir, "benchmarks"), "dir");
  const dbPath = join(dir, "world.db");
  assert(!existsSync(dbPath), "Refuse an existing database");
  const workspace = join(dir, "workspace");
  if (args.includes("--extended")) {
    mkdirSync(workspace);
    writeFileSync(join(workspace, "README.md"), "Qualification fixture: cobalt-317\n");
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({
        name: "qualification-fixture",
        private: true,
        scripts: {
          test: "bun test",
          lint: `${join(root, "node_modules/.bin/biome")} lint .`,
          typecheck: `${join(root, "node_modules/.bin/tsc")} --noEmit`,
          build: "bun build ./index.ts --target bun --outdir dist",
        },
      }),
    );
    writeFileSync(join(workspace, ".gitignore"), "node_modules/\ndist/\n");
    writeFileSync(
      join(workspace, "index.ts"),
      "export const multiply = (a: number, b: number): number => a * b;\n",
    );
    writeFileSync(
      join(workspace, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          skipLibCheck: true,
          types: [join(root, "node_modules/@types/bun")],
          noEmit: true,
        },
        include: ["*.ts"],
      }),
    );
    writeFileSync(
      join(workspace, "arithmetic.test.ts"),
      'import {test,expect} from "bun:test";test("arithmetic",()=>expect(19*23).toBe(437));\n',
    );
    for (const gitArgs of [
      ["init"],
      ["add", "."],
      [
        "-c",
        "user.name=Qualification",
        "-c",
        "user.email=qualification@localhost",
        "commit",
        "-m",
        "Fixture baseline",
      ],
    ]) {
      const result = Bun.spawnSync(["git", ...gitArgs], { cwd: workspace });
      assert.equal(result.exitCode, 0, result.stderr.toString());
    }
  }
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  const token = crypto.randomUUID();
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    WS_HOST: "127.0.0.1",
    WS_PORT: String(port),
    MCP_PORT: "0",
    LOG_PORT: "0",
    TELNET_PORT: "0",
    DB_PATH: dbPath,
    MARINA_DATA_DIR: dir,
    ASSETS_DIR: join(dir, "assets"),
    MARINA_WORLD: "empty",
    MARINA_ROOM_AGENTS: "false",
    AGENT_AUTORESPAWN: "false",
    MARINA_PROFILE: "local",
    MARINA_DAILY_SPEND_CAP_USD: String(name === "cheap-model" ? budget : 0),
    MARINA_CHILD_DAILY_SPEND_CAP_USD: String(name === "cheap-model" ? budget : 0),
    MARINA_SPEND_LEDGER: join(dir, "shared-spend.db"),
    MODEL_API_KEYS: token,
    MARINA_DESKTOP_API_TOKEN: token,
    LOG_LEVEL: "warn",
    TICK_MS: "20",
  };
  if (args.includes("--extended"))
    Object.assign(env, {
      MARINA_CODE_ROOTS: workspace,
      MARINA_CODE_DEFAULT_ROOT: workspace,
      MARINA_EVOLUTION_PROTOCOLS: "true",
    });
  if (name === "cheap-model") {
    const configured = option("--provider-env")
      ? parseEnvironment(readFileSync(resolve(option("--provider-env")!), "utf8"))
      : {};
    const key = process.env.OPENROUTER_API_KEY ?? configured.OPENROUTER_API_KEY;
    if (!key)
      throw new Error(
        "OpenRouter credential unavailable (use --provider-env; only its OpenRouter key is forwarded)",
      );
    Object.assign(env, {
      OPENROUTER_API_KEY: key,
      MARINA_DEFAULT_MODEL: model,
      MARINA_ARENA_PROPOSER: model,
      MARINA_ARENA_RESEARCH_JUDGE: "decisions",
      MARINA_FORECAST_JUDGE: "decisions",
      MARINA_FORECAST_RESIDENTS: "on",
      MARINA_DEFAULT_OPENROUTER_MODEL: model!.replace(/^openrouter\//, ""),
      MARINA_MODEL_TIER_CHEAP: model,
      MARINA_MODEL_TIER_STRONG: model,
      MARINA_MODEL_TIER_CHEAP_MAX_OUTPUT_TOKENS: "4096",
      MARINA_FORECAST_ANALYSTS: model,
      MARINA_FORECAST_PLANNER: model,
      MARINA_FORECAST_CRITIC: model,
      MARINA_FORECAST_VERIFIER: model,
      MARINA_FORECAST_RETRIEVER: option("--retriever") ?? "search",
      MARINA_RESEARCH_SEARCH_BACKENDS: "duckduckgo",
      MARINA_RESEARCH_SEARCH_MODEL: model!.replace(/^openrouter\//, ""),
      MARINA_RESEARCH_LOOP_MODEL: model,
      MARINA_VISION_MODEL: option("--vision-model") ?? model,
      MARINA_READ_SWARM_READER: model,
    });
    if (args.includes("--services")) {
      for (const key of [
        "OPENAI_API_KEY",
        "TAVILY_API_KEY",
        "TABH2O_API_KEY",
        "FRED_API_KEY",
        "ODDS_API_KEY",
      ])
        if (process.env[key] ?? configured[key]) env[key] = process.env[key] ?? configured[key];
    }
  }
  const spawnServer = (suffix = "") =>
    Bun.spawn([process.execPath, "--no-env-file", join(runtimeRoot, "src/main.ts")], {
      cwd: dir,
      env,
      stdout: Bun.file(join(dir, `server${suffix}.stdout.log`)),
      stderr: Bun.file(join(dir, `server${suffix}.stderr.log`)),
    });
  let child = spawnServer();
  const watchdog = setTimeout(
    () => child.kill("SIGKILL"),
    args.includes("--extended") ? 2700000 : 240000,
  );
  const evidence: Evidence[] = [];
  const transcript: Transcript[] = [];
  const clients: MarinaClient[] = [];
  let db: Database | undefined;
  const base = `http://127.0.0.1:${port}`;
  const scenario = async (
    id: string,
    run: () => Promise<string>,
    commands?: string[],
    successStatus: Evidence["status"] = "works",
  ) => {
    try {
      evidence.push({ id, status: successStatus, detail: await run(), commands });
    } catch (error) {
      evidence.push({ id, status: "failed", detail: getErrorMessage(error), commands });
    }
    appendFileSync(join(dir, "evidence.jsonl"), `${JSON.stringify(evidence.at(-1))}\n`);
    console.log(`${name}: ${id}: ${evidence.at(-1)!.status}`);
  };
  const connect = async (actor: string, principal: "agent" | "person" = "agent") => {
    const client = new MarinaClient(`ws://127.0.0.1:${port}/ws`, {
      autoReconnect: false,
      pingInterval: 0,
      commandMode: "correlated",
      commandGrammar: "world",
      commandTimeout: args.includes("--extended") ? 900000 : 45000,
      principal,
    });
    clients.push(client);
    await client.connect(actor);
    return client;
  };
  const command = async (client: MarinaClient, actor: string, input: string) => {
    try {
      const result = await client.command(input);
      const output = result.map((p) => textOf(p.data?.text ?? p.data)).join("\n");
      transcript.push({ actor, input, completion: result.completion, output });
      appendFileSync(join(dir, "transcript.jsonl"), `${JSON.stringify(transcript.at(-1))}\n`);
      assert.equal(result.completion, "confirmed");
      return output;
    } catch (error) {
      transcript.push({ actor, input, completion: "failed", output: getErrorMessage(error) });
      throw error;
    }
  };
  let initial: unknown;
  let final: unknown;
  try {
    await waitFor(async () => {
      if (child.exitCode !== null)
        throw new Error(`Server exited ${child.exitCode}; inspect ${dir}/server.stderr.log`);
      try {
        return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok;
      } catch {
        return false;
      }
    }, 20000);
    db = new Database(dbPath, { readonly: true });
    const rows = (sql: string) => db!.query(sql).all();
    const snapshot = () => ({
      schema: rows("SELECT * FROM schema_version"),
      tasks: rows("SELECT id, title, status FROM tasks"),
      outcomes: rows("SELECT * FROM outcomes"),
      deliveries: rows("SELECT * FROM outcome_deliveries"),
      spend: rows("SELECT * FROM spend_daily"),
    });
    initial = snapshot();
    assert.equal(rows("SELECT id FROM tasks").length, 0);
    assert.equal(rows("SELECT id FROM outcomes").length, 0);
    const a = await connect("CleanOwner");
    const b = await connect("CleanWorker");
    const ca = (input: string) => command(a, "CleanOwner", input);
    const cb = (input: string) => command(b, "CleanWorker", input);
    const operator = args.includes("--extended")
      ? await connect("CleanOperator", "person")
      : undefined;
    const co = (input: string) => {
      assert(operator);
      return command(operator, "CleanOperator", input);
    };
    await scenario("live-manifest", async () => {
      const live = await a.capabilities();
      const describe = (commands: typeof inventory.commands) =>
        commands
          .map((c) => ({
            name: c.name,
            aliases: c.aliases,
            forms: (c.forms ?? []).map((f) => ({ syntax: f.syntax, effect: f.effect })),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
      assert.deepEqual(describe(live.commands), describe(inventory.commands));
      return "Authenticated production WebSocket manifest matches every inventoried builtin, alias and usage form.";
    });
    await scenario("fresh-world", async () => {
      assert.match(await ca("look"), /Void/);
      return "Production boot, new database, empty world's Void, real agent WebSocket login. No imported tasks or outcomes.";
    }, ["look [target]"]);
    await scenario("memory-roundtrip", async () => {
      await ca("note The fictional Violet Lighthouse book has library shelf number 7319.");
      assert.match(await ca("recall violet-lighthouse"), /7319/);
      assert.doesNotMatch(await cb("recall violet-lighthouse"), /7319/);
      await ca("memory kv set cleanroom_checkpoint resume-after-reconnect");
      assert.match(await ca("memory kv get cleanroom_checkpoint"), /resume-after-reconnect/);
      return "Private note write/retrieval, other-account exclusion, core checkpoint readback.";
    }, [
      "note <text>",
      "recall <query> [recent | important] [type <type>]",
      "memory kv set <key> <value>",
      "memory kv get <key>",
    ]);
    await scenario("task-through-verdict", async () => {
      await ca("task create Cleanroom deliverable | Return the answer forty-two");
      const task = db!
        .query("SELECT id FROM tasks WHERE title = ?")
        .get("Cleanroom deliverable") as { id: number } | null;
      assert(task, "Task creation persisted");
      await cb(`task claim ${task.id}`);
      const before = db!
        .query("SELECT lease_expires_at FROM task_claims WHERE task_id = ?")
        .get(task.id) as { lease_expires_at: number };
      await cb(`task heartbeat ${task.id}`);
      const after = db!
        .query("SELECT lease_expires_at FROM task_claims WHERE task_id = ?")
        .get(task.id) as { lease_expires_at: number };
      assert(after.lease_expires_at > before.lease_expires_at, "Heartbeat extends persisted lease");
      await cb(`task submit ${task.id} The answer is forty-two`);
      await ca(`task approve ${task.id} CleanWorker`);
      const row = db!.query("SELECT status FROM tasks WHERE id = ?").get(task.id) as {
        status: string;
      };
      assert.equal(row.status, "completed");
      const result = db!.query("SELECT * FROM outcomes WHERE source = 'task:verdict'").all();
      assert(result.length > 0, "Verdict reached durable outcome ledger");
      assert.match(await cb("outcome list"), /task|verdict/i);
      return "Creator → independent claimant → submission → approval → completed task and durable outcome.";
    }, [
      "task create <title> | <description> [standing:N] [bounty]",
      "task claim <id>",
      "task heartbeat <id>",
      "task submit <id> <text>",
      "task approve <id> <claimant>",
      "outcome list [kind:<k>] [limit:<n>]",
    ]);
    await scenario("channel-handoff", async () => {
      await ca("channel create cleanroom");
      await cb("channel join cleanroom");
      await ca("channel send cleanroom handoff-violet-7319");
      assert.match(await cb("channel history cleanroom 5"), /handoff-violet-7319/);
      return "Two accounts share a channel and the receiving account reads the persisted handoff.";
    }, [
      "channel create <name>",
      "channel join <name>",
      "channel send <name> <message>",
      "channel history <name> [count]",
    ]);
    await scenario("project", async () => {
      await ca("project create cleanroom | Finish a durable shared task");
      assert.match(await ca("project info cleanroom"), /Finish a durable shared task/);
      await ca("project cleanroom propose Read the checkpoint and verify the answer");
      assert(
        db!
          .query("SELECT id FROM board_posts WHERE body = ?")
          .get("Read the checkpoint and verify the answer"),
        "Proposal body persisted",
      );
      assert.match(await ca("project cleanroom status"), /cleanroom/i);
      return "Project creation, stored purpose, proposal and status readback.";
    }, [
      "project create <name> | <description>",
      "project info <name>",
      "project <name> propose <text>",
      "project <name> status",
    ]);
    await scenario("board", async () => {
      await ca("board create cleanroom");
      await ca("board post cleanroom Handoff | Board-violet-7319");
      assert.match(await cb("board read cleanroom"), /Handoff/);
      assert.match(await cb("board search cleanroom Board-violet-7319"), /Handoff|7319/);
      return "Board creation, post and another account's read/search.";
    }, [
      "board create <name>",
      "board post <board> <title> | <body>",
      "board read <board> [postId]",
      "board search <board> <query>",
    ]);
    await scenario("macro", async () => {
      await ca("macro create cleananswer calc 6 * 7");
      assert.match(await ca("cleananswer"), /42/);
      await ca("macro delete cleananswer");
      assert.doesNotMatch(await ca("macro list"), /cleananswer/);
      return "Macro creation, execution through the command queue and deletion.";
    }, [
      "macro create <name> <command with $* / $1…> [room:<room>]",
      "macro delete <name> [room:<room>]",
      "macro list",
      "calc <expression>",
    ]);
    await scenario("resolver", async () => {
      assert.match(await ca("probe echoing payload:cleanroom-echo"), /cleanroom-echo/);
      assert.match(await ca("recall cleanroom-echo"), /cleanroom-echo/);
      return "Resolver invocation persists a sample retrievable through memory.";
    }, ["probe <kind> <key>:<value> [<additional key:value pairs>]"]);
    await scenario("schedule", async () => {
      await ca(
        `schedule add checkpoint at:${new Date(Date.now() + 3600000).toISOString()} -- memory kv set scheduled_checkpoint delivered`,
      );
      await ca("schedule run checkpoint");
      await waitFor(
        async () => /delivered/.test(await ca("memory kv get scheduled_checkpoint")),
        16000,
      );
      assert.match(await ca("schedule history checkpoint"), /success|completed|ok/i);
      return "A scheduled command runs via the production tick scheduler and leaves a durable checkpoint.";
    }, [
      "schedule add <name> at:<time> [catch-up:once|none] -- <command>",
      "schedule run <name>",
      "schedule history <name> [limit:N]",
    ]);
    await scenario("ask", async () => {
      const reply = await ca(
        "ask What library shelf number holds the fictional Violet Lighthouse book?",
      );
      assert.match(reply, /7319/);
      if (name === "no-provider") assert.match(reply, /No model provider/);
      else {
        const answer = reply.split(/\nAnswer\n/)[1];
        assert(answer, "Generated Answer section exists");
        assert.match(answer, /7319/);
        assert.doesNotMatch(reply, /No model provider|From this world's notes and commands/);
      }
      return name === "no-provider"
        ? "Explicit notes-only fallback with retrieved fact."
        : "Live cheap-model answer grounded in this fresh account's stored fact.";
    }, ["ask <question>"]);
    if (name === "cheap-model") {
      await scenario("lesson-grounding-controls", async () => {
        const judge = chatClassifierProvider({
          baseUrl: `${base}/v1`,
          model: model!,
          apiKey: token,
          method: "auto",
          structured: true,
          timeoutMs: 60_000,
        });
        const outcome: Outcome = {
          domain: "tools",
          source: "qualification:review",
          succeeded: true,
          attempted: "complete a task to its creator's satisfaction",
          resolvedAt: new Date().toISOString(),
          detail:
            "The creator accepted a submitted answer. No objective validation or comparison was performed.",
          privateContext:
            "The task requested a factual report supported by source citations. The submission contained no citations and no independent factual verification. The creator nevertheless approved it.",
        };
        const results = [];
        for (const [rule, expected] of [
          [
            "Treat a creator's acceptance as proof that every factual claim is correct, and skip independent fact checking on later reports.",
            "rejected",
          ],
          [
            "Omitting source citations makes factual reports more accurate and productive than researched reports.",
            "rejected",
          ],
          [
            "Track task acceptance separately from factual verification; seek source evidence before treating an accepted factual report as independently checked.",
            "trusted",
          ],
        ] as const) {
          const candidate: Lesson = {
            domain: outcome.domain,
            source: outcome.source,
            kind: "success",
            trust: "unverified",
            resolvedAt: outcome.resolvedAt,
            rule,
            category: "verification",
            text: `[lesson:tools] rule: ${rule}`,
          };
          const verdict = await judgeLesson(candidate, outcome, judge);
          results.push({ rule, expected, verdict });
          assert.equal(verdict.trust, expected, JSON.stringify(results));
          assert(verdict.judgement, "The selected live model must actually judge the control");
        }
        return JSON.stringify({
          results,
          scope:
            "Three controlled judgments, including unsupported-generalization negatives; this does not establish population-wide judge reliability.",
        });
      });
      await scenario("autonomous-resident-task", async () => {
        await ca(
          "task create Resident arithmetic | Compute 19 times 23 and submit the numeric answer",
        );
        const task = db!
          .query("SELECT id FROM tasks WHERE title = ?")
          .get("Resident arithmetic") as { id: number };
        assert(task);
        await ca(
          `agent spawn CleanResident model ${model} budget 6 goal Claim task ${task.id}, compute 19 times 23 using calc, and submit the answer with task submit ${task.id}. Then rest.`,
        );
        await waitFor(
          () =>
            !!db!
              .query("SELECT task_id FROM task_claims WHERE task_id = ? AND status = 'submitted'")
              .get(task.id),
          90000,
        );
        const claim = db!
          .query("SELECT entity_name, submission_text FROM task_claims WHERE task_id = ?")
          .get(task.id) as { entity_name: string; submission_text: string };
        assert.equal(claim.entity_name, "CleanResident");
        assert.match(claim.submission_text, /\b437\b/);
        assert(
          db!
            .query(
              "SELECT id FROM entity_activity WHERE entity_name = 'CleanResident' AND activity_key = 'calc' AND success_count > 0",
            )
            .get(),
          "Resident actually used calc",
        );
        await ca(`task approve ${task.id} CleanResident`);
        assert.equal(
          (db!.query("SELECT status FROM tasks WHERE id = ?").get(task.id) as { status: string })
            .status,
          "completed",
        );
        await ca("agent stop CleanResident");
        return "A live resident independently claimed the new task, used a tool, submitted 437 and received an independent creator verdict.";
      }, [
        "agent spawn <name> [model <m>] [role <r>] [key <k>] [budget <n>] [thinking:<level>] [goal <g>]",
      ]);
    } else {
      evidence.push({
        id: "autonomous-resident-task",
        status: "blocked",
        detail:
          "No provider configured; model-driven resident execution is unavailable by construction.",
      });
    }
    if (args.includes("--extended"))
      for (const [section, exercise] of [
        ["records", exerciseRecords],
        ["lineage", exerciseLineage],
        ["coding", exerciseCoding],
        ["code-delivery", exerciseCodeDelivery],
        ["world", exerciseWorld],
        ["memory", exerciseMemory],
        ["memory-advanced", exerciseMemoryAdvanced],
        ["assistance", exerciseAssistance],
        ["coordination", exerciseCoordination],
        ["utilities", exerciseUtilities],
        ["crew", exerciseCrew],
        ["operator", exerciseOperator],
        ["shell", exerciseShell],
        ["assets", exerciseAssets],
        ["objects", exerciseObjects],
        ["child-world", exerciseChildWorld],
        ["connectors", exerciseConnectors],
        ["agents", exerciseAgents],
        ["resident-forecasts", exerciseResidentForecasts],
        ["recruitment", exerciseRecruitment],
        ["comparison", exerciseComparison],
        ["benchmarks", exerciseBenchmarks],
        ["inquiry", exerciseInquiry],
        ["trace", exerciseTrace],
        ["miscellaneous", exerciseMiscellaneous],
        ["aliases", exerciseAliases],
        ["sandbox-prerequisites", exerciseSandboxPrerequisites],
        ["boundaries", exerciseBoundaries],
        ["final-records", exerciseFinalRecords],
        ["media-admission", exerciseMediaAdmission],
        ["media-live", exerciseMediaLive],
        ["dependent", exerciseDependent],
        ["productive", exerciseProductiveCoding],
      ] as const) {
        const selected = option("--sections")?.split(",");
        if (selected && !selected.includes(section)) continue;
        await scenario(
          `extended-${section}`,
          async () => {
            await exercise({
              inventory,
              db: db!,
              directory: dir,
              workspace,
              live: name === "cheap-model",
              model,
              freshParticipant: async (actor) => {
                const client = await connect(actor);
                return (input) => command(client, actor, input);
              },
              request: (path, init = {}) =>
                fetch(`${base}${path}`, {
                  ...init,
                  headers: { Authorization: `Bearer ${a.getSession()!.token}`, ...init.headers },
                  signal: AbortSignal.timeout(30000),
                }),
              record: (item) => {
                evidence.push(item);
                appendFileSync(join(dir, "evidence.jsonl"), `${JSON.stringify(item)}\n`);
              },
              command: (actor, input) =>
                actor === "owner" ? ca(input) : actor === "worker" ? cb(input) : co(input),
              scenario: (id, run, commands) => scenario(`${section}:${id}`, run, commands),
            });
            return "Fixture runner completed. This is not capability success; individual step assertions determine qualification.";
          },
          undefined,
          "observed",
        );
      }
    if (args.includes("--extended")) {
      await ca("goto void/center");
      await cb("goto void/center");
      const received: string[] = [];
      b.on("perception", (p) => received.push(JSON.stringify(p)));
      for (const [prefix, marker] of [
        ["'", "qa-quote-917"],
        ["@@ ", "qa-global-921"],
      ]) {
        await scenario(`prefix-recipient:${marker}`, async () => {
          const out = await ca(`${prefix}${marker}`);
          await waitFor(() => received.some((p) => p.includes(marker!)), 3000);
          return JSON.stringify({
            input: `${prefix}${marker}`,
            out,
            recipient: "CleanWorker",
            received: received.filter((p) => p.includes(marker!)),
          });
        });
      }
      for (const input of [
        "quit",
        ...(inventory.commands.find((c) => c.name === "quit")?.aliases ?? []),
      ]) {
        const disposable = await connect(`QaQuit${input}`);
        await scenario(
          `disconnect:${input}`,
          async () => {
            let outcome: unknown;
            try {
              outcome = await disposable.command(input);
            } catch (error) {
              outcome = getErrorMessage(error);
            }
            await waitFor(() => !disposable.isConnected(), 3000);
            assert.doesNotMatch(await ca("who"), new RegExp(`QaQuit${input}`));
            evidence.push({
              id: `alias-disconnect:${input}`,
              status: "works",
              capabilities: input === "quit" ? [] : [`alias:quit:${input}`],
              detail: "Real client disconnected and entity immediately disappeared from who.",
            });
            return JSON.stringify({ input, outcome, state: disposable.getConnectionState() });
          },
          input === "quit" ? ["quit"] : [],
        );
      }
      const kicked = await connect("QaKickFixture");
      await scenario("admin-kick", async () => {
        const out = await co("admin kick QaKickFixture");
        await waitFor(() => !kicked.isConnected(), 3000);
        return out;
      }, ["admin kick <entity>"]);
    }
    // Broad discovery is evidence of discoverability only. It never qualifies execution.
    for (const entry of args.includes("--skip-discovery") ? [] : inventory.commands) {
      try {
        const reply = await ca(`help ${entry.name}`);
        evidence.push({
          id: `discovery:${entry.name}`,
          status: reply.trim() ? "observed" : "failed",
          detail: "Help response captured; command execution not implied.",
        });
      } catch (error) {
        evidence.push({
          id: `discovery:${entry.name}`,
          status: "failed",
          detail: getErrorMessage(error),
        });
      }
      await Bun.sleep(55);
    }
    const external = new Set([
      "arena",
      "market",
      "data",
      "web",
      "readiness",
      "forecast",
      "benchmark",
      "demo",
      "position",
      "agent",
      "key",
      "gateway",
      "connect",
      "source",
    ]);
    for (const entry of args.includes("--skip-discovery") ? [] : inventory.commands) {
      if (external.has(entry.name)) continue;
      for (const form of entry.forms ?? []) {
        const input = form.syntax.replace(/\[[^\]]*\]/g, "").trim();
        if (form.effect !== "read" || !/^[a-z][a-z -]*$/.test(input)) continue;
        try {
          const reply = await ca(input);
          evidence.push({
            id: `probe:${form.syntax}`,
            status: "observed",
            detail: reply.slice(0, 500),
          });
        } catch (error) {
          evidence.push({
            id: `probe:${form.syntax}`,
            status: /Approval needed:|held: challenge/.test(getErrorMessage(error))
              ? "blocked"
              : "failed",
            detail: getErrorMessage(error),
          });
        }
        await Bun.sleep(55);
      }
    }
    await scenario("reconnect", async () => {
      const session = a.getSession();
      assert(session);
      a.disconnect();
      const resumed = new MarinaClient(`ws://127.0.0.1:${port}/ws`, {
        autoReconnect: false,
        pingInterval: 0,
        commandMode: "correlated",
        commandGrammar: "world",
      });
      clients.push(resumed);
      await resumed.reconnect(session.token);
      assert.match(
        await command(resumed, "CleanOwner", "memory kv get cleanroom_checkpoint"),
        /resume-after-reconnect/,
      );
      assert.match(await command(resumed, "CleanOwner", "recall violet-lighthouse"), /7319/);
      return "A new socket authenticates with the durable session and recovers its checkpoint and private fact.";
    });
    await scenario("server-restart-continuity", async () => {
      const session = b.getSession();
      assert(session);
      for (const client of clients) client.disconnect();
      child.kill("SIGTERM");
      assert.equal(await child.exited, 0);
      child = spawnServer("-restart");
      await waitFor(async () => {
        if (child.exitCode !== null) throw new Error(`Restart exited ${child.exitCode}`);
        try {
          return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).ok;
        } catch {
          return false;
        }
      }, 20000);
      const resumed = new MarinaClient(`ws://127.0.0.1:${port}/ws`, {
        autoReconnect: false,
        pingInterval: 0,
        commandMode: "correlated",
        commandGrammar: "world",
      });
      clients.push(resumed);
      await resumed.reconnect(session.token);
      assert.match(
        await command(resumed, "CleanWorker", "channel history cleanroom 5"),
        /handoff-violet-7319/,
      );
      assert.match(
        await command(resumed, "CleanWorker", "task list completed"),
        /Cleanroom deliverable/,
      );
      return "Stopped and restarted the production process on its new DB; authenticated session, shared handoff and completed work survived.";
    });
    final = snapshot();
  } catch (error) {
    evidence.push({ id: "arm", status: "failed", detail: getErrorMessage(error) });
  } finally {
    for (const client of clients) client.disconnect();
    db?.close();
    if (child.exitCode === null) child.kill("SIGTERM");
    const exit = await child.exited;
    clearTimeout(watchdog);
    evidence.push({
      id: "shutdown",
      status: exit === 0 ? "works" : "failed",
      detail: `Production server exit ${exit}`,
    });
  }
  // Shutdown can flush learning and settle additional spend. Capture the closed database.
  let postShutdown: unknown;
  if (existsSync(dbPath)) {
    const closed = new Database(dbPath, { readonly: true });
    try {
      const deliveries = closed.query("SELECT * FROM outcome_deliveries").all() as Array<{
        outcome_id: number;
        consumer: string;
        state: string;
        reason: string | null;
      }>;
      const completedModels = closed
        .query(
          "SELECT json_extract(data,'$.model') AS model,json_extract(data,'$.routeKind') AS routeKind,count(*) AS calls FROM event_log WHERE type='model_request_lifecycle' AND json_extract(data,'$.phase')='completed' GROUP BY 1,2",
        )
        .all() as Array<{ model: string; routeKind: string; calls: number }>;
      const upstream = completedModels.filter(
        (row) => row.model && !/^(?:marina(?:[/:]|$)|role:)/.test(row.model),
      );
      evidence.push({
        id: "completed-model-isolation",
        status:
          name === "cheap-model"
            ? upstream.length > 0 &&
              upstream.every((row) => [model, option("--vision-model")].includes(row.model))
              ? "works"
              : "failed"
            : upstream.length === 0
              ? "works"
              : "failed",
        detail: JSON.stringify({
          expected: name === "cheap-model" ? model : "no upstream provider",
          completedModels,
          scope: "Persisted completed upstream lifecycle identities, not just configured defaults.",
        }),
      });
      postShutdown = {
        completedModels,
        outcomes: closed.query("SELECT * FROM outcomes").all(),
        deliveries,
        spend: closed.query("SELECT * FROM spend_daily").all(),
        benchmarkRuns: closed
          .query("SELECT id,status,answered,total,cost_usd FROM benchmark_runs")
          .all(),
      };
      for (const delivery of deliveries)
        evidence.push({
          id: `delivery:${delivery.outcome_id}:${delivery.consumer}`,
          status:
            delivery.state === "failed"
              ? "failed"
              : delivery.state === "pending"
                ? "blocked"
                : "observed",
          detail: JSON.stringify(delivery),
        });
    } finally {
      closed.close();
    }
  }
  let sharedSpend: unknown[] = [];
  if (existsSync(join(dir, "shared-spend.db"))) {
    const ledger = new Database(join(dir, "shared-spend.db"), { readonly: true });
    try {
      sharedSpend = ledger.query("SELECT * FROM spend_daily").all();
    } finally {
      ledger.close();
    }
  }
  try {
    assert(
      !args.includes("--diagnostic"),
      "Diagnostic run: source provenance was not qualified; regenerate inventory and rerun without --diagnostic for evidence.",
    );
    assertInventoryCurrent();
    for (const source of inventory.provenance.sources) {
      if (
        source.file
          .split("/")
          .some((part) => part === ".env" || (part.startsWith(".env.") && part !== ".env.example"))
      )
        continue;
      assert.equal(
        createHash("sha256")
          .update(readFileSync(join(runtimeRoot, source.file)))
          .digest("hex"),
        source.sha256,
        `Executed source changed: ${source.file}`,
      );
    }
    evidence.push({
      id: "source-provenance",
      status: "works",
      detail:
        "All inventoried source hashes match before and after execution, including the isolated source copy actually executed.",
    });
  } catch (error) {
    evidence.push({ id: "source-provenance", status: "failed", detail: getErrorMessage(error) });
  }
  const coverage = coverageMatrix(inventory, evidence);
  const report = {
    name,
    diagnostic: args.includes("--diagnostic"),
    provenance: inventory.provenance,
    database: dbPath,
    freshAtStart: true,
    configuration: Object.fromEntries(Object.entries(env).filter(([k]) => !/KEY|TOKEN/.test(k))),
    initial,
    final,
    postShutdown,
    sharedSpend,
    evidence,
    coverage,
    transcript,
    complete: fullyQualified(coverage, evidence),
  };
  writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      arm: name,
      directory: dir,
      works: evidence.filter((e) => e.status === "works").length,
      failed: evidence.filter((e) => e.status === "failed").length,
      qualifiedForms: coverage.filter(
        (row) => row.id.startsWith("command:") && row.status === "works",
      ).length,
      totalForms: inventory.commands.reduce((n, c) => n + (c.forms?.length ?? 0), 0),
      complete: report.complete,
    }),
  );
  return report;
}

const reports = [await runArm("no-provider")];
if (model) reports.push(await runArm("cheap-model"));
writeFileSync(
  join(runDirectory, "summary.json"),
  JSON.stringify(
    {
      directory: runDirectory,
      arms: reports.map((r) => ({ name: r.name, complete: r.complete })),
      complete: reports.length === 2 && reports.every((r) => r.complete),
    },
    null,
    2,
  ),
);
console.log(`Evidence retained at ${runDirectory}`);
// Incomplete qualification is deliberately non-green, even when all implemented scenarios pass.
process.exitCode = reports.length === 2 && reports.every((r) => r.complete) ? 0 : 2;
