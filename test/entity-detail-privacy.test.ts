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

describe("entity visibility rule", () => {
  const entity = (id: string) => ({ id, name: id }) as unknown as Entity;

  it("grants the private view to privileged readers and the entity itself only", () => {
    expect(seesEntityPrivate({ privilegedRead: true }, "e_1")).toBe(true);
    expect(seesEntityPrivate({ privilegedRead: false, entity: entity("e_1") }, "e_1")).toBe(true);
    expect(seesEntityPrivate({ privilegedRead: false, entity: entity("e_2") }, "e_1")).toBe(false);
    expect(seesEntityPrivate({ privilegedRead: false }, "e_1")).toBe(false);
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
