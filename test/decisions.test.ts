// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createAgentEventRelay } from "../src/agent/agent-runtime";
import { normalizeAnswers } from "../src/decisions/answers";
import {
  decisionConfigFromEnv,
  decisionGateEnabled,
  getDecisionProvider,
} from "../src/decisions/config";
import { gateToolCall, redactToolCall } from "../src/decisions/gate";
import {
  DEFAULT_GATE_POLICY,
  decideGate,
  decideRoute,
  decideVerify,
  GATE_QUESTIONS,
  ROUTER_QUESTIONS,
} from "../src/decisions/policy";
import {
  chatClassifierProvider,
  decisionsApiProvider,
  extractJsonObject,
} from "../src/decisions/providers";
import { choice, noul, parseQuestions, score } from "../src/decisions/questions";
import type { DecisionAnswer, DecisionProvider } from "../src/decisions/types";
import { handleDecisions } from "../src/net/decisions-api";
import type { EngineEvent } from "../src/types";

const n = (p: number): DecisionAnswer => ({ type: "noul", noul: p });

type Call = { url: string; body: Record<string, unknown>; auth: string | null };
function mockFetch(reply: unknown, calls: Call[] = [], status = 200) {
  return async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(String(init.body)),
      auth: new Headers(init.headers).get("Authorization"),
    });
    return new Response(JSON.stringify(reply), { status });
  };
}

describe("questions and answers", () => {
  it("parses the Decisions API wire shape and rejects malformed questions", () => {
    const q = parseQuestions({
      destructive: {
        type: "noul",
        instructions: "Destroys data?",
        criteria: { true: "a", false: "b" },
      },
      tier: { type: "choice", instructions: "Which tier?", criteria: { fast: "x", powerful: "y" } },
      level: { type: "score", instructions: "How hard?", criteria: ["low", "mid", "high"] },
    });
    expect(q.destructive).toEqual(noul("Destroys data?", { true: "a", false: "b" }));
    expect(q.tier).toEqual(choice("Which tier?", { fast: "x", powerful: "y" }));
    expect(q.level).toEqual(score("How hard?", ["low", "mid", "high"]));
    expect(() => parseQuestions({})).toThrow(/1-16 entries/);
    expect(() => parseQuestions({ x: { type: "maybe", instructions: "?" } })).toThrow(
      /type must be/,
    );
    expect(() =>
      parseQuestions({ x: { type: "choice", instructions: "?", criteria: { a: "1" } } }),
    ).toThrow(/two options/);
    expect(() => parseQuestions({ "bad id": { type: "noul", instructions: "?" } })).toThrow(
      /question id/,
    );
  });

  it("holds every backend to the same answer contract", () => {
    const questions = { d: noul("?"), t: ROUTER_QUESTIONS.tier!, c: ROUTER_QUESTIONS.complexity! };
    const answers = normalizeAnswers(questions, {
      d: { noul: 1.7 },
      t: { choice: "fast", confidence: "0.9" },
      c: { score: 9 },
    });
    expect(answers).toEqual({
      d: { type: "noul", noul: 1 },
      t: { type: "choice", choice: "fast", confidence: 0.9 },
      c: { type: "score", score: 2 },
    });
    expect(() =>
      normalizeAnswers(questions, { d: { noul: 0.1 }, t: { choice: "medium" }, c: { score: 1 } }),
    ).toThrow(/not an option/);
    expect(() => normalizeAnswers(questions, { d: { noul: 0.1 } })).toThrow(/answer t/);
  });
});

