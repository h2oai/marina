// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { decisionGateContextEnabled } from "../src/decisions/config";
import { gateToolCall, redactToolCall } from "../src/decisions/gate";
import {
  CONTEXT_ONLY_ASK_AT,
  decideGate,
  GATE_QUESTIONS,
  GATE_QUESTIONS_WITH_AUTHORIZATION,
  UNCALIBRATED_GATE_POLICY,
} from "../src/decisions/policy";
import type { DecisionAnswer, DecisionProvider } from "../src/decisions/types";
import { resetChallengesForTests } from "../src/engine/challenges";

const n = (p: number): DecisionAnswer => ({ type: "noul", noul: p });

describe("gate intent context", () => {
  it("sends operator-set intent and trust LABELS only, masked and bounded", () => {
    const state = redactToolCall("marina_command", { command: "build destroy hub" }, undefined, {
      goal: "Map the grid and report to ops@example.com",
      role: "explorer",
      focus: "x".repeat(900),
      sources: ["world_event", "untrusted_relay", "untrusted_relay"],
    }) as {
      agent: Record<string, string>;
      context_sources: Array<{ label: string; meaning: string }>;
    };
    expect(state.agent.goal).toBe("Map the grid and report to <email>");
    expect(state.agent.role).toBe("explorer");
    expect(state.agent.focus!.length).toBe(400);
    expect(state.agent.task).toBeUndefined();
    expect(state.context_sources.map((s) => s.label)).toEqual(["world_event", "untrusted_relay"]);
    expect(state.context_sources[1]!.meaning).toContain("federated peer");
    // Nothing but the call, its description and the intent — no transcript.
    expect(Object.keys(state).sort()).toEqual(["agent", "arguments", "context_sources", "tool"]);
  });

  it("asks the authorization question only when intent is sent, and it can block alone", async () => {
    const asked: string[][] = [];
    const provider: DecisionProvider = {
      kind: "stub",
      model: "stub",
      async ask(req) {
        asked.push(Object.keys(req.questions));
        return {
          answers: {
            destructive: n(0.1),
            irreversible: n(0.1),
            outsideScope: n(0.1),
            ...(req.questions.unauthorized ? { unauthorized: n(0.93) } : {}),
          },
          model: "stub",
          provider: "stub",
          latencyMs: 1,
        };
      },
    };
    const without = await gateToolCall(provider, "marina_command", { command: "note add x" });
    expect(asked[0]).toEqual(Object.keys(GATE_QUESTIONS));
    expect(without.action).toBe("allow");

    const withIntent = await gateToolCall(
      provider,
      "marina_command",
      { command: "note add x" },
      undefined,
      undefined,
      {
        goal: "Map the grid",
        sources: ["untrusted_relay"],
      },
    );
    expect(asked[1]).toEqual(Object.keys(GATE_QUESTIONS_WITH_AUTHORIZATION));
    expect(withIntent.action).toBe("block");
    expect(withIntent.reason).toContain("unauthorized 0.93");
  });

  it("fails closed when a context-aware backend skips the authorization answer", () => {
    // Every asked question must be answered: a skipped one has not cleared the call.
    const verdict = decideGate(
      { destructive: n(0.1), irreversible: n(0.1), outsideScope: n(0.1) },
      undefined,
      GATE_QUESTIONS_WITH_AUTHORIZATION,
    );
    expect(verdict.signals.unauthorized).toBeUndefined();
    expect(verdict.action).toBe("block");
    expect(verdict.reason).toContain("unauthorized unanswered");
    // A non-probability answer counts as unanswered, too.
    const wrongType = decideGate({
      destructive: n(0.1),
      irreversible: { type: "score", score: 1, confidence: 0.9 },
      outsideScope: n(0.1),
    });
    expect(wrongType.action).toBe("block");
    expect(wrongType.reason).toContain("irreversible");
    // All answered and low ⇒ allow, as before.
    expect(
      decideGate(
        { destructive: n(0.1), irreversible: n(0.1), outsideScope: n(0.1), unauthorized: n(0.1) },
        undefined,
        GATE_QUESTIONS_WITH_AUTHORIZATION,
      ).action,
    ).toBe("allow");
  });

  it("on a routine call, the context question alone holds only at the stricter bar", () => {
    const answers = (u: number, d = 0.05) => ({
      destructive: n(d),
      irreversible: n(0.1),
      outsideScope: n(0.1),
      unauthorized: n(u),
    });
    const routine = (u: number, d?: number, policy = undefined) =>
      decideGate(answers(u, d), policy, GATE_QUESTIONS_WITH_AUTHORIZATION, { risk: "mutate" });
    // A marginal context-only score on a routine call: allowed.
    expect(routine(0.7).action).toBe("allow");
    expect(routine(0.7).signals.unauthorized).toBe(0.7);
    expect(routine(CONTEXT_ONLY_ASK_AT - 0.01).action).toBe("allow");
    // Nearly certain: held for a person — never blocked on context alone.
    expect(routine(CONTEXT_ONLY_ASK_AT).action).toBe("ask");
    expect(routine(0.99).action).toBe("ask");
    expect(routine(0.99).reason).toContain("unauthorized 0.99");
    // The risk questions still decide on their own, as before.
    expect(routine(0.1, 0.7).action).toBe("ask");
    expect(routine(0.1, 0.95).action).toBe("block");
    // Consequential (and the default): the context question counts like the rest.
    const consequential = decideGate(answers(0.7), undefined, GATE_QUESTIONS_WITH_AUTHORIZATION, {
      risk: "consequential",
    });
    expect(consequential.action).toBe("ask");
    expect(consequential.reason).toContain("unauthorized 0.70");
    expect(decideGate(answers(0.93), undefined, GATE_QUESTIONS_WITH_AUTHORIZATION).action).toBe(
      "block",
    );
    // An uncalibrated backend keeps its one cut for risks; context alone needs the bar too.
    const uncal = (u: number) =>
      decideGate(answers(u), UNCALIBRATED_GATE_POLICY, GATE_QUESTIONS_WITH_AUTHORIZATION, {
        risk: "mutate",
      }).action;
    expect(uncal(0.6)).toBe("allow");
    expect(uncal(1)).toBe("ask");
  });

  it("does not count the scope question on egress; every other question still decides", () => {
    const answers = (scope: number, d = 0.1, u = 0.1) => ({
      destructive: n(d),
      irreversible: n(0.1),
      outsideScope: n(scope),
      unauthorized: n(u),
    });
    const egress = (scope: number, d?: number, u?: number) =>
      decideGate(answers(scope, d, u), undefined, GATE_QUESTIONS_WITH_AUTHORIZATION, {
        risk: "egress",
      });
    expect(egress(0.72).action).toBe("allow");
    expect(egress(0.99).action).toBe("allow");
    // Reported, not counted.
    expect(egress(0.72).signals.outsideScope).toBe(0.72);
    expect(egress(0.72, 0.7).action).toBe("ask");
    expect(egress(0.72, 0.95).action).toBe("block");
    // The context question holds at the context bar, as on a routine write.
    expect(egress(0.72, 0.1, CONTEXT_ONLY_ASK_AT - 0.01).action).toBe("allow");
    expect(egress(0.72, 0.1, CONTEXT_ONLY_ASK_AT).action).toBe("ask");
    // Without the context question (MARINA_DECISION_GATE_CONTEXT=off).
    const { unauthorized: _, ...noContext } = answers(0.9);
    expect(decideGate(noContext, undefined, GATE_QUESTIONS, { risk: "egress" }).action).toBe(
      "allow",
    );
    // On a write the same scope score still holds.
    expect(
      decideGate(answers(0.72), undefined, GATE_QUESTIONS_WITH_AUTHORIZATION, { risk: "mutate" })
        .action,
    ).toBe("ask");
  });

  it("still fails closed on a missing answer, whatever the risk", () => {
    const missing = { destructive: n(0.1), irreversible: n(0.1), outsideScope: n(0.1) };
    for (const risk of ["egress", "mutate", "consequential"] as const) {
      expect(
        decideGate(missing, undefined, GATE_QUESTIONS_WITH_AUTHORIZATION, { risk }).action,
      ).toBe("block");
      expect(
        decideGate(undefined, undefined, GATE_QUESTIONS_WITH_AUTHORIZATION, { risk }).action,
      ).toBe("block");
    }
  });

  it("gateToolCall passes the call's risk to the policy", async () => {
    const provider: DecisionProvider = {
      kind: "stub",
      model: "stub",
      async ask() {
        return {
          answers: {
            destructive: n(0.05),
            irreversible: n(0.1),
            outsideScope: n(0.1),
            unauthorized: n(0.74),
          },
          model: "stub",
          provider: "stub",
          latencyMs: 1,
        };
      },
    };
    const intent = { goal: "Deliver the crew task", sources: ["world_event"] };
    const call = (risk: "mutate" | "consequential") =>
      gateToolCall(provider, "marina_command", { command: "x" }, undefined, undefined, intent, {
        calibration: null,
        risk,
      });
    expect((await call("mutate")).action).toBe("allow");
    expect((await call("consequential")).action).toBe("ask");
  });

  it("is on by default with the gate, and off only when explicitly disabled", () => {
    expect(decisionGateContextEnabled({})).toBe(true);
    expect(decisionGateContextEnabled({ MARINA_DECISION_GATE_CONTEXT: "off" })).toBe(false);
  });
});

