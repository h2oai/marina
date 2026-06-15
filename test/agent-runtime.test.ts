import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentRuntime, getInternalModelToken } from "../src/agent/agent-runtime";
import {
  applyRankProgression,
  checkRankProgression,
  getPromotionProgress,
} from "../src/agent/rank-progression";
import { MarinaDB } from "../src/persistence/database";
import type { Entity, EntityId, EntityRank, RoomId } from "../src/types";
import { cleanupDb } from "./helpers";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_DB = "test_agent_runtime.db";

/** Create a minimal entity for rank progression tests. */
function makeEntity(name: string, rank: EntityRank = 0): Entity {
  return {
    id: `e_${name}` as EntityId,
    kind: "agent",
    name,
    short: name,
    long: `A test entity named ${name}.`,
    room: "test/start" as RoomId,
    properties: { rank },
    inventory: [],
    createdAt: Date.now(),
  };
}

/**
 * Seed activity records for a given entity so that `getActivityStats` and
 * `getActivityByType` return meaningful data. Each entry in `commands`
 * represents a command with its success/fail counts.
 */
function _seedActivity(
  db: MarinaDB,
  entityName: string,
  commands: Array<{ key: string; success: number; fail: number }>,
): void {
  for (const cmd of commands) {
    for (let i = 0; i < cmd.success; i++) {
      db.trackActivity(entityName, "command", cmd.key, true);
    }
    for (let i = 0; i < cmd.fail; i++) {
      db.trackActivity(entityName, "command", cmd.key, false);
    }
  }
}

/** Seed notes (optionally of a specific type) for an entity. */
function _seedNotes(db: MarinaDB, entityName: string, count: number, noteType?: string): void {
  for (let i = 0; i < count; i++) {
    db.createNote(entityName, `Test note ${i + 1}`, undefined, {
      noteType: noteType ?? "observation",
    });
  }
}

/** Seed completed tasks created by an entity. */
function _seedCompletedTasks(
  db: MarinaDB,
  entityId: EntityId,
  entityName: string,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    const taskId = db.createTask({
      title: `Task ${i + 1}`,
      creatorId: entityId,
      creatorName: entityName,
    });
    db.updateTaskStatus(taskId, "completed");
  }
}

// ─── AgentRuntime Unit Tests ────────────────────────────────────────────────

