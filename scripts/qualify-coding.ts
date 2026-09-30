#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import type { AgentEvent } from "../src/agent/agent-types";
import { operatorStatusOf } from "../src/agent/lean-agent-adapter";
import { codingRunMetadata } from "../src/coding/task-run";
import { Engine } from "../src/engine/engine";
import { getErrorMessage } from "../src/engine/errors";
import { Logger } from "../src/engine/logger";
import { grant } from "../src/engine/safety-gates";
import { spentTodayUsd } from "../src/engine/spend-ledger";
import { closeWorldMemoryService } from "../src/memory/world-service";
import { setEndpointConfig } from "../src/net/model-endpoint";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import { MarinaClient } from "../src/sdk/client";
import { type EntityId, roomId } from "../src/types";
import { scopeProcessState, scopeProperty } from "../test/process-state";
import { evaluationBudgetFetch } from "./research/memory-evaluation-budget";

const SCENARIOS = ["bugfix", "feature", "refactor"] as const;
export type CodingScenario = (typeof SCENARIOS)[number];
export interface CodingQualificationOptions {
  directory: string;
  budgetUsd: number;
  scenarios?: CodingScenario[];
  timeoutMs?: number;
}

export function validateCodingQualification(options: CodingQualificationOptions): void {
  if (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0 || options.budgetUsd > 2)
    throw new Error("Use an explicit --budget-usd greater than 0 and at most 2");
  if (!options.directory) throw new Error("Use --directory PRIVATE_PATH outside the repository");
  const timeout = options.timeoutMs ?? 240_000;
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600_000)
    throw new Error("Timeout must be 1000..600000 ms per scenario");
  const scenarios = options.scenarios ?? ["bugfix"];
  if (
    !scenarios.length ||
    scenarios.length > 3 ||
    new Set(scenarios).size !== scenarios.length ||
    scenarios.some((s) => !SCENARIOS.includes(s))
  )
    throw new Error("Choose distinct scenarios: bugfix, feature, refactor");
  // Resolve the nearest existing parent as well: a symlink must not put a report
  // or disposable model-edited workspace inside the public source checkout.
  let parent = resolve(options.directory);
  const suffix: string[] = [];
  for (;;) {
    try {
      parent = realpathSync(parent);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      suffix.unshift(parent.slice(dirname(parent).length + 1));
      parent = dirname(parent);
    }
  }
  const output = resolve(parent, ...suffix);
  const project = realpathSync(resolve(import.meta.dir, ".."));
  const path = relative(project, output);
  if (!path || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path)))
    throw new Error("Qualification output must be outside the public repository");
}

/** The initial fixtures are deliberately dependency-free. These are small
 * functional journeys, not a benchmark of general coding capability. */
export function codingQualificationFixture(scenario: CodingScenario) {
  const source = `export function paginate<T>(items: readonly T[], page: number, size: number): T[] {
  if (!Number.isInteger(page) || page < 1) throw new RangeError("page");
  if (!Number.isInteger(size) || size < 1) throw new RangeError("size");
  const start = (page - 1) * size;
  return items.slice(start, start + size${scenario === "bugfix" ? " - 1" : ""});
}
`;
  const tests = `import { expect, test } from "bun:test";
import { paginate } from "./source";
test("full pages and final partial page", () => {
  expect(paginate([1,2,3,4,5], 1, 2)).toEqual([1,2]);
  expect(paginate([1,2,3,4,5], 3, 2)).toEqual([5]);
});
test("invalid arguments", () => {
  expect(() => paginate([], 0, 2)).toThrow(RangeError);
  expect(() => paginate([], 1, 0)).toThrow(RangeError);
});
`;
  const task = {
    bugfix:
      "Repair the pagination boundary bug in source.ts. Add regression tests for size=1, empty input, and a page beyond the end.",
    feature:
      "Add an exported totalPages(itemCount, size) function to source.ts: return the ceiling of nonnegative integer itemCount divided by positive integer size, including zero for no items. Reject invalid arguments with RangeError. Add tests, including fractional and negative inputs.",
    refactor:
      "Refactor the duplicated positive-integer validation in paginate into an internal reusable helper. Preserve the exported API, errors, and behavior. Add tests for fractional arguments and ensure input arrays are never mutated.",
  }[scenario];
  return {
    source,
    tests,
    task: `${task} Do not change acceptance.test.ts or package.json. Add the tests in a new regression.test.ts file. Use Marina's normal coding tools, run candidate verification with code verify candidate (marina_code action=verify, verificationMode=candidate), inspect the completed receipt, and submit a code summary with actual results. Do not commit, spawn helpers, or approve your own work.`,
  };
}

