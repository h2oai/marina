// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Session-end reflection never buys a helper. `LeanAgentAdapter.stop()` used
 * a bare `reflect`, which under LOCAL ungated auto-spawned a model-backed
 * memory-reflector that looped until someone stopped it. Now: `--no-spawn`
 * for an individual stop (a RUNNING helper may take the topic), `--template`
 * on shutdown; auto-spawn is single-flight per role; idle reflectors are
 * stopped by the runtime.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, reflectorIsIdle, reflectorJobActivity } from "../src/agent/agent-runtime";
import type { AgentHandle, AgentStatus } from "../src/agent/agent-types";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import {
  REFLECTOR_ROLE,
  type ReflectAgentView,
  reflectCommand,
  resetHelperSpawnsForTests,
  type SpawnedHelper,
} from "../src/engine/commands/reflect";
import { MEMORY_REFLECTOR_ROLE, reflectorIdleStopMs } from "../src/engine/constants";
import { Engine } from "../src/engine/engine";
import { resetTrustProfileForTests, setTrustProfile } from "../src/engine/trust-profile";
import { awaitPendingBridges } from "../src/memory/legacy-bridge";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { MarinaDB } from "../src/persistence/database";
import type { MemoryAssistancePage } from "../src/sdk/memory-assistance";
import { type EntityId, roomId } from "../src/types";
import { MockConnection, makeTestRoom, stripAnsi } from "./helpers";

// ─── Adapter: stop() never issues a spawning reflect ─────────────────────────

type AdapterInternals = {
  metrics: { startedAt: number };
  client: { command: (cmd: string) => Promise<unknown>; disconnect: () => void };
  saveCurrentCheckpoint: () => Promise<void>;
};

function makeAdapter(name: string) {
  const adapter = new LeanAgentAdapter(
    { name, model: "anthropic/claude-haiku-4-5" },
    "ws://localhost:39999",
    null,
    "sk-test",
  );
  const i = adapter as unknown as AdapterInternals;
  const sent: string[] = [];
  i.client.command = async (cmd: string) => {
    sent.push(cmd);
    return [];
  };
  i.client.disconnect = () => {};
  i.saveCurrentCheckpoint = async () => {};
  i.metrics.startedAt = Date.now() - 90_000;
  return { adapter, sent };
}

describe("LeanAgentAdapter.stop() session-end reflection", () => {
  it("individual stop: `reflect --no-spawn` — a running helper may take the topic, never a new one", async () => {
    const { adapter, sent } = makeAdapter("ender-a");
    await adapter.stop();
    const reflects = sent.filter((c) => c.startsWith("reflect"));
    expect(reflects).toHaveLength(1);
    expect(reflects[0]).toMatch(/^reflect --no-spawn Session ended: /);
  });

  it("shutdown (stopAll): `reflect --template` — deterministic, no job, no helper", async () => {
    const { adapter, sent } = makeAdapter("ender-b");
    await adapter.stop({ shutdown: true });
    const reflects = sent.filter((c) => c.startsWith("reflect"));
    expect(reflects).toHaveLength(1);
    expect(reflects[0]).toMatch(/^reflect --template Session ended: /);
  });

  it("never sends the bare (auto-spawning) form", async () => {
    for (const shutdown of [false, true]) {
      const { adapter, sent } = makeAdapter(`ender-c-${shutdown}`);
      await adapter.stop({ shutdown });
      expect(sent.some((c) => /^reflect (Session|$)/.test(c))).toBe(false);
    }
  });
});

// ─── reflect command: --no-spawn and single-flight auto-spawn ────────────────

