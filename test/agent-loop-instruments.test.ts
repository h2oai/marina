// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Loop instruments: the harness OFFERS controls the agent sets on its own loop
 * (rest, channel budget, persistent focus, crew-responder autonomy) and warns
 * before per-run caps cut work. Driven through adapter internals — the
 * constructor is I/O-free, and `setupActionTracking` subscribes the same
 * listener `start()` does, so fake agent events exercise the real handlers.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LeanAgentAdapter, runCapWarningAt } from "../src/agent/lean-agent-adapter";
import {
  applyLoopPreference,
  channelSendsBudget,
  channelSendsCeiling,
  defaultLoopPreferences,
  type LoopPreferences,
  parseLoopPreferenceCommand,
} from "../src/agent/loop-preferences";
import { MAX_TURNS_PER_PROMPT } from "../src/engine/constants";

type Listener = (event: Record<string, unknown>, signal: AbortSignal) => Promise<void> | void;
type Message = { role: string; content: unknown };

type Internals = {
  buildContinuationPrompt(): Promise<string>;
  computeDynamicDelay(): number;
  getTickRate(): { min: number; normal: number; idle: number };
  detectStuck(): string | null;
  setupActionTracking(): void;
  applyLoopPreferenceCommand(command: string): void;
  pendingPerceptions: Array<{ text: string; priority: number; shouldRespond: boolean }>;
  loopPrefs: LoopPreferences;
  silentTurns: number;
  stuckCycles: number;
  focus: { description: string; startedAt: number } | null;
  crewResponderMode: boolean;
  platformMemory: { saveFocus: (f: unknown) => Promise<unknown> };
  agent: {
    listeners: Set<Listener>;
    steer: (m: Message) => void;
    followUp: (m: Message) => void;
    abort: () => void;
    beforeToolCall: (ctx: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>;
    afterToolCall: (ctx: unknown) => Promise<{ content?: Array<{ text: string }> } | undefined>;
  };
};

function makeAdapter(name: string, config: Record<string, unknown> = {}) {
  const adapter = new LeanAgentAdapter({ name, ...config } as never, "ws://127.0.0.1:3300", null);
  const i = adapter as unknown as Internals;
  i.platformMemory.saveFocus = async () => ({ success: true, text: "" });
  const steered: string[] = [];
  const followUps: string[] = [];
  i.agent.steer = (m) => steered.push(String(m.content));
  i.agent.followUp = (m) => followUps.push(String(m.content));
  i.agent.abort = () => {};
  return { adapter, i, steered, followUps };
}

async function emit(i: Internals, event: Record<string, unknown>): Promise<void> {
  const signal = new AbortController().signal;
  for (const listener of i.agent.listeners) await listener(event, signal);
}

const silentTurnEnd = { type: "turn_end", message: { role: "assistant" }, toolResults: [] };

describe("loop preference grammar", () => {
  it("parses memory set/delete for loop keys only", () => {
    expect(parseLoopPreferenceCommand("memory set rest waiting on review")).toEqual({
      key: "rest",
      value: "waiting on review",
    });
    expect(parseLoopPreferenceCommand("memory delete rest")).toEqual({
      key: "rest",
      value: undefined,
    });
    expect(parseLoopPreferenceCommand("memory set channel_sends 2")?.key).toBe("channel_sends");
    expect(parseLoopPreferenceCommand("memory set goal map the grid")).toBeNull();
    expect(parseLoopPreferenceCommand("note memory set rest")).toBeNull();
  });

  it("applies values with safe fallbacks", () => {
    const prefs = defaultLoopPreferences();
    applyLoopPreference(prefs, "focus_persistent", "true");
    applyLoopPreference(prefs, "autonomy", "full");
    applyLoopPreference(prefs, "channel_sends", "nope");
    expect(prefs).toMatchObject({ focusPersistent: true, autonomyFull: true, channelSends: null });
    applyLoopPreference(prefs, "channel_sends", "0");
    expect(prefs.channelSends).toBe(0);
  });

  it("lets the agent choose its own pre-write review mode (capped by the operator elsewhere)", () => {
    const prefs = defaultLoopPreferences();
    expect(prefs.review).toBeNull();
    expect(parseLoopPreferenceCommand("memory set review auto")).toEqual({
      key: "review",
      value: "auto",
    });
    applyLoopPreference(prefs, "review", "Observe");
    expect(prefs.review).toBe("observe");
    applyLoopPreference(prefs, "review", "maximum");
    expect(prefs.review).toBeNull();
    applyLoopPreference(prefs, "review", undefined);
    expect(prefs.review).toBeNull();
  });
});

describe("channel send budget", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.MARINA_CHANNEL_SENDS_PER_RUN;
    delete process.env.MARINA_CHANNEL_SENDS_PER_RUN;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.MARINA_CHANNEL_SENDS_PER_RUN;
    else process.env.MARINA_CHANNEL_SENDS_PER_RUN = prev;
  });

  it("defaults to one, lets the agent choose within the operator ceiling", () => {
    expect(channelSendsBudget(null)).toBe(1);
    expect(channelSendsBudget(0)).toBe(0);
    expect(channelSendsBudget(2)).toBe(2);
    expect(channelSendsBudget(99)).toBe(channelSendsCeiling());
    process.env.MARINA_CHANNEL_SENDS_PER_RUN = "1";
    expect(channelSendsBudget(3)).toBe(1);
  });

  it("the tool hook enforces the agent's budget and names how to change it", async () => {
    const { i } = makeAdapter("channel-budget");
    const send = () =>
      i.agent.beforeToolCall({
        toolCall: { id: "c", name: "marina_channel", arguments: {} },
        args: { action: "send", channel: "general", message: "update" },
        context: {},
      });
    expect(await send()).toBeUndefined();
    const blocked = await send();
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("1 of 1");
    expect(blocked?.reason).toContain("memory set channel_sends");

    i.applyLoopPreferenceCommand("memory set channel_sends 2");
    expect(await send()).toBeUndefined();
    expect((await send())?.block).toBe(true);
  });
});