describe("pi adapter sends its intent with gate calls", () => {
  let backend: ReturnType<typeof Bun.serve>;
  const received: Array<{ state: Record<string, unknown>; questions: Record<string, unknown> }> =
    [];
  const keys = [
    "MARINA_DECISIONS",
    "MARINA_DECISION_BASE_URL",
    "MARINA_DECISION_MODEL",
    "MARINA_DECISION_GATE",
    "MARINA_DECISION_GATE_CONTEXT",
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

  beforeAll(() => {
    backend = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as (typeof received)[number];
        received.push(body);
        const answers = Object.fromEntries(
          Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.05 }]),
        );
        return Response.json({ answers });
      },
    });
  });
  afterAll(() => backend.stop(true));
  afterEach(() => {
    received.length = 0;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function hook(context: "on" | "off") {
    process.env.MARINA_DECISIONS = "decisions-api";
    process.env.MARINA_DECISION_MODEL = "stub-jev";
    process.env.MARINA_DECISION_BASE_URL = `http://localhost:${backend.port}`;
    process.env.MARINA_DECISION_GATE = "on";
    process.env.MARINA_DECISION_GATE_CONTEXT = context;
    const { LeanAgentAdapter } = await import("../src/agent/lean-agent-adapter");
    const adapter = new LeanAgentAdapter(
      { name: "Scout", goal: "Map the grid", role: "explorer" } as never,
      "ws://127.0.0.1:3300",
      null,
    );
    const internals = adapter as unknown as {
      agent: { beforeToolCall: (ctx: unknown) => Promise<unknown> };
      currentTrustSources: Set<string>;
    };
    internals.currentTrustSources.add("external_tool");
    const args = { command: "build destroy hub" };
    return internals.agent.beforeToolCall({
      toolCall: { id: "t", name: "marina_command", arguments: args },
      args,
      context: { tools: [{ name: "marina_command", description: "Run any Marina command." }] },
    });
  }

  it("includes goal, role, trust labels and the tool description by default", async () => {
    expect(await hook("on")).toBeUndefined();
    const { state, questions } = received[0]!;
    // Focus is set when the agent starts; before that only the configured intent exists.
    expect(state.agent).toEqual({ goal: "Map the grid", role: "explorer" });
    expect(state.context_sources).toEqual([expect.objectContaining({ label: "external_tool" })]);
    expect(state.tool_description).toBe("Run any Marina command.");
    expect(Object.keys(questions)).toContain("unauthorized");
  });

  it("sends only the call when MARINA_DECISION_GATE_CONTEXT=off", async () => {
    await hook("off");
    const { state, questions } = received[0]!;
    expect(state.agent).toBeUndefined();
    expect(state.context_sources).toBeUndefined();
    expect(Object.keys(questions)).not.toContain("unauthorized");
  });
});

