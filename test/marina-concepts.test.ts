// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marina's concepts, end to end, under DEFAULT settings.
 *
 * Every mechanism below ships on (or observe) by default. This file boots the
 * pieces with no `MARINA_*` mechanism variable set — only a provider key, so
 * "on when a provider is available" applies — and fails unless each concept
 * actually happens at an observable boundary (prompt sections, tool-call
 * hooks, recorded lessons, command output, response headers, answer stages):
 *
 *   1. a coder's ledger, argument check and decision backend fire on writes, not reads;
 *   2. agent work (autonomous and request-driven) becomes one judged lesson,
 *      recalled for the next coding task and at a failed `code verify`;
 *   3. a measured board's outcome teaches other boards, never its own measurements;
 *   4. an identified /v1 caller gets the stack; an anonymous one is byte-identical;
 *   5. a plain forecast runs the typed pipeline with its runs verified;
 *   6. earned defaults are resolved and traced; route evidence observes.
 *
 * No network: every model call is scripted (a stubbed `fetch`, scripted model
 * parts, a scripted judge and writer). If a default is turned off or a wire is
 * cut, a concept here goes red.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeThinkingDefault } from "../src/agent/agent-types";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import { LocalWorkspace } from "../src/coding/local-workspace";
import { decisionConfigFromEnv } from "../src/decisions/config";
import { harnessDecisionProvider, harnessGateEnabled } from "../src/decisions/engines";
import type { DecisionProvider } from "../src/decisions/types";
import { decisionVerifyMode } from "../src/decisions/verify";
import { routeEvidenceSettingsFromEnv } from "../src/engine/benchmark-evidence";
import { judgeMode } from "../src/engine/challenges";
import { codeCommand } from "../src/engine/commands/code";
import { lessonsCommand } from "../src/engine/commands/lessons";
import { onDefaultResolved } from "../src/engine/default-resolution";
import { grant } from "../src/engine/safety-gates";
import { resolveForecastDefaults } from "../src/forecast/defaults";
import { typedOptionsFromEnv } from "../src/forecast/service";
import { plainFromTyped, plainUsesLegacy } from "../src/forecast/surface";
import { forecastTyped, type ModelPart } from "../src/forecast/typed";
import { residentLessonsMode } from "../src/learning/modes";
import { memoryLessonSink } from "../src/learning/outcomes";
import {
  disableOutcomeLearning,
  enableOutcomeLearning,
  lessonsMode,
  recallForWork,
} from "../src/learning/service";
import { flushWorkLessons, lessonsFromWorkMode, resetWorkLearner } from "../src/learning/work";
import { handleModelApi } from "../src/net/model-api";
import { resetObligationsForTests } from "../src/net/model-api/obligations";
import { passthruStackPolicy } from "../src/net/model-api/stack";
import { argcheckMode, argcheckTrigger, obligationsMode } from "../src/obligations/mode";
import { obligationsReviewMode } from "../src/obligations/review";
import { deliverOutcomes } from "../src/outcomes/deliver";
import { resolveForecast } from "../src/outcomes/forecast";
import { settleDelivery } from "../src/outcomes/record";
import { MarinaDB } from "../src/persistence/database";
import type { EngineEvent, EntityId, RoomContext } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { gitInit } from "./git-helpers";
import { stripAnsi } from "./helpers";
import { scopeProcessState } from "./process-state";

