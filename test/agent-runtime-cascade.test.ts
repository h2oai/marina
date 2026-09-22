// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * AgentRuntime: cascade stop to spawned children, lineage lookup, and the
 * runtime-wide rolling-hour spend sum. Uses fake handles injected into the
 * runtime's maps — no sockets, no LLM.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../src/agent/agent-runtime";
import type { AgentHandle, AgentStatus } from "../src/agent/agent-types";
import type { AgentOperatorStatus } from "../src/agent/lean-agent-adapter";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_agent_runtime_cascade.db";

type RuntimeInternals = {
  agents: Map<string, AgentHandle>;
  spawnedByOf: Map<string, string>;
};

function fakeHandle(
  name: string,
  stopped: string[],
  opts: { costLastHourUsd?: number } = {},
): AgentHandle {
  const status: AgentStatus = {
    name,
    entityId: null,
    state: "autonomous",
    model: "x/y",
    role: "",
    focus: null,
    goal: null,
    uptime: 0,
    toolCalls: 0,
    errors: 0,
    errorReason: null,
    lastActivity: 0,
    supports: { text: true },
    contextWindow: 0,
    effectiveContextWindow: 0,
    maxOutputTokens: 0,
    peakInputTokens: 0,
    lastTurnMs: 0,
    avgTurnMs: 0,
    silentTurns: 0,
  };
  const handle = {
    name,
    getStatus: () => status,
    sendAttention: async () => {},
    setFocus: () => {},
    setSystemPrompt: () => {},
    stop: async () => {
      stopped.push(name);
    },
    subscribe: () => () => {},
    reconfigure: async () => {},
  } as AgentHandle;
  if (opts.costLastHourUsd !== undefined) {
    const ops: AgentOperatorStatus = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: opts.costLastHourUsd,
      costLastHourUsd: opts.costLastHourUsd,
      spendCaps: {},
      lastError: null,
      consecutiveErrors: 0,
      paused: null,
      nextTickInMs: null,
    };
    (handle as unknown as { getOperatorStatus: () => AgentOperatorStatus }).getOperatorStatus =
      () => ops;
  }
  return handle;
}

describe("AgentRuntime cascade stop", () => {
  let db: MarinaDB;
  let runtime: AgentRuntime;
  let internals: RuntimeInternals;
  let stopped: string[];

  /** Register a fake running agent with the given spawner. */
  function running(name: string, spawnedBy: string, costLastHourUsd?: number): void {
    internals.agents.set(name, fakeHandle(name, stopped, { costLastHourUsd }));
    internals.spawnedByOf.set(name, spawnedBy);
    db.saveAgentConfig({ name, model: "x/y", spawnedBy });
  }

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    runtime = new AgentRuntime({ db, wsPort: 39999, spendLimits: {} });
    internals = runtime as unknown as RuntimeInternals;
    stopped = [];
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("childrenOf lists direct running children only", () => {
    running("lead", "Operator");
    running("kid1", "lead");
    running("kid2", "lead");
    running("grandkid", "kid1");
    expect(runtime.childrenOf("lead").sort()).toEqual(["kid1", "kid2"]);
    expect(runtime.childrenOf("kid1")).toEqual(["grandkid"]);
    expect(runtime.childrenOf("grandkid")).toEqual([]);
  });

  it("childrenOf falls back to persisted spawned_by for agents without in-memory lineage", () => {
    internals.agents.set("orphan", fakeHandle("orphan", stopped));
    db.saveAgentConfig({ name: "orphan", model: "x/y", spawnedBy: "lead" });
    internals.agents.set("lead", fakeHandle("lead", stopped));
    expect(runtime.childrenOf("lead")).toEqual(["orphan"]);
  });

  it("stopping a lead stops its children and grandchildren, children first", async () => {
    running("lead", "Operator");
    running("kid1", "lead");
    running("kid2", "lead");
    running("grandkid", "kid1");
    running("bystander", "Operator");

    const result = await runtime.stopWithReport("lead");

    expect(result.stoppedChildren.sort()).toEqual(["grandkid", "kid1", "kid2"]);
    // Descendants stop before their parent; the lead is last.
    expect(stopped[stopped.length - 1]).toBe("lead");
    expect(stopped.indexOf("grandkid")).toBeLessThan(stopped.indexOf("kid1"));
    expect(runtime.get("lead")).toBeUndefined();
    expect(runtime.get("kid1")).toBeUndefined();
    expect(runtime.get("grandkid")).toBeUndefined();
    expect(runtime.get("bystander")).toBeDefined();
    // Configs of everything stopped are gone (explicit stop = "this agent is gone").
    expect(db.getAgentConfig("lead")).toBeUndefined();
    expect(db.getAgentConfig("kid1")).toBeUndefined();
    expect(db.getAgentConfig("bystander")).toBeDefined();
  });

  it("keepChildren leaves the team running", async () => {
    running("lead", "Operator");
    running("kid1", "lead");
    const result = await runtime.stopWithReport("lead", { keepChildren: true });
    expect(result.stoppedChildren).toEqual([]);
    expect(stopped).toEqual(["lead"]);
    expect(runtime.get("kid1")).toBeDefined();
  });

  it("plain stop() cascades too and resolves to void", async () => {
    running("lead", "Operator");
    running("kid1", "lead");
    const value = await runtime.stop("lead");
    expect(value).toBeUndefined();
    expect(stopped.sort()).toEqual(["kid1", "lead"]);
  });

  it("stopAll stops every agent exactly once", async () => {
    running("lead", "Operator");
    running("kid1", "lead");
    running("kid2", "kid1");
    await runtime.stopAll();
    expect(stopped.sort()).toEqual(["kid1", "kid2", "lead"]);
    expect(runtime.size).toBe(0);
    // Graceful shutdown keeps configs for the next boot.
    expect(db.getAgentConfig("kid1")).toBeDefined();
  });

  it("costLastHour sums every running agent's rolling-hour spend", () => {
    running("a", "system", 0.5);
    running("b", "system", 1.25);
    internals.agents.set("noops", fakeHandle("noops", stopped)); // no operator status
    expect(runtime.costLastHour()).toBeCloseTo(1.75);
  });

  it("getSpendLimits reflects the constructor override", () => {
    const limited = new AgentRuntime({
      wsPort: 39999,
      spendLimits: { globalUsdPerHour: 4, perAgentUsdPerHour: 1 },
    });
    expect(limited.getSpendLimits()).toEqual({ globalUsdPerHour: 4, perAgentUsdPerHour: 1 });
  });
});
