// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The reproduction kit's AutomationBench and IFBench setups: plans, arms and their
// headers, doctor checks, path placeholders, and both converters on fixtures. No
// model call, server or benchmark run (the IFBench request loop runs on a fake fetch).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTOMATION_BENCHMARK,
  AUTOMATION_TASKS,
  type AutomationExport,
  automationToHarness,
} from "../benchmarks/automation/convert";
import {
  answerAll,
  gradedFileFor,
  IFBENCH_BENCHMARK,
  type IfbenchInput,
  ifbenchToHarness,
  parseHeaderFlags,
  parseJsonl,
  subsetInputs,
} from "../benchmarks/ifbench/ifbench";
import { blocking, doctor, type Probe } from "../benchmarks/repro/doctor";
import { budgetRefusal, expand, planPaths, renderPlan } from "../benchmarks/repro/run";
import {
  BENCH_ARM_ENTITY,
  DEFAULT_STACK_MEMBERS,
  LEDGER_KEY,
  setupNamed,
  stackHeaderFor,
} from "../benchmarks/repro/setups";
import type { CommandStep, Plan, ReproFlags, ServerStep } from "../benchmarks/repro/types";
import { isFeatureEnvName } from "../src/engine/feature-env";
import { parseEvalHeader } from "../src/learning/eval-context";
import { DEFAULT_STACK, parseStackHeader } from "../src/net/model-api/stack";
import { scopeProcessState } from "./process-state";

function probe(over: Partial<Probe> = {}): Probe {
  return {
    env: {},
    which: () => false,
    run: () => undefined,
    readFile: () => undefined,
    disk: () => ({ freeBytes: 500 * 1024 ** 3, fsType: "ext4" }),
    exists: () => false,
    home: "/home/u",
    user: "u",
    ...over,
  };
}

const flags = (over: Partial<ReproFlags> = {}): ReproFlags => ({
  replicates: 2,
  budgetUsd: 10,
  seed: 42,
  runDir: "/runs/x",
  ledgerDb: "/runs/x/ledger.db",
  ...over,
});

const commands = (plan: Plan) => plan.steps.filter((s): s is CommandStep => s.kind === "command");
const servers = (plan: Plan) => plan.steps.filter((s): s is ServerStep => s.kind === "server");
const argAfter = (c: CommandStep, flag: string) => c.argv[c.argv.indexOf(flag) + 1];
/** Every value of a repeatable flag. */
const allAfter = (c: CommandStep, flag: string) =>
  c.argv.flatMap((a, i) => (a === flag ? [c.argv[i + 1]!] : []));

describe("instrument-stack arms", () => {
  it("`on` names exactly the server's identified-caller default stack", () => {
    expect([...DEFAULT_STACK_MEMBERS] as string[]).toEqual([...DEFAULT_STACK]);
    const on = parseStackHeader(stackHeaderFor("on"));
    expect(on?.kind).toBe("list");
    expect(on?.kind === "list" ? [...on.members] : []).toEqual([...DEFAULT_STACK]);
    expect(parseStackHeader(stackHeaderFor("bare"))?.kind).toBe("none");
    expect(parseStackHeader(stackHeaderFor("full"))?.kind).toBe("full");
    expect(() => stackHeaderFor("verify")).toThrow(/no instrument stack/);
  });
});