describe("reflect --no-spawn and shared auto-spawn", () => {
  let directory: string;
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let bob: MockConnection;

  const run = async (connection: MockConnection, text: string) => {
    connection.clear();
    await engine.processCommand(connection.entity as EntityId, text);
    await awaitPendingBridges();
    return stripAnsi(connection.allTextJoined());
  };
  const jobsOf = async (name: string) =>
    (
      (await residentMemoryOperation(db, name, { operation: "assist_jobs", input: {} }))
        .result as MemoryAssistancePage
    ).jobs;

  function wireReflect(deps: {
    listAgents?: () => ReflectAgentView[];
    helpersAvailable?: () => boolean;
    spawnHelper?: (role: string, requestedBy: string) => Promise<SpawnedHelper | undefined>;
  }) {
    engine.commands.registerBuiltin(
      reflectCommand({
        getEntity: (id) => engine.entities.get(id as EntityId),
        db,
        logEvent: (event) => engine.logEvent(event),
        ...deps,
      }),
    );
  }

  /** Fake spawn that blocks until `release()` — models the runtime's spawn latency. */
  function gatedSpawner(name = "AutoReflector") {
    const calls: { role: string; requestedBy: string }[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spawnHelper = async (role: string, requestedBy: string): Promise<SpawnedHelper> => {
      calls.push({ role, requestedBy });
      await gate;
      if (!db.getUserByName(name)) db.createUser({ id: crypto.randomUUID(), name });
      return { name, principalId: db.getUserByName(name)!.id };
    };
    return { calls, spawnHelper, release: () => release() };
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "marina-shutdown-reflect-"));
    db = new MarinaDB(join(directory, "world.db"));
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("alice");
    bob = new MockConnection("bob");
    for (const [connection, name] of [
      [alice, "Alice"],
      [bob, "Bob"],
    ] as const) {
      db.createUser({ id: crypto.randomUUID(), name });
      engine.addConnection(connection);
      engine.spawnEntity(connection.id, name);
    }
    setTrustProfile("local");
  });

  afterEach(() => {
    resetTrustProfileForTests();
    resetHelperSpawnsForTests();
    db.close();
    rmSync(directory, { recursive: true });
  });

  it("--no-spawn with no running helper: template, and spawnHelper is never called", async () => {
    for (let i = 0; i < 2; i++) await run(alice, `note Session observation ${i} !8`);
    const { calls, spawnHelper, release } = gatedSpawner();
    release();
    wireReflect({ listAgents: () => [], helpersAvailable: () => true, spawnHelper });
    const reply = await run(alice, "reflect --no-spawn Session ended: 3 tool calls");
    expect(calls).toEqual([]);
    expect(reply).toContain("Reflection Created");
    expect(await jobsOf("Alice")).toEqual([]);
  });

  it("--no-spawn with a running helper: files the job against it, still no spawn", async () => {
    db.createUser({ id: crypto.randomUUID(), name: "Reflector" });
    for (let i = 0; i < 2; i++) await run(alice, `note Session observation ${i} !8`);
    const { calls, spawnHelper, release } = gatedSpawner();
    release();
    wireReflect({
      listAgents: () => [{ name: "Reflector", role: REFLECTOR_ROLE, state: "autonomous" }],
      helpersAvailable: () => true,
      spawnHelper,
    });
    const reply = await run(alice, "reflect --no-spawn Session ended: 3 tool calls");
    expect(calls).toEqual([]);
    expect(reply).toContain("Reflection Requested");
    const [job] = await jobsOf("Alice");
    expect(job?.worker_id).toBe(db.getUserByName("Reflector")!.id);
  });

  it("two agents reflecting concurrently share ONE auto-spawned reflector", async () => {
    for (let i = 0; i < 2; i++) {
      await run(alice, `note Amber deploy observation ${i} !8`);
      await run(bob, `note Amber deploy observation ${i} !8`);
    }
    const { calls, spawnHelper, release } = gatedSpawner();
    wireReflect({ listAgents: () => [], helpersAvailable: () => true, spawnHelper });

    alice.clear();
    bob.clear();
    const first = engine.processCommand(alice.entity as EntityId, "reflect amber");
    const second = engine.processCommand(bob.entity as EntityId, "reflect amber");
    // Let both handlers reach the spawn seam before it resolves.
    await Bun.sleep(20);
    release();
    await Promise.all([first, second]);
    await awaitPendingBridges();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ role: REFLECTOR_ROLE, requestedBy: "Alice" });
    const worker = db.getUserByName("AutoReflector")!.id;
    for (const name of ["Alice", "Bob"]) {
      const deadline = Date.now() + 2_000;
      let jobs = await jobsOf(name);
      while (jobs.length === 0 && Date.now() < deadline) {
        await Bun.sleep(20);
        jobs = await jobsOf(name);
      }
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.worker_id).toBe(worker);
    }
    const bobReply = stripAnsi(bob.allTextJoined());
    const aliceReply = stripAnsi(alice.allTextJoined());
    expect(`${aliceReply}\n${bobReply}`).toContain("Reusing AutoReflector");
  });
});

// ─── Runtime: idle stop for reflectors ───────────────────────────────────────

type RuntimeInternals = {
  agents: Map<string, AgentHandle>;
  spawnedByOf: Map<string, string>;
};

