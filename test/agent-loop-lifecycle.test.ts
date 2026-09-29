// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Agent-loop cost safety and lifecycle: reply obligations expire and are
 * capped, model calls pause while the world connection is down (and stop for
 * good when the SDK gives up), the daily spend cap ends a multi-turn prompt,
 * restart rebuilds the boot config, boot/stopAll own the uptime interval, and
 * reconfigure never parks on the cycle delay.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { AgentRuntime, spawnConfigFromSaved } from "../src/agent/agent-runtime";
import type { AgentConfig, AgentEvent, AgentStatus } from "../src/agent/agent-types";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import {
  MAX_OUTSTANDING_REQUESTS,
  OUTSTANDING_REQUEST_TTL_MS,
  type OutstandingRequest,
  OutstandingRequests,
  readRequestLedger,
  updateRequestLedger,
} from "../src/agent/outstanding-requests";
import { MAX_TURNS_PER_PROMPT } from "../src/engine/constants";
import { recordSpend, resetSpendLedgerForTests } from "../src/engine/spend-ledger";
import { MarinaDB } from "../src/persistence/database";
import { MarinaClient } from "../src/sdk/client";
import type { Perception } from "../src/types";
import { until } from "./helpers";
import { scopeProcessState } from "./process-state";

function tell(message: string, messageId?: string): Perception {
  return {
    kind: "message",
    timestamp: 1,
    tag: "tell",
    data: {
      senderName: "Boss",
      text: `Boss tells you: ${message}`,
      message,
      ...(messageId ? { messageId } : {}),
    },
  };
}

// ─── 1. Reply obligations: TTL and cap ────────────────────────────────────────

describe("OutstandingRequests TTL and cap", () => {
  it("an expired request stops counting and is reported once", () => {
    let now = 1_000_000;
    const dropped: string[] = [];
    const pending = new OutstandingRequests({
      now: () => now,
      onDrop: (request, reason) => dropped.push(`${request.id}:${reason}`),
    });
    const id = pending.add(tell("status?", "m1"), 1, "Boss tells you: status?")!;
    pending.present(id);
    expect(pending.size).toBe(1);
    expect(pending.entries()[0]?.recordedAt).toBe(now);
    now += OUTSTANDING_REQUEST_TTL_MS - 1;
    expect(pending.presentedIds().size).toBe(1);
    now += 1;
    expect(pending.size).toBe(0);
    expect(pending.presentedIds().size).toBe(0);
    expect(pending.entries()).toEqual([]);
    expect(dropped).toEqual([`${id}:expired`]);
  });

  it("caps the ledger, evicting oldest first; a new arrival at the cap is still new", () => {
    let now = 5_000;
    const dropped: string[] = [];
    const pending = new OutstandingRequests({
      now: () => now,
      onDrop: (request, reason) => dropped.push(`${request.id}:${reason}`),
    });
    for (let i = 0; i < MAX_OUTSTANDING_REQUESTS; i++) {
      now += 1;
      pending.add(tell(`q${i}`, `m${i}`), i, `q${i}`);
    }
    expect(pending.size).toBe(MAX_OUTSTANDING_REQUESTS);
    now += 1;
    const tracked = pending.track(tell("newest", "new"), 999, "newest");
    expect(tracked).toEqual({ id: "tell:new", isNew: true });
    expect(pending.size).toBe(MAX_OUTSTANDING_REQUESTS);
    expect(pending.entries().some((r) => r.id === "tell:m0")).toBe(false);
    expect(pending.entries().some((r) => r.id === "tell:new")).toBe(true);
    expect(dropped).toEqual(["tell:m0:evicted"]);
    // A repeated delivery of a tracked id is not new.
    expect(pending.track(tell("newest", "new"), 1000, "newest")).toEqual({
      id: "tell:new",
      isNew: false,
    });
  });

  it("restore keeps the original recordedAt, so the TTL does not restart", () => {
    const recordedAt = 10_000;
    const ledger = updateRequestLedger(
      undefined,
      [
        {
          id: "tell:old",
          kind: "tell",
          target: "Boss",
          text: "old ask",
          presented: true,
          recordedAt,
        },
      ],
      [],
      recordedAt,
    );
    // Persisted through the checkpoint JSON round trip.
    const persisted = JSON.parse(JSON.stringify(ledger));
    let now = recordedAt + OUTSTANDING_REQUEST_TTL_MS - 1_000;
    const restored = new OutstandingRequests({ now: () => now });
    restored.restore(persisted);
    expect(restored.entries().map((r) => [r.id, r.recordedAt, r.presented])).toEqual([
      ["tell:old", recordedAt, false],
    ]);
    now += 1_000;
    expect(restored.size).toBe(0);
  });

  it("the durable ledger prunes expired and over-cap entries on write", () => {
    const base = 1_000_000;
    const entry = (id: string, recordedAt: number): OutstandingRequest => ({
      id,
      kind: "tell",
      target: "Boss",
      text: id,
      presented: false,
      recordedAt,
    });
    const stale = updateRequestLedger(undefined, [entry("stale", base)], [], base);
    const later = base + OUTSTANDING_REQUEST_TTL_MS;
    expect(updateRequestLedger(stale, [entry("fresh", later)], [], later).requests).toEqual([
      entry("fresh", later),
    ]);
    const many = Array.from({ length: MAX_OUTSTANDING_REQUESTS + 3 }, (_, i) =>
      entry(`r${i}`, base + i),
    );
    const capped = updateRequestLedger(undefined, many, [], base + 100);
    expect(capped.requests).toHaveLength(MAX_OUTSTANDING_REQUESTS);
    expect(capped.requests[0]?.id).toBe("r3");
  });

  it("a pre-upgrade entry without recordedAt starts its TTL at the first read", () => {
    const legacy = {
      version: 1,
      requests: [{ id: "tell:x", kind: "tell", target: "Boss", text: "x", presented: false }],
    };
    expect(readRequestLedger(legacy, 42)[0]?.recordedAt).toBe(42);
    expect(() =>
      readRequestLedger({ version: 1, requests: [{ ...legacy.requests[0], recordedAt: "soon" }] }),
    ).toThrow(/Invalid outstanding-request checkpoint/);
  });
});