describe("repro plans: automation and ifbench", () => {
  let state: DisposableStack | undefined;
  beforeEach(() => {
    const cleared = Object.fromEntries(
      Object.keys(process.env)
        .filter(isFeatureEnvName)
        .map((k) => [k, undefined]),
    );
    state = scopeProcessState({ env: cleared });
  });
  afterEach(() => {
    state?.dispose();
    state = undefined;
  });

  it("automation smoke: one auto-bench per task, one per domain, per arm and replicate", () => {
    const plan = setupNamed("automation")!.plan(flags({ replicates: 1 }), "frontier");
    expect(plan.arms).toEqual(["bare", "on"]);
    expect(plan.limit).toBe(6);
    const runs = commands(plan).filter((c) => c.argv[0] === "$AUTOMATIONBENCH_BIN");
    expect(runs.length).toBe(12);
    const bareTasks = runs
      .filter((c) => c.label.startsWith("bare"))
      .map((c) => argAfter(c, "--tasks"));
    expect(bareTasks).toEqual(AUTOMATION_TASKS.slice(0, 6));
    expect(new Set(bareTasks.map((t) => t!.split(".")[0])).size).toBe(6);
    for (const c of runs) {
      expect(argAfter(c, "--domains")).toBe(argAfter(c, "--tasks")!.split(".")[0]);
      expect(argAfter(c, "--api")).toBe("chat_completions");
      expect(argAfter(c, "--num-examples")).toBe("1");
      expect(argAfter(c, "--max-concurrent")).toBe("1");
      expect(argAfter(c, "--max-steps")).toBe("50");
      expect(argAfter(c, "--toolset")).toBe("api");
      expect(argAfter(c, "--reasoning-effort")).toBe("medium");
      expect(c.argv).toContain("--no-ensure-complete");
      // The key travels in the environment only, never argv.
      expect(c.env).toEqual({ OPENAI_API_KEY: LEDGER_KEY });
      expect(c.argv.join(" ")).not.toContain(LEDGER_KEY);
    }
    // Each arm its own server, bound to the bench entity (an identified caller).
    const srv = servers(plan);
    expect(srv.map((s) => s.id)).toEqual(["automation-bare", "automation-on"]);
    for (const s of srv) expect(s.env.MODEL_API_KEYS).toBe(`${LEDGER_KEY}:${BENCH_ARM_ENTITY}`);
    const bare = runs.find((c) => c.label.startsWith("bare"))!;
    const on = runs.find((c) => c.label.startsWith("on"))!;
    expect(argAfter(bare, "--base-url")).toBe(`http://localhost:${srv[0]!.port}/v1`);
    expect(argAfter(on, "--base-url")).toBe(`http://localhost:${srv[1]!.port}/v1`);
    expect(allAfter(bare, "--headers")).toEqual([
      "x-marina-stack=none",
      "x-marina-eval=benchmark=automationbench; mode=measure",
    ]);
    expect(allAfter(on, "--headers")[0]).toBe(`x-marina-stack=${DEFAULT_STACK_MEMBERS.join(",")}`);
    // The eval header parses as a measurement of the ledger's own benchmark id.
    const evalValue = allAfter(on, "--headers")[1]!.slice("x-marina-eval=".length);
    expect(parseEvalHeader(evalValue)).toEqual({
      benchmark: AUTOMATION_BENCHMARK,
      mode: "measure",
    });
  });

  it("automation converts with --require-clean, imports per replicate and compares on vs bare", () => {
    const plan = setupNamed("automation")!.plan(flags(), "frontier");
    const converts = commands(plan).filter((c) => c.argv[1] === "scripts/automationbench.ts");
    expect(converts.length).toBe(4);
    for (const c of converts) {
      expect(c.argv).toContain("--require-clean");
      expect(argAfter(c, "--expect")!.split(",").length).toBe(6);
    }
    const imports = commands(plan).filter((c) => c.argv[1] === "scripts/benchmark-import.ts");
    expect(imports.map((c) => argAfter(c, "--group"))).toEqual([
      "automation-bare",
      "automation-bare",
      "automation-on",
      "automation-on",
    ]);
    expect(JSON.parse(argAfter(imports[2]!, "--target")!)).toEqual({
      model: "openrouter/openai/gpt-6.1-sol",
      stack: "lessons,obligations,argcheck,learn",
    });
    for (const c of imports) expect(c.env).toEqual({ DB_PATH: "/runs/x/ledger.db" });
    // Every import file is the file its convert step wrote.
    expect(imports.map((c) => c.argv[2])).toEqual(converts.map((c) => argAfter(c, "--out")));
    expect(plan.steps.filter((s) => s.kind === "compare")).toEqual([
      { kind: "compare", benchmark: "automationbench", a: "automation-on", b: "automation-bare" },
    ]);
  });

  it("ifbench smoke: answer, official grader, convert, import — key in env only", () => {
    const plan = setupNamed("ifbench")!.plan(flags({ replicates: 1 }), "frontier");
    expect(plan.arms).toEqual(["bare", "on"]);
    expect(plan.limit).toBe(20);
    const cmds = commands(plan);
    const answers = cmds.filter((c) => c.argv[2] === "answer");
    expect(answers.length).toBe(2);
    for (const a of answers) {
      expect(argAfter(a, "--input")).toBe("$IFBENCH_INPUT");
      expect(argAfter(a, "--limit")).toBe("20");
      expect(a.env).toEqual({ MARINA_BENCH_API_KEY: LEDGER_KEY });
      expect(a.argv.join(" ")).not.toContain(LEDGER_KEY);
    }
    expect(allAfter(answers[0]!, "--header")).toEqual([
      "x-marina-stack=none",
      "x-marina-eval=benchmark=ifbench; mode=measure",
    ]);
    expect(allAfter(answers[1]!, "--header")[0]).toBe(
      "x-marina-stack=lessons,obligations,argcheck,learn",
    );
    const grader = cmds.find((c) => c.argv[0] === "$IFBENCH_PYTHON")!;
    expect(grader.cwd).toBe("$IFBENCH_HOME");
    expect(grader.argv.slice(1, 3)).toEqual(["-m", "run_eval"]);
    expect(grader.argv).toContain("--input_data=/runs/x/results/ifbench-bare-r1/input.jsonl");
    // The grader grades exactly the subset the answer step wrote.
    expect(argAfter(answers[0]!, "--subset-out")).toBe(
      "/runs/x/results/ifbench-bare-r1/input.jsonl",
    );
    const convert = cmds.find((c) => c.argv[2] === "convert")!;
    expect(convert.argv).toContain("--require-clean");
    expect(argAfter(convert, "--mode")).toBe("strict");
    for (const s of servers(plan)) {
      expect(s.env.MODEL_API_KEYS).toBe(`${LEDGER_KEY}:${BENCH_ARM_ENTITY}`);
    }
    const groups = cmds
      .filter((c) => c.argv[1] === "scripts/benchmark-import.ts")
      .map((c) => argAfter(c, "--group"));
    expect(groups).toEqual(["ifbench-bare", "ifbench-on"]);
    expect(plan.steps.at(-1)).toEqual({
      kind: "compare",
      benchmark: IFBENCH_BENCHMARK,
      a: "ifbench-on",
      b: "ifbench-bare",
    });
  });

  it("`full` runs only when named, sending x-marina-stack: full", () => {
    for (const name of ["automation", "ifbench"]) {
      const setup = setupNamed(name)!;
      expect(setup.plan(flags(), "frontier").arms).not.toContain("full");
      const plan = setup.plan(flags({ arms: ["bare", "full"], replicates: 1 }), "frontier");
      expect(plan.arms).toEqual(["bare", "full"]);
      const flag = name === "automation" ? "--headers" : "--header";
      const full = commands(plan).filter(
        (c) => c.label.startsWith("full") && c.argv.includes(flag),
      );
      expect(full.length).toBeGreaterThan(0);
      for (const c of full) expect(allAfter(c, flag)[0]).toBe("x-marina-stack=full");
      expect(plan.steps.find((s) => s.kind === "compare")).toMatchObject({
        a: `${name}-full`,
        b: `${name}-bare`,
      });
    }
  });

  it("--limit takes the first N tasks or prompts, and the automation list caps it", () => {
    const auto = setupNamed("automation")!.plan(flags({ limit: 9, replicates: 1 }), "frontier");
    const tasks = commands(auto)
      .filter((c) => c.label.startsWith("bare") && c.argv[0] === "$AUTOMATIONBENCH_BIN")
      .map((c) => argAfter(c, "--tasks"));
    expect(tasks).toEqual(AUTOMATION_TASKS.slice(0, 9));
    expect(AUTOMATION_TASKS.length).toBe(24);
    expect(new Set(AUTOMATION_TASKS).size).toBe(24);
    expect(() => setupNamed("automation")!.plan(flags({ limit: 25 }), "frontier")).toThrow(
      /exceeds the 24 tasks/,
    );
    const ifb = setupNamed("ifbench")!.plan(flags({ limit: 150 }), "frontier");
    expect(ifb.limit).toBe(150);
    expect(argAfter(commands(ifb).find((c) => c.argv[2] === "answer")!, "--limit")).toBe("150");
  });

  it("estimates per arm and refuses over budget; dry-run text hides the key", () => {
    const auto = setupNamed("automation")!;
    // 6 tasks × 2 replicates × ($0.12 + $0.45)
    const smoke = auto.plan(flags(), "frontier");
    expect(smoke.estimateUsd).toBeCloseTo(6 * 2 * 0.57, 6);
    expect(budgetRefusal(smoke, 10)).toBeUndefined();
    const full = auto.plan(flags({ limit: 24, arms: ["bare", "on", "full"] }), "frontier");
    expect(full.estimateUsd).toBeCloseTo(24 * 2 * (0.12 + 0.45 + 0.6), 6);
    expect(budgetRefusal(full, 10)).toMatch(/exceeds --budget-usd/);
    const ifb = setupNamed("ifbench")!.plan(flags({ limit: 150 }), "frontier");
    expect(ifb.estimateUsd).toBeCloseTo(150 * 2 * 0.03, 6);
    expect(setupNamed("ifbench")!.plan(flags(), "single-local").estimateUsd).toBe(0);
    for (const plan of [smoke, full, ifb]) {
      const text = renderPlan(plan, 10);
      expect(text).not.toContain(LEDGER_KEY);
      expect(text).toContain("x-marina-stack=");
    }
  });

  it("each server's spend cap is an even share of the budget", () => {
    const plan = setupNamed("ifbench")!.plan(
      flags({ arms: ["bare", "on", "full"], budgetUsd: 9 }),
      "frontier",
    );
    expect(servers(plan).map((s) => s.env.MARINA_DAILY_SPEND_CAP_USD)).toEqual(["3", "3", "3"]);
  });
});