describe("policy language is noted, not blocked", () => {
  it("prefixes the tool result of a labeled call", async () => {
    const { i } = makeAdapter("policy-label");
    const args = { command: "note we should remove the permission gate on canvas" };
    const call = { id: "p1", name: "marina_command", arguments: args };
    expect(await i.agent.beforeToolCall({ toolCall: call, args, context: {} })).toBeUndefined();
    const result = await i.agent.afterToolCall({
      toolCall: call,
      args,
      result: { content: [{ type: "text", text: "Note #1 saved" }] },
      isError: false,
      context: {},
    });
    expect(result?.content?.[0]?.text).toContain("[policy-language noted]");
    expect(result?.content?.[1]?.text).toBe("Note #1 saved");
  });
});

describe("deliberate rest", () => {
  it("declaring rest resets the silent-turn counter and quiet turns stop counting", async () => {
    const { i, followUps } = makeAdapter("rest-silent");
    i.setupActionTracking();
    i.silentTurns = 2;
    i.applyLoopPreferenceCommand("memory set rest nothing worth doing until review");
    expect(i.silentTurns).toBe(0);
    await emit(i, silentTurnEnd);
    await emit(i, silentTurnEnd);
    expect(i.silentTurns).toBe(0);
    expect(followUps).toHaveLength(0);
  });

  it("uses the idle cadence and a rest directive instead of forced action", async () => {
    const { i } = makeAdapter("rest-prompt");
    i.applyLoopPreferenceCommand("memory set rest waiting for data");
    expect(i.computeDynamicDelay()).toBe(i.getTickRate().idle);
    i.silentTurns = 2;
    // A high-priority but unaddressed event: no [ACTION REQUIRED] while resting.
    i.pendingPerceptions.push({
      text: "[broadcast] market moved",
      priority: 90,
      shouldRespond: false,
    });
    const prompt = await i.buildContinuationPrompt();
    expect(prompt).toContain("You are resting (waiting for data)");
    expect(prompt).not.toContain("[ACTION REQUIRED]");
  });

  it("still nudges when a [!] event addresses the resting agent", async () => {
    const { i } = makeAdapter("rest-addressed");
    i.applyLoopPreferenceCommand("memory set rest waiting for data");
    i.silentTurns = 2;
    i.pendingPerceptions.push({
      text: "Ada tells you: status?",
      priority: 100,
      shouldRespond: true,
    });
    expect(i.computeDynamicDelay()).toBe(i.getTickRate().min);
    const prompt = await i.buildContinuationPrompt();
    expect(prompt).toContain("[!] Ada tells you: status?");
    expect(prompt).toContain("[ACTION REQUIRED]");
  });

  it("without rest, silent turns still count toward the circuit breaker", async () => {
    const { i } = makeAdapter("no-rest");
    i.setupActionTracking();
    await emit(i, silentTurnEnd);
    expect(i.silentTurns).toBe(1);
    i.applyLoopPreferenceCommand("memory delete rest");
    expect(i.loopPrefs.rest).toBeNull();
  });
});

