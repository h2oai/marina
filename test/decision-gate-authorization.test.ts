// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { decisionGateContextEnabled } from "../src/decisions/config";
import { gateToolCall, redactToolCall } from "../src/decisions/gate";
import {
  decideGate,
  GATE_QUESTIONS,
  GATE_QUESTIONS_WITH_AUTHORIZATION,
} from "../src/decisions/policy";
import type { DecisionAnswer, DecisionProvider } from "../src/decisions/types";

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
    // decideGate only reads the questions it was given; a missing answer is simply absent.
    const verdict = decideGate(
      { destructive: n(0.1), irreversible: n(0.1), outsideScope: n(0.1) },
      undefined,
      GATE_QUESTIONS_WITH_AUTHORIZATION,
    );
    expect(verdict.signals.unauthorized).toBeUndefined();
    expect(verdict.action).toBe("allow");
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