describe("repro doctor: automation and ifbench", () => {
  const checkOf = (p: Probe, id: string) =>
    doctor(p, { runDir: "/runs", only: [id] }).checks.find((c) => c.id === id)!;

  it("each setup requires its harness checks", () => {
    expect(setupNamed("automation")!.requires).toContain("automationbench");
    expect(setupNamed("ifbench")!.requires).toEqual(
      expect.arrayContaining(["ifbench", "ifbench-input"]),
    );
  });

  it("AUTOMATIONBENCH_BIN must name an executable, with the fix", () => {
    const unset = checkOf(probe(), "automationbench");
    expect(unset.status).toBe("missing");
    expect(unset.detail).toContain("AUTOMATIONBENCH_BIN not set");
    expect(unset.fix).toContain("export AUTOMATIONBENCH_BIN=");
    const notExec = checkOf(
      probe({
        env: { AUTOMATIONBENCH_BIN: "/opt/ab/bin/auto-bench" },
        exists: () => true,
        executable: () => false,
      }),
      "automationbench",
    );
    expect(notExec.status).toBe("missing");
    expect(notExec.detail).toContain("not executable");
    const ok = checkOf(
      probe({
        env: { AUTOMATIONBENCH_BIN: "/opt/ab/bin/auto-bench" },
        executable: (p) => p === "/opt/ab/bin/auto-bench",
      }),
      "automationbench",
    );
    expect(ok.status).toBe("ok");
  });

  it("IFBENCH_HOME needs run_eval.py and IFBENCH_INPUT must exist", () => {
    const { checks } = doctor(probe(), { runDir: "/runs", only: setupNamed("ifbench")!.requires });
    const missing = blocking(checks).map((c) => c.id);
    expect(missing).toEqual(expect.arrayContaining(["ifbench", "ifbench-input"]));
    expect(checks.find((c) => c.id === "ifbench")!.fix).toContain("export IFBENCH_HOME=");
    expect(checks.find((c) => c.id === "ifbench-input")!.fix).toContain("export IFBENCH_INPUT=");
    const files = new Set(["/opt/ifb/run_eval.py", "/data/in.jsonl"]);
    const ok = doctor(
      probe({
        env: { IFBENCH_HOME: "/opt/ifb", IFBENCH_INPUT: "/data/in.jsonl" },
        exists: (p) => files.has(p),
      }),
      { runDir: "/runs", only: ["ifbench", "ifbench-input"] },
    ).checks;
    expect(ok.find((c) => c.id === "ifbench")!.status).toBe("ok");
    expect(ok.find((c) => c.id === "ifbench")!.detail).toContain("python3");
    expect(ok.find((c) => c.id === "ifbench-input")!.status).toBe("ok");
  });

  it("plan placeholders expand to the operator's paths; the grader prefers the checkout venv", () => {
    const env = {
      AUTOMATIONBENCH_BIN: "/opt/ab/bin/auto-bench",
      IFBENCH_HOME: "/opt/ifb",
      IFBENCH_INPUT: "/data/in.jsonl",
    };
    const withVenv = planPaths(env, (p) => p === "/opt/ifb/.venv/bin/python");
    expect(withVenv.IFBENCH_PYTHON).toBe("/opt/ifb/.venv/bin/python");
    expect(planPaths(env, () => false).IFBENCH_PYTHON).toBe("python3");
    const vars = { LEDGER_KEY: "k", ...withVenv };
    expect(expand("$AUTOMATIONBENCH_BIN", vars)).toBe("/opt/ab/bin/auto-bench");
    expect(expand("$IFBENCH_INPUT", vars)).toBe("/data/in.jsonl");
    expect(expand("$IFBENCH_HOME", vars)).toBe("/opt/ifb");
    expect(expand(`${LEDGER_KEY}:${BENCH_ARM_ENTITY}`, vars)).toBe(`k:${BENCH_ARM_ENTITY}`);
  });
});