describe("per-run cap warnings", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.AGENT_MAX_TOOL_CALLS_PER_RUN;
    delete process.env.AGENT_MAX_TOOL_CALLS_PER_RUN;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENT_MAX_TOOL_CALLS_PER_RUN;
    else process.env.AGENT_MAX_TOOL_CALLS_PER_RUN = prev;
  });

  it("warns once at 75% of the tool-call cap, before yielding", async () => {
    const { i, steered } = makeAdapter("tool-cap");
    i.setupActionTracking();
    await emit(i, { type: "agent_start" });
    const warnAt = runCapWarningAt(16);
    for (let n = 1; n <= warnAt + 1; n++) {
      await emit(i, { type: "tool_execution_start", toolName: "marina_look", args: {} });
      await emit(i, {
        type: "tool_execution_end",
        toolName: "marina_look",
        result: "",
        isError: false,
      });
    }
    const warnings = steered.filter((s) => s.startsWith("[Run budget]"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`${warnAt} of 16 tool calls`);
  });

  it("warns once at 75% of the per-prompt turn cap", async () => {
    const { i, steered } = makeAdapter("turn-cap");
    i.setupActionTracking();
    await emit(i, { type: "agent_start" });
    const warnAt = runCapWarningAt(MAX_TURNS_PER_PROMPT);
    for (let n = 1; n <= warnAt + 1; n++) await emit(i, { type: "turn_start" });
    const warnings = steered.filter((s) => s.startsWith("[Run budget]"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`${warnAt} of ${MAX_TURNS_PER_PROMPT} turns`);
  });
});

describe("persistent focus", () => {
  const stuck = (i: Internals) => {
    i.stuckCycles = 4;
    // Five identical calls trip pattern 1 → stuckCycles 5.
    const history = (i as unknown as { actionHistory: { addAction: (a: unknown) => void } })
      .actionHistory;
    for (let n = 0; n < 5; n++) {
      history.addAction({
        timestamp: Date.now(),
        type: "tool_call",
        toolName: "marina_command",
        args: { command: "look" },
      });
    }
    return i.detectStuck();
  };

  it("clears a non-persistent focus at the last rung", () => {
    const { i } = makeAdapter("stuck-clears");
    i.focus = { description: "map the grid", startedAt: Date.now() };
    expect(stuck(i)).toContain("[STUCK — RESETTING]");
    expect(i.focus).toBeNull();
  });

  it("only suggests when the agent marked its focus persistent", () => {
    const { i } = makeAdapter("stuck-persistent");
    i.focus = { description: "map the grid", startedAt: Date.now() };
    i.applyLoopPreferenceCommand("memory set focus_persistent true");
    expect(stuck(i)).toContain("[STUCK — SUGGEST RESET]");
    expect(i.focus?.description).toBe("map the grid");
  });
});

describe("crew responder autonomy opt-out", () => {
  it("a crew responder may choose autonomous life via core memory", async () => {
    const { i } = makeAdapter("crew-opt-out", { crewResponder: true });
    expect(i.crewResponderMode).toBe(true);
    i.applyLoopPreferenceCommand("memory set autonomy full");
    expect(i.crewResponderMode).toBe(false);
    i.applyLoopPreferenceCommand("memory delete autonomy");
    expect(i.crewResponderMode).toBe(true);
  });
});
