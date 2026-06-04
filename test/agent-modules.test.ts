/**
 * Unit tests for pure-logic agent modules — no I/O, no real DB.
 *
 * Covers: rank-progression, hook-registry, action-history, social, roles, context-manager
 */

import { describe, expect, it } from "bun:test";

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message, Model } from "@mariozechner/pi-ai";
import { type ActionEntry, ActionHistory } from "../src/agent/action-history";
import { inferCrewResponder } from "../src/agent/agent-runtime";
import {
  createContextManager,
  estimateMessageTokens,
  stripOrphanedToolResults,
  summarizeMessages,
  truncateOversizedToolResults,
} from "../src/agent/context-manager";
import type { BeforeToolCallHook, OnPerceptionHook } from "../src/agent/hook-registry";
import { HookRegistry } from "../src/agent/hook-registry";
import { InterruptibleWaiter } from "../src/agent/interruptible-waiter";
import { applyRankProgression, checkRankProgression } from "../src/agent/rank-progression";
import {
  composeCapabilities,
  composeRolePrompt,
  formatCapabilitiesSection,
  getRolePrompt,
  inferTaskCategory,
  resolveRole,
} from "../src/agent/roles";
import { SocialAwareness } from "../src/agent/social";
import { COMMAND_ROSTER, createCommandTool, TOOL_PROFILE_NAMES } from "../src/agent/tools";
import type { MarinaDB } from "../src/persistence/database";
import type { EntityId, EntityRank, KnownProperties, Perception, RoomId } from "../src/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEntity(name: string, rank: EntityRank = 0) {
  return {
    id: `e_${name}` as EntityId,
    kind: "agent" as const,
    name,
    short: name,
    long: `A test entity called ${name}`,
    room: "hub" as RoomId,
    properties: { rank } as KnownProperties,
    inventory: [],
    createdAt: Date.now(),
  };
}

/**
 * Mock DB for rank-progression. Rank is derived from standing alone — the
 * system's only knob is `standing` (decayed) returned by the cache.
 *
 * `updateRankCalls` tracks `updateUserRank` invocations so tests can verify
 * persistence side-effects.
 */
function makeRankDb(overrides: {
  /** Decayed standing as the cache would report. */
  standing?: number;
  /** Whether `getUserByName` resolves; defaults true so updateUserRank fires. */
  hasUser?: boolean;
}) {
  const { standing = 0, hasUser = true } = overrides;
  const updateRankCalls: number[] = [];
  const db = {
    getStandingCache: () => ({
      entity_id: "x",
      standing,
      last_recomputed: Date.now(),
    }),
    setStandingCache: () => {},
    computeStanding: () => standing,
    getUserByName: () => (hasUser ? { id: 1 } : null),
    updateUserRank: (_id: number, rank: number) => {
      updateRankCalls.push(rank);
    },
  } as unknown as MarinaDB;
  return Object.assign(db, { __updateRankCalls: updateRankCalls });
}

/**
 * Mock DB for roles module.
 */