/** Every mechanism switch, cleared: the test sees Marina's shipped defaults. */
const MECHANISM_ENV = [
  "MARINA_DECISIONS",
  "MARINA_DECISION_ENGINE",
  "MARINA_DECISION_GATE",
  "MARINA_DECISION_VERIFY",
  "MARINA_DECISION_MODEL",
  "MARINA_CHALLENGE_JUDGE",
  "MARINA_OBLIGATIONS",
  "MARINA_OBLIGATIONS_REVIEW",
  "MARINA_OBLIGATIONS_CONSENT",
  "MARINA_ARGCHECK",
  "MARINA_ARGCHECK_TRIGGER",
  "MARINA_LESSONS",
  "MARINA_LESSONS_META",
  "MARINA_LESSONS_RESIDENT",
  "MARINA_LESSONS_FROM_WORK",
  "MARINA_ROUTE_EVIDENCE",
  "MARINA_PASSTHRU_STACK",
  "MARINA_FORECAST_VERIFY",
  "MARINA_FORECAST_PLAIN",
  "MARINA_FORECAST_FORMATION",
  "MARINA_FORECAST_HISTORY",
  "MARINA_CODE_THINKING",
  "MARINA_AGENT_THINKING",
  "MARINA_OPEN_API",
  "MODEL_API_KEYS",
  "MARINA_PROFILE",
  "MARINA_DAILY_SPEND_CAP_USD",
] as const;

/** Defaults, plus one provider key ("on when a provider is available") and a local bearer. */
function defaults(over: Record<string, string | undefined> = {}) {
  return scopeProcessState({
    env: {
      ...Object.fromEntries(MECHANISM_ENV.map((k) => [k, undefined])),
      OPENROUTER_API_KEY: "test-openrouter-key",
      MARINA_LOCAL_API_KEY: "test-local-key",
      ...over,
    },
  });
}

/** A judge that answers every question 0.9 (calibrated). */
const judge: DecisionProvider = {
  kind: "test",
  model: "test/jev",
  calibrated: true,
  async ask(request: { questions: Record<string, unknown> }) {
    return {
      answers: Object.fromEntries(
        Object.keys(request.questions).map((k) => [k, { type: "noul", noul: 0.9 }]),
      ),
      model: "test/jev",
      provider: "test",
      latencyMs: 1,
      calibrated: true,
    };
  },
} as unknown as DecisionProvider;

const FILE_RULE = "Before editing a file, confirm the file exists with a files listing first.";
const COMMAND_RULE = "Look up the exact command name in help before running a command.";

/** A lesson writer naming one general rule per tool. */
const writer = {
  name: "test/writer",
  async complete(_system: string, user: string) {
    const rule = user.includes("marina_code") ? FILE_RULE : COMMAND_RULE;
    return JSON.stringify({ category: "tool work", rule });
  },
};

// ─── 1. A coder's instruments fire on writes, not reads ─────────────────────

