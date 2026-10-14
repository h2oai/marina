// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Agent-loop spend: what makes a resident call its model. Each case drives the
 * real adapter against a fake upstream (`agent.streamFunction`) that counts
 * calls, so "the loop is quiet" is a number, not a reading of the prompt.
 *
 * - an idle or resting agent makes no model call until something happens;
 * - pi's normal tool-less final turn is not a "silent turn";
 * - the silent-turn backoff never runs faster than the idle tick;
 * - declared rest registers on success only, through every surface;
 * - the agent's own focus survives its time horizon;
 * - heartbeats are metrics, not fact-tier notes.
 *
 * Addressing and reply settlement live in `test/agent-reply-loop.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import {
  defaultLoopPreferences,
  type LoopPreferences,
  parseLoopPreferenceCommand,
} from "../src/agent/loop-preferences";
import type { OutstandingRequests } from "../src/agent/outstanding-requests";
import { createMemoryTool } from "../src/agent/tools/memory";
import type { Perception } from "../src/types";
import { until } from "./helpers";
import { scopeProcessState } from "./process-state";

type Listener = (event: Record<string, unknown>, signal: AbortSignal) => Promise<void> | void;
type Message = { role: string; content: unknown };

type Internals = {
  agent: Agent;
  client: {
    emit(event: string, ...args: unknown[]): void;
    isConnected(): boolean;
    capabilities(): Promise<unknown>;
    command(cmd: string): Promise<Perception[]>;
  };
  platformMemory: Record<string, unknown>;
  outstandingRequests: OutstandingRequests;
  pendingPerceptions: Array<{
    text: string;
    priority: number;
    shouldRespond?: boolean;
    owesReply?: boolean;
  }>;
  autonomousLoopRunning: boolean;
  autonomousMode: boolean;
  cycleWaiter: { wake(): void };
  loopPrefs: LoopPreferences;
  silentTurns: number;
  currentPromptActionable: boolean;
  currentPromptAddressed: boolean;
  focus: { description: string; startedAt: number } | null;
  loopIterationCount: number;
  computeDynamicDelay(): number;
  getTickRate(): { min: number; normal: number; idle: number };
  runAutonomousLoop(): Promise<void>;
  buildContinuationPrompt(): Promise<string>;
  setupActionTracking(): void;
  connectionUnavailable(): boolean;
  noteHeartbeat(): void;
};

function textReply(model: { api: string; provider: string; id: string }, n: number) {
  const message: AssistantMessage = {
    role: "assistant",
    api: model.api as AssistantMessage["api"],
    provider: model.provider,
    model: model.id,
    timestamp: n,
    content: [{ type: "text", text: "nothing to do" }],
    stopReason: "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  return message;
}

/** An adapter wired to a fake upstream and an inert world; counts model calls and loop cycles. */
function harness(name = "Idler", config: Record<string, unknown> = {}) {
  const adapter = new LeanAgentAdapter(
    { name, model: "anthropic/claude-haiku-4-5", ...config } as never,
    "ws://localhost:39996",
    null,
    "sk-test",
  );
  const i = adapter as unknown as Internals;
  const writes: string[] = [];
  const saved: Array<unknown> = [];
  const pm = i.platformMemory;
  pm.saveOutstandingRequests = async () => {};
  pm.journalMessage = async () => {};
  pm.workInbox = async () => ({ success: true, text: "" });
  pm.getNoveltySuggestions = async () => [];
  pm.orient = async () => ({ success: true, text: "" });
  pm.questStatus = async () => ({ active: false, text: "" });
  pm.unifiedContext = async () => ({ success: true, text: "", context: null });
  pm.searchTiered = async () => ({ trusted: [], ordinary: [] });
  pm.searchSkills = async () => ({ results: [] });
  pm.lessonsFor = async () => ({ lines: [], ids: [] });
  pm.getCoreValue = async () => undefined;
  pm.getPace = async () => null;
  pm.saveFocus = async (f: unknown) => {
    saved.push(f);
    return { success: true, text: "" };
  };
  pm.write = async (_c: string, content: string) => {
    writes.push(content);
    return { success: true, text: "" };
  };
  i.client.isConnected = () => true;
  i.client.capabilities = async () => ({
    schema: "marina.capabilities.v1",
    revision: 1,
    commands: [],
  });
  i.client.command = async () => [];
  i.agent.transformContext = undefined;
  i.agent.prepareNextTurnWithContext = undefined;
  let calls = 0;
  i.agent.streamFunction = async (model) => {
    calls++;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message: textReply(model, calls) });
    stream.end();
    return stream;
  };
  const steered: string[] = [];
  const followUps: string[] = [];
  const realSteer = i.agent.steer.bind(i.agent);
  i.agent.steer = ((m: Message) => {
    steered.push(String(m.content));
    realSteer(m as never);
  }) as Agent["steer"];
  const realFollowUp = i.agent.followUp.bind(i.agent);
  i.agent.followUp = ((m: Message) => {
    followUps.push(String(m.content));
    realFollowUp(m as never);
  }) as Agent["followUp"];
  let cycles = 0;
  const realUnavailable = i.connectionUnavailable.bind(i);
  i.connectionUnavailable = () => {
    cycles++;
    return realUnavailable();
  };
  i.autonomousMode = true;
  i.setupActionTracking();

  /** Run the real loop for `n` cycles with a near-zero cycle delay. */
  async function runCycles(n: number, during?: (cycle: number) => void): Promise<void> {
    const realDelay = i.computeDynamicDelay.bind(i);
    i.computeDynamicDelay = () => {
      realDelay();
      return 1;
    };
    const start = cycles;
    i.autonomousLoopRunning = true;
    const loop = i.runAutonomousLoop();
    let seen = start;
    await until(() => {
      if (cycles !== seen) {
        seen = cycles;
        during?.(cycles - start);
      }
      i.cycleWaiter.wake();
      return cycles - start >= n;
    });
    i.autonomousLoopRunning = false;
    i.cycleWaiter.wake();
    await loop;
    i.computeDynamicDelay = realDelay;
  }

  return {
    adapter,
    i,
    calls: () => calls,
    writes,
    saved,
    steered,
    followUps,
    runCycles,
  };
}

async function emit(i: Internals, event: Record<string, unknown>): Promise<void> {
  const signal = new AbortController().signal;
  const listeners = (i.agent as unknown as { listeners: Set<Listener> }).listeners;
  for (const listener of listeners) await listener(event, signal);
}

const quietTurnEnd = { type: "turn_end", message: { role: "assistant" }, toolResults: [] };
const toolTurnEnd = {
  type: "turn_end",
  message: { role: "assistant" },
  toolResults: [{ role: "toolResult" }],
};

function channelPost(message: string, id: string, from = "Lead"): Perception {
  return {
    kind: "message",
    timestamp: Date.now(),
    data: {
      from,
      channel: "crew",
      message,
      text: `[crew] ${from}: ${message}`,
      messageId: id,
    },
  } as Perception;
}

function tellPerception(message: string, id: string, from = "Peer"): Perception {
  return {
    kind: "message",
    timestamp: Date.now(),
    tag: "tell",
    data: { senderName: from, text: `${from} tells you: ${message}`, message, messageId: id },
  } as Perception;
}

// ─── 3. Idle and resting agents do not call the model ───────────────────────

describe("idle agents don't call the model", () => {
  it("an idle agent with nothing new makes zero model calls over many cycles", async () => {
    using _s = scopeProcessState({ env: { MARINA_AGENT_HEARTBEAT_MS: undefined } });
    const h = harness("Idler");
    await h.runCycles(12);
    expect(h.calls()).toBe(0);
  });

  it("a resting agent stays quiet through ambient chatter", async () => {
    using _s = scopeProcessState({ env: { MARINA_AGENT_HEARTBEAT_MS: undefined } });
    const h = harness("Rester");
    h.i.loopPrefs = { ...defaultLoopPreferences(), rest: "waiting for review" };
    let sent = false;
    await h.runCycles(12, (cycle) => {
      if (cycle >= 3 && !sent) {
        sent = true;
        h.i.client.emit("perception", channelPost("market is up today", "a1"));
      }
    });
    expect(sent).toBe(true);
    expect(h.calls()).toBe(0);
  });

  it("a request wakes the agent: exactly one run, then quiet again", async () => {
    using _s = scopeProcessState({ env: { MARINA_AGENT_HEARTBEAT_MS: undefined } });
    const h = harness("Waker");
    h.i.loopPrefs = { ...defaultLoopPreferences(), rest: "waiting" };
    // The reply is delivered with the model's answer (as a real `marina_tell`
    // receipt would settle it) — settled in the model call itself, so a busy
    // runner that skips polls between cycles cannot leave it owed.
    const model = h.i.agent.streamFunction;
    h.i.agent.streamFunction = (async (...args: Parameters<typeof model>) => {
      h.i.outstandingRequests.clear();
      return model(...args);
    }) as typeof model;
    let sent = false;
    await h.runCycles(10, (cycle) => {
      if (cycle >= 2 && !sent) {
        sent = true;
        h.i.client.emit("perception", tellPerception("what is the total?", "t1"));
      }
    });
    // One run, plus at most one in-run recovery turn (the fake model answers
    // in prose) — never a call per cycle.
    expect(h.calls()).toBeGreaterThanOrEqual(1);
    expect(h.calls()).toBeLessThanOrEqual(2);
  });

  it("an agent whose last run did work keeps working; an idle one stops", async () => {
    using _s = scopeProcessState({ env: { MARINA_AGENT_HEARTBEAT_MS: undefined } });
    const h = harness("Worker");
    h.i.focus = { description: "map the grid", startedAt: Date.now() };
    (h.i as unknown as { lastRunToolCalls: number }).lastRunToolCalls = 2;
    await h.runCycles(8);
    // One run (its last turn made no tool call), then nothing.
    expect(h.calls()).toBe(1);
  });

  it("the long heartbeat lets an idle agent look around now and then", async () => {
    using _s = scopeProcessState({ env: { MARINA_AGENT_HEARTBEAT_MS: "1" } });
    const h = harness("Heart");
    await h.runCycles(3);
    expect(h.calls()).toBeGreaterThan(0);
  });

  it("heartbeat env: off disables it, junk keeps the default", async () => {
    const { agentHeartbeatMs } = await import("../src/agent/lean-agent-adapter");
    expect(agentHeartbeatMs({})).toBe(30 * 60_000);
    expect(agentHeartbeatMs({ MARINA_AGENT_HEARTBEAT_MS: "off" })).toBe(0);
    expect(agentHeartbeatMs({ MARINA_AGENT_HEARTBEAT_MS: "0" })).toBe(0);
    expect(agentHeartbeatMs({ MARINA_AGENT_HEARTBEAT_MS: "nope" })).toBe(30 * 60_000);
    expect(agentHeartbeatMs({ MARINA_AGENT_HEARTBEAT_MS: "600000" })).toBe(600_000);
  });
});

// ─── 1. Silent turns ────────────────────────────────────────────────────────

describe("silent turns", () => {
  it("pi's tool-less final turn after tool calls is not silent", async () => {
    const h = harness("Finisher");
    h.i.currentPromptActionable = false;
    await emit(h.i, { type: "agent_start" });
    await emit(h.i, { type: "tool_execution_start", toolCallId: "c1", toolName: "marina_look" });
    await emit(h.i, {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "marina_look",
      result: { content: [] },
      isError: false,
    });
    await emit(h.i, toolTurnEnd);
    await emit(h.i, quietTurnEnd);
    expect(h.i.silentTurns).toBe(0);
    expect(h.followUps).toHaveLength(0);
  });

  it("a tool-less run with nothing owed is a choice, not a silent turn", async () => {
    const h = harness("Chooser");
    await emit(h.i, { type: "agent_start" });
    h.i.currentPromptActionable = false;
    await emit(h.i, quietTurnEnd);
    expect(h.i.silentTurns).toBe(0);
    expect(h.followUps).toHaveLength(0);
  });

  it("a tool-less run while a reply is owed counts, with at most one follow-up per run", async () => {
    const h = harness("Owing");
    await emit(h.i, { type: "agent_start" });
    h.i.currentPromptActionable = true;
    await emit(h.i, quietTurnEnd);
    await emit(h.i, quietTurnEnd);
    expect(h.i.silentTurns).toBe(2);
    expect(h.followUps).toHaveLength(1);
    expect(h.followUps[0]).not.toContain("not delivered anywhere");
  });

  it("the real loop: a working run does not log silent turns", async () => {
    using _s = scopeProcessState({ env: { MARINA_AGENT_HEARTBEAT_MS: undefined } });
    const h = harness("RealRun");
    let n = 0;
    h.i.agent.state.tools = [
      {
        name: "marina_look",
        label: "look",
        description: "look",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "a room" }], details: {} }),
      },
    ];
    h.i.agent.streamFunction = async (model) => {
      n++;
      const stream = createAssistantMessageEventStream();
      const message = textReply(model, n);
      if (n === 1) {
        message.content = [{ type: "toolCall", name: "marina_look", id: "l1", arguments: {} }];
        message.stopReason = "toolUse";
      }
      stream.push({ type: "done", reason: message.stopReason as "stop", message });
      stream.end();
      return stream;
    };
    h.i.client.emit("perception", channelPost("the market is up", "w1"));
    await h.runCycles(6);
    expect(n).toBe(2); // tool turn + final text turn; nothing after
    expect(h.i.silentTurns).toBe(0);
    expect(h.followUps).toHaveLength(0);
  });
});

// ─── 2. Backoff floors at the idle rate ─────────────────────────────────────

describe("silent-turn backoff", () => {
  it("never runs faster than the idle tick and ramps upward", () => {
    const h = harness("Backoff");
    const idle = h.i.getTickRate().idle;
    h.i.silentTurns = 3;
    const first = h.i.computeDynamicDelay();
    h.i.silentTurns = 5;
    const later = h.i.computeDynamicDelay();
    expect(first).toBeGreaterThanOrEqual(idle);
    expect(later).toBeGreaterThan(first);
  });
});

// ─── 5. Rest registration ───────────────────────────────────────────────────

describe("declared rest registers through every surface, on success only", () => {
  it("accepts the canonical memory kv grammar", () => {
    expect(parseLoopPreferenceCommand("memory kv set rest waiting")).toEqual({
      key: "rest",
      value: "waiting",
    });
    expect(parseLoopPreferenceCommand("memory kv delete rest")).toEqual({
      key: "rest",
      value: undefined,
    });
  });

  it("applies on tool_execution_end, never on start or a refused call", async () => {
    const h = harness("Rest1");
    const command = "memory kv set rest nothing to do";
    await emit(h.i, {
      type: "tool_execution_start",
      toolCallId: "r1",
      toolName: "marina_command",
      args: { command },
    });
    expect(h.i.loopPrefs.rest).toBeNull();
    await emit(h.i, {
      type: "tool_execution_end",
      toolCallId: "r1",
      toolName: "marina_command",
      result: { content: [{ type: "text", text: "refused" }] },
      isError: true,
    });
    expect(h.i.loopPrefs.rest).toBeNull();
    await emit(h.i, {
      type: "tool_execution_start",
      toolCallId: "r2",
      toolName: "marina_command",
      args: { command },
    });
    await emit(h.i, {
      type: "tool_execution_end",
      toolCallId: "r2",
      toolName: "marina_command",
      result: { content: [{ type: "text", text: 'Memory "rest" set.' }] },
      isError: false,
    });
    expect(h.i.loopPrefs.rest).toBe("nothing to do");
  });

  it("the memory tool has rest and wake actions that write the rest key", async () => {
    const commands: string[] = [];
    const backend = {
      setCoreValue: async (key: string, value: string) => {
        commands.push(`set ${key} ${value}`);
        return { success: true, text: `Memory "${key}" set.` };
      },
      deleteCoreValue: async (key: string) => {
        commands.push(`delete ${key}`);
        return { success: true, text: `Memory "${key}" deleted.` };
      },
    };
    const tool = createMemoryTool(backend as never);
    const rested = await tool.execute("x", { action: "rest", content: "waiting on review" });
    expect(rested.details).toMatchObject({ success: true });
    await tool.execute("y", { action: "wake" });
    expect(commands).toEqual(["set rest waiting on review", "delete rest"]);

    const h = harness("Rest2");
    await emit(h.i, {
      type: "tool_execution_start",
      toolCallId: "m1",
      toolName: "memory",
      args: { action: "rest", content: "waiting on review" },
    });
    await emit(h.i, {
      type: "tool_execution_end",
      toolCallId: "m1",
      toolName: "memory",
      result: rested,
      isError: false,
    });
    expect(h.i.loopPrefs.rest).toBe("waiting on review");
  });

  it("an addressed information post does not break rest; an owed request does", () => {
    using _s = scopeProcessState({ env: { MARINA_FORCED_ACTION_NUDGE: undefined } });
    const h = harness("Resty");
    h.i.loopPrefs = { ...defaultLoopPreferences(), rest: "waiting" };
    const idle = h.i.getTickRate().idle;
    h.i.client.emit("perception", channelPost("Resty: shard 2 total is 4,113.", "i1"));
    expect(h.i.computeDynamicDelay()).toBe(idle);
    h.i.client.emit("perception", tellPerception("can you verify shard 3?", "i2"));
    expect(h.i.computeDynamicDelay()).toBe(h.i.getTickRate().min);
  });
});

// ─── 6. Focus ───────────────────────────────────────────────────────────────

describe("focus", () => {
  it("the agent's own focus survives its time horizon (review, not deletion)", async () => {
    const h = harness("Focus1");
    h.i.focus = { description: "map the grid", startedAt: Date.now() - 6 * 60_000 };
    const prompt = await h.i.buildContinuationPrompt();
    expect(prompt).toContain("[Focus Review Due]");
    expect(h.i.focus?.description).toBe("map the grid");
    expect(h.saved).not.toContain(null);
  });

  it("an operator/config goal never expires", async () => {
    const h = harness("Focus2", { goal: "keep the ledger balanced" });
    h.i.focus = { description: "keep the ledger balanced", startedAt: Date.now() - 60 * 60_000 };
    const prompt = await h.i.buildContinuationPrompt();
    expect(prompt).not.toContain("[Focus Review Due]");
    expect(h.i.focus?.description).toBe("keep the ledger balanced");
  });

  it("focus_persistent is honoured on expiry", async () => {
    const h = harness("Focus3");
    h.i.loopPrefs = { ...defaultLoopPreferences(), focusPersistent: true };
    h.i.focus = { description: "map the grid", startedAt: Date.now() - 6 * 60_000 };
    const prompt = await h.i.buildContinuationPrompt();
    expect(prompt).not.toContain("[Focus Review Due]");
    expect(h.i.focus?.description).toBe("map the grid");
  });

  it("the agent's own goal/focus writes update the live focus", async () => {
    const h = harness("Focus4");
    const run = async (id: string, toolName: string, args: unknown, text: string) => {
      await emit(h.i, { type: "tool_execution_start", toolCallId: id, toolName, args });
      await emit(h.i, {
        type: "tool_execution_end",
        toolCallId: id,
        toolName,
        result: { content: [{ type: "text", text }] },
        isError: false,
      });
    };
    await run(
      "g1",
      "marina_command",
      { command: "memory set goal chart the reef" },
      'Memory "goal" set.',
    );
    expect(h.i.focus?.description).toBe("chart the reef");
    await run(
      "g2",
      "marina_focus",
      { action: "set", description: "count the fish" },
      'Memory "focus" set.',
    );
    // An unconfirmed write changes nothing.
    await run("g2b", "marina_command", { command: "memory set goal nope" }, "Usage: …");
    expect(h.i.focus?.description).toBe("count the fish");
    expect(h.i.focus?.description).toBe("count the fish");
    await run(
      "g3",
      "marina_command",
      { command: "task goal Survey | survey the north shelf priority:3" },
      'Goal set: #4 "Survey" (priority 3).',
    );
    expect(h.i.focus?.description).toBe("Survey — survey the north shelf");
    await run("g4", "marina_focus", { action: "clear" }, 'Memory "focus" deleted.');
    expect(h.i.focus).toBeNull();
  });
});

// ─── 8–9. Heartbeat notes, stale strings ─────────────────────

describe("heartbeat, prompt text", () => {
  it("the heartbeat writes no fact-tier note", () => {
    const h = harness("Beat");
    h.i.noteHeartbeat();
    expect(h.writes).toHaveLength(0);
  });

  it("prompts name real commands and never double the period", async () => {
    const h = harness("Texts");
    h.i.focus = { description: "map the grid.", startedAt: Date.now() };
    const prompt = await h.i.buildContinuationPrompt();
    expect(prompt).not.toContain("..");
    expect(prompt).not.toContain("focus clear");
    const none = harness("NoFocus");
    const idlePrompt = await none.i.buildContinuationPrompt();
    expect(idlePrompt).not.toContain("Follow your curiosity");
    expect(idlePrompt).toContain("memory set rest");
  });

  it("observe-mode obligations log only on change, and at DEBUG when nothing was extracted", async () => {
    using _s = scopeProcessState({ env: { MARINA_OBLIGATIONS: "observe" } });
    const h = harness("Obliged");
    const lines: string[] = [];
    const log = (h.i as unknown as { log: Record<string, (...a: unknown[]) => void> }).log;
    log.info = (_c: unknown, msg: unknown) => lines.push(`info:${String(msg)}`);
    log.debug = (_c: unknown, msg: unknown) => lines.push(`debug:${String(msg)}`);
    const obligations = (h.i as unknown as { obligations: Record<string, unknown> }).obligations;
    let total = 0;
    obligations.refresh = async () => {};
    obligations.section = () => undefined;
    obligations.summary = () => ({ total, open: total });
    await h.i.buildContinuationPrompt();
    await h.i.buildContinuationPrompt();
    total = 1;
    await h.i.buildContinuationPrompt();
    await h.i.buildContinuationPrompt();
    const observed = lines.filter((l) => l.endsWith("obligations observed (not shown)"));
    expect(observed).toEqual([
      "debug:obligations observed (not shown)",
      "info:obligations observed (not shown)",
    ]);
  });
});

describe("plain-text focus values", () => {
  it("getFocus reads a focus stored as plain text (marina_focus set)", async () => {
    const { PlatformMemoryBackend } = await import("../src/agent/memory-platform");
    const client = {
      command: async () => [
        { kind: "system", timestamp: 0, data: { text: "focus (v2): count the fish" } },
      ],
    };
    const mem = new PlatformMemoryBackend(client as never);
    expect(await mem.getFocus()).toEqual({ description: "count the fish", startedAt: 0 });
  });
});
