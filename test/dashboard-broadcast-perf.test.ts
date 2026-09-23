// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard broadcast hot paths:
 *   1. `broadcastState` builds ONE base snapshot per tick (one entity walk, one
 *      `getAllAgentConfigs`) and masks it per client — the wire shape for every
 *      principal must stay byte-identical to the previous per-principal build.
 *   2. `memoryObserver` is memoized per principal for one TTL and invalidated
 *      by privilege / entity-binding events.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { ServerWebSocket } from "bun";
import { Engine } from "../src/engine/engine";
import { setRank } from "../src/engine/permissions";
import {
  DashboardBroadcaster,
  type DashboardWSData,
  OBSERVER_INVALIDATING_EVENTS,
  type WorldSnapshot,
} from "../src/net/dashboard-ws";
import { memoryObserver } from "../src/net/memory-visibility";
import { MarinaDB } from "../src/persistence/database";
import { type EngineEvent, type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_dashboard_broadcast_perf.db";

let db: MarinaDB;
let engine: Engine;
let alice: EntityId;
let bob: EntityId;
let root: EntityId;

function login(name: string): EntityId {
  const conn = new MockConnection(`bcast-${name}`);
  engine.addConnection(conn);
  const session = engine.login(conn.id, name);
  if ("error" in session) throw new Error(session.error);
  return session.entityId as EntityId;
}

type Sink = { messages: string[]; ws: ServerWebSocket<DashboardWSData> };
function client(principal?: string): Sink {
  const messages: string[] = [];
  const ws = {
    data: { connId: `c-${principal ?? "anon"}-${messages.length}`, isDashboard: true, principal },
    send: (m: string) => messages.push(m),
  } as unknown as ServerWebSocket<DashboardWSData>;
  return { messages, ws };
}

const FAKE_STATUS = {
  state: "autonomous",
  model: "marina/default",
  role: "scholar",
  focus: "SECRET_FOCUS",
  uptime: 42,
  toolCalls: 7,
  errors: 1,
  errorReason: "SECRET_ERROR_BODY",
  supports: { streaming: true, tools: true, vision: false, thinking: false },
  lastActivity: 1234,
  avgTurnMs: 900,
  silentTurns: 2,
};

/** The pre-refactor `buildSnapshot` (per principal, full walk) — the wire oracle. */
function legacyBuildSnapshot(principal: string | undefined, timestamp: number): WorldSnapshot {
  const observer = memoryObserver(engine, principal);
  const spawnedByName = new Map<string, string | null>();
  for (const config of db.getAllAgentConfigs()) spawnedByName.set(config.name, config.spawned_by);
  const entities = engine.entities.all().map((e) => {
    const privateView = observer.privilegedRead || observer.entity?.id === e.id;
    const agentHandle = engine.agentRuntime.get(e.name);
    const agentStatus = agentHandle
      ? (() => {
          const s = agentHandle.getStatus();
          return {
            state: s.state,
            model: s.model,
            role: s.role,
            focus: privateView ? s.focus : null,
            uptime: s.uptime,
            toolCalls: s.toolCalls,
            errors: s.errors,
            errorReason: privateView ? s.errorReason : null,
            supports: s.supports,
            lastActivity: s.lastActivity,
            avgTurnMs: s.avgTurnMs,
            silentTurns: s.silentTurns,
          };
        })()
      : undefined;
    const spawnedBy = agentHandle ? (spawnedByName.get(e.name) ?? undefined) : undefined;
    return {
      id: e.id,
      name: e.name,
      kind: e.kind,
      room: e.room as string,
      properties: privateView ? e.properties : { rank: e.properties.rank, role: e.properties.role },
      agentStatus,
      spawnedBy,
    };
  });
  const roomPopulations: Record<string, number> = {};
  for (const e of entities) roomPopulations[e.room] = (roomPopulations[e.room] ?? 0) + 1;
  const rooms = engine.rooms.all().map((r) => ({
    id: r.id as string,
    short: r.module.short,
    district: (r.id as string).split("/")[0] ?? "",
    exits: Object.fromEntries(
      Object.entries(r.module.exits ?? {}).map(([k, v]) => [k, v as string]),
    ),
  }));
  return {
    timestamp,
    instanceName: engine.instanceName,
    worldName: engine.world?.name ?? "Unknown",
    startRoom: engine.config.startRoom as string,
    entities,
    roomPopulations,
    rooms,
    connections: engine.getConnections().size,
    memory: { heapUsed: 0, rss: 0 },
    gridPositions: engine.world?.gridPositions,
  };
}

beforeEach(() => {
  delete process.env.MARINA_OPEN_API;
  db = new MarinaDB(TEST_DB);
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  alice = login("Alice");
  bob = login("Bob");
  root = login("Root");
  const rootEntity = engine.entities.get(root);
  if (!rootEntity) throw new Error("no root entity");
  setRank(rootEntity, 9);
  const aliceEntity = engine.entities.get(alice);
  if (!aliceEntity) throw new Error("no alice entity");
  aliceEntity.properties.quest = "PRIVATE_PROPERTY";
  // Alice is "an agent" for snapshot purposes: stub the runtime handle so the
  // focus / errorReason masking path is exercised without a model.
  type Handle = NonNullable<ReturnType<Engine["agentRuntime"]["get"]>>;
  spyOn(engine.agentRuntime, "get").mockImplementation((name: string) =>
    name === "Alice" ? ({ getStatus: () => FAKE_STATUS } as unknown as Handle) : undefined,
  );
  db.saveAgentConfig({
    name: "Alice",
    model: "marina/default",
    role: "scholar",
    spawnedBy: "operator",
  });
});

afterEach(() => {
  db.close();
  cleanupDb(TEST_DB);
});

function stateOf(sink: Sink, index = -1): WorldSnapshot {
  const raw = sink.messages.at(index);
  if (!raw) throw new Error("no message");
  const parsed = JSON.parse(raw) as { type: string; data: WorldSnapshot };
  return parsed.data;
}

/** Normalize the process-memory field (not deterministic) before byte comparison. */
function normalized(snapshot: WorldSnapshot): string {
  return JSON.stringify({ ...snapshot, memory: { heapUsed: 0, rss: 0 } });
}

describe("broadcastState — one snapshot per tick, byte-identical per principal", () => {
  it("masked payloads match the legacy per-principal build for every visibility class", () => {
    const now = 1_700_000_000_000;
    const broadcaster = new DashboardBroadcaster({ now: () => now });
    const principals: (string | undefined)[] = [
      root,
      "loopback-anon",
      alice,
      bob,
      "ghost",
      undefined,
    ];
    const sinks = principals.map((p) => client(p));
    for (const s of sinks) broadcaster.addClient(s.ws, engine);
    broadcaster.broadcastState(engine);

    for (const [i, principal] of principals.entries()) {
      const got = stateOf(sinks[i]!);
      expect(got.timestamp).toBe(now);
      expect(normalized(got)).toBe(JSON.stringify(legacyBuildSnapshot(principal, now)));
    }

    // Sanity on the masking itself: privileged + owner see the private view,
    // strangers / anonymous / entity-less principals do not.
    const secretFor = (i: number) => sinks[i]!.messages.at(-1)!.includes("SECRET_FOCUS");
    const propertyFor = (i: number) => sinks[i]!.messages.at(-1)!.includes("PRIVATE_PROPERTY");
    expect([0, 1, 2].map(secretFor)).toEqual([true, true, true]); // root, loopback-anon, Alice
    expect([3, 4, 5].map(secretFor)).toEqual([false, false, false]); // Bob, ghost, undefined
    expect([0, 1, 2].map(propertyFor)).toEqual([true, true, true]);
    expect([3, 4, 5].map(propertyFor)).toEqual([false, false, false]);
    expect(sinks[3]!.messages.at(-1)!).not.toContain("SECRET_ERROR_BODY");
  });

  it("walks entities and reads agent configs once per tick regardless of client count", () => {
    const broadcaster = new DashboardBroadcaster();
    const sinks = [client(root), client(root), client(alice), client(bob), client("ghost")];
    for (const s of sinks) broadcaster.addClient(s.ws, engine);
    const configs = spyOn(db, "getAllAgentConfigs");
    const walk = spyOn(engine.entities, "all");
    const roomsWalk = spyOn(engine.rooms, "all");

    broadcaster.broadcastState(engine);
    // Before: one of each per client (5). After: one per tick.
    expect(configs).toHaveBeenCalledTimes(1);
    expect(walk).toHaveBeenCalledTimes(1);
    expect(roomsWalk).toHaveBeenCalledTimes(1);
    for (const s of sinks) expect(s.messages).toHaveLength(2); // snapshot + state

    broadcaster.broadcastState(engine);
    expect(configs).toHaveBeenCalledTimes(2);
    expect(walk).toHaveBeenCalledTimes(2);
  });

  it("reuses one serialized payload per visibility class", () => {
    const broadcaster = new DashboardBroadcaster({ now: () => 1 });
    const opA = client(root);
    const opB = client("loopback-anon");
    const ghostA = client("ghost-1");
    const ghostB = client("ghost-2");
    const bobA = client(bob);
    const bobB = client(bob);
    const aliceTab = client(alice);
    for (const s of [opA, opB, ghostA, ghostB, bobA, bobB, aliceTab])
      broadcaster.addClient(s.ws, engine);
    broadcaster.broadcastState(engine);
    const last = (s: Sink) => s.messages.at(-1)!;
    // Same class ⇒ the very same string (privileged; entity-less public; one owner's two tabs).
    expect(last(opA)).toBe(last(opB));
    expect(last(ghostA)).toBe(last(ghostB));
    expect(last(bobA)).toBe(last(bobB));
    // Different classes differ.
    expect(last(opA)).not.toBe(last(ghostA));
    expect(last(bobA)).not.toBe(last(ghostA));
    expect(last(aliceTab)).not.toBe(last(bobA));
  });
});

describe("memoryObserver memoization", () => {
  it("constructs M observers per TTL window for N events × M clients, then refreshes", () => {
    let now = 10_000;
    let constructions = 0;
    const broadcaster = new DashboardBroadcaster({
      now: () => now,
      observerTtlMs: 2_000,
      observer: (eng, principal) => {
        constructions++;
        return memoryObserver(eng, principal);
      },
    });
    const sinks = [client(alice), client(bob), client("ghost")];
    for (const s of sinks) broadcaster.addClient(s.ws, engine);
    expect(constructions).toBe(3); // one per principal on addClient
    const events: EngineEvent[] = Array.from({ length: 10 }, (_, i) => ({
      type: "note_created",
      entity: alice,
      authorName: "Alice",
      noteId: i + 1,
      content: `n${i}`,
      importance: 5,
      noteType: "fact",
      timestamp: now,
    }));
    for (const e of events) broadcaster.broadcastEvent(e);
    broadcaster.broadcastState(engine);
    // Before: 10 events × 3 clients + 3 snapshots = 33 constructions. After: 0 new inside the TTL.
    expect(constructions).toBe(3);

    now += 2_001; // TTL lapses
    broadcaster.broadcastEvent(events[0]!);
    expect(constructions).toBe(6);
    for (const e of events) broadcaster.broadcastEvent(e);
    broadcaster.broadcastState(engine);
    expect(constructions).toBe(6);
  });

  it("invalidates only the named principal on privilege / binding events, all when unnamed", () => {
    let constructions = 0;
    const seen: (string | undefined)[] = [];
    const broadcaster = new DashboardBroadcaster({
      now: () => 0,
      observer: (eng, principal) => {
        constructions++;
        seen.push(principal);
        return memoryObserver(eng, principal);
      },
    });
    for (const s of [client(alice), client(bob)]) broadcaster.addClient(s.ws, engine);
    expect(constructions).toBe(2);

    const rankChange: EngineEvent = {
      type: "rank_change",
      entity: alice,
      name: "Alice",
      oldRank: 0,
      newRank: 3,
      direction: "promoted",
      timestamp: 0,
    };
    broadcaster.broadcastEvent(rankChange);
    // The rank_change is delivered to both clients, but only Alice's observer was rebuilt.
    expect(constructions).toBe(3);
    expect(seen.at(-1)).toBe(alice);

    broadcaster.broadcastEvent({
      type: "entity_leave",
      entity: bob,
      room: roomId("test/start"),
      timestamp: 0,
    });
    expect(constructions).toBe(4);
    expect(seen.at(-1)).toBe(bob);

    // A non-invalidating event leaves the cache alone.
    broadcaster.broadcastEvent({ type: "coordination_change", timestamp: 0 } as EngineEvent);
    expect(constructions).toBe(4);
  });

  it("a promotion to sovereign is visible on the very next event without waiting for the TTL", () => {
    const broadcaster = new DashboardBroadcaster({ now: () => 0 });
    const bobTab = client(bob);
    broadcaster.addClient(bobTab.ws, engine);
    const secret = db.createNote("Alice", "PROMOTION_SENTINEL");
    const noteEvent: EngineEvent = {
      type: "note_created",
      entity: alice,
      authorName: "Alice",
      noteId: secret,
      content: "PROMOTION_SENTINEL",
      importance: 5,
      noteType: "fact",
      timestamp: 0,
    };
    broadcaster.broadcastEvent(noteEvent);
    expect(bobTab.messages.join("")).not.toContain("PROMOTION_SENTINEL");

    const bobEntity = engine.entities.get(bob);
    if (!bobEntity) throw new Error("no bob");
    setRank(bobEntity, 9);
    broadcaster.broadcastEvent({
      type: "rank_change",
      entity: bob,
      name: "Bob",
      oldRank: 0,
      newRank: 9,
      direction: "promoted",
      timestamp: 0,
    });
    broadcaster.broadcastEvent(noteEvent);
    expect(bobTab.messages.join("")).toContain("PROMOTION_SENTINEL");
  });

  it("documents the invalidation set", () => {
    expect([...OBSERVER_INVALIDATING_EVENTS].sort()).toEqual([
      "agent_spawn",
      "agent_stop",
      "entity_enter",
      "entity_leave",
      "rank_change",
    ]);
  });
});