describe("concept 1: a coder's ledger, argument check and decision backend", () => {
  it("ship on by default (decisions through Marina's own /v1; the gate stays off)", () => {
    using _env = defaults();
    expect(obligationsMode(process.env, { coder: true })).toBe("on");
    expect(obligationsMode(process.env, { coder: false })).toBe("observe");
    expect(obligationsReviewMode()).toBe("auto");
    expect(argcheckMode()).toBe("on");
    expect(argcheckTrigger()).toBe("flagged");
    expect(decisionConfigFromEnv()?.kind).toBe("marina-self");
    expect(harnessDecisionProvider()?.kind).toBe("marina-self");
    expect(harnessGateEnabled()).toBe(false);
    expect(decisionVerifyMode()).toBe("observe");
    expect(judgeMode()).toBe("observe");
    expect(codeThinkingDefault()).toBe("high");
  });

  it("the ledger lists the task, settles it on the write, and reads never reach the check", async () => {
    using _env = defaults();
    const selfCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    // Marina's own /v1 (the decision backend) answers with an outage: the
    // argument check is consulted and fails open.
    globalThis.fetch = (async (input: string | URL | Request) => {
      selfCalls.push(String(input instanceof Request ? input.url : input));
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    try {
      const adapter = new LeanAgentAdapter({ name: "ConceptCoder" }, "ws://127.0.0.1:3300", null);
      const i = adapter as unknown as {
        agent: {
          beforeToolCall(context: unknown): Promise<{ block: boolean; reason: string } | undefined>;
          afterToolCall(context: unknown): Promise<unknown>;
        };
        obligationsComplete(system: string, user: string): Promise<string>;
        buildContinuationPrompt(): Promise<string>;
        argcheck: { check(...args: unknown[]): Promise<unknown> };
        platformMemory: { client: { command(cmd: string): Promise<unknown[]> } };
      };
      i.platformMemory.client.command = async () => [];
      const ledgerCalls: string[] = [];
      i.obligationsComplete = async (system: string) => {
        ledgerCalls.push(system.slice(0, 40));
        if (system.startsWith("You keep the ledger"))
          return '{"add":[{"request":1,"what":"Create src/report_4417.ts","target":"src/report_4417.ts","tools":["marina_code"]}],"cancel":[]}';
        if (system.startsWith("You review a state-changing action"))
          return '{"order":"no","evidence":"no"}';
        return "{}";
      };
      const checked: string[] = [];
      const check = i.argcheck.check.bind(i.argcheck);
      i.argcheck.check = async (...args: unknown[]) => {
        checked.push(String(args[0]));
        return check(...args);
      };

      adapter.setActiveCodingTask("Create src/report_4417.ts with the quarterly totals.");
      const first = await i.buildContinuationPrompt();
      expect(ledgerCalls.some((c) => c.startsWith("You keep the ledger"))).toBe(true);
      expect(first).toContain("[Open obligations — 1]");

      const call = (id: string, args: Record<string, unknown>) => ({
        assistantMessage: { stopReason: "toolUse" },
        toolCall: { id, name: "marina_code" },
        args,
        context: {
          messages: [{ role: "user", content: "Create the quarterly report file." }],
          tools: [],
        },
      });
      // A read never reaches the argument check.
      await i.agent.beforeToolCall(call("r1", { action: "read", path: "src/index.ts" }));
      expect(checked).toEqual([]);
      // A write carrying a value nobody stated is checked, and the judge is
      // asked on Marina's own /v1 (an outage fails open: not blocked).
      const write = await i.agent.beforeToolCall(
        call("w1", { action: "write", path: "src/report_9921.ts", content: "x" }),
      );
      expect(checked).toEqual(["marina_code"]);
      expect(selfCalls.some((u) => u.startsWith("http://localhost:3300/v1"))).toBe(true);
      expect(write?.block ?? false).toBe(false);

      // The write the task asked for settles the obligation.
      await i.agent.afterToolCall({
        toolCall: { id: "w2", name: "marina_code" },
        args: { action: "write", path: "src/report_4417.ts", content: "totals" },
        isError: false,
        result: { content: [{ type: "text", text: "wrote src/report_4417.ts" }], details: {} },
      });
      const second = await i.buildContinuationPrompt();
      expect(second).not.toContain("[Open obligations");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── 2. Agent work becomes a judged lesson, recalled where work happens ─────

describe("concept 2: lessons from work, recalled for the next task and at a failed verify", () => {
  let world: ReturnType<typeof createTestEngine>;
  let root: string;
  beforeEach(() => {
    world = createTestEngine();
    root = realpathSync(mkdtempSync(join(tmpdir(), "marina-concepts-")));
  });
  afterEach(async () => {
    resetWorkLearner(world.db);
    await world.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  const toolResult = (
    name: string,
    toolName: string,
    origin: "autonomous" | "request",
    isError: boolean,
    timestamp: number,
  ): EngineEvent =>
    ({
      type: "agent_tool_result",
      name,
      toolName,
      runId: `run-${timestamp}`,
      traceId: origin === "autonomous" ? "agent-trace-1" : "req-1",
      origin,
      isError,
      ...(isError ? { errorClass: "not-found" } : {}),
      timestamp,
    }) as EngineEvent;

  /** The lessons command as the adapter's platform memory runs it (`lessons <topic>`). */
  const runLessons = (db: MarinaDB) => async (raw: string) => {
    const out: string[] = [];
    const ctx = {
      send: (_e: EntityId, m: string) => out.push(m),
      getEntity: () => ({ name: "ConceptCoder" }),
    } as unknown as RoomContext;
    const args = raw.replace(/^lessons\s+/, "");
    await lessonsCommand({ db }).handler(ctx, {
      entity: "e_coder" as EntityId,
      verb: "lessons",
      args,
      tokens: args.split(/\s+/),
      raw,
    } as never);
    return out.map((text) => ({ type: "message", data: { text } }));
  };

  it("autonomous and request-driven recoveries teach; the lesson reaches the next task and a failed verify", async () => {
    using _env = defaults();
    expect(lessonsMode()).toBe("on");
    expect(residentLessonsMode()).toBe("on");
    expect(lessonsFromWorkMode()).toBe("on");
    const { db, engine } = world;
    // World agents (no human owner): their work teaches the shared pool.
    db.ensurePrincipal({ type: "agent", displayName: "Builder" });
    db.ensurePrincipal({ type: "agent", displayName: "Helper" });
    const t0 = Date.now() - 60_000;
    // Autonomous work: two not-found → success recoveries of marina_code.
    for (const at of [t0, t0 + 2_000]) {
      engine.logEvent(toolResult("Builder", "marina_code", "autonomous", true, at));
      engine.logEvent(toolResult("Builder", "marina_code", "autonomous", false, at + 1_000));
    }
    // Request-driven work (serving a caller, a benchmark included): the same for marina_command.
    for (const at of [t0 + 10_000, t0 + 12_000]) {
      engine.logEvent(toolResult("Helper", "marina_command", "request", true, at));
      engine.logEvent(toolResult("Helper", "marina_command", "request", false, at + 1_000));
    }
    const report = await flushWorkLessons(db, {
      judge,
      writer,
      admit: async (lesson) => lesson,
      stopReason: () => undefined,
    });
    expect(report?.learned).toBe(2);
    // One judged lesson per pattern, nothing twice.
    const again = await flushWorkLessons(db, {
      judge,
      writer,
      admit: async (lesson) => lesson,
      stopReason: () => undefined,
    });
    expect(again?.learned ?? 0).toBe(0);

    // The next coding task starts with the lesson beside it.
    const adapter = new LeanAgentAdapter({ name: "ConceptCoder" }, "ws://127.0.0.1:3300", null);
    const i = adapter as unknown as {
      buildContinuationPrompt(): Promise<string>;
      obligationsComplete(system: string, user: string): Promise<string>;
      platformMemory: { client: { command(cmd: string): Promise<unknown[]> } };
    };
    i.obligationsComplete = async () => '{"add":[],"cancel":[]}';
    i.platformMemory.client.command = async (raw: string) =>
      raw.startsWith("lessons ") ? await runLessons(db)(raw) : [];
    adapter.setActiveCodingTask("Edit the config loader; confirm the file exists before editing.");
    const prompt = await i.buildContinuationPrompt();
    expect(prompt).toContain("[Lessons]");
    expect(prompt).toContain(FILE_RULE);

    // A failed `code verify` brings the lesson back too.
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        scripts: {
          test: "echo 'error: file not found; confirm the file exists before editing' && exit 1",
        },
      }),
    );
    gitInit(root);
    const { entityId } = world.login("Ada");
    grant(db, entityId, "code.exec");
    const entity = engine.entities.get(entityId)!;
    const sent: string[] = [];
    const ctx = {
      send: (_t: EntityId, message: string) => sent.push(stripAnsi(message)),
    } as unknown as RoomContext;
    const command = codeCommand({
      db,
      getEntity: () => entity,
      workspace: new LocalWorkspace(root),
    });
    const input = (raw: string) => {
      const args = raw.slice("code ".length);
      return {
        raw,
        verb: "code",
        args,
        tokens: args.split(/\s+/),
        entity: entity.id,
        room: entity.room,
      } as never;
    };
    await command.handler(ctx, input("code start Concepts"));
    await command.handler(ctx, input("code verify"));
    const verified = sent.join("\n");
    expect(verified).toContain("failed");
    expect(verified).toContain(FILE_RULE);
  });
});

// ─── 3. A measured board teaches other boards, never its own measurements ───

describe("concept 3: benchmark outcomes teach", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
  });
  afterEach(async () => {
    await settleDelivery(db);
    disableOutcomeLearning(db);
    db.close();
  });

  it("a board-tagged measurement delivers a lesson other boards recall and its own does not", async () => {
    using _env = defaults();
    const sink = memoryLessonSink();
    enableOutcomeLearning(db, {
      sink,
      writer: {
        name: "test/writer",
        async complete() {
          return '{"category":"probability forecasting","rule":"Discount strong priors when the base rate is low."}';
        },
      },
      judge,
    });
    const id = db.saveForecastAnswer({
      entityName: "Ada",
      question: "Will the measured event happen?",
      kind: "probability",
      probability: 0.8,
      answerJson: "{}",
      evalMode: "measure",
      source: "prophet",
    });
    resolveForecast(db, id, { outcome: "no" }, Date.now() - 1_000);
    await settleDelivery(db);
    await deliverOutcomes(db);
    const o = db.getOutcomeBySubject(`forecast:${id}`)!;
    expect(o).toMatchObject({ eval_mode: "measure", source: "prophet:probability" });
    expect(db.outcomeDeliveries(o.id).find((d) => d.consumer === "lessons")?.state).toBe("done");
    expect(sink.all()).toHaveLength(1);
    const domains = [sink.all()[0]!.domain];
    const q = "discount strong priors base rate";
    const own = await recallForWork(undefined, domains, q, {
      sink,
      eval: { benchmark: "prophet", mode: "measure" },
    });
    expect(own.recalled).toHaveLength(0);
    const other = await recallForWork(undefined, domains, q, {
      sink,
      eval: { benchmark: "metaculus", mode: "measure" },
    });
    expect(other.recalled.map((l) => l.text).join(" ")).toContain("Discount strong priors");
  });
});

// ─── 4. /v1: identified callers get the stack, anonymous ones do not ────────

describe("concept 4: the /v1 instrument stack", () => {
  let dir: string;
  let db: MarinaDB;
  let world: ReturnType<typeof createTestEngine> | undefined;
  let seen: { kind: string; messages: unknown }[];
  let originalFetch: typeof fetch;
  const MODEL = "openrouter/openai/gpt-6.1-sol";
  const TOOLS = [
    { type: "function", function: { name: "get_card", parameters: { type: "object" } } },
    { type: "function", function: { name: "close_card", parameters: { type: "object" } } },
  ];
  const opening = [
    { role: "system", content: "You are a bank agent. Confirm before closing cards." },
    { role: "user", content: "Please close my card 4417." },
  ];

  beforeEach(() => {
    resetObligationsForTests();
    seen = [];
    dir = mkdtempSync(join(tmpdir(), "marina-concepts-v1-"));
    db = new MarinaDB(join(dir, "w.db"));
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const system = ((body.messages ?? []) as { role: string; content: unknown }[])
        .filter((m) => m.role === "system")
        .map((m) => String(m.content))
        .join("\n");
      const ledger = system.startsWith("You keep the ledger");
      seen.push({ kind: ledger ? "extract" : "main", messages: body.messages });
      const content = ledger
        ? '{"add":[{"request":1,"what":"Close card 4417","target":"4417","tools":["close_card"]}],"cancel":[]}'
        : "Anything else?";
      return Response.json({
        id: "c",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      });
    }) as typeof fetch;
  });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (world) await world.dispose();
    world = undefined;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function post(headers: Record<string, string>) {
    world ??= createTestEngine();
    const url = new URL("http://localhost:3300/v1/chat/completions");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ model: MODEL, messages: opening, tools: TOOLS }),
    });
    return (await handleModelApi(url, "POST", req, world.engine))!;
  }

  it("an identified caller gets lessons, the ledger, the argument check and learning", async () => {
    using _env = defaults({ MODEL_API_KEYS: "sk-bound:Alice" });
    expect(passthruStackPolicy()).toBe("identified");
    const r = await post({ Authorization: "Bearer sk-bound" });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-marina-stack")).toBe(
      "lessons,obligations,argcheck,learn; source=default",
    );
    expect(seen[0]!.kind).toBe("extract");
    expect(r.headers.get("x-marina-obligations")).toContain("open=1");
  });

  it("an anonymous caller is forwarded byte-identical", async () => {
    using _env = defaults({ MARINA_OPEN_API: "true" });
    const r = await post({});
    expect(r.status).toBe(200);
    expect(r.headers.get("x-marina-stack")).toBeNull();
    expect(seen.map((s) => s.kind)).toEqual(["main"]);
    expect(seen[0]!.messages).toEqual(opening);
  });
});