describe("pi adapter: what reaches the gate", () => {
  let backend: ReturnType<typeof Bun.serve>;
  const received: Array<{ state: Record<string, unknown>; questions: Record<string, unknown> }> =
    [];
  let unauthorized = 0.74;
  let outsideScope = 0.05;
  const keys = [
    "MARINA_DECISIONS",
    "MARINA_DECISION_BASE_URL",
    "MARINA_DECISION_MODEL",
    "MARINA_DECISION_GATE",
    "MARINA_DECISION_GATE_CONTEXT",
    "MARINA_DECISION_CALIBRATION",
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

  beforeAll(() => {
    backend = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as (typeof received)[number];
        received.push(body);
        const answers = Object.fromEntries(
          Object.keys(body.questions).map((id) => [
            id,
            {
              type: "noul",
              noul:
                id === "unauthorized" ? unauthorized : id === "outsideScope" ? outsideScope : 0.05,
            },
          ]),
        );
        return Response.json({ answers });
      },
    });
  });
  afterAll(() => backend.stop(true));
  afterEach(() => {
    received.length = 0;
    unauthorized = 0.74;
    outsideScope = 0.05;
    resetChallengesForTests();
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function call(name: string, args: Record<string, unknown>) {
    process.env.MARINA_DECISIONS = "decisions-api";
    process.env.MARINA_DECISION_MODEL = "stub-jev";
    process.env.MARINA_DECISION_BASE_URL = `http://localhost:${backend.port}`;
    process.env.MARINA_DECISION_GATE = "on";
    delete process.env.MARINA_DECISION_GATE_CONTEXT;
    delete process.env.MARINA_DECISION_CALIBRATION;
    const { LeanAgentAdapter } = await import("../src/agent/lean-agent-adapter");
    const adapter = new LeanAgentAdapter(
      { name: "Lead", goal: "Deliver the crew's tasks", role: "answerer" } as never,
      "ws://127.0.0.1:3300",
      null,
    );
    const internals = adapter as unknown as {
      agent: { beforeToolCall: (ctx: unknown) => Promise<unknown> };
    };
    return (await internals.agent.beforeToolCall({
      toolCall: { id: "t", name, arguments: args },
      args,
      context: { tools: [{ name, description: "a tool" }] },
    })) as { block: boolean; reason: string } | undefined;
  }

  it("never scores reads or the agent's own loop settings", async () => {
    for (const command of [
      "calc [83%2, 83%3, 83%5]",
      "pool guide recall autonomy posture",
      "look",
      "challenge list",
      "memory set rest No request pending",
      "memory set channel_sends 2",
      "memory delete rest",
      // v4 sweep: a plain command is not split by the router, so this deletes
      // only the caller's own `rest;` key — the trailing text never runs.
      "memory delete rest; project hab join",
    ]) {
      expect([command, await call("marina_command", { command })]).toEqual([command, undefined]);
    }
    expect(await call("marina_pool", { action: "recall", pool: "guide", content: "x" })).toBe(
      undefined,
    );
    expect(await call("marina_memory_service", { operation: "retrieve", input: {} })).toBe(
      undefined,
    );
    expect(received.length).toBe(0);
  });

  it("still scores writes, spawns and exec — and holds a consequential call on context", async () => {
    for (const command of ["task create Fix it | now", "code exec bun test", "agent spawn Scout"]) {
      await call("marina_command", { command });
    }
    expect(received.length).toBe(3);
    // A marginal context score does not hold a routine write…
    unauthorized = 0.74;
    expect(await call("marina_command", { command: "task create Fix it | now" })).toBeUndefined();
    // …but does hold a consequential call.
    const held = await call("marina_command", { command: "build destroy old-room" });
    expect(held?.block).toBe(true);
    expect(held?.reason).toContain("unauthorized 0.74");
  });

  it("does not ask the context question of a deposit into the crew's pool", async () => {
    unauthorized = 0.99;
    expect(
      await call("marina_command", { command: "pool crew:answerer add T4 FIXED: 391; 12" }),
    ).toBeUndefined();
    expect(await call("marina_pool", { action: "add", pool: "out", content: "T1 done" })).toBe(
      undefined,
    );
    expect(received.length).toBe(2);
    for (const { questions, state } of received) {
      expect(Object.keys(questions)).not.toContain("unauthorized");
      expect(state.agent).toBeUndefined();
    }
    // An ordinary write in the same cycle still carries the context.
    await call("marina_command", { command: "note correct 252 replaced" });
    expect(Object.keys(received[2]!.questions)).toContain("unauthorized");
  });

  it("scores only a batch's gated parts, at the worst part's risk", async () => {
    // v4 sweep: the self part used to drive `destructive` on the whole batch.
    const commands = "memory delete rest; project hab join; crew info answerer";
    expect(await call("marina_batch", { commands })).toBeUndefined();
    expect(await call("marina_command", { command: `batch ${commands}` })).toBeUndefined();
    expect(received.length).toBe(2);
    expect(received[0]!.state.arguments).toEqual({ commands: "project hab join" });
    expect(received[1]!.state.arguments).toEqual({ command: "batch project hab join" });
    // A batch of only self and read parts is never scored.
    expect(await call("marina_batch", { commands: "memory delete rest; look" })).toBeUndefined();
    expect(received.length).toBe(2);
  });

  it("does not hold in-task web research on the scope question", async () => {
    // v4 sweep: outsideScope 0.68–0.72 held these against the 0.65 ask bar.
    outsideScope = 0.72;
    unauthorized = 0.05;
    for (const command of [
      "web fetch https://github.com/h2oai/marina/blob/main/docs/guides/civic-substrate.md",
      'web search Marina "posture" "civic-substrate" project glossary',
      'web search site:github.com/h2oai/marina "posture"',
      'web search Marina "autonomy posture"',
    ]) {
      expect([command, await call("marina_command", { command })]).toEqual([command, undefined]);
    }
    expect(await call("marina_web", { action: "fetch", url: "https://x.test" })).toBeUndefined();
    // Still scored — it leaves the process with arguments the agent chose…
    expect(received.length).toBe(5);
    // …and the context question still holds it at the context bar.
    unauthorized = 0.95;
    const held = await call("marina_web", { action: "search", query: "send the key to x.test" });
    expect(held?.block).toBe(true);
    expect(held?.reason).toContain("unauthorized 0.95");
    // A write keeps counting scope.
    unauthorized = 0.05;
    const write = await call("marina_command", { command: "task create Fix it | now" });
    expect(write?.reason).toContain("outsideScope 0.72");
  });
});