function exportOf(
  name: string,
  over: Partial<NonNullable<AutomationExport["tasks"]>[number]> = {},
) {
  return {
    path: `/r/${name}.json`,
    data: {
      meta: {
        timestamp: "2026-10-11T12:00:00",
        model: "openrouter/openai/gpt-6.1-sol",
        duration_seconds: 42.5,
        benchmark_version: "1.2.0",
        reasoning_effort: "medium",
        toolset: "api",
      },
      summary: { aborted_tasks: [] },
      tasks: [
        {
          name,
          score: 0.875,
          passed: false,
          assertions_total: 8,
          assertions_passed: 7,
          num_model_calls: 9,
          cost: 0.11,
          messages: [{ role: "user", content: "SECRET TASK TEXT" }],
          ...over,
        },
      ],
    } as AutomationExport,
  };
}

describe("automationbench converter", () => {
  it("files task names and outcomes only, never transcripts", () => {
    const { file, infrastructure } = automationToHarness(
      [
        exportOf("finance.payment_fraud_detection"),
        exportOf("hr.visa_expiry_tracking", { passed: true, score: 1 }),
      ],
      {
        expect: ["finance.payment_fraud_detection", "hr.visa_expiry_tracking"],
        stack: "none",
      },
    );
    expect(infrastructure).toEqual([]);
    expect(file.config?.dataset).toBe(AUTOMATION_BENCHMARK);
    expect(file.config?.lessons_mode).toBe("measure");
    expect(file.config?.stack).toBe("none");
    expect(file.items).toEqual([
      {
        id: "finance.payment_fraud_detection",
        correct: false,
        score: 0.875,
        latencyMs: 42500,
        usage: { costUsd: 0.11 },
      },
      {
        id: "hr.visa_expiry_tracking",
        correct: true,
        score: 1,
        latencyMs: 42500,
        usage: { costUsd: 0.11 },
      },
    ]);
    expect(JSON.stringify(file)).not.toContain("SECRET TASK TEXT");
  });

  it("counts a missing export, a missing task and an aborted task as infrastructure", () => {
    const aborted = exportOf("sales.email_zoom_fuzzy");
    aborted.data.summary = { aborted_tasks: ["sales.email_zoom_fuzzy"] };
    const { file, infrastructure } = automationToHarness(
      [
        { path: "/r/sales.zoom_meeting_followup.json", error: "no export" },
        aborted,
        exportOf("hr.docusign_offer_letters", { num_model_calls: 0 }),
      ],
      {
        expect: [
          "sales.zoom_meeting_followup",
          "sales.email_zoom_fuzzy",
          "hr.docusign_offer_letters",
        ],
      },
    );
    expect(infrastructure.length).toBe(4);
    expect(infrastructure.join("\n")).toMatch(/no export/);
    expect(infrastructure.join("\n")).toMatch(/sales.zoom_meeting_followup: no result/);
    expect(infrastructure.join("\n")).toMatch(/aborted/);
    expect(infrastructure.join("\n")).toMatch(/no model call/);
    expect(file.config?.infrastructureErrors).toBe(4);
    expect(file.items?.every((i) => i.fallback === true)).toBe(true);
  });
});

