// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { setRank } from "../src/engine/permissions";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_building.db";

describe("Building System", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn1: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({
        short: "Starting Room",
        long: "The starting room.",
        exits: { north: roomId("test/north") },
      }),
    );
    engine.registerRoom(
      roomId("test/north"),
      makeTestRoom({
        short: "Northern Room",
        long: "The northern room.",
        exits: { south: roomId("test/start") },
      }),
    );

    conn1 = new MockConnection("c1");
    engine.addConnection(conn1);
    engine.spawnEntity("c1", "Builder");
    conn1.clear();

    // Set rank to builder (4)
    const entity = engine.entities.get(conn1.entity!)!;
    setRank(entity, 4);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("requires builder rank to use build commands", () => {
    const entity = engine.entities.get(conn1.entity!)!;
    setRank(entity, 0); // newcomer

    engine.processCommand(conn1.entity!, "build room test/new");
    expect(conn1.lastText()).toContain("builder (rank 4)");
  });

  it("creates a new room", () => {
    engine.processCommand(conn1.entity!, "build room test/new A New Room");
    expect(conn1.lastText()).toContain("Created room");
    expect(conn1.lastText()).toContain("A New Room");

    // Verify room exists
    const room = engine.rooms.get(roomId("test/new"));
    expect(room).toBeDefined();
    expect(room!.module.short).toBe("A New Room");
  });

  it("prevents creating duplicate rooms", () => {
    engine.processCommand(conn1.entity!, "build room test/start Another Room");
    expect(conn1.lastText()).toContain("already exists");
  });

  it("modifies room short description", () => {
    engine.processCommand(conn1.entity!, "build modify short Updated Description");
    expect(conn1.lastText()).toContain("Modified short");

    const room = engine.rooms.get(roomId("test/start"));
    expect(room!.module.short).toBe("Updated Description");
  });

  it("modifies room long description", () => {
    engine.processCommand(conn1.entity!, "build modify long A much longer description of the room");
    expect(conn1.lastText()).toContain("Modified long");

    const room = engine.rooms.get(roomId("test/start"));
    expect(room!.module.long).toBe("A much longer description of the room");
  });

  it("modifies a specific room", () => {
    engine.processCommand(conn1.entity!, "build modify test/north short Northern Updated");
    expect(conn1.lastText()).toContain("Modified short");

    const room = engine.rooms.get(roomId("test/north"));
    expect(room!.module.short).toBe("Northern Updated");
  });

  it("links two rooms with a new exit", () => {
    engine.processCommand(conn1.entity!, "build room test/east An Eastern Room");
    conn1.clear();

    engine.processCommand(conn1.entity!, "build link east test/east");
    expect(conn1.lastText()).toContain('Linked exit "east"');

    const room = engine.rooms.get(roomId("test/start"));
    expect(room!.module.exits?.east).toBe(roomId("test/east"));
  });

  it("unlinks an exit", () => {
    engine.processCommand(conn1.entity!, "build unlink north");
    expect(conn1.lastText()).toContain('Removed exit "north"');

    const room = engine.rooms.get(roomId("test/start"));
    expect(room!.module.exits?.north).toBeUndefined();
  });

  it("refuses to unlink non-existent exit", () => {
    engine.processCommand(conn1.entity!, "build unlink west");
    expect(conn1.lastText()).toContain('No exit "west"');
  });

  it("saves source on room creation", () => {
    engine.processCommand(conn1.entity!, "build room test/saved A Saved Room");
    const source = db.getRoomSource("test/saved");
    expect(source).toBeDefined();
    expect(source!.version).toBe(1);
    expect(source!.valid).toBe(1);
  });

  it("increments version on each modification", () => {
    engine.processCommand(conn1.entity!, "build modify short First Edit");
    engine.processCommand(conn1.entity!, "build modify short Second Edit");
    engine.processCommand(conn1.entity!, "build modify short Third Edit");

    const latest = db.getLatestRoomSourceVersion("test/start");
    expect(latest).toBe(3);
  });

  it("shows audit history", () => {
    engine.processCommand(conn1.entity!, "build modify short Edit One");
    engine.processCommand(conn1.entity!, "build modify short Edit Two");
    conn1.clear();

    engine.processCommand(conn1.entity!, "build audit test/start");
    const text = conn1.lastText();
    expect(text).toContain("Source History");
    expect(text).toContain("v1");
    expect(text).toContain("v2");
    expect(text).toContain("Builder");
  });

  it("requires architect rank for code command", () => {
    engine.processCommand(
      conn1.entity!,
      'build code test/start export default { short: "X", long: "Y" }',
    );
    expect(conn1.lastText()).toContain("architect (rank 5)");
  });

  it("validates room source via validate command", () => {
    const entity = engine.entities.get(conn1.entity!)!;
    setRank(entity, 5); // architect

    // First save some valid source
    db.saveRoomSource({
      roomId: "test/start",
      source: 'export default { short: "Valid", long: "Valid room" };',
      authorId: conn1.entity!,
      authorName: "Builder",
    });

    engine.processCommand(conn1.entity!, "build validate test/start");
    expect(conn1.lastText()).toContain("valid");
  });

  it("requires architect rank for destroy", () => {
    engine.processCommand(conn1.entity!, "build destroy test/north");
    expect(conn1.lastText()).toContain("architect (rank 5)");
  });

  it("refuses to destroy occupied room", () => {
    const entity = engine.entities.get(conn1.entity!)!;
    setRank(entity, 5);

    engine.processCommand(conn1.entity!, "build destroy test/start");
    expect(conn1.lastText()).toContain("entities are inside");
  });

  it("destroys empty room", () => {
    const entity = engine.entities.get(conn1.entity!)!;
    setRank(entity, 5);

    // First save source for test/north
    db.saveRoomSource({
      roomId: "test/north",
      source: 'export default { short: "North", long: "North room" };',
      authorId: conn1.entity!,
      authorName: "Builder",
    });

    engine.processCommand(conn1.entity!, "build destroy test/north");
    expect(conn1.lastText()).toContain("Destroyed room");

    // Source should be deleted
    expect(db.getRoomSource("test/north")).toBeUndefined();
  });

  it("adds items to a room", () => {
    engine.processCommand(conn1.entity!, "build modify item table A sturdy table");
    expect(conn1.lastText()).toContain("Modified item");

    const room = engine.rooms.get(roomId("test/start"));
    expect(room!.module.items?.table).toBe("A sturdy table");
  });
});

