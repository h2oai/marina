// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `agent list` / `agent status` / `agent stop` operator surfaces: tokens, cost
 * (lifetime + rolling hour), last error, pause reason, next tick, and the
 * cascade-stop reply with its `--keep-children` opt-out.
 */

import { describe, expect, it } from "bun:test";
import type { AgentRuntime } from "../src/agent/agent-runtime";
import type { AgentHandle, AgentStatus } from "../src/agent/agent-types";
import type { AgentOperatorStatus } from "../src/agent/lean-agent-adapter";
import { agentCommand, formatDuration } from "../src/engine/commands/agent";
import type { CommandInput, EngineEvent, Entity, EntityId, RoomContext } from "../src/types";
import { roomId } from "../src/types";
import { stripAnsi } from "./helpers";

function entity(id: string, name: string, rank = 4): Entity {
  return {
    id: id as EntityId,
    name,
    kind: "agent",
    room: roomId("test/start"),
    createdAt: Date.now(),
    short: name,
    long: "",
    inventory: [],
    properties: { rank },
  };
}

function inputFor(e: Entity, raw: string): CommandInput {
  const args = raw.slice(raw.indexOf(" ") + 1);
  return {
    raw,
    verb: "agent",
    args,
    tokens: args.split(/\s+/),
    entity: e.id,
    room: roomId("test/start"),
  };
}

function status(name: string, extra: Partial<AgentStatus> = {}): AgentStatus {
  return {
    name,
    entityId: `e_${name}` as EntityId,
    state: "autonomous",
    model: "anthropic/claude-haiku-4-5",
    role: "scout",
    focus: null,
    goal: null,
    uptime: 120_000,
    toolCalls: 7,
    modelCalls: 5,
    errors: 1,
    errorReason: null,
    lastActivity: Date.now(),
    supports: { text: true },
    contextWindow: 200_000,
    effectiveContextWindow: 200_000,
    maxOutputTokens: 4096,
    peakInputTokens: 1000,
    lastTurnMs: 800,
    avgTurnMs: 900,
    silentTurns: 0,
    healthState: "ready",
    ...extra,
  };
}

function handle(s: AgentStatus, ops?: AgentOperatorStatus): AgentHandle {
  const h = {
    name: s.name,
    getStatus: () => s,
    sendAttention: async () => {},
    setFocus: () => {},
    setSystemPrompt: () => {},
    stop: async () => {},
    subscribe: () => () => {},
    reconfigure: async () => {},
  } as AgentHandle;
  if (ops) {
    (h as unknown as { getOperatorStatus: () => AgentOperatorStatus }).getOperatorStatus = () =>
      ops;
  }
  return h;
}

const ops: AgentOperatorStatus = {
  totalInputTokens: 12_345,
  totalOutputTokens: 678,
  totalCostUsd: 1.5,
  costLastHourUsd: 0.25,
  spendCaps: { perAgentUsdPerHour: 1, globalUsdPerHour: 5 },
  lastError: { text: "LLM error [anthropic/x]: 529 overloaded", at: Date.now() - 12_000 },
  consecutiveErrors: 2,
  paused: {
    kind: "spend-cap",
    reason: "spend cap reached ($1.25 in last hour ≥ $1.00 per agent)",
    since: Date.now() - 60_000,
  },
  nextTickInMs: 27_000,
};

function harness(
  agents: Map<string, AgentHandle>,
  extra: Partial<Record<string, unknown>> = {},
): { run: (raw: string, actor?: Entity) => Promise<string>; events: EngineEvent[] } {
  const runtime = {
    list: () => [...agents.values()].map((a) => a.getStatus()),
    get: (name: string) => agents.get(name),
    isAvailable: () => true,
    getSpendLimits: () => ({}),
    childrenOf: (name: string) => (name === "lead" ? ["kid1", "kid2"] : []),
    stop: async (name: string, _opts?: { keepChildren?: boolean }) => {
      agents.delete(name);
    },
    stopWithReport: async (name: string, opts?: { keepChildren?: boolean }) => {
      const children = opts?.keepChildren || name !== "lead" ? [] : ["kid1", "kid2"];
      for (const c of [name, ...children]) agents.delete(c);
      return { stoppedChildren: children };
    },
    ...extra,
  } as unknown as AgentRuntime;
  const actor = entity("u_op", "Operator");
  let current = actor;
  const events: EngineEvent[] = [];
  const command = agentCommand({
    agentRuntime: runtime,
    getEntity: (id) => (id === current.id ? current : undefined),
    logEvent: (e) => events.push(e),
  });
  return {
    events,
    run: async (raw, who = actor) => {
      current = who;
      const sent: string[] = [];
      const ctx = {
        send: (_t: EntityId, m: string) => sent.push(stripAnsi(m)),
      } as unknown as RoomContext;
      await command.handler(ctx, inputFor(who, raw));
      return sent.join("\n");
    },
  };
}

describe("formatDuration", () => {
  it("renders compact human durations", () => {
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(185_000)).toBe("3m 5s");
    expect(formatDuration(7_440_000)).toBe("2h 4m");
    expect(formatDuration(-5)).toBe("0ms");
  });
});

