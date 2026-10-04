#!/usr/bin/env bun
// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
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
import { BUN_PREPARATION_POLICY } from "../src/coding/candidate-dependencies";
import { LocalWorkspace } from "../src/coding/local-workspace";
import type { ProjectInstructions } from "../src/coding/project-instructions";
import { codingRunMetadata } from "../src/coding/task-run";
import { Engine } from "../src/engine/engine";
import { getErrorMessage } from "../src/engine/errors";
import { Logger } from "../src/engine/logger";
import { grant } from "../src/engine/safety-gates";
import { spentTodayUsd } from "../src/engine/spend-ledger";
import { closeWorldMemoryService } from "../src/memory/world-service";
import { DashboardBroadcaster } from "../src/net/dashboard-ws";
import { setEndpointConfig } from "../src/net/model-endpoint";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import type { CodingEventRow } from "../src/persistence/db-coding";
import { MarinaClient } from "../src/sdk/client";
import { codingDesk } from "../src/sdk/coding-desk";
import { MarinaPanelClient } from "../src/sdk/panel-client";
import { type EntityId, roomId } from "../src/types";
import { scopeProcessState, scopeProperty } from "../test/process-state";
import type { TerminalPanelState } from "./code-panel-form";
import { CodePanels } from "./code-panels";
import {
  codingRepositoryFixture,
  codingRepositoryHoldout,
} from "./coding-qualification-repository";
import {
  type EvaluationRequestSize,
  evaluationBudgetFetch,
} from "./research/memory-evaluation-budget";

const SCENARIOS = ["bugfix", "feature", "refactor", "workspace", "marina"] as const;
export type CodingScenario = (typeof SCENARIOS)[number];
export interface CodingQualificationOptions {
  directory: string;
  budgetUsd: number;
  scenarios?: CodingScenario[];
  timeoutMs?: number;
  /** Repeat the real-repository task against a recorded local commit. */
  repositoryRevision?: string;
}

