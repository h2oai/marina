// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { Engine } from "../src/engine/engine";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { DashboardBroadcaster, type DashboardWSData } from "../src/net/dashboard-ws";
import {
  publicActivity,
  publicEntityProperties,
  seesEntityPrivate,
} from "../src/net/entity-visibility";
import { MarinaDB } from "../src/persistence/database";
import { type EngineEvent, type Entity, type EntityId, roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

const INPUT = "tell Bob INPUT_SENTINEL";
const PROP = "PROP_SENTINEL";

let directory: string;
let db: MarinaDB;
let engine: Engine;
let alice: ReturnType<Engine["login"]> & { entityId: string; token: string };
let bob: typeof alice;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "marina-entity-privacy-"));
  db = new MarinaDB(join(directory, "test.db"));
  engine = new Engine({ db, startRoom: roomId("test/start") });
  engine.registerRoom(roomId("test/start"), makeTestRoom());
  const login = (name: string) => {
    const connection = new MockConnection(name);
    engine.addConnection(connection);
    const session = engine.login(connection.id, name);
    if ("error" in session) throw new Error(session.error);
    return session;
  };
  alice = login("Alice");
  bob = login("Bob");
  const entity = engine.entities.get(alice.entityId as EntityId)!;
  entity.properties.goal_note = PROP;
  db.logEvent({
    type: "command",
    entity: alice.entityId as EntityId,
    input: INPUT,
    timestamp: Date.now(),
  } as unknown as EngineEvent);
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true });
});

async function get(path: string, actor: typeof alice) {
  const url = new URL(path, "http://test.invalid");
  const response = await handleDashboardApi(
    new Request(url, { headers: { Authorization: `Bearer ${actor.token}` } }),
    url,
    "GET",
    engine,
    db,
  );
  if (!response) throw new Error("Unhandled route");
  return { status: response.status, text: await response.text() };
}

describe("entity private view on the dashboard", () => {
  it("another account never receives the raw input or private properties", async () => {
    for (const path of ["/api/entities/Alice", "/api/events?limit=500"]) {
      const { text } = await get(path, bob);
      expect(text).not.toContain("INPUT_SENTINEL");
      expect(text).not.toContain(PROP);
    }
    expect((await get("/api/entities/Alice", bob)).status).toBe(403);
  });

  it("the entity itself reads its own input and properties", async () => {
    const { status, text } = await get("/api/entities/Alice", alice);
    expect(status).toBe(200);
    expect(text).toContain("INPUT_SENTINEL");
    expect(text).toContain(PROP);
  });

  it("the live snapshot gives another account only the public properties", () => {
    const broadcaster = new DashboardBroadcaster();
    const sinks: Record<string, string[]> = { own: [], other: [] };
    for (const [principal, sink] of [
      [alice.entityId, sinks.own!],
      [bob.entityId, sinks.other!],
    ] as const)
      broadcaster.addClient(
        {
          data: { connId: principal, isDashboard: true, principal },
          send: (message: string) => sink.push(message),
        } as unknown as ServerWebSocket<DashboardWSData>,
        engine,
      );
    broadcaster.broadcastState(engine);
    expect(sinks.own!.join("")).toContain(PROP);
    expect(sinks.other!.join("")).not.toContain(PROP);
    expect(sinks.other!.join("")).not.toContain("INPUT_SENTINEL");
  });
});