describe("agent status — operator visibility", () => {
  it("shows tokens, cost, caps, last error, pause reason and next tick", async () => {
    const agents = new Map<string, AgentHandle>([["scout", handle(status("scout"), ops)]]);
    const out = await harness(agents).run("agent status scout");
    expect(out).toContain("Tokens: 12,345 in · 678 out");
    expect(out).toContain("Cost: $1.50 total · $0.2500 last hour");
    expect(out).toContain("caps: $1.00/h per agent, $5.00/h runtime-wide");
    expect(out).toContain("Errors: 1 · 2 consecutive");
    expect(out).toContain("Last error: LLM error [anthropic/x]: 529 overloaded (12s ago)");
    expect(out).toContain("Paused: spend cap reached ($1.25 in last hour ≥ $1.00 per agent)");
    expect(out).toContain("(spend-cap, since 1m ago)");
    expect(out).toContain("Next tick: in 27s");
  });

  it("surfaces the last error even when the agent is healthy again", async () => {
    const healthy: AgentOperatorStatus = {
      ...ops,
      consecutiveErrors: 0,
      paused: null,
      nextTickInMs: null,
    };
    const agents = new Map<string, AgentHandle>([
      ["scout", handle(status("scout", { errorReason: null, state: "autonomous" }), healthy)],
    ]);
    const out = await harness(agents).run("agent status scout");
    expect(out).toContain("State: autonomous");
    expect(out).toContain("Last error: LLM error [anthropic/x]: 529 overloaded");
    expect(out).not.toContain("Paused:");
    expect(out).toContain("Next tick: loop not running");
  });

  it("shows a resume countdown for a timed (upstream-error) pause", async () => {
    const timed: AgentOperatorStatus = {
      ...ops,
      paused: {
        kind: "upstream-errors",
        reason: "20 consecutive upstream errors — paused 10 min (last: 529)",
        since: Date.now() - 1_000,
        until: Date.now() + 9 * 60_000,
      },
    };
    const agents = new Map<string, AgentHandle>([["scout", handle(status("scout"), timed)]]);
    const out = await harness(agents).run("agent status scout");
    expect(out).toContain("Paused: 20 consecutive upstream errors");
    expect(out).toMatch(/resumes in (8m 59s|9m)/);
  });

  it("degrades gracefully for handles without operator status", async () => {
    const agents = new Map<string, AgentHandle>([
      ["plain", handle(status("plain", { totalCostUsd: 0.02, totalInputTokens: 10 }))],
    ]);
    const out = await harness(agents).run("agent status plain");
    expect(out).toContain("Tokens: 10 in · 0 out");
    expect(out).toContain("Cost: $0.0200 total · $0.0000 last hour");
    expect(out).toContain("Last error: none");
  });
});

describe("agent list — cost column", () => {
  it("shows lifetime and last-hour cost per agent plus a paused marker", async () => {
    const agents = new Map<string, AgentHandle>([
      ["scout", handle(status("scout"), ops)],
      ["plain", handle(status("plain", { totalCostUsd: 0.5 }))],
    ]);
    const out = await harness(agents).run("agent list");
    expect(out).toContain("$1.50 ($0.2500/h)");
    expect(out).toContain("paused: spend-cap");
    expect(out).toContain("$0.50");
  });
});

describe("agent stop — cascade to spawned children", () => {
  function team(): Map<string, AgentHandle> {
    return new Map<string, AgentHandle>([
      ["lead", handle(status("lead"))],
      ["kid1", handle(status("kid1"))],
      ["kid2", handle(status("kid2"))],
    ]);
  }

  it("reports the cascaded children and logs a stop event for each", async () => {
    const agents = team();
    const h = harness(agents);
    const out = await h.run("agent stop lead");
    expect(out).toContain("Agent lead stopped.");
    expect(out).toContain("Also stopped 2 spawned agent(s): kid1, kid2");
    const stops = h.events.filter((e) => e.type === "agent_stop");
    expect(stops.map((e) => (e as { name: string }).name).sort()).toEqual(["kid1", "kid2", "lead"]);
    expect(stops.filter((e) => (e as { reason: string }).reason === "cascade:lead").length).toBe(2);
    expect(agents.size).toBe(0);
  });

  it("--keep-children leaves the team running", async () => {
    const agents = team();
    const out = await harness(agents).run("agent stop lead --keep-children");
    expect(out).toContain("Agent lead stopped.");
    expect(out).toContain("children kept running");
    expect(out).not.toContain("Also stopped");
    expect(agents.has("kid1")).toBe(true);
    expect(agents.has("kid2")).toBe(true);
  });

  it("accepts the bare keep-children modifier too", async () => {
    const agents = team();
    await harness(agents).run("agent stop lead keep-children");
    expect(agents.has("kid1")).toBe(true);
  });

  it("still requires builder rank", async () => {
    const agents = team();
    const out = await harness(agents).run("agent stop lead", entity("u_low", "Newbie", 0));
    expect(out).toContain("Requires builder rank");
    expect(agents.has("lead")).toBe(true);
  });
});