describe("providers", () => {
  it("decisions-api sends { model, state, questions } to {baseUrl}/decisions", async () => {
    const calls: Call[] = [];
    const provider = decisionsApiProvider({
      baseUrl: "https://example.test/api/alpha/",
      model: "typesafe/nanojev-1",
      apiKey: "k",
      timeoutMs: 1000,
      fetch: mockFetch(
        { answers: { d: { type: "noul", noul: 0.83 } }, usage: { cost: 0.00002 } },
        calls,
      ),
    });
    const result = await provider.ask({ state: { tool: "delete" }, questions: { d: noul("?") } });
    expect(calls[0]!.url).toBe("https://example.test/api/alpha/decisions");
    expect(calls[0]!.body).toEqual({
      model: "typesafe/nanojev-1",
      state: { tool: "delete" },
      questions: { d: noul("?") },
    });
    expect(calls[0]!.auth).toBe("Bearer k");
    expect(result).toMatchObject({
      answers: { d: { type: "noul", noul: 0.83 } },
      model: "typesafe/nanojev-1",
      provider: "decisions-api",
      costUsd: 0.00002,
    });
  });

  it("chat-classifier turns any chat model's JSON reply into typed answers", async () => {
    const calls: Call[] = [];
    const reply =
      'Sure! ```json\n{"answers": {"d": {"noul": 0.2}, "t": {"choice": "powerful", "confidence": 0.7}}}\n```';
    const provider = chatClassifierProvider({
      baseUrl: "http://localhost:11434/v1",
      model: "qwen3:4b",
      timeoutMs: 1000,
      fetch: mockFetch({ choices: [{ message: { content: reply } }] }, calls),
    });
    const result = await provider.ask({
      state: "rename the archive folder",
      questions: { d: noul("Destroys data?"), t: ROUTER_QUESTIONS.tier! },
    });
    expect(calls[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(calls[0]!.body.response_format).toBeUndefined();
    expect(calls[0]!.auth).toBeNull();
    expect(result.answers).toEqual({
      d: { type: "noul", noul: 0.2 },
      t: { type: "choice", choice: "powerful", confidence: 0.7 },
    });
    expect(result.provider).toBe("chat-classifier");
  });

  it("extracts the first balanced JSON object, braces inside strings included", () => {
    expect(extractJsonObject('x {"a": "}{", "b": {"c": 1}} y {"z": 2}')).toEqual({
      a: "}{",
      b: { c: 1 },
    });
    expect(() => extractJsonObject("no json here")).toThrow(/no JSON/);
  });

  it("maps HTTP failures and timeouts to DecisionError", async () => {
    const failing = decisionsApiProvider({
      baseUrl: "https://example.test",
      model: "m",
      timeoutMs: 1000,
      fetch: mockFetch({ error: "nope" }, [], 503),
    });
    await expect(failing.ask({ state: "s", questions: { d: noul("?") } })).rejects.toMatchObject({
      code: "upstream_error",
    });
    const slow = decisionsApiProvider({
      baseUrl: "https://example.test",
      model: "m",
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        ),
    });
    await expect(slow.ask({ state: "s", questions: { d: noul("?") } })).rejects.toMatchObject({
      code: "timeout",
    });
  });
});

describe("policies (numbers from the Pi + Jev tutorial)", () => {
  it("gate: one worst risk, two thresholds, three verdicts; no answer blocks", () => {
    const ask = decideGate({ destructive: n(0.83), outsideScope: n(0.03), irreversible: n(0.66) });
    expect(ask.action).toBe("ask");
    expect(ask.worst).toBe(0.83);
    expect(ask.reason).toContain("destructive 0.83");
    expect(decideGate({ destructive: n(0.9), outsideScope: n(0), irreversible: n(0) }).action).toBe(
      "block",
    );
    expect(
      decideGate({ destructive: n(0.01), outsideScope: n(0.03), irreversible: n(0.03) }).action,
    ).toBe("allow");
    expect(decideGate(undefined).action).toBe("block");
    expect(
      decideGate({ destructive: n(0.83) }, { ...DEFAULT_GATE_POLICY, blockAt: 0.6 }).action,
    ).toBe("block");
  });

  it("router: escalates on complexity or low confidence; outage uses the fallback tier", () => {
    const tier = (c: string, confidence?: number): DecisionAnswer => ({
      type: "choice",
      choice: c,
      ...(confidence === undefined ? {} : { confidence }),
    });
    const cx = (s: number): DecisionAnswer => ({ type: "score", score: s });
    expect(decideRoute({ tier: tier("fast", 0.99), complexity: cx(1.11) }).tier).toBe("powerful");
    expect(decideRoute({ tier: tier("fast", 0.4), complexity: cx(0.2) }).tier).toBe("powerful");
    expect(decideRoute({ tier: tier("fast", 0.83), complexity: cx(0.79) }).tier).toBe("fast");
    expect(decideRoute(undefined).tier).toBe("powerful");
  });

  it("verifier: retries once below the bar, never on an unsure judge, an outage, or out of attempts", () => {
    const answers = (
      q: number,
      g: number,
      confidence?: number,
    ): Record<string, DecisionAnswer> => ({
      quality: { type: "score", score: q, ...(confidence === undefined ? {} : { confidence }) },
      grounded: n(g),
    });
    expect(decideVerify(answers(1.97, 0.73), 1).action).toBe("accept");
    expect(decideVerify(answers(0.93, 0.59), 1).action).toBe("retry");
    expect(decideVerify(answers(0.93, 0.59), 2).action).toBe("accept");
    expect(decideVerify(answers(0.93, 0.59, 0.2), 1).action).toBe("accept");
    expect(decideVerify(undefined, 1).action).toBe("accept");
  });
});

describe("gate runtime", () => {
  it("sends only the redacted call, never secrets or emails", () => {
    const state = redactToolCall("marina_command", {
      command: `tell ops@example.com key sk-ant-abcdefghijklmnop ${"x".repeat(900)}`,
      apiKey: "super-secret",
    }) as { tool: string; arguments: Record<string, string> };
    expect(state.tool).toBe("marina_command");
    expect(state.arguments.command).toContain("<email>");
    expect(state.arguments.command).toContain("<secret>");
    expect(state.arguments.command).not.toContain("ops@example.com");
    expect(state.arguments.command!.length).toBeLessThanOrEqual(501);
    expect(state.arguments.apiKey).toBe("[REDACTED]");
  });

  it("asks the gate questions and fails closed when the backend errors", async () => {
    const seen: unknown[] = [];
    const ok: DecisionProvider = {
      kind: "stub",
      model: "stub-1",
      async ask(req) {
        seen.push(req.questions);
        return {
          answers: { destructive: n(0.95), irreversible: n(0.1), outsideScope: n(0.1) },
          model: "stub-1",
          provider: "stub",
          latencyMs: 3,
        };
      },
    };
    const blocked = await gateToolCall(ok, "marina_command", { command: "destroy tree" });
    expect(seen[0]).toBe(GATE_QUESTIONS);
    expect(blocked).toMatchObject({ action: "block", model: "stub-1", latencyMs: 3 });

    const down: DecisionProvider = {
      kind: "stub",
      model: "stub-1",
      ask: async () => {
        throw new Error("503");
      },
    };
    const closed = await gateToolCall(down, "marina_command", { command: "destroy tree" });
    expect(closed.action).toBe("block");
    expect(closed.error).toContain("503");
  });

  it("relays a decision as an agent_decision engine event", () => {
    const events: EngineEvent[] = [];
    createAgentEventRelay("Builder", (e) => events.push(e))({
      type: "decision",
      stage: "gate",
      verdict: "block",
      subject: "marina_command",
      reason: "Blocked",
      signals: { destructive: 0.95 },
      model: "stub-1",
    });
    expect(events[0]).toMatchObject({
      type: "agent_decision",
      name: "Builder",
      stage: "gate",
      verdict: "block",
      subject: "marina_command",
      signals: { destructive: 0.95 },
    });
  });
});

describe("config", () => {
  it("is off by default and only an explicit backend turns it on", () => {
    expect(decisionConfigFromEnv({})).toBeUndefined();
    expect(decisionConfigFromEnv({ MARINA_DECISIONS: "off" })).toBeUndefined();
    expect(decisionConfigFromEnv({ MARINA_DECISIONS: "jev", OPENROUTER_API_KEY: "or" })).toEqual({
      kind: "decisions-api",
      model: "typesafe/jev-1.13",
      baseUrl: "https://openrouter.ai/api/alpha",
      path: "/decisions",
      apiKey: "or",
      timeoutMs: 2000,
    });
    // chat-classifier has no default model — any chat model, but you name it.
    expect(decisionConfigFromEnv({ MARINA_DECISIONS: "llm" })).toBeUndefined();
    // The OpenRouter key never leaks to another host.
    const local = decisionConfigFromEnv({
      MARINA_DECISIONS: "chat-classifier",
      MARINA_DECISION_MODEL: "qwen3:4b",
      MARINA_DECISION_BASE_URL: "http://localhost:11434/v1",
      OPENROUTER_API_KEY: "or",
    });
    expect(local?.apiKey).toBeUndefined();
    expect(local?.timeoutMs).toBe(8000);
    expect(decisionGateEnabled({ MARINA_DECISION_GATE: "on" })).toBe(false);
    expect(decisionGateEnabled({ MARINA_DECISION_GATE: "on", MARINA_DECISIONS: "jev" })).toBe(true);
  });
});

describe("POST /v1/decisions", () => {
  let backend: ReturnType<typeof Bun.serve>;
  const saved = { ...process.env };
  const received: unknown[] = [];

  beforeAll(() => {
    backend = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { questions: Record<string, unknown> };
        received.push(body);
        const answers = Object.fromEntries(
          Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.42 }]),
        );
        return Response.json({ answers, usage: { cost: 0.000001 } });
      },
    });
  });
  afterAll(() => backend.stop(true));
  afterEach(() => {
    for (const key of ["MARINA_DECISIONS", "MARINA_DECISION_MODEL", "MARINA_DECISION_BASE_URL"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const post = (body: unknown) =>
    handleDecisions(
      new Request("http://marina.test/v1/decisions", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );

  it("404s with decisions_disabled while MARINA_DECISIONS is off", async () => {
    delete process.env.MARINA_DECISIONS;
    const res = await post({ state: "x", questions: { d: { type: "noul", instructions: "?" } } });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "decisions_disabled",
    );
  });

  it("answers any harness through the configured backend", async () => {
    process.env.MARINA_DECISIONS = "decisions-api";
    process.env.MARINA_DECISION_MODEL = "openjev-local";
    process.env.MARINA_DECISION_BASE_URL = `http://localhost:${backend.port}`;
    expect(getDecisionProvider()?.model).toBe("openjev-local");

    const res = await post({
      state: { tool: "rm" },
      questions: { d: { type: "noul", instructions: "Destroys?" } },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      answers: { d: { type: "noul", noul: 0.42 } },
      model: "openjev-local",
      provider: "decisions-api",
      usage: { cost: 0.000001 },
    });
    expect(received.at(-1)).toMatchObject({ model: "openjev-local", state: { tool: "rm" } });

    const bad = await post({ state: "x", questions: { d: { type: "maybe", instructions: "?" } } });
    expect(bad.status).toBe(400);
    const wrongModel = await post({
      model: "other",
      state: "x",
      questions: { d: { type: "noul", instructions: "?" } },
    });
    expect(wrongModel.status).toBe(400);
    expect(((await wrongModel.json()) as { error: { param: string } }).error.param).toBe("model");
  });
});

describe("pi adapter decision gate", () => {
  let backend: ReturnType<typeof Bun.serve>;
  let calls = 0;
  const keys = [
    "MARINA_DECISIONS",
    "MARINA_DECISION_BASE_URL",
    "MARINA_DECISION_MODEL",
    "MARINA_DECISION_GATE",
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

  beforeAll(() => {
    backend = Bun.serve({
      port: 0,
      fetch() {
        calls++;
        return Response.json({
          answers: {
            destructive: { type: "noul", noul: 0.95 },
            irreversible: { type: "noul", noul: 0.9 },
            outsideScope: { type: "noul", noul: 0.1 },
          },
        });
      },
    });
  });
  afterAll(() => backend.stop(true));
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function hookFor(gate: "on" | "off") {
    process.env.MARINA_DECISIONS = "decisions-api";
    process.env.MARINA_DECISION_MODEL = "stub-jev";
    process.env.MARINA_DECISION_BASE_URL = `http://localhost:${backend.port}`;
    process.env.MARINA_DECISION_GATE = gate;
    const { LeanAgentAdapter } = await import("../src/agent/lean-agent-adapter");
    const adapter = new LeanAgentAdapter(
      { name: "gate-probe" } as never,
      "ws://127.0.0.1:3300",
      null,
    );
    const events: Array<{ type: string }> = [];
    adapter.subscribe((e) => events.push(e));
    const agent = (
      adapter as unknown as { agent: { beforeToolCall: (ctx: unknown) => Promise<unknown> } }
    ).agent;
    const call = (name: string, args: Record<string, unknown>) =>
      agent.beforeToolCall({ toolCall: { id: "t1", name, arguments: args }, args, context: {} });
    return { call, events };
  }

  it("blocks a destructive command before it runs and records the decision", async () => {
    calls = 0;
    const { call, events } = await hookFor("on");
    const result = (await call("marina_command", { command: "build destroy old-room" })) as {
      block: boolean;
      reason: string;
    };
    expect(result.block).toBe(true);
    expect(result.reason).toContain("decision gate");
    expect(calls).toBe(1);
    expect(events.find((e) => e.type === "decision")).toMatchObject({
      stage: "gate",
      verdict: "block",
      subject: "marina_command",
      model: "stub-jev",
    });
  });

  it("never sends reads, and does nothing while the gate is off", async () => {
    calls = 0;
    const on = await hookFor("on");
    expect(await on.call("marina_command", { command: "look" })).toBeUndefined();
    expect(calls).toBe(0);
    const off = await hookFor("off");
    expect(await off.call("marina_command", { command: "build destroy old-room" })).toBeUndefined();
    expect(calls).toBe(0);
  });
});