async function processResult(command: string[], cwd: string) {
  const child = Bun.spawn(command, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      LANG: "C.UTF-8",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

function passingTests(output: string): number {
  return Number(output.match(/\b(\d+) pass\b/)?.[1] ?? 0);
}

/** Real native worker, real WS ingress, existing task/artifact ledgers. The
 * harness supplies the task and later performs an independent owner review;
 * it never makes the worker's edits, checks or summary for it. Run standalone:
 * process-wide policy/fetch scopes must not overlap another running world. */
export async function qualifyCoding(options: CodingQualificationOptions) {
  validateCodingQualification(options);
  if (!process.env.OPENAI_API_KEY)
    throw new Error("OPENAI_API_KEY is unavailable; no live qualification was run");
  const directory = resolve(options.directory);
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  // Published non-batch rates, checked 2026-09-29:
  // https://developers.openai.com/api/docs/models/gpt-4.1-mini
  // Byte-based reservations deliberately overestimate text token counts; the
  // existing gate refuses alternate models/endpoints and retains lost replies.
  const spending = new Proxy(
    {
      ceiling: options.budgetUsd,
      reserved: 0,
      attempts: 0,
      maxAttempts: 40 * (options.scenarios?.length ?? 1),
      model: "gpt-4.1-mini-2025-04-14",
      outputLimit: 2000,
      inputLimit: 131072,
      inputPerMillion: 0.4,
      outputPerMillion: 1.6,
    },
    {
      set(target, property, value) {
        Reflect.set(target, property, value);
        const temporary = join(directory, "spending.pending.json");
        writeFileSync(temporary, JSON.stringify(target, null, 2), { mode: 0o600 });
        renameSync(temporary, join(directory, "spending.json"));
        return true;
      },
    },
  );
  writeFileSync(join(directory, "spending.json"), JSON.stringify(spending, null, 2), {
    mode: 0o600,
  });
  using _state = scopeProcessState({
    trustProfile: "shared",
    env: {
      WS_HOST: "127.0.0.1",
      MARINA_CODE_ROOTS: directory,
      MARINA_CODE_DEFAULT_ROOT: directory,
      MARINA_AUTONOMY: "guarded",
      MARINA_CHALLENGES: "off",
      MARINA_ROOM_AGENTS: "false",
      MARINA_DAILY_SPEND_CAP_USD: String(options.budgetUsd),
    },
  });
  using _network = scopeProperty(
    globalThis,
    "fetch",
    evaluationBudgetFetch(globalThis.fetch, spending),
  );
  await using cleanup = new AsyncDisposableStack();
  const db = new MarinaDB(join(directory, "world.db"));
  cleanup.defer(() => db.close());
  cleanup.defer(() => closeWorldMemoryService(db));
  db.setSetting("default_model", `openai/${spending.model}`);
  setEndpointConfig(db, {
    mode: "passthru",
    fallback: false,
    passthruModel: `openai/${spending.model}`,
  });
  const engine = new Engine({
    db,
    startRoom: roomId("coding-qualification/start"),
    tickInterval: 100,
    logger: new Logger({ level: "error" }),
  });
  cleanup.defer(async () => {
    engine.stop();
    await engine.drainCommands();
    await engine.shutdown();
  });
  engine.registerRoom(roomId("coding-qualification/start"), {
    short: "Coding workshop",
    long: "Disposable live coding qualification",
    exits: {},
  });
  const server = new WebSocketServer(engine, 0);
  server.setDb(db);
  cleanup.defer(() => server.stop());
  server.start();
  engine.agentRuntime.setWsPort(server.getPort());
  engine.start();
  const url = `ws://127.0.0.1:${server.getPort()}`;
  const owner = new MarinaClient(url, { autoReconnect: false, pingInterval: 0 });
  const peer = new MarinaClient(url, { autoReconnect: false, pingInterval: 0 });
  cleanup.defer(() => {
    owner.disconnect();
    peer.disconnect();
  });
  cleanup.defer(() => engine.agentRuntime.stopAll());
  const traces: { scenario: string; event: AgentEvent }[] = [];
  const messages: string[] = [];
  owner.onPerception((p) => messages.push(String(p.data.text ?? "")));
  const report: Record<string, unknown> = {
    schema: "marina.coding.qualification.v1",
    passed: false,
    provider: `openai/${spending.model}`,
    model_loop: "native Marina worker",
    scenarios: [],
    limits: "Small dependency-free fixtures; no general coding-quality or hermetic-build claim.",
  };
  const started = Date.now();
  const workers: { name: string; recordedCostUsd: number }[] = [];
  try {
    await owner.connect("CodingOwner");
    await peer.connect("WorldPeer");
    const ownerId = owner.getSession()!.entityId as EntityId;
    grant(db, ownerId, "code.exec");
    for (const scenario of options.scenarios ?? ["bugfix"]) {
      const fixture = codingQualificationFixture(scenario);
      const root = join(directory, scenario);
      mkdirSync(root, { mode: 0o700 });
      writeFileSync(join(root, "source.ts"), fixture.source);
      writeFileSync(join(root, "acceptance.test.ts"), fixture.tests);
      const pkg = JSON.stringify({ private: true, scripts: { test: "bun test" } });
      writeFileSync(join(root, "package.json"), pkg);
      writeFileSync(join(root, ".gitignore"), "node_modules/\n");
      const git = async (...args: string[]) => {
        const result = await processResult(
          [
            "git",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "user.name=Qualification",
            "-c",
            "user.email=qualification@example.invalid",
            ...args,
          ],
          root,
        );
        assert.equal(result.code, 0, result.stderr);
      };
      await git("init", "--quiet", "--template=");
      await git("add", ".");
      await git("commit", "--quiet", "-m", "Qualification baseline");
      const baseline = await processResult([process.execPath, "test"], root);
      assert.equal(baseline.code === 0, scenario !== "bugfix", "Fixture baseline invalid");
      await owner.command(`code workspace use ${root}`);
      await owner.command(`code start ${scenario}`);
      const sessionId = engine.entities.get(ownerId)!.properties.coding_session_id!;
      const name = `Coder${scenario}`;
      const handle = await engine.agentRuntime.spawn({
        name,
        model: "marina/default",
        role: "coder",
        goal: "Wait for your coding task assignment; do not make changes or dispatch other agents until assigned.",
        crewResponder: true,
        toolProfile: "full",
        thinkingLevel: "off",
        maxTokens: spending.outputLimit,
        budgetCalls: 40,
        promptTimeoutMs: 60_000,
        maxRetryDelayMs: 0,
        loopCycleDelay: 200,
      });
      const unsubscribe = handle.subscribe((event) => traces.push({ scenario, event }));
      db.updateCodingSession(sessionId, { agent: name });
      const workerId = handle.getStatus().entityId;
      assert.ok(workerId, "Native worker failed to join the world");
      grant(db, workerId, "code.exec");
      const scenarioStarted = Date.now();
      await owner.command(`code do verification:candidate -- ${fixture.task}`);
      const run = db.listCodingRuns({ sessionId, status: "active" })[0];
      assert.ok(run, "Task dispatch did not create a canonical attempt");
      assert.equal(
        codingRunMetadata(run).verificationRequirement,
        "candidate",
        "Dispatch lost the owner completion contract",
      );
      const marker = `world-responsive-${scenario}`;
      const sent = performance.now();
      await peer.command(`tell CodingOwner ${marker}`);
      const deadline = scenarioStarted + (options.timeoutMs ?? 240_000);
      let worldLatency: number | undefined;
      while (Date.now() < deadline && db.getCodingArtifact(run.id)?.status === "active") {
        if (worldLatency === undefined && messages.some((m) => m.includes(marker)))
          worldLatency = performance.now() - sent;
        if (handle.getStatus().budgetExhausted)
          throw new Error(`${scenario}: native worker exhausted its call budget`);
        await Bun.sleep(50);
      }
      const submitted = db.getCodingArtifact(run.id)!;
      const result: Record<string, unknown> = {
        scenario,
        runId: run.id,
        status: submitted.status,
        verification: codingRunMetadata(submitted).verification,
        verification_requirement: codingRunMetadata(submitted).verificationRequirement,
        verification_feedback_count: db
          .listCodingEvents(sessionId, 1000)
          .filter((event) => event.kind === "verification_required").length,
        elapsed_ms: Date.now() - scenarioStarted,
        world_message_latency_ms: worldLatency,
        worker: handle.getStatus(),
      };
      (report.scenarios as unknown[]).push(result);
      assert.equal(
        submitted.status,
        "submitted",
        `${scenario}: worker did not submit before timeout`,
      );
      assert.equal(
        codingRunMetadata(submitted).verification,
        "passed",
        `${scenario}: missing passing candidate-bound evidence`,
      );
      assert.ok(
        worldLatency !== undefined,
        "Independent world communication did not arrive during work",
      );
      // Checks cannot be made green by weakening the provided acceptance suite.
      assert.equal(readFileSync(join(root, "acceptance.test.ts"), "utf8"), fixture.tests);
      assert.equal(readFileSync(join(root, "package.json"), "utf8"), pkg);
      assert.notEqual(readFileSync(join(root, "source.ts"), "utf8"), fixture.source);
      const regressionFiles = readdirSync(root, { recursive: true }).filter(
        (path) =>
          typeof path === "string" &&
          /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) &&
          path !== "acceptance.test.ts",
      );
      assert.ok(regressionFiles.length, `${scenario}: no model-authored regression test file`);
      const checkOutputs = db
        .listCodingArtifacts(sessionId)
        .filter((artifact) => artifact.kind === "command_output")
        .map((artifact) => artifact.content_text)
        .join("\n");
      assert.ok(
        passingTests(checkOutputs) > passingTests(baseline.stdout + baseline.stderr),
        `${scenario}: verification did not execute additional passing tests`,
      );
      result.regression_files = regressionFiles;
      result.passing_tests = passingTests(checkOutputs);
      const holdout = join(directory, `holdout-${scenario}.ts`);
      writeFileSync(
        holdout,
        `import { strict as assert } from "node:assert";
import * as source from ${JSON.stringify(join(root, "source.ts"))};
for (let length=0; length<19; length++) for (let size=1; size<7; size++) for (let page=1; page<8; page++) {
  const items=Array.from({length},(_,i)=>i); const before=[...items];
  assert.deepEqual(source.paginate(items,page,size),items.slice((page-1)*size,page*size)); assert.deepEqual(items,before);
}
for (const invalid of [0,-1,1.5,NaN,Infinity]) {
  assert.throws(()=>source.paginate([],invalid,2),RangeError); assert.throws(()=>source.paginate([],1,invalid),RangeError);
}
${scenario === "feature" ? "for (let count=0;count<50;count++) for(let size=1;size<8;size++) assert.equal(source.totalPages(count,size),Math.ceil(count/size)); for(const invalid of [-1,1.5,NaN,Infinity]) assert.throws(()=>source.totalPages(invalid,2),RangeError); for(const invalid of [0,-1,1.5,NaN,Infinity]) assert.throws(()=>source.totalPages(2,invalid),RangeError);" : ""}
console.log("Independent pagination contract passed");
`,
        { mode: 0o600 },
      );
      const heldoutResult = await processResult([process.execPath, holdout], directory);
      result.independent_check = heldoutResult;
      assert.equal(
        heldoutResult.code,
        0,
        `${scenario}: independent contract failed: ${heldoutResult.stderr}`,
      );
      await owner.command(`code review approve ${run.id}`, { codingTarget: { sessionId } });
      assert.equal(db.getTask(codingRunMetadata(submitted).taskId)?.status, "completed");
      result.review = "Canonical owner approval after independent deterministic contract checks";
      result.passed = true;
      workers.push({ name, recordedCostUsd: operatorStatusOf(handle)?.totalCostUsd ?? 0 });
      unsubscribe();
      await engine.agentRuntime.stop(name);
    }
    assert.ok(spending.attempts > 0, "No actual provider request occurred");
    report.passed = true;
  } catch (error) {
    report.error = getErrorMessage(error);
  } finally {
    report.spending = {
      ...spending,
      recorded_usd: spentTodayUsd(),
      estimated_completed_turn_cost_usd: traces.reduce(
        (sum, { event }) =>
          event.type === "turn_end"
            ? sum +
              ((event.inputTokens ?? 0) * spending.inputPerMillion +
                (event.cacheReadTokens ?? 0) * 0.1 +
                (event.cacheWriteTokens ?? 0) * spending.inputPerMillion +
                (event.outputTokens ?? 0) * spending.outputPerMillion) /
                1_000_000
            : sum,
        0,
      ),
      workers,
      accounting:
        "Reservations cover all attempted requests, including discovery and ambiguous failures. Completed-turn estimate applies published token rates to reported usage; it is not an invoice. Recorded cost is best-effort provider accounting and can be zero for an unpriced model, not evidence of free requests.",
    };
    report.elapsed_ms = Date.now() - started;
    writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    writeFileSync(join(directory, "traces.json"), JSON.stringify(traces), { mode: 0o600 });
    writeFileSync(join(directory, "transcript.json"), JSON.stringify(messages), { mode: 0o600 });
    // Persist the outcome before shutdown: a broken worker's own checkpoint
    // cleanup must not erase the evidence explaining its failure.
    await cleanup.disposeAsync();
  }
  return report;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      directory: { type: "string" },
      "budget-usd": { type: "string" },
      scenarios: { type: "string", default: "bugfix" },
      "timeout-ms": { type: "string" },
    },
  });
  const timeoutMs = values["timeout-ms"] ? Number(values["timeout-ms"]) : 240_000;
  const watchdog = setTimeout(
    () => {
      console.error(
        "Coding qualification exceeded its total lifecycle deadline; inspect the private report and world DB. No live success claimed.",
      );
      process.exit(1);
    },
    Math.min(1_860_000, timeoutMs * values.scenarios!.split(",").length + 60_000),
  );
  const report = await qualifyCoding({
    directory: values.directory ?? "",
    budgetUsd: Number(values["budget-usd"]),
    scenarios: values.scenarios!.split(",") as CodingScenario[],
    timeoutMs,
  });
  clearTimeout(watchdog);
  console.log(
    JSON.stringify({
      passed: report.passed,
      error: report.error,
      report: join(resolve(values.directory!), "report.json"),
      spending: report.spending,
    }),
  );
  if (!report.passed) process.exitCode = 1;
}