describe("a person sees the private view of agents it owns", () => {
  let carol: typeof alice;
  let scout: typeof alice;
  let ranger: typeof alice;
  let dave: typeof alice;
  beforeEach(() => {
    const login = (name: string) => {
      const connection = new MockConnection(name);
      engine.addConnection(connection);
      const session = engine.login(connection.id, name);
      if ("error" in session) throw new Error(session.error);
      return session as typeof alice;
    };
    // Carol owns Scout and Ranger; Dave is an unrelated person.
    for (const name of ["Scout", "Ranger"])
      db.saveAgentConfig({ name, model: "marina/default", spawnedBy: "Carol" });
    carol = login("Carol");
    scout = login("Scout");
    ranger = login("Ranger");
    dave = login("Dave");
    const agent = engine.entities.get(scout.entityId as EntityId)!;
    agent.properties.goal_note = PROP;
    db.setCoreMemory("Scout", "focus", "CORE_SENTINEL");
    db.logEvent({
      type: "command",
      entity: scout.entityId as EntityId,
      input: INPUT,
      timestamp: Date.now(),
    } as unknown as EngineEvent);
  });

  it("the owning person reads its agent's input, properties and core memory", async () => {
    for (const path of ["/api/entities/Scout", "/api/memory/core/Scout"]) {
      const { status } = await get(path, carol);
      expect(status).toBe(200);
    }
    const { text } = await get("/api/entities/Scout", carol);
    expect(text).toContain("INPUT_SENTINEL");
    expect(text).toContain(PROP);
    expect(text).toContain("CORE_SENTINEL");
  });

  it("a sibling agent and an unrelated person do not", async () => {
    for (const actor of [ranger, dave])
      for (const path of ["/api/entities/Scout", "/api/memory/core/Scout"]) {
        const { status, text } = await get(path, actor);
        expect(status).toBe(403);
        expect(text).not.toContain("INPUT_SENTINEL");
        expect(text).not.toContain("CORE_SENTINEL");
      }
  });

  it("an agent never reads its owner's private view", async () => {
    expect((await get("/api/entities/Carol", scout)).status).toBe(403);
  });

  it("the live snapshot gives the owner the private shape and no one else", () => {
    const broadcaster = new DashboardBroadcaster();
    const sinks: Record<string, string[]> = { carol: [], ranger: [], dave: [] };
    for (const [principal, sink] of [
      [carol.entityId, sinks.carol!],
      [ranger.entityId, sinks.ranger!],
      [dave.entityId, sinks.dave!],
    ] as const)
      broadcaster.addClient(
        {
          data: { connId: principal, isDashboard: true, principal },
          send: (message: string) => sink.push(message),
        } as unknown as ServerWebSocket<DashboardWSData>,
        engine,
      );
    broadcaster.broadcastState(engine);
    expect(sinks.carol!.join("")).toContain(PROP);
    expect(sinks.ranger!.join("")).not.toContain(PROP);
    expect(sinks.dave!.join("")).not.toContain(PROP);
  });

  it("the rule needs a person who is the owner", () => {
    const person = { id: "e_9", name: "Carol" } as unknown as Entity;
    expect(
      seesEntityPrivate({ privilegedRead: false, entity: person }, { id: "e_5", owner: "carol" }),
    ).toBe(true);
    expect(
      seesEntityPrivate({ privilegedRead: false, entity: person }, { id: "e_5", owner: "Dave" }),
    ).toBe(false);
    expect(seesEntityPrivate({ privilegedRead: false, entity: person }, { id: "e_5" })).toBe(false);
  });
});

describe("entity visibility rule", () => {
  const entity = (id: string) => ({ id, name: id }) as unknown as Entity;

  it("grants the private view to privileged readers and the entity itself only", () => {
    const target = { id: "e_1" };
    expect(seesEntityPrivate({ privilegedRead: true }, target)).toBe(true);
    expect(seesEntityPrivate({ privilegedRead: false, entity: entity("e_1") }, target)).toBe(true);
    expect(seesEntityPrivate({ privilegedRead: false, entity: entity("e_2") }, target)).toBe(false);
    expect(seesEntityPrivate({ privilegedRead: false }, target)).toBe(false);
  });

  it("public activity keeps a registered verb and never the arguments", () => {
    const known = (verb: string) => (verb === "tell" ? "tell" : undefined);
    expect(
      publicActivity(
        [
          { type: "command", input: INPUT, timestamp: 1 },
          { type: "command", input: "my password is hunter2", timestamp: 2 },
          { type: "move", timestamp: 3 },
        ],
        known,
      ),
    ).toEqual([
      { type: "command", timestamp: 1, verb: "tell" },
      { type: "command", timestamp: 2 },
      { type: "move", timestamp: 3 },
    ]);
  });

  it("public properties are the allowlist only", () => {
    expect(publicEntityProperties({ rank: 3, role: "builder", goal_note: PROP })).toEqual({
      rank: 3,
      role: "builder",
    });
  });
});