// ─── 5. A plain forecast question runs the typed pipeline, verified ─────────

describe("concept 5: forecasting", () => {
  it("a plain question takes the typed pipeline and every run is verified by default", async () => {
    using _env = defaults();
    expect(plainUsesLegacy()).toBe(false);
    const options = typedOptionsFromEnv();
    expect(options.verify).toBe(true);
    const verifierPrompts: string[] = [];
    const part = (name: string, reply: (system: string) => string): ModelPart => ({
      name,
      complete: async (system) => reply(system),
    });
    const planner = part("planner", (system) => {
      if (system.startsWith("You plan research"))
        return JSON.stringify({ restatement: "Will it?", queries: ["latest reading"] });
      if (system.startsWith("You review a research dossier")) return '{"done":true}';
      if (system.startsWith("You verify a forecaster's draft")) {
        verifierPrompts.push(system.slice(0, 30));
        return '{"verdict":"keep","reason":"consistent with the dossier"}';
      }
      return '{"verdict":"keep","confidence":0.5,"reason":"fine"}';
    });
    const typed = await forecastTyped(
      {
        question: "Will the reading exceed 40%?",
        answer: {
          type: "choice",
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
          probabilities: true,
        },
        endTime: "2026-10-20T00:00:00Z",
      },
      {
        retriever: async () => ({
          report: "- 2026-09-20 — the reading was 42.5% ([src](https://example.org/1))",
          sources: [{ url: "https://example.org/1" }],
          costUsd: 0,
          searches: 1,
          retriever: "fake",
        }),
        analysts: [
          part(
            "analyst",
            () => '{"answer":"yes","probabilities":{"yes":0.7,"no":0.3},"confidence":0.7}',
          ),
        ],
        planner,
        now: () => new Date("2026-10-05T00:00:00Z"),
        options: { ...options, runs: 2, researchRounds: 1 },
      },
    );
    expect(typed.runs.length).toBeGreaterThan(0);
    expect(verifierPrompts.length).toBeGreaterThan(0);
    const plain = plainFromTyped("probability", typed);
    expect(plain.pipeline).toBe("typed");
    expect(plain.probability).toBeGreaterThan(0.5);
  });
});

// ─── 6. Earned defaults are resolved and traced; route evidence observes ────

describe("concept 6: the ledger decides defaults", () => {
  it("forecast defaults resolve through the traced default path; route evidence observes", () => {
    using _env = defaults();
    expect(routeEvidenceSettingsFromEnv().mode).toBe("observe");
    const db = new MarinaDB(":memory:");
    const traced: string[] = [];
    const off = onDefaultResolved((r) => traced.push(String(r.slot)));
    try {
      resolveForecastDefaults({ env: process.env, db, board: "concepts" });
      expect(traced.length).toBeGreaterThan(0);
    } finally {
      off();
      db.close();
    }
  });
});
