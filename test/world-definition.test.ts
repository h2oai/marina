// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { loadRooms } from "../src/world/room-loader";
import { seedGuidePool } from "../src/world/seed-guide";
import defaultWorld from "../worlds/default";
import emptyWorld from "../worlds/empty";
import showcaseWorld from "../worlds/showcase";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

describe("WorldDefinition: default world", () => {
  it("should be a compact inline workbench", () => {
    expect(defaultWorld.name).toBe("Workbench");
    expect(Object.keys(defaultWorld.rooms).length).toBe(4);
    expect(defaultWorld.roomsDir).toBeUndefined();
    expect(defaultWorld.gridPositions).toBeDefined();
    expect(Object.keys(defaultWorld.gridPositions!).length).toBe(4);
  });

  it("should register its four focused rooms", () => {
    const engine = new Engine({
      startRoom: defaultWorld.startRoom,
      tickInterval: 60_000,
      world: defaultWorld,
    });
    engine.registerWorldRooms(defaultWorld);
    expect(engine.rooms.size).toBe(4);
    expect(engine.rooms.has(roomId("workbench/start"))).toBe(true);
  });

  it("starts with an outcome contract and a runtime population hook", () => {
    expect(defaultWorld.startRoom).toBe(roomId("workbench/start"));
    expect(defaultWorld.guideNotes[0]?.content).toContain("memory set outcome");
    expect(defaultWorld.afterAgentsReady).toBeDefined();
  });

  it("ships with no ceremony quests — the guide pool is the inheritance surface", () => {
    expect(defaultWorld.quests.length).toBe(0);
    expect(defaultWorld.autoQuest).toBeUndefined();
  });

  it("should have guide notes", () => {
    expect(defaultWorld.guideNotes.length).toBe(11);
  });

  it("should have canvas config", () => {
    expect(defaultWorld.canvas).toBeDefined();
    expect(defaultWorld.canvas!.name).toBe("workbench");
  });

  it("seeds a compact demo population and visible shared work", () => {
    const path = "test_workbench_seed.db";
    const db = new MarinaDB(path);
    try {
      defaultWorld.seed?.(db);
      expect(["Host", "Builder", "Critic", "Chronicler"].every((n) => db.getAgentConfig(n))).toBe(
        true,
      );
      expect(db.getProjectByName("Demo Pulse")).toBeDefined();
      expect(db.getBoardByName("demo-scenarios")).toBeDefined();
    } finally {
      db.close();
      cleanupDb(path);
    }
  });
});

describe("WorldDefinition: showcase world", () => {
  it("preserves the full 25-room grid", async () => {
    expect(Object.keys(showcaseWorld.rooms).length).toBe(0);
    expect(showcaseWorld.roomsDir).toBeDefined();
    expect(Object.keys(showcaseWorld.gridPositions!).length).toBe(25);

    const engine = new Engine({
      startRoom: showcaseWorld.startRoom,
      tickInterval: 60_000,
      world: showcaseWorld,
    });
    engine.registerWorldRooms(showcaseWorld);
    await loadRooms(engine, resolve(showcaseWorld.roomsDir!));
    expect(engine.rooms.size).toBe(25);
  });

  it("preserves the full guide and runtime crew registration", () => {
    expect(showcaseWorld.name).toBe("Showcase");
    expect(showcaseWorld.guideNotes.length).toBe(46);
    expect(showcaseWorld.guideNotes[0]?.content).toContain("Debut Tour");
    expect(showcaseWorld.canvas?.name).toBe("global");
    expect(showcaseWorld.afterAgentsReady).toBeDefined();
  });
});

describe("WorldDefinition: empty world", () => {
  it("should have 1 room", () => {
    expect(Object.keys(emptyWorld.rooms).length).toBe(1);
  });

  it("should have 0 quests", () => {
    expect(emptyWorld.quests.length).toBe(0);
  });

  it("should have 0 guide notes", () => {
    expect(emptyWorld.guideNotes.length).toBe(0);
  });

  it("should not have autoQuest", () => {
    expect(emptyWorld.autoQuest).toBeUndefined();
  });
});

describe("WorldDefinition: registerWorldRooms", () => {
  it("should register all rooms from a world definition", () => {
    const engine = new Engine({
      startRoom: roomId("void/center"),
      tickInterval: 60_000,
      world: emptyWorld,
    });
    engine.registerWorldRooms(emptyWorld);
    expect(engine.rooms.size).toBe(1);
    expect(engine.rooms.has(roomId("void/center"))).toBe(true);
  });

  it("should register all 25 rooms from showcase world (all files)", async () => {
    const engine = new Engine({
      startRoom: roomId("hub/crossroads"),
      tickInterval: 60_000,
      world: showcaseWorld,
    });
    engine.registerWorldRooms(showcaseWorld);
    await loadRooms(engine, resolve(showcaseWorld.roomsDir!));
    expect(engine.rooms.size).toBe(25);
  });
});

describe("WorldDefinition: empty world engine", () => {
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    engine = new Engine({
      startRoom: roomId("void/center"),
      tickInterval: 60_000,
      world: emptyWorld,
    });
    engine.registerWorldRooms(emptyWorld);
    conn = new MockConnection("c1");
    engine.addConnection(conn);
  });

  it("should spawn in void room", () => {
    const result = engine.login("c1", "Wanderer");
    expect("entityId" in result).toBe(true);
    if ("entityId" in result) {
      const entity = engine.entities.get(result.entityId);
      expect(entity?.room).toBe(roomId("void/center"));
    }
  });

  it("should not auto-start any quest", () => {
    const result = engine.login("c1", "Wanderer");
    expect("entityId" in result).toBe(true);
    if ("entityId" in result) {
      const entity = engine.entities.get(result.entityId);
      expect(entity?.properties.active_quest).toBeUndefined();
    }
  });

  it("should have no objectives available", () => {
    engine.login("c1", "Wanderer");
    conn.clear();
    engine.processCommand(conn.entity!, "quest list");
    const text = conn.lastText();
    // Should show header but no objective entries
    expect(text).toContain("Available Objectives");
    expect(text).not.toContain("First Steps");
  });
});