type AdapterInternals = {
  agent: Agent;
  client: Pick<MarinaClient, "isConnected" | "capabilities"> & {
    emit(event: string, ...args: unknown[]): void;
  };
  platformMemory: {
    saveOutstandingRequests(requests: OutstandingRequest[]): Promise<void>;
    getCheckpoint(): Promise<Record<string, unknown> | null>;
    workInbox(): Promise<{ success: boolean; text: string }>;
    journalMessage(...args: unknown[]): Promise<void>;
  };
  outstandingRequests: OutstandingRequests;
  pendingPerceptions: unknown[];
  autonomousLoopRunning: boolean;
  autonomousMode: boolean;
  autonomousLoopPromise: Promise<void> | null;
  cycleWaiter: { wake(): void };
  currentPromptActionable: boolean;
  computeDynamicDelay(): number;
  runAutonomousLoop(): Promise<void>;
  buildContinuationPrompt(): Promise<string>;
  loadCheckpointSummary(): Promise<string>;
  stopCheckpointTimer(): void;
  setupActionTracking(): void;
};

function makeAdapter(config: Partial<AgentConfig> = {}) {
  const adapter = new LeanAgentAdapter(
    { name: "Looper", model: "anthropic/claude-haiku-4-5", spawnedBy: "Boss", ...config },
    "ws://localhost:39998",
    null,
    "sk-test",
  );
  const i = adapter as unknown as AdapterInternals;
  i.platformMemory.saveOutstandingRequests = async () => {};
  i.platformMemory.workInbox = async () => ({ success: true, text: "" });
  const events: AgentEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  return { adapter, i, events };
}

