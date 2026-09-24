// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import type { WorldDefinition } from "../src/world/world-definition";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

describe("dashboard discovery", () => {
  let db: MarinaDB;
  let engine: Engine;
  let token: string;
  const previous = process.env.MARINA_OPEN_API;
  const start = roomId("test/discovery");
  beforeEach(() => {
    delete process.env.MARINA_OPEN_API;
    resetHttpRateLimitersForTests();
    db = new MarinaDB("/tmp/marina-dashboard-discovery-test.db");
    const world = {
      name: "Discovery",
      startRoom: start,
      quests: [
        {
          id: "intro",
          name: "First steps",
          description: "Explore",
          reward: "Ready",
          steps: [
            {
              id: "look",
              description: "Look around",
              hint: "look",
              check: (entity) => entity.properties.looked === true,
            },
          ],
        },
      ],
    } satisfies Partial<WorldDefinition>;
    engine = new Engine({ startRoom: start, db, world: world as WorldDefinition });
    engine.registerRoom(start, makeTestRoom({ short: "Discovery room" }));
    for (const name of ["Alice", "Bob"]) {
      const conn = new MockConnection(`discovery-${name}`);
      engine.addConnection(conn);
      const login = engine.login(conn.id, name);
      if ("error" in login) throw new Error(login.error);
      if (name === "Alice") token = login.token;
    }
  });
  afterEach(() => {
    db?.close();
    cleanupDb("/tmp/marina-dashboard-discovery-test.db");
    if (previous === undefined) delete process.env.MARINA_OPEN_API;
    else process.env.MARINA_OPEN_API = previous;
  });
  const get = async (path: string, bearer: string | null = token) => {
    const url = new URL(path, "http://localhost");
    return (await handleDashboardApi(
      new Request(url, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} }),
      url,
      "GET",
      engine,
      db,
    ))!;
  };

  it("requires authentication and derives the catalog from registered commands", async () => {
    expect((await get("/api/command-catalog", null)).status).toBe(401);
    const catalog = await (await get("/api/command-catalog")).json();
    expect(catalog).toHaveLength(engine.commands.allBuiltins().length);
    expect(catalog.find((cmd: { name: string }) => cmd.name === "quest")).toMatchObject({
      aliases: ["checklist", "onboarding"],
      category: "Identity & Access",
    });
    expect(JSON.stringify(catalog)).not.toContain('"handler"');
  });
  it("searches rooms and FTS notes without leaking another resident's memory or process tier", async () => {
    const own = db.createNote("Alice", "discovery shared word", start);
    db.createNote("Bob", "discovery secret word", start);
    db.createNote("Alice", "[compaction] discovery process word", start);
    const hits = await (await get("/api/search?q=discovery")).json();
    expect(hits.some((hit: { kind: string }) => hit.kind === "room")).toBe(true);
    expect(
      hits
        .filter((hit: { kind: string }) => hit.kind === "note")
        .map((hit: { id: string }) => hit.id),
    ).toEqual([String(own)]);
    expect((await get(`/api/search?q=${"x".repeat(201)}`)).status).toBe(400);
    expect(await (await get("/api/search?q=x")).json()).toEqual([]);
  });
  it("keeps private preview fields scoped while returning public rank and standing", async () => {
    const other = await (await get("/api/entities/Bob/preview")).json();
    expect(other).toMatchObject({
      name: "Bob",
      privateVisible: false,
      inventory: null,
      task: null,
      crew: null,
    });
    expect(typeof other.rank).toBe("number");
    expect(await (await get("/api/entities/Alice/preview")).json()).toMatchObject({
      privateVisible: true,
      inventory: [],
    });
  });
  it("projects actual quest checks and protects another resident's progress", async () => {
    const entity = engine.findEntityGlobal("Alice")!;
    entity.properties.active_quest = "intro";
    let quests = await (await get("/api/entities/Alice/quests")).json();
    expect(quests[0]).toMatchObject({
      active: true,
      completed: false,
      steps: [{ id: "look", done: false }],
    });
    entity.properties.looked = true;
    quests = await (await get("/api/entities/Alice/quests")).json();
    expect(quests[0].steps[0].done).toBe(true);
    entity.properties.completed_quests = ["intro"];
    entity.properties.looked = false;
    quests = await (await get("/api/entities/Alice/quests")).json();
    expect(quests[0]).toMatchObject({ completed: true, steps: [{ done: true }] });
    expect((await get("/api/entities/Bob/quests")).status).toBe(403);
  });
});