describe("Building System - Templates", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn1: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({
        short: "Starting Room",
        long: "The starting room.",
        exits: {},
        items: { table: "A table." },
      }),
    );

    conn1 = new MockConnection("c1");
    engine.addConnection(conn1);
    engine.spawnEntity("c1", "Architect");
    conn1.clear();

    const entity = engine.entities.get(conn1.entity!)!;
    setRank(entity, 4);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("saves a template from a live room", () => {
    engine.processCommand(conn1.entity!, "build template save test/start tavern A tavern template");
    expect(conn1.lastText()).toContain('Saved template "tavern"');

    const template = db.getRoomTemplate("tavern");
    expect(template).toBeDefined();
    expect(template!.description).toBe("A tavern template");
  });

  it("lists templates", () => {
    db.saveRoomTemplate({
      name: "basic",
      source: 'export default { short: "Basic", long: "A basic room" };',
      authorId: conn1.entity!,
      authorName: "Architect",
      description: "Basic room",
    });
    db.saveRoomTemplate({
      name: "shop",
      source: 'export default { short: "Shop", long: "A shop" };',
      authorId: conn1.entity!,
      authorName: "Architect",
      description: "Shop room",
    });

    engine.processCommand(conn1.entity!, "build template list");
    const text = conn1.lastText();
    expect(text).toContain("basic");
    expect(text).toContain("shop");
    expect(text).toContain("Room Templates");
  });

  it("applies a template to create new room", async () => {
    // Save a valid template
    db.saveRoomTemplate({
      name: "basic",
      source: 'export default { short: "Basic Room", long: "A basic room." };',
      authorId: conn1.entity!,
      authorName: "Architect",
    });

    engine.processCommand(conn1.entity!, "build template apply basic test/applied");

    // Need a small delay for async compilation
    await Bun.sleep(100);

    const text = conn1.lastText();
    expect(text).toContain("Applied template");

    const room = engine.rooms.get(roomId("test/applied"));
    expect(room).toBeDefined();
    expect(room!.module.short).toBe("Basic Room");
  });

  it("rejects applying to existing room", () => {
    db.saveRoomTemplate({
      name: "basic",
      source: 'export default { short: "Basic", long: "A basic room" };',
      authorId: conn1.entity!,
      authorName: "Architect",
    });

    engine.processCommand(conn1.entity!, "build template apply basic test/start");
    expect(conn1.lastText()).toContain("already exists");
  });
});