describe("LeanAgentAdapter with an expired reply obligation", () => {
  it("no longer forces the fast tick or the reply-owed section", async () => {
    const { i } = makeAdapter();
    i.autonomousMode = true;
    const idleDelay = i.computeDynamicDelay();
    i.client.emit("perception", tell("please answer [re:abcd12]", "m1"));
    // The tell itself is actionable: consume it into a prompt so only the
    // outstanding obligation remains.
    await i.buildContinuationPrompt();
    i.pendingPerceptions = [];
    expect(i.outstandingRequests.size).toBe(1);
    const owedDelay = i.computeDynamicDelay();
    expect(owedDelay).toBeLessThan(idleDelay);
    expect(await i.buildContinuationPrompt()).toContain("Reply still owed");
    expect(i.currentPromptActionable).toBe(true);

    for (const request of i.outstandingRequests.entries())
      request.recordedAt -= OUTSTANDING_REQUEST_TTL_MS;
    expect(i.outstandingRequests.size).toBe(0);
    expect(i.computeDynamicDelay()).toBe(idleDelay);
    const prompt = await i.buildContinuationPrompt();
    expect(prompt).not.toContain("Reply still owed");
    expect(i.currentPromptActionable).toBe(false);
  });

  it("an expired checkpointed request is not recovered as a fresh perception on boot", async () => {
    const { i } = makeAdapter();
    const old = Date.now() - OUTSTANDING_REQUEST_TTL_MS - 1;
    const fresh = Date.now();
    i.platformMemory.getCheckpoint = async () => ({
      outstandingRequests: {
        version: 1,
        requests: [
          {
            id: "tell:old",
            kind: "tell",
            target: "Boss",
            text: "old",
            presented: true,
            recordedAt: old,
          },
          {
            id: "tell:new",
            kind: "tell",
            target: "Boss",
            text: "new",
            presented: true,
            recordedAt: fresh,
          },
        ],
      },
    });
    await i.loadCheckpointSummary();
    expect(i.outstandingRequests.entries().map((r) => [r.id, r.recordedAt])).toEqual([
      ["tell:new", fresh],
    ]);
    expect(i.pendingPerceptions).toHaveLength(1);
  });
});

// ─── 2. Connection loss pauses model calls ────────────────────────────────────

describe("LeanAgentAdapter connection handling", () => {
  it("never prompts while disconnected, resumes on reconnect, and stops on reconnect_failed", async () => {
    const { adapter, i, events } = makeAdapter();
    let connected = false;
    i.client.isConnected = () => connected;
    let prompts = 0;
    i.buildContinuationPrompt = async () => "continue";
    i.client.capabilities = async () => ({
      schema: "marina.capabilities.v1",
      revision: 1,
      commands: [],
    });
    i.agent.prompt = (async () => {
      prompts++;
    }) as Agent["prompt"];
    i.autonomousLoopRunning = true;
    i.autonomousMode = true;
    const loop = i.runAutonomousLoop();

    for (let n = 0; n < 3; n++) {
      i.cycleWaiter.wake();
      await Bun.sleep(10);
    }
    expect(prompts).toBe(0);

    connected = true;
    i.client.emit("connect", { entityId: "e_1" as never, token: "t", name: "Looper" });
    // The reconnect woke the parked wait; the next cycle's delay is cut short too.
    await until(() => {
      i.cycleWaiter.wake();
      return prompts >= 1;
    });

    connected = false;
    const before = prompts;
    i.client.emit("reconnect_failed");
    await loop;
    expect(prompts).toBe(before);
    expect(i.autonomousLoopRunning).toBe(false);
    const status = adapter.getStatus();
    expect(status.state).toBe("error");
    expect(status.errorReason).toContain("reconnect gave up");
    expect(events.some((e) => e.type === "error" && e.context === "connection")).toBe(true);
    expect(events.some((e) => e.type === "status_change" && e.status.state === "error")).toBe(true);
  });
});

describe("MarinaClient reconnect give-up", () => {
  it("emits reconnect_failed once and reports the failed state", () => {
    const client = new MarinaClient("ws://localhost:39997", { maxReconnectAttempts: 0 });
    const internals = client as unknown as {
      session: unknown;
      scheduleReconnect(): void;
    };
    internals.session = { entityId: "e_1", token: "t", name: "x" };
    expect(client.hasGivenUpReconnecting()).toBe(false);
    expect(client.getConnectionState()).toBe("reconnecting");
    let failures = 0;
    client.on("reconnect_failed", () => failures++);
    internals.scheduleReconnect();
    internals.scheduleReconnect();
    expect(failures).toBe(1);
    expect(client.hasGivenUpReconnecting()).toBe(true);
    expect(client.getConnectionState()).toBe("failed");
  });

  it("a fresh client is disconnected, not failed", () => {
    const client = new MarinaClient("ws://localhost:39997");
    expect(client.getConnectionState()).toBe("disconnected");
    expect(client.hasGivenUpReconnecting()).toBe(false);
  });
});

// ─── 3. Daily spend cap per turn ──────────────────────────────────────────────

function assistant(model: { api: string; provider: string; id: string }, n: number, cost = 0) {
  const message: AssistantMessage = {
    role: "assistant",
    api: model.api as AssistantMessage["api"],
    provider: model.provider,
    model: model.id,
    timestamp: n,
    content: [{ type: "toolCall", name: "work", id: `call-${n}`, arguments: {} }],
    stopReason: "toolUse",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    },
  };
  return message;
}