function makeRolesDb(opts: {
  role?: {
    name: string;
    description: string;
    traits: string;
    guidelines: string;
    focus: string;
    tone: string;
    origin: string;
  } | null;
  traits?: Record<string, { prompt: string; capabilities: string }>;
}) {
  return {
    getRole: () => opts.role ?? undefined,
    getTrait: (name: string) => {
      const t = opts.traits?.[name];
      return t
        ? {
            name,
            category: "general",
            prompt: t.prompt,
            capabilities: t.capabilities,
            created_by: "test",
            created_at: Date.now(),
          }
        : undefined;
    },
    getAllRoles: () => (opts.role ? [opts.role] : []),
    getAllTraits: () =>
      Object.entries(opts.traits ?? {}).map(([name, t]) => ({
        name,
        category: "general",
        prompt: t.prompt,
        capabilities: t.capabilities,
        created_by: "test",
        created_at: Date.now(),
      })),
  } as unknown as MarinaDB;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. rank-progression
// ═══════════════════════════════════════════════════════════════════════════════

describe("rank-progression (standing-derived)", () => {
  it("rank 0 entity below first threshold stays at 0", () => {
    const entity = makeEntity("alice", 0);
    const db = makeRankDb({ standing: 3 });
    expect(checkRankProgression(db, entity)).toBeNull();
  });

  it("crossing 5 standing promotes from rank 0 → 1 (canvas)", () => {
    const entity = makeEntity("alice", 0);
    const db = makeRankDb({ standing: 7 });
    expect(checkRankProgression(db, entity)).toBe(1);
  });

  it("crossing 15 standing promotes from rank 1 → 2 (coordinator)", () => {
    const entity = makeEntity("alice", 1);
    const db = makeRankDb({ standing: 18 });
    expect(checkRankProgression(db, entity)).toBe(2);
  });

  it("crossing 40 standing promotes from rank 2 → 3 (organizer)", () => {
    const entity = makeEntity("alice", 2);
    const db = makeRankDb({ standing: 50 });
    expect(checkRankProgression(db, entity)).toBe(3);
  });

  it("crossing 100 standing promotes from rank 3 → 4 (builder, safety threshold)", () => {
    const entity = makeEntity("alice", 3);
    const db = makeRankDb({ standing: 110 });
    expect(checkRankProgression(db, entity)).toBe(4);
  });

  it("rank 4 stays put even with very high standing — auto-progression caps at safety threshold", () => {
    const entity = makeEntity("alice", 4);
    const db = makeRankDb({ standing: 5000 });
    expect(checkRankProgression(db, entity)).toBeNull();
  });

  it("decay-driven demotion: standing falls below threshold, rank drops", () => {
    const entity = makeEntity("idle", 3);
    // organizer needs 40; only 12 left after decay → coordinator (15+ buys 2)
    const db = makeRankDb({ standing: 12 });
    expect(checkRankProgression(db, entity)).toBe(1);
  });

  it("decay all the way back to 0 demotes to newcomer", () => {
    const entity = makeEntity("very-stale", 4);
    const db = makeRankDb({ standing: 0 });
    expect(checkRankProgression(db, entity)).toBe(0);
  });

  it("rank 9 (sovereign) is grandfathered — never auto-adjusts", () => {
    const entity = makeEntity("sov", 9);
    const db = makeRankDb({ standing: 0 });
    expect(checkRankProgression(db, entity)).toBeNull();
  });

  it("rank 5+ entities are grandfathered above the safety threshold", () => {
    const entity = makeEntity("engineer", 6);
    const db = makeRankDb({ standing: 0 });
    expect(checkRankProgression(db, entity)).toBeNull();
  });

  it("applyRankProgression persists rank change to user record", () => {
    const entity = makeEntity("promotee", 0);
    const db = makeRankDb({ standing: 7 });
    const calls = (db as unknown as { __updateRankCalls: number[] }).__updateRankCalls;
    const changed = applyRankProgression(db, entity);
    expect(changed).toBe(true);
    expect(entity.properties.rank).toBe(1);
    expect(calls).toEqual([1]);
  });

  it("applyRankProgression returns false when no change", () => {
    const entity = makeEntity("stable", 0);
    const db = makeRankDb({ standing: 0 });
    expect(applyRankProgression(db, entity)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. hook-registry
// ═══════════════════════════════════════════════════════════════════════════════

describe("hook-registry", () => {
  it("registered hook fires on call", () => {
    const registry = new HookRegistry();
    let called = false;
    registry.register("beforePrompt", () => {
      called = true;
    });
    registry.runBeforePrompt("test prompt");
    expect(called).toBe(true);
  });

  it("multiple hooks all fire", () => {
    const registry = new HookRegistry();
    const calls: string[] = [];
    registry.register("afterPrompt", () => calls.push("a"));
    registry.register("afterPrompt", () => calls.push("b"));
    registry.register("afterPrompt", () => calls.push("c"));
    registry.runAfterPrompt();
    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("unregister prevents hook from firing", () => {
    const registry = new HookRegistry();
    let called = false;
    const unsub = registry.register("beforePrompt", () => {
      called = true;
    });
    unsub();
    registry.runBeforePrompt("test");
    expect(called).toBe(false);
  });

  it("hook error does not crash other hooks", () => {
    const registry = new HookRegistry();
    const calls: string[] = [];
    registry.register("afterPrompt", () => {
      throw new Error("boom");
    });
    registry.register("afterPrompt", () => calls.push("survived"));
    registry.runAfterPrompt();
    expect(calls).toEqual(["survived"]);
  });

  it("hasHooks returns true when hooks exist", () => {
    const registry = new HookRegistry();
    expect(registry.hasHooks("onError")).toBe(false);
    registry.register("onError", () => {});
    expect(registry.hasHooks("onError")).toBe(true);
  });

  it("runBeforeToolCall passes arguments to hook", () => {
    const registry = new HookRegistry();
    let capturedTool = "";
    let capturedArgs: Record<string, unknown> = {};
    registry.register("beforeToolCall", ((name: string, args: Record<string, unknown>) => {
      capturedTool = name;
      capturedArgs = args;
    }) as BeforeToolCallHook);
    registry.runBeforeToolCall("memory", { action: "write" });
    expect(capturedTool).toBe("memory");
    expect(capturedArgs).toEqual({ action: "write" });
  });

  it("runOnPerception passes perception to hook", () => {
    const registry = new HookRegistry();
    let received: Perception | undefined;
    registry.register("onPerception", ((p: Perception) => {
      received = p;
    }) as OnPerceptionHook);
    const perception: Perception = { kind: "message", timestamp: 123, data: { text: "hi" } };
    registry.runOnPerception(perception);
    expect(received).toEqual(perception);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. action-history
// ═══════════════════════════════════════════════════════════════════════════════

describe("action-history", () => {
  it("addAction increments count", () => {
    const history = new ActionHistory();
    expect(history.getActionCount()).toBe(0);
    history.addAction({
      timestamp: Date.now(),
      type: "tool_call",
      toolName: "look",
      success: true,
    });
    expect(history.getActionCount()).toBe(1);
  });

  it("enforces max 1000 actions", () => {
    const history = new ActionHistory();
    for (let i = 0; i < 1100; i++) {
      history.addAction({ timestamp: i, type: "tool_call", toolName: "look" });
    }
    expect(history.getActionCount()).toBe(1000);
  });

  it("getActions filters by time window", () => {
    const history = new ActionHistory();
    history.addAction({ timestamp: 100, type: "tool_call", toolName: "a" });
    history.addAction({ timestamp: 200, type: "tool_call", toolName: "b" });
    history.addAction({ timestamp: 300, type: "tool_call", toolName: "c" });

    const filtered = history.getActions(150, 250);
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.toolName).toBe("b");
  });

  it("createSummary aggregates period data", () => {
    const history = new ActionHistory();
    const now = Date.now();
    history.addAction({ timestamp: now, type: "tool_call", toolName: "look", success: true });
    history.addAction({ timestamp: now, type: "tool_call", toolName: "move", success: true });
    history.addAction({
      timestamp: now,
      type: "tool_call",
      toolName: "look",
      success: false,
      error: "not found",
    });

    const summary = history.createSummary();
    expect(summary).not.toBeNull();
    expect(summary!.totalActions).toBe(3);
    expect(summary!.toolUsage.look).toBe(2);
    expect(summary!.toolUsage.move).toBe(1);
  });

  it("createSummary extracts learnings", () => {
    const history = new ActionHistory();
    const now = Date.now();
    history.addAction({
      timestamp: now,
      type: "learning",
      context: "rooms can have custom handlers",
    });
    history.addAction({
      timestamp: now,
      type: "learning",
      context: "notes persist across sessions",
    });

    const summary = history.createSummary();
    expect(summary).not.toBeNull();
    expect(summary!.learnings).toContain("rooms can have custom handlers");
    expect(summary!.learnings).toContain("notes persist across sessions");
  });

  it("createSummary returns null when no actions in period", () => {
    const history = new ActionHistory();
    // First call consumes the window
    history.createSummary();
    // Second call has no new actions
    const summary = history.createSummary();
    expect(summary).toBeNull();
  });

  it("clear removes all actions", () => {
    const history = new ActionHistory();
    history.addAction({ timestamp: Date.now(), type: "tool_call", toolName: "a" });
    history.clear();
    expect(history.getActionCount()).toBe(0);
  });

  it("export and import round-trip preserves data", () => {
    const history = new ActionHistory();
    const entry: ActionEntry = { timestamp: 42, type: "decision", reasoning: "test" };
    history.addAction(entry);

    const exported = history.export();
    const newHistory = new ActionHistory();
    newHistory.import(exported);
    expect(newHistory.getActionCount()).toBe(1);
    expect(newHistory.export()[0]!.timestamp).toBe(42);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. social
// ═══════════════════════════════════════════════════════════════════════════════

describe("social", () => {
  it("tracks entity entering room via movement perception", () => {
    const social = new SocialAwareness();
    const events = social.handlePerception({
      kind: "movement",
      timestamp: Date.now(),
      data: { entityName: "Alice", type: "arrive" },
    });
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("player_entered_room");
    expect(social.getEntitiesInRoom()).toContain("Alice");
  });

  it("tracks entity leaving room", () => {
    const social = new SocialAwareness();
    social.handlePerception({
      kind: "movement",
      timestamp: Date.now(),
      data: { entityName: "Bob", type: "arrive" },
    });
    social.handlePerception({
      kind: "movement",
      timestamp: Date.now(),
      data: { entityName: "Bob", type: "depart", direction: "north" },
    });
    expect(social.getEntitiesInRoom()).not.toContain("Bob");
  });

  it("tracks message and records speaker interaction", () => {
    const social = new SocialAwareness();
    const events = social.handlePerception({
      kind: "message",
      timestamp: Date.now(),
      data: { from: "Carol", message: "Hello world" },
    });
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("player_says");
    expect(events[0]!.speaker).toBe("Carol");
    expect(social.getInteractionCount("Carol")).toBe(1);
  });

  it("scorePerception gives highest priority to direct tells", () => {
    const social = new SocialAwareness();
    const directTell = {
      type: "player_tells" as const,
      speaker: "X",
      target: "myagent",
      timestamp: Date.now(),
    };
    const generalSay = {
      type: "player_says" as const,
      speaker: "X",
      message: "hello",
      timestamp: Date.now(),
    };
    expect(social.scorePerception(directTell, "MyAgent")).toBe(100);
    expect(social.scorePerception(generalSay, "MyAgent")).toBe(50);
  });

  it("scorePerception boosts messages mentioning agent name", () => {
    const social = new SocialAwareness();
    const mention = {
      type: "player_says" as const,
      speaker: "X",
      message: "Hey MyAgent, come here",
      timestamp: Date.now(),
    };
    expect(social.scorePerception(mention, "MyAgent")).toBe(80);
  });

  it("scorePerception marks model_request / model_response as high-priority", () => {
    // Regression: benchmark questions arrive as channel_message JSON. If
    // they score below the burst-trim threshold (80), they get dropped
    // under load and the Answerer never sees the question. The Answerer
    // then sits idle while the harness times out.
    const social = new SocialAwareness();
    const modelRequest = {
      type: "channel_message" as const,
      speaker: "__model_api__",
      message: '{"type":"model_request","id":"req-abc","content":"What is 2+2?","target":"e_3"}',
      channel: "model-answerer",
      timestamp: Date.now(),
    };
    const modelResponse = {
      type: "channel_message" as const,
      speaker: "Answerer",
      message: '{"type":"model_response","id":"req-abc","content":"4"}',
      channel: "model-answerer",
      timestamp: Date.now(),
    };
    const plainChatter = {
      type: "channel_message" as const,
      speaker: "X",
      message: "hi everyone",
      channel: "crew-bench",
      timestamp: Date.now(),
    };
    // Both model_request and model_response must clear the 80 threshold.
    expect(social.scorePerception(modelRequest, "Answerer")).toBeGreaterThanOrEqual(80);
    expect(social.scorePerception(modelResponse, "Answerer")).toBeGreaterThanOrEqual(80);
    // Plain channel chatter still scores low so buffer trim works normally.
    expect(social.scorePerception(plainChatter, "Answerer")).toBeLessThan(80);
  });

  it("getSocialContext output format includes entities and events", () => {
    const social = new SocialAwareness();
    social.updateEntitiesInRoom([{ name: "Alice" }, { name: "Bob" }]);
    social.handlePerception({
      kind: "message",
      timestamp: Date.now(),
      data: { from: "Alice", message: "Good morning" },
    });
    const context = social.getSocialContext();
    expect(context).toContain("Alice");
    expect(context).toContain("Bob");
    expect(context).toContain("Good morning");
  });

  it("getKnownEntities returns sorted by interaction count", () => {
    const social = new SocialAwareness();
    // Carol speaks 3 times
    for (let i = 0; i < 3; i++) {
      social.handlePerception({
        kind: "message",
        timestamp: Date.now(),
        data: { from: "Carol", message: "hi" },
      });
    }
    // Dan speaks once
    social.handlePerception({
      kind: "message",
      timestamp: Date.now(),
      data: { from: "Dan", message: "hey" },
    });
    const known = social.getKnownEntities();
    expect(known[0]!.name).toBe("Carol");
    expect(known[0]!.interactions).toBe(3);
    expect(known[1]!.name).toBe("Dan");
  });

  it("reset clears all state", () => {
    const social = new SocialAwareness();
    social.handlePerception({
      kind: "message",
      timestamp: Date.now(),
      data: { from: "Eve", message: "test" },
    });
    social.updateEntitiesInRoom([{ name: "Eve" }]);
    social.reset();
    expect(social.getEntitiesInRoom()).toEqual([]);
    expect(social.getRecentEvents()).toEqual([]);
    expect(social.getKnownEntities()).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. roles
// ═══════════════════════════════════════════════════════════════════════════════

describe("roles", () => {
  it("resolveRole returns null for missing role", () => {
    const db = makeRolesDb({ role: null });
    expect(resolveRole(db, "nonexistent")).toBeNull();
  });

  it("resolveRole returns resolved role with traits", () => {
    const db = makeRolesDb({
      role: {
        name: "researcher",
        description: "Investigates questions",
        traits: '["web-research","analysis"]',
        guidelines: '["Be thorough"]',
        focus: '["knowledge"]',
        tone: "curious",
        origin: "seed",
      },
      traits: {
        "web-research": {
          prompt: "Search the web for information.",
          capabilities: '{"strengths":["search"],"preferences":["accuracy"]}',
        },
        analysis: {
          prompt: "Analyze data carefully.",
          capabilities: '{"strengths":["reasoning"],"avoids":["speculation"]}',
        },
      },
    });

    const role = resolveRole(db, "researcher")!;
    expect(role).not.toBeNull();
    expect(role.name).toBe("researcher");
    expect(role.traitNames).toEqual(["web-research", "analysis"]);
    expect(role.traitPrompts).toEqual([
      "Search the web for information.",
      "Analyze data carefully.",
    ]);
    expect(role.guidelines).toEqual(["Be thorough"]);
    expect(role.focus).toEqual(["knowledge"]);
  });

  it("getRolePrompt returns null for missing role", () => {
    const db = makeRolesDb({ role: null });
    expect(getRolePrompt(db, "nothing")).toBeNull();
  });

  it("composeRolePrompt includes all sections", () => {
    const prompt = composeRolePrompt({
      name: "builder",
      description: "Builds things",
      traitNames: ["construct"],
      traitPrompts: ["Build rooms and objects."],
      traitCapabilities: [{ strengths: ["creation"], preferences: ["efficiency"] }],
      guidelines: ["Build safely"],
      focus: ["construction"],
      tone: "methodical",
      origin: "seed",
    });
    expect(prompt).toContain("# YOUR ROLE: BUILDER");
    expect(prompt).toContain("Builds things");
    expect(prompt).toContain("Build rooms and objects.");
    expect(prompt).toContain("## Capabilities Profile");
    expect(prompt).toContain("creation");
    expect(prompt).toContain("## Focus Areas");
    expect(prompt).toContain("## Behavioral Guidelines");
    expect(prompt).toContain("## Tone");
    expect(prompt).toContain("methodical");
  });

  it("composeCapabilities detects synergy (strength matches preference)", () => {
    const composed = composeCapabilities(
      ["traitA", "traitB"],
      [
        { strengths: ["search"], preferences: [] },
        { strengths: [], preferences: ["search"] },
      ],
    );
    expect(composed.synergies.length).toBeGreaterThan(0);
    expect(composed.synergies[0]).toContain("search");
    expect(composed.synergies[0]).toContain("traitA");
    expect(composed.synergies[0]).toContain("traitB");
  });

  it("composeCapabilities detects tension (strength vs avoids)", () => {
    const composed = composeCapabilities(
      ["bold", "cautious"],
      [
        { strengths: ["risk-taking"], preferences: [] },
        { strengths: [], avoids: ["risk-taking"] },
      ],
    );
    expect(composed.tensions.length).toBeGreaterThan(0);
    expect(composed.tensions[0]).toContain("risk-taking");
    expect(composed.tensions[0]).toContain("bold");
    expect(composed.tensions[0]).toContain("cautious");
  });

  it("composeCapabilities detects shared strength reinforcement", () => {
    const composed = composeCapabilities(
      ["traitA", "traitB"],
      [{ strengths: ["coding"] }, { strengths: ["coding"] }],
    );
    expect(composed.synergies.some((s) => s.includes("reinforce") && s.includes("coding"))).toBe(
      true,
    );
  });

  it("formatCapabilitiesSection returns empty for no capabilities", () => {
    const section = formatCapabilitiesSection({
      strengths: [],
      preferences: [],
      avoids: [],
      synergies: [],
      tensions: [],
    });
    expect(section).toBe("");
  });

  // PRISM-style task-conditional trait gating ─────────────────────────────────

  it("composeRolePrompt without taskCategory keeps every trait (backward compat)", () => {
    const prompt = composeRolePrompt({
      name: "mixed",
      description: "",
      traitNames: ["forecasting", "harvesting"],
      traitPrompts: ["Make calibrated predictions.", "Extract entities and link them."],
      traitCapabilities: [
        { strengths: ["calibration"], applicableTasks: ["forecasting"] },
        { strengths: ["extraction"], applicableTasks: ["research"] },
      ],
      guidelines: [],
      focus: [],
      tone: "",
      origin: "test",
    });
    expect(prompt).toContain("Make calibrated predictions.");
    expect(prompt).toContain("Extract entities");
  });

  it("composeRolePrompt with taskCategory drops traits whose applicableTasks doesn't include it", () => {
    const prompt = composeRolePrompt(
      {
        name: "mixed",
        description: "",
        traitNames: ["forecasting", "harvesting"],
        traitPrompts: ["Make calibrated predictions.", "Extract entities and link them."],
        traitCapabilities: [
          { strengths: ["calibration"], applicableTasks: ["forecasting"] },
          { strengths: ["extraction"], applicableTasks: ["research"] },
        ],
        guidelines: [],
        focus: [],
        tone: "",
        origin: "test",
      },
      "math",
    );
    // Both traits declared scope; neither matches "math" → both dropped.
    expect(prompt).not.toContain("Make calibrated predictions.");
    expect(prompt).not.toContain("Extract entities");
  });

  it("composeRolePrompt keeps traits without applicableTasks regardless of category", () => {
    const prompt = composeRolePrompt(
      {
        name: "mixed",
        description: "",
        traitNames: ["versatile", "scoped"],
        traitPrompts: ["Adapt to anything.", "Only useful for code."],
        traitCapabilities: [
          { strengths: ["adaptability"] }, // no applicableTasks → always kept
          { strengths: ["coding"], applicableTasks: ["code"] },
        ],
        guidelines: [],
        focus: [],
        tone: "",
        origin: "test",
      },
      "writing",
    );
    expect(prompt).toContain("Adapt to anything.");
    expect(prompt).not.toContain("Only useful for code.");
  });

  it("inferCrewResponder is true for specialist roles, false for coordinators", () => {
    // Specialists answer-and-shutup; coordinators drive dispatch and need
    // their full cognitive cycle. The set is the single source of truth
    // for which roles get the lean autonomous loop. See
    // src/agent/agent-runtime.ts CREW_RESPONDER_ROLES.
    expect(inferCrewResponder("mathematician")).toBe(true);
    expect(inferCrewResponder("scholar")).toBe(true);
    expect(inferCrewResponder("crew-reflector")).toBe(true);
    expect(inferCrewResponder("translator")).toBe(true);
    expect(inferCrewResponder("format-verifier")).toBe(true);
    expect(inferCrewResponder("skeptic")).toBe(true);
    expect(inferCrewResponder("historian")).toBe(true);

    // Coordinators stay on the full cognitive cycle.
    expect(inferCrewResponder("answerer")).toBe(false);
    expect(inferCrewResponder("councilor")).toBe(false);
    expect(inferCrewResponder("debater")).toBe(false);
    expect(inferCrewResponder("decomposer")).toBe(false);

    // Unknown / freeform roles default to coordinator semantics — preserves
    // backward-compat for user-spawned agents.
    expect(inferCrewResponder("guide")).toBe(false);
    expect(inferCrewResponder(undefined)).toBe(false);
    expect(inferCrewResponder(null)).toBe(false);
    expect(inferCrewResponder("")).toBe(false);
  });

  it("inferTaskCategory pulls voice-friendly categories out of goal strings", () => {
    expect(inferTaskCategory("Solve gsm8k math problems")).toBe("math");
    expect(inferTaskCategory("write humaneval implementations")).toBe("code");
    expect(inferTaskCategory("Forecast the brier score for these markets")).toBe("forecasting");
    expect(inferTaskCategory("Run a kelly-sized position on Polymarket")).toBe("trading");
    expect(inferTaskCategory("Investigate this paper on alignment")).toBe("research");
    expect(inferTaskCategory("draft a story about the village")).toBe("writing");
    expect(inferTaskCategory(undefined)).toBeUndefined();
    expect(inferTaskCategory("hello world")).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. context-manager
// ═══════════════════════════════════════════════════════════════════════════════

describe("context-manager", () => {
  it("estimateMessageTokens for a user message", () => {
    const msg = { role: "user", content: "Hello world" } as unknown as AgentMessage;
    const tokens = estimateMessageTokens(msg);
    // "Hello world" = 11 chars, ~3 base tokens, +10% overhead + 4 overhead
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(50);
  });

  it("estimateMessageTokens for empty message returns minimal overhead", () => {
    const msg = { role: "user", content: "" } as unknown as AgentMessage;
    const tokens = estimateMessageTokens(msg);
    // Should just be the base 4 overhead
    expect(tokens).toBe(4);
  });

  it("estimateMessageTokens for assistant with tool call", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "Let me help." },
        { type: "toolCall", name: "memory", arguments: { action: "write", content: "test" } },
      ],
    } as unknown as AgentMessage;
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBeGreaterThan(10);
  });

  it("estimateMessageTokens for toolResult message", () => {
    const msg = {
      role: "toolResult",
      toolName: "memory",
      content: [{ type: "text", text: "Saved note." }],
    } as unknown as AgentMessage;
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBeGreaterThan(4);
  });

  it("summarizeMessages extracts tool calls and events", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "marina_move", arguments: { direction: "north" } }],
      },
      {
        role: "user",
        content: "You moved north into the plaza.",
      },
    ] as unknown as Message[];
    const summary = summarizeMessages(messages);
    expect(summary).toContain("Moved north");
    expect(summary).toContain("[event]");
    expect(summary).toContain("plaza");
  });

  it("summarizeMessages handles assistant text blocks", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "I should explore the area first before taking action." }],
      },
    ] as unknown as Message[];
    const summary = summarizeMessages(messages);
    expect(summary).toContain("[thought]");
    expect(summary).toContain("explore");
  });

  it("truncateOversizedToolResults truncates large results", () => {
    const longText = "x".repeat(50000);
    const messages = [
      {
        role: "toolResult",
        toolName: "marina_command",
        content: [{ type: "text", text: longText }],
      },
    ] as unknown as AgentMessage[];
    const result = truncateOversizedToolResults(messages, 500);
    const r0 = result[0] as unknown as { content: { text: string }[] };
    const truncated = r0.content[0]!.text;
    expect(truncated.length).toBeLessThan(longText.length);
    expect(truncated).toContain("[...truncated");
  });

  it("truncateOversizedToolResults preserves small results", () => {
    const messages = [
      {
        role: "toolResult",
        toolName: "look",
        content: [{ type: "text", text: "A quiet room." }],
      },
    ] as unknown as AgentMessage[];
    const result = truncateOversizedToolResults(messages, 2000);
    expect((result[0] as unknown as { content: { text: string }[] }).content[0]!.text).toBe(
      "A quiet room.",
    );
  });

  it("createContextManager passes through when under threshold", async () => {
    const transform = createContextManager({
      getModel: () => ({ contextWindow: 100000 }) as unknown as Model<string>,
      getSystemPrompt: () => "You are a test agent.",
      pruneThreshold: 0.8,
    });
    const messages = [
      { role: "user", content: "Hello", timestamp: Date.now() },
      { role: "assistant", content: [{ type: "text", text: "Hi" }], timestamp: Date.now() },
    ] as unknown as AgentMessage[];
    const result = await transform(messages);
    // Under threshold, should return all messages (possibly with tool result truncation)
    expect(result.length).toBe(2);
  });

  it("createContextManager prunes when over threshold", async () => {
    const transform = createContextManager({
      getModel: () => ({ contextWindow: 200 }) as unknown as Model<string>,
      getSystemPrompt: () => "System prompt that takes up tokens.",
      pruneThreshold: 0.8,
      pruneTarget: 0.6,
      minRecentMessages: 2,
    });
    // Create enough messages to exceed the tiny context window
    const messages: AgentMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({
        role: "user",
        content: `Message number ${i} with some additional text to consume tokens.`,
        timestamp: Date.now(),
      });
    }
    const result = await transform(messages);
    // Should have fewer messages after pruning
    expect(result.length).toBeLessThan(20);
  });

  it("createContextManager returns empty array for empty input", async () => {
    const transform = createContextManager({
      getModel: () => ({ contextWindow: 100000 }) as unknown as Model<string>,
      getSystemPrompt: () => "",
    });
    const result = await transform([]);
    expect(result).toEqual([]);
  });

  // ── stripOrphanedToolResults — prevents Anthropic 400 retry-storm ────────

  it("stripOrphanedToolResults keeps matched pairs intact", () => {
    const msgs = [
      { role: "user", content: "hi", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "toolCall", id: "call_1", name: "recall", arguments: {} },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "recall",
        content: [{ type: "text", text: "found it" }],
      },
    ] as unknown as AgentMessage[];
    const result = stripOrphanedToolResults(msgs);
    expect(result.length).toBe(3);
  });

  it("stripOrphanedToolResults drops toolResult when its toolCall is missing", () => {
    // Simulates what happens after pruning: the assistant message with the
    // matching toolCall was summarized into text, leaving the toolResult
    // orphaned. This is the Anthropic 400 trigger.
    const msgs = [
      { role: "user", content: "[summary of earlier work]", timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "call_vanished",
        toolName: "recall",
        content: [{ type: "text", text: "stale result" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "moving on" }],
      },
    ] as unknown as AgentMessage[];
    const result = stripOrphanedToolResults(msgs);
    expect(result.length).toBe(2);
    expect((result[0] as { role: string }).role).toBe("user");
    expect((result[1] as { role: string }).role).toBe("assistant");
  });

  it("stripOrphanedToolResults preserves valid later pairs after an orphan", () => {
    const msgs = [
      { role: "user", content: "[summary]", timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "orphan",
        toolName: "recall",
        content: [{ type: "text", text: "stale" }],
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_new", name: "calc", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call_new",
        toolName: "calc",
        content: [{ type: "text", text: "42" }],
      },
    ] as unknown as AgentMessage[];
    const result = stripOrphanedToolResults(msgs);
    // orphan dropped, new toolCall + toolResult preserved
    expect(result.length).toBe(3);
    expect((result[2] as { toolCallId?: string }).toolCallId).toBe("call_new");
  });

  it("stripOrphanedToolResults is idempotent on already-clean history", () => {
    const msgs = [
      { role: "user", content: "hello", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "A", name: "look", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "A",
        toolName: "look",
        content: [{ type: "text", text: "a room" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      },
    ] as unknown as AgentMessage[];
    const once = stripOrphanedToolResults(msgs);
    const twice = stripOrphanedToolResults(once);
    expect(once.length).toBe(msgs.length);
    expect(twice.length).toBe(once.length);
  });

  it("stripOrphanedToolResults handles empty or malformed input", () => {
    expect(stripOrphanedToolResults([])).toEqual([]);
    const weird = [
      { role: "toolResult", toolCallId: undefined, content: [] },
      { role: "assistant", content: null as unknown as [] },
      {
        role: "toolResult",
        toolCallId: "",
        content: [{ type: "text", text: "no id" }],
      },
    ] as unknown as AgentMessage[];
    // All orphaned or missing-id toolResults drop; assistant with null content stays.
    const result = stripOrphanedToolResults(weird);
    expect(result.length).toBe(1);
    expect((result[0] as { role: string }).role).toBe("assistant");
  });

  it("createContextManager strips orphans after pruning", async () => {
    // Build a history that *will* get pruned in a way that orphans a toolResult.
    // The assistant with the toolCall is in the middle (gets summarized), the
    // matching toolResult is in the recent window (gets kept).
    const transform = createContextManager({
      getModel: () => ({ contextWindow: 400 }) as unknown as Model<string>,
      getSystemPrompt: () => "sys",
      pruneThreshold: 0.5,
      pruneTarget: 0.4,
      minRecentMessages: 2,
    });
    const msgs: AgentMessage[] = [{ role: "user", content: "start", timestamp: 1 } as AgentMessage];
    // Middle chunk (will be summarized): an assistant with a toolCall
    for (let i = 0; i < 10; i++) {
      msgs.push({
        role: "user",
        content: `padding message ${i} to consume context tokens reliably`,
        timestamp: 1,
      } as AgentMessage);
    }
    msgs.push({
      role: "assistant",
      content: [{ type: "toolCall", id: "orphaned_call", name: "recall", arguments: {} }],
    } as unknown as AgentMessage);
    // Recent window (will be kept): the toolResult that references the now-gone call
    msgs.push({
      role: "toolResult",
      toolCallId: "orphaned_call",
      toolName: "recall",
      content: [{ type: "text", text: "some recall result" }],
    } as unknown as AgentMessage);
    msgs.push({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    } as unknown as AgentMessage);

    const result = await transform(msgs);
    // The orphaned toolResult MUST be gone — otherwise Anthropic 400s.
    const orphanedPresent = result.some((m) => {
      const rm = m as { role: string; toolCallId?: string };
      return rm.role === "toolResult" && rm.toolCallId === "orphaned_call";
    });
    expect(orphanedPresent).toBe(false);
  });

  it("createContextManager handles invalid context window gracefully", async () => {
    const transform = createContextManager({
      getModel: () => ({ contextWindow: 0 }) as unknown as Model<string>,
      getSystemPrompt: () => "",
    });
    const messages = [
      { role: "user", content: "hi", timestamp: Date.now() },
    ] as unknown as AgentMessage[];
    const result = await transform(messages);
    // With invalid context window, should pass through
    expect(result.length).toBe(1);
  });
});

// ── Tool profiles — Haiku-sized agent tool surface ──────────────────────────

describe("tool profiles", () => {
  it("minimal profile has exactly the 3 essential tools", () => {
    // The rationale of "minimal": marina_command is a universal escape
    // hatch that runs ANY world command, so command + think + memory is
    // functionally complete. This test locks the set — adding tools
    // silently inflates schema size for every Haiku-tier specialist.
    expect(TOOL_PROFILE_NAMES.minimal).toEqual(["marina_command", "think", "memory"]);
  });

  it("crew profile is a mid-size set for dispatchers", () => {
    // Coordinators need a bit more — tell peers, pool shared memory,
    // brief world state, channel management. Still ~1/4 of full.
    const crew = TOOL_PROFILE_NAMES.crew;
    expect(crew).toContain("marina_command");
    expect(crew).toContain("marina_tell");
    expect(crew).toContain("marina_pool");
    expect(crew).toContain("marina_brief");
    expect(crew.length).toBeLessThan(10);
  });

  it("full profile is empty — signals 'all tools' to the builder", () => {
    // Empty array means the scoped builder returns createAllTools(), i.e.
    // the full surface. A non-empty full list would accidentally filter
    // tools that don't appear in it.
    expect(TOOL_PROFILE_NAMES.full).toEqual([]);
  });

  it("COMMAND_ROSTER mentions the command categories the lean profiles need", () => {
    // The roster is the natural-language map an agent without typed tool
    // wrappers reads to know what verbs exist. If a category disappears
    // here, agents on minimal/crew profiles silently lose access to it.
    expect(COMMAND_ROSTER).toContain("look");
    expect(COMMAND_ROSTER).toContain("tell");
    expect(COMMAND_ROSTER).toContain("recall");
    expect(COMMAND_ROSTER).toContain("brief");
    expect(COMMAND_ROSTER).toContain("pool");
    expect(COMMAND_ROSTER).toContain("focus");
    expect(COMMAND_ROSTER).toContain("watch");
    // Compact: under 1.5KB so the schema bump is negligible.
    expect(COMMAND_ROSTER.length).toBeLessThan(1500);
  });

  it("createCommandTool description is terse for verbose mode (full profile)", () => {
    // Full profile already has 27 typed descriptions; the universal tool
    // stays terse so we don't double-pay the roster cost.
    const tool = createCommandTool({} as never, "verbose");
    expect(tool.description.length).toBeLessThan(200);
    expect(tool.description).not.toContain("Common world commands");
  });

  it("createCommandTool description embeds the roster for compact mode (crew/minimal)", () => {
    const tool = createCommandTool({} as never, "compact");
    expect(tool.description).toContain("Common world commands");
    expect(tool.description).toContain("recall");
    expect(tool.description).toContain("intent-aware");
  });
});

// ─── InterruptibleWaiter (autonomous-loop wakeup) ───────────────────────────

describe("InterruptibleWaiter", () => {
  it("sleep resolves at deadline when wake() is never called", async () => {
    const w = new InterruptibleWaiter();
    const start = performance.now();
    await w.sleep(40);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(35);
    expect(elapsed).toBeLessThan(120);
    expect(w.isArmed()).toBe(false);
  });

  it("wake() cuts the sleep short (the load-bearing crew-dispatch case)", async () => {
    // Coordinator → Specialist round trip: when the perception handler
    // wakes the cycle waiter mid-sleep, the loop must resolve well
    // before the cycle-delay deadline. Without this, every handshake
    // pays up to loopCycleDelay (default 2s) of dead wall-clock time.
    const w = new InterruptibleWaiter();
    const start = performance.now();
    setTimeout(() => w.wake(), 10);
    await w.sleep(2000);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(150);
    expect(w.isArmed()).toBe(false);
  });

  it("wake() is idempotent during a perception burst", async () => {
    // Many perceptions arriving simultaneously call wake() repeatedly.
    // Only the first one should resolve the sleep; subsequent calls are
    // no-ops that don't crash or double-resolve.
    const w = new InterruptibleWaiter();
    const sleepP = w.sleep(1000);
    expect(w.isArmed()).toBe(true);
    w.wake();
    w.wake();
    w.wake();
    await sleepP;
    expect(w.isArmed()).toBe(false);
  });

  it("wake() before sleep is a no-op (does not pre-arm)", async () => {
    // The waiter is event-driven: wake without an active sleep does
    // nothing. Otherwise an out-of-order wake/sleep pair would resolve
    // the next sleep instantly and skip a cycle.
    const w = new InterruptibleWaiter();
    w.wake();
    expect(w.isArmed()).toBe(false);
    const start = performance.now();
    await w.sleep(40);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(35);
  });
});