function fakeHandle(
  name: string,
  role: string,
  uptime: number,
  stops: Array<{ name: string; opts: unknown }>,
): AgentHandle {
  const status: AgentStatus = {
    name,
    entityId: null,
    state: "autonomous",
    model: "marina/default",
    role,
    focus: null,
    goal: null,
    uptime,
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
  return {
    name,
    getStatus: () => status,
    sendAttention: async () => {},
    setFocus: () => {},
    setSystemPrompt: () => {},
    stop: async (opts?: unknown) => {
      stops.push({ name, opts });
    },
    subscribe: () => () => {},
    reconfigure: async () => {},
  } as AgentHandle;
}

describe("reflectorIsIdle", () => {
  const W = 600_000;
  it("needs the full window of uptime, no open job, and no job created inside the window", () => {
    const base = { uptimeMs: W + 1, lastJobCreatedAt: null, openJobs: 0, windowMs: W, now: 10 * W };
    expect(reflectorIsIdle(base)).toBe(true);
    expect(reflectorIsIdle({ ...base, uptimeMs: W - 1 })).toBe(false);
    expect(reflectorIsIdle({ ...base, openJobs: 1 })).toBe(false);
    expect(reflectorIsIdle({ ...base, lastJobCreatedAt: 10 * W - W / 2 })).toBe(false);
    expect(reflectorIsIdle({ ...base, lastJobCreatedAt: 10 * W - 2 * W })).toBe(true);
    expect(reflectorIsIdle({ ...base, windowMs: 0 })).toBe(false);
  });

  it("reflectorIdleStopMs defaults to 10 min, honours the env, 0 disables", () => {
    expect(reflectorIdleStopMs({})).toBe(600_000);
    expect(reflectorIdleStopMs({ MARINA_REFLECTOR_IDLE_STOP_MS: "50" })).toBe(50);
    expect(reflectorIdleStopMs({ MARINA_REFLECTOR_IDLE_STOP_MS: "0" })).toBe(0);
    expect(reflectorIdleStopMs({ MARINA_REFLECTOR_IDLE_STOP_MS: "soon" })).toBe(600_000);
  });
});

describe("AgentRuntime reflector idle stop", () => {
  let directory: string;
  let db: MarinaDB;
  let runtime: AgentRuntime;
  let internals: RuntimeInternals;
  let stops: Array<{ name: string; opts: unknown }>;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "marina-reflector-idle-"));
    db = new MarinaDB(join(directory, "world.db"));
    runtime = new AgentRuntime({ db, wsPort: 39999 });
    internals = runtime as unknown as RuntimeInternals;
    stops = [];
    process.env.MARINA_REFLECTOR_IDLE_STOP_MS = "50";
  });

  afterEach(() => {
    delete process.env.MARINA_REFLECTOR_IDLE_STOP_MS;
    db.close();
    rmSync(directory, { recursive: true });
  });

  function running(name: string, role: string, uptime: number) {
    internals.agents.set(name, fakeHandle(name, role, uptime, stops));
    internals.spawnedByOf.set(name, "Alice");
    db.createUser({ id: crypto.randomUUID(), name });
  }

  it("stops a reflector past the window with no assigned job; leaves other roles alone", async () => {
    running("Reflector", MEMORY_REFLECTOR_ROLE, 1_000);
    running("Scholar", "scholar", 1_000_000);
    const stopped = await runtime.enforceReflectorIdleStop();
    expect(stopped).toEqual(["Reflector"]);
    expect(stops.map((s) => s.name)).toEqual(["Reflector"]);
    expect(internals.agents.has("Reflector")).toBe(false);
    expect(internals.agents.has("Scholar")).toBe(true);
  });

  it("a fresh reflector (uptime inside the window) is given time to receive its first job", async () => {
    running("Reflector", MEMORY_REFLECTOR_ROLE, 10);
    expect(await runtime.enforceReflectorIdleStop()).toEqual([]);
    expect(stops).toEqual([]);
  });

  it("a reflector with an open assistance job is kept", async () => {
    running("Reflector", MEMORY_REFLECTOR_ROLE, 1_000);
    db.createUser({ id: crypto.randomUUID(), name: "Alice" });
    const worker = db.getUserByName("Reflector")!.id;
    const filed = await residentMemoryOperation(db, "Alice", {
      operation: "assist_create",
      input: {
        worker_id: worker,
        role: "reflector",
        task: "Reflect on amber: propose one reusable lesson with citations.",
        max_operations: 8,
        timeout_ms: 60_000,
      },
    });
    expect(filed.ok).toBe(true);
    expect(reflectorJobActivity(db, worker).openJobs).toBe(1);
    expect(await runtime.enforceReflectorIdleStop()).toEqual([]);
    expect(stops).toEqual([]);
  });

  it("MARINA_REFLECTOR_IDLE_STOP_MS=0 disables the idle stop", async () => {
    process.env.MARINA_REFLECTOR_IDLE_STOP_MS = "0";
    running("Reflector", MEMORY_REFLECTOR_ROLE, 10_000_000);
    expect(await runtime.enforceReflectorIdleStop()).toEqual([]);
  });

  it("stopAll hands every handle { shutdown: true }; a plain stop hands nothing", async () => {
    running("Reflector", MEMORY_REFLECTOR_ROLE, 10);
    running("Scholar", "scholar", 10);
    await runtime.stop("Scholar");
    expect(stops).toEqual([{ name: "Scholar", opts: undefined }]);
    await runtime.stopAll();
    expect(stops.find((s) => s.name === "Reflector")?.opts).toEqual({ shutdown: true });
  });
});