describe("ifbench runner and converter", () => {
  const inputs: IfbenchInput[] = [
    { key: 129, prompt: "Write a haiku. SECRET PROMPT ONE", instruction_id_list: ["a"] },
    {
      key: 130,
      prompt: "  List three things. SECRET PROMPT TWO  ",
      instruction_id_list: ["b", "c"],
    },
    { key: 131, prompt: "Answer in French.", instruction_id_list: ["d"] },
  ];

  it("answers each prompt with one chat completion: bearer from options, arm headers, trace id", async () => {
    const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      seen.push({ url: String(url), headers, body });
      if (body.messages[0]!.content.includes("French")) {
        return new Response('{"error":{"code":"spend_cap_reached"}}', { status: 429 });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: `reply to ${body.messages[0]!.content}` } }],
        }),
        { status: 200, headers: { "x-request-id": "req-abc" } },
      );
    }) as typeof fetch;
    const out = await answerAll(inputs, {
      endpoint: "http://localhost:47170/",
      model: "m",
      apiKey: "sk-run",
      headers: parseHeaderFlags([
        "x-marina-stack=none",
        "x-marina-eval=benchmark=ifbench; mode=measure",
      ]),
      concurrency: 2,
      fetch: fake,
      wait: async () => {},
    });
    expect(seen.length).toBe(3); // a 429 is not retried
    expect(seen[0]!.url).toBe("http://localhost:47170/v1/chat/completions");
    expect(seen[0]!.headers.Authorization).toBe("Bearer sk-run");
    expect(seen[0]!.headers["x-marina-stack"]).toBe("none");
    expect(seen[0]!.headers["x-marina-eval"]).toBe("benchmark=ifbench; mode=measure");
    expect(out.map((r) => r.key)).toEqual([129, 130, 131]);
    expect(out[0]).toMatchObject({
      response: expect.stringContaining("reply to"),
      traceId: "req-abc",
    });
    expect(out[2]!.response).toBe("");
    expect(out[2]!.error).toMatch(/HTTP 429/);
  });

  it("retries a gateway error, then gives up with an error line", async () => {
    let calls = 0;
    const flaky = (async () => {
      calls++;
      return new Response("bad gateway", { status: 502 });
    }) as unknown as typeof fetch;
    const [r] = await answerAll([inputs[0]!], {
      endpoint: "http://x",
      model: "m",
      retries: 2,
      fetch: flaky,
      wait: async () => {},
    });
    expect(calls).toBe(3);
    expect(r!.error).toMatch(/HTTP 502/);
  });

  it("subsets, parses header flags and finds the grader's output", () => {
    expect(subsetInputs(inputs, 2).map((i) => i.key)).toEqual([129, 130]);
    expect(subsetInputs(inputs).length).toBe(3);
    expect(() => parseHeaderFlags(["nope"])).toThrow(/KEY=VALUE/);
    expect(gradedFileFor(["eval_results_strict.jsonl", "eval_results_loose.jsonl"], "strict")).toBe(
      "eval_results_strict.jsonl",
    );
    expect(gradedFileFor(["responses-eval_results_loose.jsonl"], "loose")).toBe(
      "responses-eval_results_loose.jsonl",
    );
    expect(gradedFileFor([], "strict")).toBeUndefined();
  });

  it("keys items by the input key with strict verdicts, never prompt or response text", () => {
    const graded = [
      { prompt: inputs[0]!.prompt, follow_all_instructions: true, follow_instruction_list: [true] },
      {
        prompt: inputs[1]!.prompt.trim(),
        follow_all_instructions: false,
        follow_instruction_list: [true, false],
      },
      { prompt: inputs[2]!.prompt, follow_all_instructions: true, follow_instruction_list: [true] },
    ];
    const responses = inputs.map((i) => ({
      key: i.key,
      prompt: i.prompt,
      response: "SECRET RESPONSE",
      model: "m",
      latencyMs: 100,
      traceId: `req-${i.key}`,
    }));
    const { file, infrastructure } = ifbenchToHarness(inputs, graded, responses, {
      stack: "lessons,obligations,argcheck,learn",
    });
    expect(infrastructure).toEqual([]);
    expect(file.config).toMatchObject({
      dataset: IFBENCH_BENCHMARK,
      model: "m",
      lessons_mode: "measure",
      stack: "lessons,obligations,argcheck,learn",
      infrastructureErrors: 0,
    });
    expect(file.items).toEqual([
      { id: "129", correct: true, score: 1, latencyMs: 100, traceId: "req-129" },
      { id: "130", correct: false, score: 0.5, latencyMs: 100, traceId: "req-130" },
      { id: "131", correct: true, score: 1, latencyMs: 100, traceId: "req-131" },
    ]);
    const text = JSON.stringify(file);
    expect(text).not.toContain("SECRET");
    expect(
      ifbenchToHarness(inputs, graded, responses, { mode: "loose" }).file.config?.dataset,
    ).toBe("ifbench-loose");
  });

  it("a prompt without an answer or a verdict is an infrastructure failure, never a model miss", () => {
    const graded = [
      { prompt: inputs[0]!.prompt, follow_all_instructions: true, follow_instruction_list: [true] },
      {
        prompt: inputs[2]!.prompt,
        follow_all_instructions: false,
        follow_instruction_list: [false],
      },
    ];
    const responses = [
      { key: 129, prompt: inputs[0]!.prompt, response: "r" },
      { key: 130, prompt: inputs[1]!.prompt, response: "r" },
      { key: 131, prompt: inputs[2]!.prompt, response: "", error: "HTTP 429: spend cap" },
    ];
    const { file, infrastructure } = ifbenchToHarness(inputs, graded, responses);
    expect(infrastructure).toEqual(["130: not graded", "131: no answer (HTTP 429: spend cap)"]);
    expect(file.items?.filter((i) => i.fallback).map((i) => i.id)).toEqual(["130", "131"]);
  });

  it("parses JSONL and names a malformed line", () => {
    expect(parseJsonl<{ a: number }>('{"a":1}\n\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(() => parseJsonl('{"a":1}\nnot json')).toThrow(/line 2/);
  });
});