export function validateCodingQualification(options: CodingQualificationOptions): void {
  if (options.repositoryRevision && !/^[a-f0-9]{40}$/.test(options.repositoryRevision))
    throw new Error("repository-revision must be a full local Git commit ID");
  if (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0 || options.budgetUsd > 2)
    throw new Error("Use an explicit --budget-usd greater than 0 and at most 2");
  if (!options.directory) throw new Error("Use --directory PRIVATE_PATH outside the repository");
  const timeout = options.timeoutMs ?? 240_000;
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600_000)
    throw new Error("Timeout must be 1000..600000 ms per scenario");
  const scenarios = options.scenarios ?? ["bugfix"];
  if (
    !scenarios.length ||
    scenarios.length > SCENARIOS.length ||
    new Set(scenarios).size !== scenarios.length ||
    scenarios.some((s) => !SCENARIOS.includes(s))
  )
    throw new Error(`Choose distinct scenarios: ${SCENARIOS.join(", ")}`);
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
export function codingQualificationFixture(
  scenario: Exclude<CodingScenario, "workspace" | "marina">,
) {
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

/** A small real package boundary, with no registry or ambient dependency input.
 * Instructions are captured source. Holdouts are created outside the worker's
 * repository only after it submits; they are never part of its acceptance suite. */
export function codingWorkspaceFixture() {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "checkout-qualification",
      private: true,
      workspaces: ["packages/*", "apps/*"],
      scripts: { test: "bun test" },
    }),
    "packages/pricing/package.json": JSON.stringify({
      name: "@fixture/pricing",
      version: "1.0.0",
      exports: "./src/index.ts",
    }),
    "apps/checkout/package.json": JSON.stringify({
      name: "@fixture/checkout",
      version: "1.0.0",
      exports: "./src/index.ts",
      dependencies: { "@fixture/pricing": "workspace:*" },
    }),
    "bun.lock": JSON.stringify({
      lockfileVersion: 2,
      configVersion: 1,
      workspaces: {
        "": { name: "checkout-qualification" },
        "packages/pricing": { name: "@fixture/pricing", version: "1.0.0" },
        "apps/checkout": {
          name: "@fixture/checkout",
          version: "1.0.0",
          dependencies: { "@fixture/pricing": "workspace:*" },
        },
      },
      packages: {
        "@fixture/pricing": ["@fixture/pricing@workspace:packages/pricing"],
        "@fixture/checkout": ["@fixture/checkout@workspace:apps/checkout"],
      },
    }),
    ".gitignore": "node_modules/\n",
    "AGENTS.md": `This repository uses Bun workspaces. Read the nested AGENTS.md governing each package before changing it.
Keep acceptance.test.ts, package.json files, bun.lock and all AGENTS.md files unchanged.
Implement pricing in packages/pricing, and consume it through @fixture/pricing in apps/checkout.
Add a new regression.test.ts in each package's src directory. Use candidate verification with dependencies:bun; inspect its completed receipt before summarizing. No commits or self-approval.
`,
    "packages/pricing/AGENTS.md": `Pricing contract: unitCents is an integer from 0 through 1000000; quantity is an integer from 1 through 1000.
The optional discountBasisPoints is an integer from 0 through 10000, defaulting to 0. Reject invalid numeric inputs with RangeError.
Apply the discount to the full line (unitCents * quantity), then round HALF UP to the nearest integer cent ONCE. Do not round each unit. Keep arithmetic in integer cents/basis points; do not format or use decimal currency strings.
Preserve the existing two-argument lineTotal API. Add regression tests in src/regression.test.ts, including a fractional-cent discount on a multi-unit line.
`,
    "apps/checkout/AGENTS.md": `Checkout contract: accept optional discountBasisPoints on each input line and pass it to @fixture/pricing's lineTotal; do not duplicate pricing arithmetic here.
Preserve the result shape { lines: [{ sku, totalCents }], totalCents }, input SKU order, duplicate-SKU rejection, and the caller's array/objects unchanged. An omitted discount preserves current behavior.
Add regression tests in src/regression.test.ts for discounted checkout and unchanged no-discount behavior.
`,
    "packages/pricing/src/index.ts": `export function lineTotal(unitCents: number, quantity: number): number {
  if (!Number.isInteger(unitCents) || unitCents < 0 || unitCents > 1000000) throw new RangeError("unitCents");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) throw new RangeError("quantity");
  return unitCents * quantity;
}
`,
    "apps/checkout/src/index.ts": `import { lineTotal } from "@fixture/pricing";
export interface CheckoutLine { sku: string; unitCents: number; quantity: number }
export function checkout(input: readonly CheckoutLine[]) {
  const seen = new Set<string>();
  const lines = input.map((line) => {
    if (seen.has(line.sku)) throw new RangeError("duplicate sku");
    seen.add(line.sku);
    return { sku: line.sku, totalCents: lineTotal(line.unitCents, line.quantity) };
  });
  return { lines, totalCents: lines.reduce((total, line) => total + line.totalCents, 0) };
}
`,
    "acceptance.test.ts": `import { expect, test } from "bun:test";
import { lineTotal } from "./packages/pricing/src/index";
import { checkout } from "./apps/checkout/src/index";
test("existing integer pricing", () => {
  expect(lineTotal(125, 3)).toBe(375);
  expect(() => lineTotal(-1, 1)).toThrow(RangeError);
  expect(() => lineTotal(1, 0)).toThrow(RangeError);
});
test("existing checkout shape and duplicate rejection", () => {
  expect(checkout([{ sku: "b", unitCents: 125, quantity: 2 }, { sku: "a", unitCents: 20, quantity: 1 }])).toEqual({ lines: [{ sku: "b", totalCents: 250 }, { sku: "a", totalCents: 20 }], totalCents: 270 });
  expect(checkout([])).toEqual({ lines: [], totalCents: 0 });
  expect(() => checkout([{ sku: "a", unitCents: 1, quantity: 1 }, { sku: "a", unitCents: 2, quantity: 1 }])).toThrow(RangeError);
});
`,
  };
  return {
    files,
    sourcePaths: ["packages/pricing/src/index.ts", "apps/checkout/src/index.ts"],
    regressionPaths: [
      "packages/pricing/src/regression.test.ts",
      "apps/checkout/src/regression.test.ts",
    ],
    instructionPaths: ["packages/pricing/AGENTS.md", "apps/checkout/AGENTS.md"],
    task: "Add optional per-line discountBasisPoints support to lineTotal and checkout across both workspace packages. Read applicable AGENTS.md instructions for the exact validation and rounding contract. Preserve existing behavior when the discount is omitted. Add new regression.test.ts tests in each package's src directory. Do not change acceptance.test.ts, any package.json, bun.lock, or AGENTS.md. Use Marina's normal coding tools, run candidate verification with code verify candidate dependencies:bun (marina_code action=verify, verificationMode=candidate, dependencies=bun), inspect the completed receipt, then submit a code summary with actual results. Do not commit, spawn helpers, or approve your own work.",
  };
}