describe("AgentRuntime", () => {
  let db: MarinaDB;
  let runtime: AgentRuntime;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    runtime = new AgentRuntime({ db, wsPort: 39999 });
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  // ─── Constructor & Properties ──────────────────────────────────────────

  describe("constructor", () => {
    it("initializes with zero running agents", () => {
      expect(runtime.size).toBe(0);
    });

    it("list() returns empty array initially", () => {
      expect(runtime.list()).toEqual([]);
    });

    it("get() returns undefined for unknown agents", () => {
      expect(runtime.get("nonexistent")).toBeUndefined();
    });
  });

  // ─── isAvailable() ────────────────────────────────────────────────────

  describe("isAvailable()", () => {
    it("returns false when no API keys are present", () => {
      // Save and clear all API key env vars
      const keyVars = [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GROQ_API_KEY",
        "OPENROUTER_API_KEY",
        "CEREBRAS_API_KEY",
        "XAI_API_KEY",
        "MISTRAL_API_KEY",
        "DEEPSEEK_API_KEY",
      ];
      const saved: Record<string, string | undefined> = {};
      for (const v of keyVars) {
        saved[v] = process.env[v];
        process.env[v] = undefined;
      }

      // Ensure no DB keys either (fresh DB has none)
      const freshDb = new MarinaDB("test_agent_avail.db");
      const freshRuntime = new AgentRuntime({ db: freshDb });
      try {
        expect(freshRuntime.isAvailable()).toBe(false);
      } finally {
        freshDb.close();
        cleanupDb("test_agent_avail.db");
        // Restore env
        for (const [k, v] of Object.entries(saved)) {
          if (v !== undefined) process.env[k] = v;
          else process.env[k] = undefined;
        }
      }
    });

    it("returns true when an env key is set", () => {
      const saved = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sk-test-fake-key";

      try {
        expect(runtime.isAvailable()).toBe(true);
      } finally {
        if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
        else process.env.OPENAI_API_KEY = undefined;
      }
    });

    it("returns true when a DB API key exists", () => {
      // Clear env keys
      const keyVars = [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GROQ_API_KEY",
        "OPENROUTER_API_KEY",
        "CEREBRAS_API_KEY",
        "XAI_API_KEY",
        "MISTRAL_API_KEY",
        "DEEPSEEK_API_KEY",
      ];
      const saved: Record<string, string | undefined> = {};
      for (const v of keyVars) {
        saved[v] = process.env[v];
        process.env[v] = undefined;
      }

      try {
        db.saveApiKey({
          name: "test-key",
          provider: "openai",
          encryptedValue: "sk-test-from-db",
          setBy: "test",
        });
        expect(runtime.isAvailable()).toBe(true);
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v !== undefined) process.env[k] = v;
          else process.env[k] = undefined;
        }
      }
    });
  });

  // ─── spawn() input validation ──────────────────────────────────────────

  describe("spawn() input validation", () => {
    it("explains the <provider>/<model> format when only a bare model is given", async () => {
      await expect(runtime.spawn({ name: "Bare", model: "claude-sonnet-4-5" })).rejects.toThrow(
        /missing the provider prefix.*<provider>\/<model-id>/,
      );
    });

    it("lists known providers when the prefix is typoed", async () => {
      await expect(
        runtime.spawn({ name: "Typo", model: "anthrpic/claude-sonnet-4-5" }),
      ).rejects.toThrow(/Unknown provider "anthrpic"/);
    });
  });

  // ─── spawn() rejection cases ──────────────────────────────────────────

  describe("spawn() rejection cases", () => {
    it("rejects duplicate agent names", async () => {
      // Manually add a fake agent handle to the internal map to simulate a running agent
      // We access the private map via the runtime's spawn logic:
      // First spawn will fail because there's no WS server, but we can test the duplicate check
      // by setting up the agents map via a different approach.
      // Instead, we test via the public API: first spawn attempt will fail (no WS server),
      // but the duplicate check happens BEFORE the WS connect attempt.

      // Simpler approach: use the runtime's internal map via a helper
      const agents = (runtime as unknown as { agents: Map<string, unknown> }).agents;
      agents.set("TestAgent", {} as unknown);

      await expect(runtime.spawn({ name: "TestAgent", model: "openai/gpt-4" })).rejects.toThrow(
        'Agent "TestAgent" is already running.',
      );
    });

    it("rejects when MAX_AGENTS reached", async () => {
      // Fill the agents map to the max
      const agents = (runtime as unknown as { agents: Map<string, unknown> }).agents;
      const max = 30; // default MAX_AGENTS
      for (let i = 0; i < max; i++) {
        agents.set(`agent-${i}`, {} as unknown);
      }

      await expect(runtime.spawn({ name: "NewAgent", model: "openai/gpt-4" })).rejects.toThrow(
        "Agent limit reached",
      );
    });
  });

  // ─── stop() ───────────────────────────────────────────────────────────

  describe("stop()", () => {
    it("throws for non-existent agent", async () => {
      await expect(runtime.stop("ghost")).rejects.toThrow('Agent "ghost" is not running.');
    });

    it("clears an in-flight spawn reservation so a stuck name can be unstuck", async () => {
      // Simulate a discovery prompt that hung: the name is reserved in
      // spawnsInFlight but never made it into the running-agents map.
      const inFlight = (runtime as unknown as { spawnsInFlight: Set<string> }).spawnsInFlight;
      inFlight.add("StuckAgent");
      // Before: list() surfaces it with state "starting"
      const listed = runtime.list().find((a) => a.name === "StuckAgent");
      expect(listed?.state).toBe("starting");
      // stop() succeeds (instead of throwing "not running") and frees the slot.
      await runtime.stop("StuckAgent");
      expect(inFlight.has("StuckAgent")).toBe(false);
      expect(runtime.list().find((a) => a.name === "StuckAgent")).toBeUndefined();
    });

    it("stops an agent by a case-mismatched name", async () => {
      const agents = (runtime as unknown as { agents: Map<string, unknown> }).agents;
      let stopped = false;
      agents.set("Alice", { stop: async () => void (stopped = true) } as unknown);
      // `agent stop alice` must resolve to the canonical "Alice" key.
      await runtime.stop("alice");
      expect(stopped).toBe(true);
      expect(agents.has("Alice")).toBe(false);
    });
  });

  // ─── get() name resolution ────────────────────────────────────────────

  describe("get()", () => {
    it("resolves a name case-insensitively", () => {
      const agents = (runtime as unknown as { agents: Map<string, unknown> }).agents;
      const handle = { marker: "alice-handle" };
      agents.set("Alice", handle as unknown);
      // Exact, lower, and upper all resolve to the same handle.
      expect(runtime.get("Alice")).toBe(handle as never);
      expect(runtime.get("alice")).toBe(handle as never);
      expect(runtime.get("ALICE")).toBe(handle as never);
      expect(runtime.get("bob")).toBeUndefined();
    });

    it("refuses an ambiguous case-insensitive match rather than guessing", () => {
      const agents = (runtime as unknown as { agents: Map<string, unknown> }).agents;
      agents.set("Bot", { id: 1 } as unknown);
      agents.set("bot", { id: 2 } as unknown);
      // Exact match still works; ambiguous case-fold does not.
      expect(runtime.get("Bot")).toEqual({ id: 1 } as never);
      expect(runtime.get("BOT")).toBeUndefined();
    });
  });

  // ─── list() ───────────────────────────────────────────────────────────

  describe("list()", () => {
    it("surfaces both running and spawning agents", () => {
      const agents = (runtime as unknown as { agents: Map<string, unknown> }).agents;
      const inFlight = (runtime as unknown as { spawnsInFlight: Set<string> }).spawnsInFlight;
      // Inject a running stub via the same trick the spawn-rejection tests
      // use — getStatus() must return something list() can map over.
      const fakeStatus = {
        name: "Live",
        entityId: null,
        state: "autonomous",
        model: "x",
        role: "",
        focus: null,
        goal: null,
        uptime: 0,
        toolCalls: 0,
        errors: 0,
        errorReason: null,
        lastActivity: 0,
      };
      agents.set("Live", { getStatus: () => fakeStatus } as unknown);
      inFlight.add("Spawning");
      const result = runtime.list();
      const states = Object.fromEntries(result.map((a) => [a.name, a.state]));
      expect(states.Live).toBe("autonomous");
      expect(states.Spawning).toBe("starting");
    });
  });

  // ─── reconfigure() ────────────────────────────────────────────────────

  describe("reconfigure()", () => {
    it("throws for non-existent agent", async () => {
      await expect(runtime.reconfigure("ghost", { model: "openai/gpt-4" })).rejects.toThrow(
        'Agent "ghost" is not running.',
      );
    });
  });

  // ─── init() ───────────────────────────────────────────────────────────

  describe("init()", () => {
    it("returns 0 when no saved configs exist", async () => {
      const count = await runtime.init();
      expect(count).toBe(0);
      // Clean up the uptime interval
      await runtime.stopAll();
    });

    it("returns 0 when no DB is available", async () => {
      const noDB = new AgentRuntime({});
      const count = await noDB.init();
      expect(count).toBe(0);
      await noDB.stopAll();
    });
  });

  // ─── stopAll() ────────────────────────────────────────────────────────

  describe("stopAll()", () => {
    it("clears the uptime check interval", async () => {
      await runtime.init();
      const interval = (runtime as unknown as { uptimeCheckInterval: unknown }).uptimeCheckInterval;
      expect(interval).not.toBeNull();

      await runtime.stopAll();
      const cleared = (runtime as unknown as { uptimeCheckInterval: unknown }).uptimeCheckInterval;
      expect(cleared).toBeNull();
    });

    it("is safe to call when no agents are running", async () => {
      await runtime.stopAll();
      expect(runtime.size).toBe(0);
    });
  });

  // ─── API Key Resolution ───────────────────────────────────────────────

  describe("API key resolution", () => {
    const resolveApiKey = (runtime: AgentRuntime, model?: string, keyName?: string) => {
      return (
        runtime as unknown as {
          resolveApiKey: (model?: string, keyName?: string) => string | undefined;
        }
      ).resolveApiKey(model, keyName);
    };

    it("resolves from explicit keyName via DB lookup", () => {
      db.saveApiKey({
        name: "my-key",
        provider: "openai",
        encryptedValue: "sk-from-db-key",
        setBy: "test",
      });

      const key = resolveApiKey(runtime, "openai/gpt-4", "my-key");
      expect(key).toBe("sk-from-db-key");
    });

    it("falls back to provider match in DB", () => {
      db.saveApiKey({
        name: "anthropic-default",
        provider: "anthropic",
        encryptedValue: "sk-anthropic-db",
        setBy: "test",
      });

      const key = resolveApiKey(runtime, "anthropic/claude-3-sonnet");
      expect(key).toBe("sk-anthropic-db");
    });

    it("falls back to environment variables", () => {
      const saved = process.env.GROQ_API_KEY;
      process.env.GROQ_API_KEY = "gsk-test-env-key";

      try {
        const key = resolveApiKey(runtime, "groq/llama-3");
        expect(key).toBe("gsk-test-env-key");
      } finally {
        if (saved !== undefined) process.env.GROQ_API_KEY = saved;
        else process.env.GROQ_API_KEY = undefined;
      }
    });

    it("returns undefined when no keys available", () => {
      // Clear all env keys for the test provider
      const saved = process.env.XAI_API_KEY;
      process.env.XAI_API_KEY = undefined;

      try {
        const key = resolveApiKey(runtime, "xai/grok-2");
        expect(key).toBeUndefined();
      } finally {
        if (saved !== undefined) process.env.XAI_API_KEY = saved;
      }
    });

    it("prefers explicit keyName over provider match", () => {
      db.saveApiKey({
        name: "specific-key",
        provider: "openai",
        encryptedValue: "sk-specific",
        setBy: "test",
      });
      db.saveApiKey({
        name: "generic-key",
        provider: "openai",
        encryptedValue: "sk-generic",
        setBy: "test",
      });

      const key = resolveApiKey(runtime, "openai/gpt-4", "specific-key");
      expect(key).toBe("sk-specific");
    });

    it("resolves Google API keys with GEMINI_API_KEY env", () => {
      const savedGemini = process.env.GEMINI_API_KEY;
      const savedGoogle = process.env.GOOGLE_API_KEY;
      process.env.GOOGLE_API_KEY = undefined;
      process.env.GEMINI_API_KEY = "gemini-test-key";

      try {
        const key = resolveApiKey(runtime, "google/gemini-2.0-flash");
        expect(key).toBe("gemini-test-key");
      } finally {
        if (savedGemini !== undefined) process.env.GEMINI_API_KEY = savedGemini;
        else process.env.GEMINI_API_KEY = undefined;
        if (savedGoogle !== undefined) process.env.GOOGLE_API_KEY = savedGoogle;
        else process.env.GOOGLE_API_KEY = undefined;
      }
    });

    it("uses default model (google/gemini-2.0-flash) when model is undefined", () => {
      const savedGemini = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = "gemini-default-test";

      try {
        const key = resolveApiKey(runtime, undefined);
        expect(key).toBe("gemini-default-test");
      } finally {
        if (savedGemini !== undefined) process.env.GEMINI_API_KEY = savedGemini;
        else process.env.GEMINI_API_KEY = undefined;
      }
    });

    it("local marina uses the internal token; remote marina (marina@host) does not", () => {
      // Local: always the auto-generated internal token, ignoring keys.
      const local = resolveApiKey(runtime, "marina");
      expect(local).toBe(getInternalModelToken());
      expect(resolveApiKey(runtime, "marina/default")).toBe(getInternalModelToken());

      // Remote with a named key → resolves the DB key, NOT the internal token.
      db.saveApiKey({
        name: "remote-marina",
        provider: "marina",
        encryptedValue: "sk-remote-token",
        setBy: "test",
      });
      const remoteKeyed = resolveApiKey(runtime, "marina@https://gpu.box:3300/v1", "remote-marina");
      expect(remoteKeyed).toBe("sk-remote-token");
      expect(remoteKeyed).not.toBe(getInternalModelToken());

      // Remote with no key → undefined (works only against an open remote).
      expect(resolveApiKey(runtime, "marina@https://gpu.box:3300/v1")).toBeUndefined();
    });
  });

  // ─── Provider Extraction ──────────────────────────────────────────────

  describe("provider extraction", () => {
    const extractProvider = (runtime: AgentRuntime, model: string) => {
      return (runtime as unknown as { extractProvider: (model: string) => string }).extractProvider(
        model,
      );
    };

    it("extracts provider from slash-separated model string", () => {
      expect(extractProvider(runtime, "openai/gpt-4")).toBe("openai");
      expect(extractProvider(runtime, "anthropic/claude-3-sonnet")).toBe("anthropic");
      expect(extractProvider(runtime, "google/gemini-2.0-flash")).toBe("google");
    });

    it("returns entire string when no slash present", () => {
      expect(extractProvider(runtime, "gpt-4")).toBe("gpt-4");
    });

    it("strips a remote-Marina @host suffix to the marina provider", () => {
      expect(extractProvider(runtime, "marina@https://gpu.box:3300/v1")).toBe("marina");
      expect(extractProvider(runtime, "marina@gpu.box:3300")).toBe("marina");
      expect(extractProvider(runtime, "marina")).toBe("marina");
    });
  });

  // ─── Agent Config Persistence ──────────────────────────────────────────

  describe("agent config persistence", () => {
    it("saves and retrieves agent configs", () => {
      db.saveAgentConfig({
        name: "bot-1",
        model: "openai/gpt-4",
        role: "researcher",
        goal: "Research quantum computing",
        keyName: "my-key",
        spawnedBy: "admin",
      });

      const configs = db.getAllAgentConfigs();
      expect(configs).toHaveLength(1);
      expect(configs[0]!.name).toBe("bot-1");
      expect(configs[0]!.model).toBe("openai/gpt-4");
      expect(configs[0]!.role).toBe("researcher");
      expect(configs[0]!.goal).toBe("Research quantum computing");
    });

    it("deletes agent configs", () => {
      db.saveAgentConfig({
        name: "bot-2",
        model: "google/gemini-2.0-flash",
        spawnedBy: "system",
      });

      expect(db.getAllAgentConfigs()).toHaveLength(1);
      db.deleteAgentConfig("bot-2");
      expect(db.getAllAgentConfigs()).toHaveLength(0);
    });

    it("upserts agent config on save (same name)", () => {
      db.saveAgentConfig({
        name: "bot-3",
        model: "openai/gpt-4",
        spawnedBy: "system",
      });
      db.saveAgentConfig({
        name: "bot-3",
        model: "anthropic/claude-3-sonnet",
        role: "explorer",
        spawnedBy: "system",
      });

      const configs = db.getAllAgentConfigs();
      expect(configs).toHaveLength(1);
      expect(configs[0]!.model).toBe("anthropic/claude-3-sonnet");
      expect(configs[0]!.role).toBe("explorer");
    });
  });
});