describe("converter scripts: --require-clean", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "repro-ab-if-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (args: string[]) =>
    Bun.spawnSync(["bun", ...args], { cwd: join(import.meta.dir, ".."), stderr: "pipe" });

  it("automationbench convert refuses a missing task and writes nothing; files a clean run", () => {
    const good = join(dir, "finance.payment_fraud_detection.json");
    writeFileSync(good, JSON.stringify(exportOf("finance.payment_fraud_detection").data));
    const missing = join(dir, "hr.visa_expiry_tracking.json");
    const out = join(dir, "ledger.json");
    const refused = run([
      "scripts/automationbench.ts",
      "convert",
      good,
      missing,
      "--expect",
      "finance.payment_fraud_detection,hr.visa_expiry_tracking",
      "--out",
      out,
      "--require-clean",
    ]);
    expect(refused.exitCode).toBe(3);
    expect(refused.stderr.toString()).toContain("INVALID");
    expect(Bun.file(out).size).toBe(0);
    const ok = run([
      "scripts/automationbench.ts",
      "convert",
      good,
      "--out",
      out,
      "--require-clean",
    ]);
    expect(ok.exitCode).toBe(0);
    const filed = JSON.parse(readFileSync(out, "utf8"));
    expect(filed.items.map((i: { id: string }) => i.id)).toEqual([
      "finance.payment_fraud_detection",
    ]);
  });

  it("ifbench convert refuses a prompt with no answer", () => {
    const input = join(dir, "input.jsonl");
    writeFileSync(
      input,
      `${JSON.stringify({ key: 1, prompt: "p1" })}\n${JSON.stringify({ key: 2, prompt: "p2" })}\n`,
    );
    const responses = join(dir, "responses.jsonl");
    writeFileSync(responses, `${JSON.stringify({ key: 1, prompt: "p1", response: "r" })}\n`);
    const graded = join(dir, "graded");
    mkdirSync(graded);
    writeFileSync(
      join(graded, "eval_results_strict.jsonl"),
      `${JSON.stringify({ prompt: "p1", follow_all_instructions: true, follow_instruction_list: [true] })}\n${JSON.stringify({ prompt: "p2", follow_all_instructions: false, follow_instruction_list: [false] })}\n`,
    );
    const out = join(dir, "ledger.json");
    const args = [
      "scripts/ifbench.ts",
      "convert",
      graded,
      "--input",
      input,
      "--responses",
      responses,
      "--out",
      out,
    ];
    const refused = run([...args, "--require-clean"]);
    expect(refused.exitCode).toBe(3);
    expect(refused.stderr.toString()).toContain("2: no answer");
    expect(Bun.file(out).size).toBe(0);
    const lenient = run(args);
    expect(lenient.exitCode).toBe(0);
    const filed = JSON.parse(readFileSync(out, "utf8"));
    expect(filed.items).toEqual([
      { id: "1", correct: true, score: 1 },
      { id: "2", correct: false, fallback: true },
    ]);
  });
});