export function codingWorkspaceHoldout(root: string): string {
  return `import { strict as assert } from "node:assert";
import { lineTotal } from ${JSON.stringify(join(root, "packages/pricing/src/index.ts"))};
import { checkout } from ${JSON.stringify(join(root, "apps/checkout/src/index.ts"))};
// BigInt gives the owner an independent integer oracle, including half-cent ties.
for (const cents of [0,1,3,99,125,999999,1000000]) for (const quantity of [1,2,3,1000]) for (const discount of [0,1,3333,5000,9999,10000]) {
  const expected = Number((BigInt(cents) * BigInt(quantity) * BigInt(10000-discount) + 5000n) / 10000n);
  assert.equal(lineTotal(cents, quantity, discount), expected);
  const input = Object.freeze([Object.freeze({sku:"z",unitCents:cents,quantity,discountBasisPoints:discount}), Object.freeze({sku:"a",unitCents:7,quantity:2})]);
  const before = JSON.stringify(input);
  assert.deepEqual(checkout(input), {lines:[{sku:"z",totalCents:expected},{sku:"a",totalCents:14}],totalCents:expected+14});
  assert.equal(JSON.stringify(input),before);
  assert.equal(lineTotal(cents,quantity),cents*quantity);
}
for (const discount of [-1,10001,0.5,NaN,Infinity,null,"5000"]) {
  assert.throws(()=>lineTotal(125,3,discount),RangeError);
  assert.throws(()=>checkout([{sku:"a",unitCents:125,quantity:3,discountBasisPoints:discount}]),RangeError);
}
for (const [cents,quantity] of [[-1,1],[1000001,1],[1.5,1],[NaN,1],[1,0],[1,1001],[1,1.5],[1,Infinity]]) assert.throws(()=>lineTotal(cents,quantity,0),RangeError);
assert.throws(()=>checkout([{sku:"x",unitCents:1,quantity:1},{sku:"x",unitCents:1,quantity:1,discountBasisPoints:5000}]),RangeError);
assert.deepEqual(checkout([]),{lines:[],totalCents:0});
console.log("Independent workspace discount contract passed");
`;
}

/** Evidence of instruction delivery, not a claim that a model understood it. */
export function codingWorkspaceInstructionEvidence(
  events: Pick<CodingEventRow, "id" | "actor" | "kind" | "payload_json">[],
  worker: string,
) {
  const fixture = codingWorkspaceFixture();
  return fixture.instructionPaths.flatMap((path) => {
    const expected = fixture.files[path]!;
    const expectedHash = createHash("sha256").update(expected).digest("hex");
    for (const event of events) {
      if (event.actor !== worker || !["file_read", "files_listed"].includes(event.kind)) continue;
      const payload = JSON.parse(event.payload_json) as {
        path?: string;
        size?: number;
        truncated?: boolean;
        projectInstructions?: ProjectInstructions;
      };
      if (
        payload.projectInstructions?.sources.some(
          (source) =>
            source.path === path &&
            source.status === "loaded" &&
            source.excerptHash === expectedHash,
        )
      )
        return [
          { path, eventId: event.id, inspected: payload.path, delivery: "scoped-instructions" },
        ];
      if (
        event.kind === "file_read" &&
        payload.path === path &&
        payload.truncated === false &&
        payload.size === Buffer.byteLength(expected)
      )
        return [{ path, eventId: event.id, inspected: payload.path, delivery: "explicit-read" }];
    }
    return [];
  });
}