describe("WorldDefinition: onComplete callback", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  const dbPath = `/tmp/marina-oncomplete-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({
      startRoom: roomId("hub/crossroads"),
      tickInterval: 60_000,
      db,
      world: showcaseWorld,
    });
    engine.registerRoom(
      roomId("hub/crossroads"),
      makeTestRoom({
        short: "Crossroads",
        items: { terminal: "A terminal." },
        exits: {
          north: roomId("knowledge/hub"),
          east: roomId("markets/floor"),
          south: roomId("coord/center"),
        },
      }),
    );
    engine.registerRoom(
      roomId("knowledge/hub"),
      makeTestRoom({ short: "Knowledge Hub", exits: { south: roomId("hub/crossroads") } }),
    );
    engine.registerRoom(
      roomId("markets/floor"),
      makeTestRoom({ short: "Trade Floor", exits: { west: roomId("hub/crossroads") } }),
    );
    engine.registerRoom(
      roomId("coord/center"),
      makeTestRoom({ short: "Coordination", exits: { north: roomId("hub/crossroads") } }),
    );

    conn = new MockConnection("c1");
    engine.addConnection(conn);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("should fire onComplete and promote to citizen on tutorial completion", () => {
    // Seed a project and task so the tutorial steps can complete
    const groupId = crypto.randomUUID();
    const poolId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    db.createMemoryPool(poolId, "test", "system", groupId);
    db.createGroup({
      id: groupId,
      name: "test",
      description: "Test project",
      leaderId: "system",
    });
    db.createProject({
      id: projectId,
      name: "Test",
      description: "Test project",
      poolId,
      groupId,
      orchestration: "swarm",
      createdBy: "system",
    });
    db.createTask({
      groupId,
      title: "Test task",
      description: "A test task",
      creatorId: "system",
      creatorName: "system",
      validationMode: "bounty",
      standing: 5,
    });

    engine.login("c1", "Player");
    const entity = engine.entities.get(conn.entity!)!;

    // Complete all tutorial steps: look, set goal, join project, claim task, note
    engine.processCommand(conn.entity!, "look");
    engine.processCommand(conn.entity!, "memory set goal explore");
    engine.processCommand(conn.entity!, "project Test join");
    engine.processCommand(conn.entity!, "task claim 1");
    engine.processCommand(conn.entity!, "note this is interesting");

    engine.processCommand(conn.entity!, "quest complete");
    // Should have at least rank 1 (may be higher if standing from tasks promoted further)
    expect((entity.properties.rank as number) ?? 0).toBeGreaterThanOrEqual(1);

    // DB should also reflect the rank
    const user = db.getUserByName("Player");
    expect(user!.rank).toBeGreaterThanOrEqual(1);
  });
});

describe("seedGuidePool with custom notes", () => {
  let db: MarinaDB;
  const dbPath = `/tmp/marina-guide-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("should seed notes from provided array", () => {
    const notes = [
      { content: "Test note one", importance: 8, type: "skill" },
      { content: "Test note two", importance: 5, type: "fact" },
    ];
    seedGuidePool(db, notes);

    const pool = db.getMemoryPool("guide");
    expect(pool).toBeDefined();

    const recalled = db.recallPoolNotes(pool!.id, "Test note", {
      weightRelevance: 1.0,
      weightRecency: 0,
      weightImportance: 0,
    });
    expect(recalled.length).toBeGreaterThanOrEqual(2);
  });

  it("seeds platform guide notes even when the world provides none", () => {
    // The platform-wide self-improvement ("evolver") notes are merged into
    // every world's guide pool, so an empty world-notes array still produces a
    // pool — it just contains the platform notes.
    seedGuidePool(db, []);
    const pool = db.getMemoryPool("guide");
    expect(pool).toBeDefined();
    const notes = db.getPoolNotes(pool!.id, 50);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.map((n) => n.content).join("\n")).toContain("self-improvement loop");
  });

  it("should be idempotent", () => {
    const notes = [{ content: "Idempotency test", importance: 5, type: "skill" }];
    seedGuidePool(db, notes);
    seedGuidePool(db, notes); // second call should be no-op

    const pool = db.getMemoryPool("guide");
    expect(pool).toBeDefined();
  });

  it("adds new guide notes to an existing guide pool without duplicating old ones", () => {
    const oldNote = { content: "Existing guide note", importance: 5, type: "fact" };
    const newNote = { content: "New guide note", importance: 7, type: "skill" };

    seedGuidePool(db, [oldNote]);
    const pool = db.getMemoryPool("guide");
    expect(pool).toBeDefined();
    const before = db.getPoolNotes(pool!.id, 1_000).length;

    seedGuidePool(db, [oldNote, newNote]);
    const afterNotes = db.getPoolNotes(pool!.id, 1_000);

    expect(afterNotes.length).toBe(before + 1);
    expect(afterNotes.filter((note) => note.content === oldNote.content)).toHaveLength(1);
    expect(afterNotes.filter((note) => note.content === newNote.content)).toHaveLength(1);
  });
});