describe("daily spend cap inside one prompt", () => {
  beforeEach(() => resetSpendLedgerForTests());
  afterEach(() => resetSpendLedgerForTests());

  function runner(turnCost: (n: number) => number, onTool: () => void) {
    const { i } = makeAdapter();
    i.agent.transformContext = undefined;
    i.agent.prepareNextTurnWithContext = undefined;
    // The real per-run caps (turns, tool calls) stay in force alongside spend.
    i.platformMemory.journalMessage = async () => {};
    i.setupActionTracking();
    let calls = 0;
    i.agent.state.tools = [
      {
        name: "work",
        label: "work",
        description: "does work",
        parameters: Type.Object({}),
        execute: async () => {
          onTool();
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      },
    ];
    i.agent.streamFunction = async (model) => {
      calls++;
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "toolUse",
        message: assistant(model, calls, turnCost(calls)),
      });
      stream.end();
      return stream;
    };
    return { i, calls: () => calls };
  }

  it("ends the run at the turn where spend reaches the cap", async () => {
    using _state = scopeProcessState({ env: { MARINA_DAILY_SPEND_CAP_USD: "1" } });
    let tools = 0;
    const r = runner(
      () => 0,
      () => {
        tools++;
        // Another spend site (e.g. the /v1 passthru) crosses the cap mid-run.
        if (tools === 2) recordSpend("model_api", 5);
      },
    );
    await r.i.agent.prompt("go");
    await r.i.agent.waitForIdle();
    expect(r.calls()).toBe(2);
  });

  it("counts the finishing turn's own cost before turn_end records it", async () => {
    using _state = scopeProcessState({ env: { MARINA_DAILY_SPEND_CAP_USD: "1" } });
    const r = runner(
      () => 2,
      () => {},
    );
    await r.i.agent.prompt("go");
    await r.i.agent.waitForIdle();
    expect(r.calls()).toBe(1);
  });

  it("uncapped: the run continues past the spend", async () => {
    using _state = scopeProcessState({ env: { MARINA_DAILY_SPEND_CAP_USD: "0" } });
    const r = runner(
      () => 2,
      () => {},
    );
    await r.i.agent.prompt("go");
    await r.i.agent.waitForIdle();
    // Only the ordinary per-run cap ends it.
    expect(r.calls()).toBeGreaterThan(2);
    expect(r.calls()).toBeLessThanOrEqual(MAX_TURNS_PER_PROMPT);
  });
});

// ─── 4–5. Runtime restart config and boot lifecycle ───────────────────────────

function fakeStatus(over: Partial<AgentStatus>): AgentStatus {
  return {
    name: "x",
    entityId: null,
    state: "autonomous",
    model: "openai/gpt-5-mini",
    role: "",
    focus: null,
    goal: null,
    uptime: 0,
    toolCalls: 0,
    errors: 0,
    errorReason: null,
    lastActivity: 0,
    supports: { text: true },
    contextWindow: 1,
    effectiveContextWindow: 1,
    maxOutputTokens: 1,
    peakInputTokens: 0,
    lastTurnMs: 0,
    avgTurnMs: 0,
    silentTurns: 0,
    ...over,
  } as AgentStatus;
}

type RuntimeInternals = {
  agents: Map<string, unknown>;
  launchConfigs: Map<string, AgentConfig>;
  uptimeCheckInterval: unknown;
  spawn: (config: AgentConfig) => Promise<unknown>;
};