// ─── Rank Progression Tests ─────────────────────────────────────────────────

describe("Rank Progression", () => {
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  // ─── checkRankProgression — derived from decayed standing ─────────────
  //
  // Rank 0–4 reads off a standing-threshold table (5 / 15 / 40 / 100). Above
  // rank 4, entities are grandfathered and never auto-adjusted. Demotion is
  // the natural consequence of standing decay.

  /** Drive the standing for an entity to a target value via real ledger writes. */
  function setStandingTo(db: MarinaDB, entity: Entity, value: number): void {
    if (value <= 0) return;
    const taskId = db.createTask({
      title: `seed-standing-${entity.name}`,
      creatorId: entity.id,
      creatorName: entity.name,
    });
    db.recordStandingEarned(entity.id, entity.name, taskId, value);
  }

  describe("checkRankProgression()", () => {
    it("returns null for fresh entity (standing 0, rank 0 already)", () => {
      const entity = makeEntity("fresh");
      expect(checkRankProgression(db, entity)).toBeNull();
    });

    it("returns null for sovereign (rank 9) — grandfathered above safety threshold", () => {
      const entity = makeEntity("sovereign", 9);
      expect(checkRankProgression(db, entity)).toBeNull();
    });

    it("crossing 5 standing promotes rank 0 → 1 (canvas)", () => {
      const entity = makeEntity("alice", 0);
      setStandingTo(db, entity, 7);
      expect(checkRankProgression(db, entity)).toBe(1);
    });

    it("crossing 15 standing promotes rank 1 → 2 (coordinator)", () => {
      const entity = makeEntity("bob", 1);
      setStandingTo(db, entity, 18);
      expect(checkRankProgression(db, entity)).toBe(2);
    });

    it("crossing 40 standing promotes rank 2 → 3 (organizer)", () => {
      const entity = makeEntity("carol", 2);
      setStandingTo(db, entity, 50);
      expect(checkRankProgression(db, entity)).toBe(3);
    });

    it("crossing 100 standing promotes rank 3 → 4 (builder, safety threshold)", () => {
      const entity = makeEntity("dave", 3);
      setStandingTo(db, entity, 110);
      expect(checkRankProgression(db, entity)).toBe(4);
    });

    it("rank 4 stays put even with very high standing — caps at the safety threshold", () => {
      const entity = makeEntity("at-cap", 4);
      setStandingTo(db, entity, 5000);
      expect(checkRankProgression(db, entity)).toBeNull();
    });

    it("rank 5+ is grandfathered above the safety threshold", () => {
      const entity = makeEntity("engineer", 6);
      expect(checkRankProgression(db, entity)).toBeNull();
    });

    it("rank 0 stays at 0 below the first threshold", () => {
      const entity = makeEntity("newbie", 0);
      setStandingTo(db, entity, 3);
      expect(checkRankProgression(db, entity)).toBeNull();
    });

    it("decay-driven demotion: standing fell below threshold → rank drops", () => {
      const entity = makeEntity("idle", 3);
      setStandingTo(db, entity, 12);
      expect(checkRankProgression(db, entity)).toBe(1);
    });

    it("decay all the way to 0 demotes a builder back to newcomer", () => {
      const entity = makeEntity("very-stale", 4);
      expect(checkRankProgression(db, entity)).toBe(0);
    });
  });

  describe("applyRankProgression()", () => {
    it("persists rank change to entity and DB when promoted", () => {
      const entity = makeEntity("promoted", 0);
      db.createUser({ id: entity.id, name: "promoted", rank: 0 });
      setStandingTo(db, entity, 7);

      const changed = applyRankProgression(db, entity);
      expect(changed).toBe(true);
      expect(entity.properties.rank).toBe(1);

      const user = db.getUserByName("promoted");
      expect(user).toBeDefined();
      expect(user!.rank).toBe(1);
    });

    it("persists rank change to entity and DB when demoted via decay", () => {
      const entity = makeEntity("demoted", 3);
      db.createUser({ id: entity.id, name: "demoted", rank: 3 });

      const changed = applyRankProgression(db, entity);
      expect(changed).toBe(true);
      expect(entity.properties.rank).toBe(0);

      const user = db.getUserByName("demoted");
      expect(user!.rank).toBe(0);
    });

    it("returns false when no rank change needed", () => {
      const entity = makeEntity("stable", 0);
      db.createUser({ id: entity.id, name: "stable", rank: 0 });
      const changed = applyRankProgression(db, entity);
      expect(changed).toBe(false);
      expect(entity.properties.rank).toBe(0);
    });

    it("handles entity without a corresponding user row gracefully", () => {
      const entity = makeEntity("orphan", 0);
      setStandingTo(db, entity, 7);
      const changed = applyRankProgression(db, entity);
      expect(changed).toBe(true);
      expect(entity.properties.rank).toBe(1);
    });
  });

  describe("getPromotionProgress()", () => {
    it("returns gap to next threshold for a fresh entity", () => {
      const entity = makeEntity("newbie", 0);
      const result = getPromotionProgress(db, entity);
      expect(result).not.toBeNull();
      expect(result).toContain("standing");
      expect(result).toContain("rank 1");
    });

    it("returns null when entity is at or above the safety threshold", () => {
      const entity = makeEntity("builder", 4);
      expect(getPromotionProgress(db, entity)).toBeNull();
    });

    it("returns null for sovereign (above safety threshold)", () => {
      const entity = makeEntity("sovereign", 9);
      expect(getPromotionProgress(db, entity)).toBeNull();
    });

    it("returns null when entity already qualifies for the next tier", () => {
      const entity = makeEntity("ready", 0);
      setStandingTo(db, entity, 7);
      expect(getPromotionProgress(db, entity)).toBeNull();
    });

    it("shows the remaining standing needed mid-tier", () => {
      const entity = makeEntity("midway", 1);
      setStandingTo(db, entity, 10);
      const result = getPromotionProgress(db, entity);
      expect(result).not.toBeNull();
      expect(result).toContain("rank 2");
      expect(result).toContain("standing 10");
    });
  });
});