export async function runCodingQualificationProcess(command: string[], cwd: string) {
  const child = Bun.spawn(command, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      LANG: "C.UTF-8",
      HOME: cwd,
      // Baseline/holdout execution must not add transpiler .pile files to the
      // source candidate. Never ignore unexpected worker files to hide this.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
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

export function codingQualificationFailure(input: {
  status: string;
  reason?: string;
  budgetExhausted?: boolean;
  deadlineReached: boolean;
}): string | undefined {
  if (input.status === "submitted") return undefined;
  if (input.reason?.startsWith("Blocked:"))
    return `worker blocked: ${input.reason.slice(8).trim()}`;
  if (input.status !== "active")
    return `run ${input.status}${input.reason ? `: ${input.reason}` : ""}`;
  if (input.budgetExhausted) return "native worker exhausted its call budget";
  if (input.deadlineReached) return "scenario deadline reached while the run was still active";
  return `worker did not submit (run ${input.status})`;
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
  const requestSizes: EvaluationRequestSize[] = [];
  const spending = new Proxy(
    {
      ceiling: options.budgetUsd,
      reserved: 0,
      attempts: 0,
      maxAttempts: 40 * (options.scenarios?.length ?? 1),
      model: "gpt-4.1-mini-2025-04-14",
      outputLimit: options.scenarios?.includes("marina") ? 4096 : 2000,
      inputLimit: options.scenarios?.includes("marina") ? 262144 : 131072,
      inputPerMillion: 0.4,
      outputPerMillion: 1.6,
      onAttempt: (size: EvaluationRequestSize) => {
        requestSizes.push(size);
        writeFileSync(
          join(directory, "request-sizes.json"),
          JSON.stringify(requestSizes, null, 2),
          { mode: 0o600 },
        );
      },
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
      // Qualify the core coding contract in this disposable world. Do not inherit
      // an operator's optional external judge: the fixture's network policy permits
      // only its bounded coding provider. This does not test decision-gate policy.
      MARINA_DECISION_GATE: "off",
      MARINA_ROOM_AGENTS: "false",
      MARINA_DAILY_SPEND_CAP_USD: String(options.budgetUsd),
    },
  });
  let networkFailure: string | undefined;
  const budgetedFetch = evaluationBudgetFetch(globalThis.fetch, spending);
  using _network = scopeProperty(
    globalThis,
    "fetch",
    new Proxy(budgetedFetch, {
      async apply(target, receiver, args: Parameters<typeof fetch>) {
        try {
          return await Reflect.apply(target, receiver, args);
        } catch (error) {
          const message = getErrorMessage(error);
          if (/^Evaluation (refused|input budget|spending limit)/.test(message))
            networkFailure ??= message;
          throw error;
        }
      },
    }),
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
  const broadcaster = new DashboardBroadcaster();
  server.setBroadcaster(broadcaster);
  engine.addEventListener((event) => broadcaster.broadcastEvent(event));
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
    policy: {
      autonomy: "guarded",
      trust: "shared",
      decision_gate: "off (optional judge excluded from this fixture)",
      command_gates: "enforced",
    },
    scenarios: [],
    request_sizes: requestSizes,
    limits:
      "Small functional fixtures; workspace uses captured local packages only. No general coding-quality or hermetic-build claim.",
  };
  const started = Date.now();
  const workers: { name: string; recordedCostUsd: number }[] = [];
  try {
    await owner.connect("CodingOwner");
    await peer.connect("WorldPeer");
    const ownerId = owner.getSession()!.entityId as EntityId;
    grant(db, ownerId, "code.exec");
    for (const scenario of options.scenarios ?? ["bugfix"]) {
      const workspaceFixture = scenario === "workspace" ? codingWorkspaceFixture() : undefined;
      const repositoryFixture = scenario === "marina" ? codingRepositoryFixture() : undefined;
      const fixture =
        scenario !== "workspace" && scenario !== "marina"
          ? codingQualificationFixture(scenario)
          : undefined;
      const root = join(directory, scenario);
      let repositoryCommit: string | undefined;
      if (repositoryFixture) {
        const clone = await runCodingQualificationProcess(
          ["git", "clone", "--quiet", "--no-hardlinks", "--", resolve(import.meta.dir, ".."), root],
          directory,
        );
        assert.equal(clone.code, 0, clone.stderr);
        if (options.repositoryRevision) {
          const checkout = await runCodingQualificationProcess(
            ["git", "checkout", "--quiet", "--detach", options.repositoryRevision, "--"],
            root,
          );
          assert.equal(checkout.code, 0, checkout.stderr);
        }
        const head = await runCodingQualificationProcess(["git", "rev-parse", "HEAD"], root);
        assert.equal(head.code, 0, head.stderr);
        repositoryCommit = head.stdout.trim();
        report.repository_baseline = repositoryCommit;
      } else mkdirSync(root, { mode: 0o700 });
      const pkg = JSON.stringify({ private: true, scripts: { test: "bun test" } });
      const files: Record<string, string> = repositoryFixture?.files ??
        workspaceFixture?.files ?? {
          "source.ts": fixture!.source,
          "acceptance.test.ts": fixture!.tests,
          "package.json": pkg,
          ".gitignore": "node_modules/\n",
        };
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
      }
      if (workspaceFixture) {
        // The initial live checkout needs its captured workspace links too. Use
        // the same frozen preparation policy as candidate verification, with
        // no registry dependencies, scripts, or shared node_modules.
        const initialPreparation = await new LocalWorkspace(root).prepareCandidateDependencies(
          () => {},
        );
        assert.equal(initialPreparation.result.exitCode, 0, initialPreparation.result.output);
      }
      const git = async (...args: string[]) => {
        const result = await runCodingQualificationProcess(
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
      const baselineHead = repositoryFixture
        ? await runCodingQualificationProcess(["git", "rev-parse", "HEAD"], root)
        : undefined;
      if (baselineHead) assert.equal(baselineHead.code, 0, baselineHead.stderr);
      const baseline = await runCodingQualificationProcess(
        [
          process.execPath,
          "test",
          ...(repositoryFixture ? ["./.qualification/acceptance.test.ts"] : []),
        ],
        root,
      );
      assert.equal(
        baseline.code === 0,
        scenario !== "bugfix" && scenario !== "marina",
        "Fixture baseline invalid",
      );
      if (repositoryFixture) {
        const output = baseline.stdout + baseline.stderr;
        assert.ok(
          output.includes(".qualification/acceptance.test.ts:") &&
            output.includes(
              "(fail) return from paged history directly to the newest retained output",
            ) &&
            output.includes("latest"),
          "Repository baseline did not execute the expected missing-feature acceptance case",
        );
        const clean = await runCodingQualificationProcess(["git", "status", "--porcelain"], root);
        assert.equal(clean.code, 0, clean.stderr);
        assert.equal(
          clean.stdout.trim(),
          "",
          "Baseline execution dirtied the source checkout before worker dispatch",
        );
      }
      await owner.command(`code workspace use ${root}`);
      await owner.command(`code start ${scenario}`);
      const sessionId = engine.entities.get(ownerId)!.properties.coding_session_id!;
      if (repositoryFixture)
        await owner.command(`code recipe save default ${repositoryFixture.recipe}`);
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
      await owner.command(
        `code do verification:candidate -- ${repositoryFixture?.task ?? workspaceFixture?.task ?? fixture!.task}`,
      );
      const run = db.listCodingRuns({ sessionId, status: "active" })[0];
      assert.ok(run, "Task dispatch did not create a canonical attempt");
      assert.equal(
        codingRunMetadata(run).verificationRequirement,
        "candidate",
        "Dispatch lost the owner completion contract",
      );
      // An external participant publishes an ordinary desk; this is SDK composition,
      // not a claim that the model authored the UI. The native worker does the coding.
      const panels = new MarinaPanelClient({
        url: url.replace("ws:", "http:"),
        token: owner.getSession()!.token,
      });
      const publisher = new MarinaPanelClient({
        url: url.replace("ws:", "http:"),
        token: peer.getSession()!.token,
      });
      const canvas = await panels.request<{ id: string }>("/api/canvases", "POST", {
        name: `Coding desk ${scenario}`,
      });
      const publication = await publisher.publish(
        canvas.id,
        codingDesk({ sessionId, taskId: String(codingRunMetadata(run).taskId) }),
      );
      let deskState: TerminalPanelState | undefined;
      const renders: string[] = [];
      const desk = new CodePanels(
        panels,
        (text) => renders.push(text),
        async () => null,
        {
          present: (state) => {
            deskState = state;
          },
        },
      );
      cleanup.defer(() => desk.dispose());
      await desk.command(`open ${canvas.id} ${publication.id}`);
      assert.ok(deskState, "Published desk failed to open through the canonical APIs");
      desk.input({
        type: "field",
        id: "request",
        value: "Preserve my draft while the worker runs",
      });
      const beforeEvent = renders.length;
      await owner.command("code observe Coding desk live refresh proof", {
        codingTarget: { sessionId },
      });
      const refreshDeadline = Date.now() + 3000; // Shorter than the five-second recovery poll.
      while (
        !renders
          .slice(beforeEvent)
          .some((text) => text.includes("Coding desk live refresh proof")) &&
        Date.now() < refreshDeadline
      )
        await Bun.sleep(20);
      writeFileSync(join(directory, `desk-${scenario}.txt`), renders.join("\n---\n"), {
        mode: 0o600,
      });
      assert.ok(
        renders.slice(beforeEvent).some((text) => text.includes("Coding desk live refresh proof")),
        "Desk missed its live invalidation",
      );
      assert.equal(
        deskState.fields.find((field) => field.id === "request")?.value,
        "Preserve my draft while the worker runs",
      );
      await desk.command("close");
      assert.equal(
        db.getCodingSession(sessionId)?.status,
        "active",
        "Closing a view stopped its session",
      );
      assert.ok(engine.agentRuntime.get(name), "Closing a view stopped its worker");
      const deskProof = {
        publication: publication.id,
        source: "ordinary SDK publisher + terminal CodePanels",
        live_refresh: true,
        local_draft_preserved: true,
        close_preserved_worker: true,
      };
      const marker = `world-responsive-${scenario}`;
      const sent = performance.now();
      await peer.command(`tell CodingOwner ${marker}`);
      const deadline = scenarioStarted + (options.timeoutMs ?? 240_000);
      let worldLatency: number | undefined;
      while (Date.now() < deadline && db.getCodingArtifact(run.id)?.status === "active") {
        if (worldLatency === undefined && messages.some((m) => m.includes(marker)))
          worldLatency = performance.now() - sent;
        if (handle.getStatus().budgetExhausted || networkFailure) break;
        await Bun.sleep(50);
      }
      const submitted = db.getCodingArtifact(run.id)!;
      const failure =
        networkFailure ??
        codingQualificationFailure({
          status: submitted.status,
          reason: codingRunMetadata(submitted).reason,
          budgetExhausted: handle.getStatus().budgetExhausted,
          deadlineReached: Date.now() >= deadline,
        });
      const result: Record<string, unknown> = {
        scenario,
        repository_commit: repositoryCommit,
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
        failure,
        desk: deskProof,
      };
      (report.scenarios as unknown[]).push(result);
      assert.equal(submitted.status, "submitted", `${scenario}: ${failure}`);
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
      const sourcePaths = repositoryFixture?.sourcePaths ??
        workspaceFixture?.sourcePaths ?? ["source.ts"];
      for (const [path, original] of Object.entries(files)) {
        if (sourcePaths.includes(path))
          assert.notEqual(
            readFileSync(join(root, path), "utf8"),
            original,
            `${path}: source unchanged`,
          );
        else
          assert.equal(
            readFileSync(join(root, path), "utf8"),
            original,
            `${path}: fixture changed`,
          );
      }
      const regressionFiles = readdirSync(root, { recursive: true }).filter(
        (path) =>
          typeof path === "string" &&
          /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) &&
          !path.split(sep).includes("node_modules") &&
          path !== "acceptance.test.ts",
      );
      assert.ok(regressionFiles.length, `${scenario}: no model-authored regression test file`);
      if (repositoryFixture) {
        const currentHead = await runCodingQualificationProcess(["git", "rev-parse", "HEAD"], root);
        assert.equal(currentHead.code, 0, currentHead.stderr);
        assert.equal(
          currentHead.stdout,
          baselineHead!.stdout,
          "Worker changed the qualification baseline commit",
        );
        const diff = await runCodingQualificationProcess(
          ["git", "diff", "HEAD", "--name-only"],
          root,
        );
        const extra = await runCodingQualificationProcess(
          ["git", "ls-files", "--others", "--exclude-standard"],
          root,
        );
        assert.equal(diff.code, 0, diff.stderr);
        assert.equal(extra.code, 0, extra.stderr);
        const changed = `${diff.stdout}\n${extra.stdout}`.trim().split(/\s+/).filter(Boolean);
        assert.deepEqual(
          [...new Set(changed)].sort(),
          [...repositoryFixture.sourcePaths, ...repositoryFixture.regressionPaths].sort(),
          "Worker changed files outside the requested repository task",
        );
        result.changed_files = changed;
      }
      const artifacts = db.listCodingArtifacts(sessionId);
      const verificationId = codingRunMetadata(submitted).verificationId;
      const verification = artifacts.find((artifact) => artifact.id === verificationId);
      const verificationMetadata = verification ? JSON.parse(verification.metadata_json) : {};
      const checkOutputs = artifacts
        .filter((artifact) =>
          workspaceFixture || repositoryFixture
            ? verificationMetadata.artifactIds?.includes(artifact.id)
            : artifact.kind === "command_output",
        )
        .map((artifact) => artifact.content_text)
        .join("\n");
      assert.ok(
        passingTests(checkOutputs) > passingTests(baseline.stdout + baseline.stderr),
        `${scenario}: verification did not execute additional passing tests`,
      );
      result.regression_files = repositoryFixture?.regressionPaths ?? regressionFiles;
      result.passing_tests = passingTests(checkOutputs);
      if (repositoryFixture) {
        for (const path of [
          ".qualification/acceptance.test.ts",
          ...repositoryFixture.regressionPaths,
        ])
          assert.ok(
            checkOutputs.includes(`${path}:`),
            `Accepted verification did not execute ${path}`,
          );
        assert.ok(
          passingTests(checkOutputs) >= 2,
          "Accepted verification needs the fixed acceptance case and a model-authored passing regression",
        );
      }
      if (workspaceFixture) {
        const instructionEvidence = codingWorkspaceInstructionEvidence(
          db.listCodingEvents(sessionId, 1000),
          name,
        );
        result.instruction_delivery = instructionEvidence;
        assert.equal(
          instructionEvidence.length,
          workspaceFixture.instructionPaths.length,
          "Worker did not inspect both packages' complete governing instructions",
        );
        // Evidence must belong to the exact verification accepted for this run,
        // not a prior successful install or a failed attempt's extra test count.
        const preparation = artifacts.find(
          (artifact) => artifact.id === verificationMetadata.preparationArtifactId,
        );
        assert.ok(preparation, "Workspace verification omitted frozen dependency preparation");
        const preparationMetadata = JSON.parse(preparation.metadata_json);
        assert.equal(preparation.status, "complete");
        assert.equal(preparationMetadata.policy, BUN_PREPARATION_POLICY);
        assert.equal(preparationMetadata.candidateId, codingRunMetadata(submitted).candidateId);
        assert.equal(preparationMetadata.executionLocation, "candidate-materialization");
        assert.equal(
          preparationMetadata.lockfileSha256,
          createHash("sha256").update(files["bun.lock"]!).digest("hex"),
        );
        for (const path of workspaceFixture.regressionPaths) {
          assert.ok(regressionFiles.includes(path), `Missing model-authored ${path}`);
          assert.ok(checkOutputs.includes(path), `Accepted verification did not execute ${path}`);
        }
        assert.ok(
          passingTests(checkOutputs) >= passingTests(baseline.stdout + baseline.stderr) + 2,
        );
        result.dependency_preparation = preparationMetadata;
      }
      const holdout = join(directory, `holdout-${scenario}.ts`);
      writeFileSync(
        holdout,
        repositoryFixture
          ? codingRepositoryHoldout(root)
          : workspaceFixture
            ? codingWorkspaceHoldout(root)
            : `import { strict as assert } from "node:assert";
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
      const heldoutResult = await runCodingQualificationProcess(
        [process.execPath, holdout],
        directory,
      );
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
      "repository-revision": { type: "string" },
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
    repositoryRevision: values["repository-revision"],
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