describe("AgentRuntime restart and boot lifecycle", () => {
  let db: MarinaDB;
  let runtime: AgentRuntime;
  let internals: RuntimeInternals;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
    runtime = new AgentRuntime({ db });
    internals = runtime as unknown as RuntimeInternals;
  });
  afterEach(async () => {
    await runtime.stopAll();
    db.close();
  });

  function stubAgent(name: string, status: Partial<AgentStatus> = {}) {
    const handle = {
      stopped: false,
      getStatus: () => fakeStatus({ name, ...status }),
      stop: async () => {
        handle.stopped = true;
      },
      setFocus: () => {},
    };
    return handle;
  }

  it("restart builds the same config boot respawn does (crew role keeps its profile)", async () => {
    db.saveAgentConfig({
      name: "Scholar",
      model: "openai/gpt-5-mini",
      role: "scholar",
      goal: "check sources",
      spawnedBy: "Lead",
      supports: { text: true, image: true },
    });
    const spawned: AgentConfig[] = [];
    internals.spawn = async (config) => {
      spawned.push(config);
      const handle = stubAgent(config.name);
      internals.agents.set(config.name, handle);
      return handle;
    };
    await runtime.init();
    expect(spawned).toHaveLength(1);
    const boot = spawned[0]!;
    expect(boot).toEqual(spawnConfigFromSaved(db.getAgentConfig("Scholar")!));
    expect(boot.toolProfile).toBe("crew");
    expect(boot.crewResponder).toBe(true);

    await runtime.restart("Scholar");
    const restarted = spawned[1]!;
    expect(restarted.toolProfile).toBe("crew");
    expect(restarted.crewResponder).toBe(true);
    expect(restarted.supports).toEqual({ text: true, image: true });
    expect(restarted.spawnedBy).toBe("Lead");
    expect(restarted.goal).toBe("check sources");
  });

  it("restart keeps an explicit launch profile and budget; a new model re-derives supports", async () => {
    db.saveAgentConfig({
      name: "Tiny",
      model: "openai/gpt-5-mini",
      spawnedBy: "system",
      supports: { text: true },
    });
    internals.agents.set("Tiny", stubAgent("Tiny"));
    internals.launchConfigs.set("Tiny", {
      name: "Tiny",
      model: "openai/gpt-5-mini",
      toolProfile: "minimal",
      crewResponder: false,
      budgetCalls: 7,
      contextWindow: 8192,
    });
    let spawned: AgentConfig | undefined;
    internals.spawn = async (config) => {
      spawned = config;
      return stubAgent(config.name);
    };
    await runtime.restart("Tiny", { model: "openai/gpt-5" });
    expect(spawned?.toolProfile).toBe("minimal");
    expect(spawned?.budgetCalls).toBe(7);
    expect(spawned?.model).toBe("openai/gpt-5");
    expect(spawned?.supports).toBeUndefined();
    expect(spawned?.contextWindow).toBeUndefined();
  });

  it("a second init() joins the first and arms one uptime interval", async () => {
    db.saveAgentConfig({ name: "Once", model: "openai/gpt-5-mini", spawnedBy: "system" });
    let spawns = 0;
    internals.spawn = async (config) => {
      spawns++;
      const handle = stubAgent(config.name);
      internals.agents.set(config.name, handle);
      return handle;
    };
    const [a, b] = await Promise.all([runtime.init(), runtime.init()]);
    expect([a, b]).toEqual([1, 1]);
    const interval = internals.uptimeCheckInterval;
    expect(interval).not.toBeNull();
    expect(await runtime.init()).toBe(1);
    expect(internals.uptimeCheckInterval).toBe(interval);
    expect(spawns).toBe(1);
    await runtime.stopAll();
    expect(internals.uptimeCheckInterval).toBeNull();
  });

  it("stopAll() during boot cancels the interval and winds down late spawns", async () => {
    db.saveAgentConfig({ name: "Late", model: "openai/gpt-5-mini", spawnedBy: "system" });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let spawnStarted = false;
    const handle = stubAgent("Late");
    internals.spawn = async (config) => {
      spawnStarted = true;
      await gate;
      internals.agents.set(config.name, handle);
      return handle;
    };
    const boot = runtime.init();
    await until(() => spawnStarted);
    await runtime.stopAll();
    release();
    expect(await boot).toBe(0);
    expect(internals.uptimeCheckInterval).toBeNull();
    expect(handle.stopped).toBe(true);
    expect(runtime.size).toBe(0);
    // The config survives for the next boot.
    expect(db.getAgentConfig("Late")).toBeTruthy();
  });
});

// ─── 6. reconfigure wakes the cycle waiter ────────────────────────────────────

describe("LeanAgentAdapter.reconfigure", () => {
  it("does not park on the idle cycle delay", async () => {
    const { adapter, i } = makeAdapter();
    i.client.isConnected = () => true;
    // Parked in the idle cycle-delay sleep (tens of seconds).
    i.autonomousLoopRunning = true;
    i.autonomousMode = true;
    i.autonomousLoopPromise = i.runAutonomousLoop();
    await Bun.sleep(5);
    expect(i.computeDynamicDelay()).toBeGreaterThan(5_000);
    const started = Date.now();
    await adapter.reconfigure({});
    expect(Date.now() - started).toBeLessThan(1_000);
    // reconfigure restarted the loop; wind it down.
    i.autonomousLoopRunning = false;
    i.autonomousMode = false;
    i.cycleWaiter.wake();
    await i.autonomousLoopPromise;
    i.stopCheckpointTimer();
  });
});