describe("Building System - DB Persistence", () => {
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("room_sources table has correct schema (migration 6)", () => {
    const version = db.saveRoomSource({
      roomId: "test/room",
      source: "export default { short: 'Test', long: 'Test room' };",
      authorId: "e_1",
      authorName: "Admin",
      valid: true,
    });
    expect(version).toBe(1);

    const source = db.getRoomSource("test/room");
    expect(source).toBeDefined();
    expect(source!.room_id).toBe("test/room");
    expect(source!.version).toBe(1);
    expect(source!.valid).toBe(1);
  });

  it("auto-increments room source version", () => {
    db.saveRoomSource({
      roomId: "test/room",
      source: "v1",
      authorId: "e_1",
      authorName: "Admin",
    });
    db.saveRoomSource({
      roomId: "test/room",
      source: "v2",
      authorId: "e_1",
      authorName: "Admin",
    });
    const v3 = db.saveRoomSource({
      roomId: "test/room",
      source: "v3",
      authorId: "e_1",
      authorName: "Admin",
    });
    expect(v3).toBe(3);

    const latest = db.getRoomSource("test/room");
    expect(latest!.source).toBe("v3");
    expect(latest!.version).toBe(3);
  });

  it("retrieves specific version", () => {
    db.saveRoomSource({
      roomId: "test/room",
      source: "version-1",
      authorId: "e_1",
      authorName: "Admin",
    });
    db.saveRoomSource({
      roomId: "test/room",
      source: "version-2",
      authorId: "e_1",
      authorName: "Admin",
    });

    const v1 = db.getRoomSource("test/room", 1);
    expect(v1!.source).toBe("version-1");

    const v2 = db.getRoomSource("test/room", 2);
    expect(v2!.source).toBe("version-2");
  });

  it("lists room source history", () => {
    for (let i = 0; i < 5; i++) {
      db.saveRoomSource({
        roomId: "test/room",
        source: `v${i + 1}`,
        authorId: "e_1",
        authorName: "Admin",
      });
    }

    const history = db.getRoomSourceHistory("test/room");
    expect(history).toHaveLength(5);
    expect(history[0]!.version).toBe(5); // newest first
    expect(history[4]!.version).toBe(1);
  });

  it("gets all room source IDs", () => {
    db.saveRoomSource({
      roomId: "room/a",
      source: "a",
      authorId: "e_1",
      authorName: "Admin",
    });
    db.saveRoomSource({
      roomId: "room/b",
      source: "b",
      authorId: "e_1",
      authorName: "Admin",
    });

    const ids = db.getAllRoomSourceIds();
    expect(ids).toContain("room/a");
    expect(ids).toContain("room/b");
  });

  it("marks source as valid", () => {
    db.saveRoomSource({
      roomId: "test/room",
      source: "test",
      authorId: "e_1",
      authorName: "Admin",
    });

    let source = db.getRoomSource("test/room");
    expect(source!.valid).toBe(0);

    db.markRoomSourceValid("test/room", 1);
    source = db.getRoomSource("test/room");
    expect(source!.valid).toBe(1);
  });

  it("deletes all room sources", () => {
    db.saveRoomSource({
      roomId: "test/room",
      source: "v1",
      authorId: "e_1",
      authorName: "Admin",
    });
    db.saveRoomSource({
      roomId: "test/room",
      source: "v2",
      authorId: "e_1",
      authorName: "Admin",
    });

    db.deleteRoomSources("test/room");
    expect(db.getRoomSource("test/room")).toBeUndefined();
  });

  it("room_templates CRUD", () => {
    db.saveRoomTemplate({
      name: "tavern",
      source: "export default { short: 'Tavern', long: 'A cozy tavern' };",
      authorId: "e_1",
      authorName: "Admin",
      description: "Standard tavern",
    });

    const template = db.getRoomTemplate("tavern");
    expect(template).toBeDefined();
    expect(template!.name).toBe("tavern");
    expect(template!.description).toBe("Standard tavern");

    const all = db.getAllRoomTemplates();
    expect(all.length).toBeGreaterThanOrEqual(1);

    db.deleteRoomTemplate("tavern");
    expect(db.getRoomTemplate("tavern")).toBeUndefined();
  });
});
