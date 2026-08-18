// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId, RoomId } from "../src/types";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

// ─── Ignore Command ─────────────────────────────────────────────────────────

describe("Ignore Command", () => {
  let engine: Engine;
  let conn1: MockConnection;
  let conn2: MockConnection;
  let conn3: MockConnection;
  let e1: EntityId;
  let e2: EntityId;
  let e3: EntityId;

  beforeEach(() => {
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({ exits: { north: "test/other" as RoomId } }),
    );
    engine.registerRoom(roomId("test/other") as RoomId, makeTestRoom());
    conn1 = new MockConnection("c1");
    conn2 = new MockConnection("c2");
    conn3 = new MockConnection("c3");
    engine.addConnection(conn1);
    engine.addConnection(conn2);
    engine.addConnection(conn3);
    const r1 = engine.login("c1", "Alice");
    const r2 = engine.login("c2", "Bob");
    const r3 = engine.login("c3", "Charlie");
    if ("entityId" in r1) e1 = r1.entityId;
    if ("entityId" in r2) e2 = r2.entityId;
    if ("entityId" in r3) e3 = r3.entityId;
    conn1.clear();
    conn2.clear();
    conn3.clear();
  });

  it("adds a player to ignore list", () => {
    engine.processCommand(e1, "ignore Bob");
    expect(stripAnsi(conn1.lastText())).toContain("Now ignoring Bob");
  });

  it("shows empty ignore list", () => {
    engine.processCommand(e1, "ignore list");
    expect(conn1.lastText()).toContain("not ignoring anyone");
  });

  it("shows populated ignore list", () => {
    engine.processCommand(e1, "ignore Bob");
    conn1.clear();
    engine.processCommand(e1, "ignore list");
    expect(conn1.lastText()).toContain("Bob");
  });

  it("removes from ignore list", () => {
    engine.processCommand(e1, "ignore Bob");
    conn1.clear();
    engine.processCommand(e1, "ignore remove Bob");
    expect(stripAnsi(conn1.lastText())).toContain("No longer ignoring Bob");
  });

  it("reports already ignored", () => {
    engine.processCommand(e1, "ignore Bob");
    conn1.clear();
    engine.processCommand(e1, "ignore Bob");
    expect(conn1.lastText()).toContain("already ignoring Bob");
  });

  it("prevents ignoring yourself", () => {
    engine.processCommand(e1, "ignore Alice");
    expect(conn1.lastText()).toContain("cannot ignore yourself");
  });

  it("reports unknown player", () => {
    engine.processCommand(e1, "ignore Nobody");
    expect(conn1.lastText()).toContain("found");
  });

  it("shows usage with no arguments", () => {
    engine.processCommand(e1, "ignore");
    expect(conn1.lastText()).toContain("Usage:");
  });

  it("blocks say messages from ignored player", () => {
    engine.processCommand(e1, "ignore Bob");
    conn1.clear();
    engine.processCommand(e2, "say Hello everyone!");
    // Alice should NOT see Bob's message
    expect(conn1.messages.length).toBe(0);
    // Charlie should still see it
    expect(stripAnsi(conn3.lastText())).toContain("Bob says:");
  });

  it("blocks shout messages from ignored player", () => {
    // Move Charlie to another room
    engine.processCommand(e3, "north");
    conn1.clear();
    conn3.clear();

    engine.processCommand(e1, "ignore Bob");
    conn1.clear();
    engine.processCommand(e2, "shout Hey everyone!");
    // Alice ignores Bob, should not see it
    expect(conn1.messages.length).toBe(0);
    // Charlie does not ignore Bob, should see it
    expect(conn3.lastText()).toContain("Bob shouts:");
  });

  it("blocks tell messages from ignored player", () => {
    engine.processCommand(e1, "ignore Bob");
    conn1.clear();
    engine.processCommand(e2, "tell Alice Secret message");
    // Alice should NOT see Bob's tell
    expect(conn1.messages.length).toBe(0);
    // Bob still sees their own confirmation
    expect(stripAnsi(conn2.lastText())).toContain("You tell Alice:");
  });

  it("blocks emote messages from ignored player", () => {
    engine.processCommand(e1, "ignore Bob");
    conn1.clear();
    engine.processCommand(e2, "emote dances around");
    // Alice should NOT see Bob's emote
    expect(conn1.messages.length).toBe(0);
    // Charlie should still see it
    expect(conn3.lastText()).toContain("Bob dances around");
  });

  it("works with block alias", () => {
    engine.processCommand(e1, "block Bob");
    expect(stripAnsi(conn1.lastText())).toContain("Now ignoring Bob");
  });
});

// ─── Shout Command ──────────────────────────────────────────────────────────

describe("Shout Command", () => {
  let engine: Engine;
  let conn1: MockConnection;
  let conn2: MockConnection;
  let conn3: MockConnection;
  let e1: EntityId;
  let _e2: EntityId;

  beforeEach(() => {
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({ exits: { north: "test/other" as RoomId } }),
    );
    engine.registerRoom(roomId("test/other") as RoomId, makeTestRoom());
    conn1 = new MockConnection("c1");
    conn2 = new MockConnection("c2");
    conn3 = new MockConnection("c3");
    engine.addConnection(conn1);
    engine.addConnection(conn2);
    engine.addConnection(conn3);
    const r1 = engine.login("c1", "Alice");
    const r2 = engine.login("c2", "Bob");
    const r3 = engine.login("c3", "Charlie");
    if ("entityId" in r1) e1 = r1.entityId;
    if ("entityId" in r2) _e2 = r2.entityId;
    // Move Charlie to a different room
    if ("entityId" in r3) engine.processCommand(r3.entityId, "north");
    conn1.clear();
    conn2.clear();
    conn3.clear();
  });

  it("sends message to all players globally", () => {
    engine.processCommand(e1, "shout Hello world!");
    expect(conn1.lastText()).toContain("You shout: Hello world!");
    expect(conn2.lastText()).toContain("Alice shouts: Hello world!");
    // Charlie is in a different room but still receives the shout
    expect(conn3.lastText()).toContain("Alice shouts: Hello world!");
  });

  it("shows error with no message", () => {
    engine.processCommand(e1, "shout");
    expect(conn1.lastText()).toContain("Shout what?");
  });

  it("works with yell alias", () => {
    engine.processCommand(e1, "yell Fire!");
    expect(conn1.lastText()).toContain("You shout: Fire!");
    expect(conn2.lastText()).toContain("Alice shouts: Fire!");
  });

  it("does not echo back to the shouter via broadcast", () => {
    engine.processCommand(e1, "shout Testing");
    // Sender should only get "You shout:", not "Alice shouts:"
    const aliceTexts = conn1.allText();
    expect(aliceTexts.some((t) => t.includes("You shout:"))).toBe(true);
    expect(aliceTexts.some((t) => t.includes("Alice shouts:"))).toBe(false);
  });
});

// ─── Emote Command ───────────────────────────────────────────────────────────

describe("Emote Command", () => {
  let engine: Engine;
  let conn1: MockConnection;
  let conn2: MockConnection;

  beforeEach(() => {
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    conn1 = new MockConnection("c1");
    conn2 = new MockConnection("c2");
    engine.addConnection(conn1);
    engine.addConnection(conn2);
    engine.login("c1", "Alice");
    engine.login("c2", "Bob");
    conn1.clear();
    conn2.clear();
  });

  it("should broadcast emote to room", () => {
    engine.processCommand(conn1.entity!, "emote waves cheerfully");
    expect(conn1.lastText()).toContain("Alice waves cheerfully");
    expect(conn2.lastText()).toContain("Alice waves cheerfully");
  });

  it("should require emote text", () => {
    engine.processCommand(conn1.entity!, "emote");
    expect(conn1.lastText()).toContain("what");
  });

  it("should work with me alias", () => {
    engine.processCommand(conn1.entity!, "me dances");
    expect(conn1.lastText()).toContain("Alice dances");
  });
});

// ─── Score Command ───────────────────────────────────────────────────────────

describe("Score Command", () => {
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Starting Room" }));
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.login("c1", "Tester");
    conn.clear();
  });

  it("should show player score", () => {
    engine.processCommand(conn.entity!, "score");
    const text = conn.lastText();
    expect(text).toContain("Tester");
    expect(text).toContain("Newcomer");
  });

  it("should work with stats alias", () => {
    engine.processCommand(conn.entity!, "stats");
    expect(conn.lastText()).toContain("Tester");
  });
});

// ─── Item System (get/drop/give) ─────────────────────────────────────────────

describe("Item System", () => {
  let engine: Engine;
  let conn1: MockConnection;
  let conn2: MockConnection;
  let itemId: EntityId;

  beforeEach(() => {
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    conn1 = new MockConnection("c1");
    conn2 = new MockConnection("c2");
    engine.addConnection(conn1);
    engine.addConnection(conn2);
    engine.login("c1", "Alice");
    engine.login("c2", "Bob");

    // Spawn an object in the room
    const item = engine.entities.create({
      name: "Crystal Key",
      short: "A glowing crystal key lies here.",
      long: "A crystal key that pulses with inner light.",
      room: roomId("test/start"),
      kind: "object",
    });
    itemId = item.id;

    conn1.clear();
    conn2.clear();
  });

  it("should pick up items with get", () => {
    engine.processCommand(conn1.entity!, "get crystal");
    expect(stripAnsi(conn1.lastText())).toContain("pick up Crystal Key");
    expect(stripAnsi(conn2.lastText())).toContain("picks up Crystal Key");

    // Item should be in inventory
    const alice = engine.entities.get(conn1.entity!);
    expect(alice?.inventory).toContain(itemId);
  });

  it("should work with take alias", () => {
    engine.processCommand(conn1.entity!, "take crystal");
    expect(stripAnsi(conn1.lastText())).toContain("pick up Crystal Key");
  });

  it("should drop items", () => {
    engine.processCommand(conn1.entity!, "get crystal");
    conn1.clear();
    conn2.clear();

    engine.processCommand(conn1.entity!, "drop crystal");
    expect(stripAnsi(conn1.lastText())).toContain("drop Crystal Key");
    expect(stripAnsi(conn2.lastText())).toContain("drops Crystal Key");

    const alice = engine.entities.get(conn1.entity!);
    expect(alice?.inventory).not.toContain(itemId);
  });

  it("should not pick up non-existent items", () => {
    engine.processCommand(conn1.entity!, "get sword");
    expect(conn1.lastText()).toContain("don't see that");
  });

  it("should not drop items you don't have", () => {
    engine.processCommand(conn1.entity!, "drop crystal");
    expect(conn1.lastText()).toContain("don't have that");
  });

  it("should give items to other players", () => {
    engine.processCommand(conn1.entity!, "get crystal");
    conn1.clear();
    conn2.clear();

    engine.processCommand(conn1.entity!, "give crystal to Bob");
    expect(stripAnsi(conn1.lastText())).toContain("give Crystal Key to Bob");
    expect(conn2.allText().some((t) => stripAnsi(t).includes("gives you Crystal Key"))).toBe(true);

    const alice = engine.entities.get(conn1.entity!);
    const bob = engine.entities.get(conn2.entity!);
    expect(alice?.inventory).not.toContain(itemId);
    expect(bob?.inventory).toContain(itemId);
  });

  it("should require give syntax", () => {
    engine.processCommand(conn1.entity!, "give crystal");
    expect(conn1.lastText()).toContain("Usage");
  });

  it("should require argument for get", () => {
    engine.processCommand(conn1.entity!, "get");
    expect(conn1.lastText()).toContain("Get what");
  });

  it("should require argument for drop", () => {
    engine.processCommand(conn1.entity!, "drop");
    expect(conn1.lastText()).toContain("Drop what");
  });
});

// ─── Map Command ─────────────────────────────────────────────────────────────

describe("Map Command", () => {
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({
        short: "Center",
        exits: {
          north: roomId("test/north"),
          south: roomId("test/south"),
          east: roomId("test/east"),
        },
      }),
    );
    engine.registerRoom(roomId("test/north"), makeTestRoom({ short: "Northern Room" }));
    engine.registerRoom(roomId("test/south"), makeTestRoom({ short: "Southern Room" }));
    engine.registerRoom(roomId("test/east"), makeTestRoom({ short: "Eastern Room" }));
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.login("c1", "Player");
    conn.clear();
  });

  it("should show nearby rooms", () => {
    engine.processCommand(conn.entity!, "map");
    const text = conn.lastText();
    expect(text).toContain("Nearby Rooms");
    expect(text).toContain("Center");
    expect(text).toContain("Northern Room");
    expect(text).toContain("Southern Room");
    expect(text).toContain("Eastern Room");
  });

  it("should handle room with no exits", () => {
    engine.registerRoom(roomId("test/isolated"), makeTestRoom({ short: "Isolated" }));
    const entity = engine.entities.get(conn.entity!);
    if (entity) entity.room = roomId("test/isolated");
    conn.clear();

    engine.processCommand(conn.entity!, "map");
    expect(conn.lastText()).toContain("No exits");
  });
});

// ─── Who Command (enriched) ──────────────────────────────────────────────────

describe("Who Command (enriched)", () => {
  let engine: Engine;
  let conn1: MockConnection;
  let conn2: MockConnection;

  beforeEach(() => {
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Hub" }));
    conn1 = new MockConnection("c1");
    conn2 = new MockConnection("c2");
    engine.addConnection(conn1);
    engine.addConnection(conn2);
    engine.login("c1", "Admin");
    engine.login("c2", "Player");

    // Set admin rank
    const admin = engine.entities.get(conn1.entity!);
    if (admin) admin.properties.rank = 4;

    conn1.clear();
  });

  it("should show all online players", () => {
    engine.processCommand(conn1.entity!, "who");
    const text = conn1.lastText();
    expect(text).toContain("Admin");
    expect(text).toContain("Player");
    expect(text).toContain("Online");
  });

  it("should show rank names", () => {
    engine.processCommand(conn1.entity!, "who");
    const text = conn1.lastText();
    expect(text).toContain("Admin");
  });

  it("should show room location", () => {
    engine.processCommand(conn1.entity!, "who");
    const text = conn1.lastText();
    expect(text).toContain("Hub");
  });
});

// ─── Help Command (categorized) ──────────────────────────────────────────────

describe("Help Command (categorized)", () => {
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.login("c1", "Player");
    conn.clear();
  });

  it("should group commands by category", () => {
    engine.processCommand(conn.entity!, "help");
    const text = conn.lastText();
    expect(text).toContain("Navigation");
    expect(text).toContain("Communication");
    expect(text).toContain("Objects");
    expect(text).toContain("Information");
  });

  it("should show category in help detail", () => {
    engine.processCommand(conn.entity!, "help say");
    const text = conn.lastText();
    expect(text).toContain("say");
    expect(text).toContain("Category: Communication");
  });

  it("should show aliases in muted color", () => {
    engine.processCommand(conn.entity!, "help look");
    const text = conn.lastText();
    expect(text).toContain("aliases:");
  });

  it("should work with ? alias", () => {
    engine.processCommand(conn.entity!, "?");
    const text = conn.lastText();
    expect(text).toContain("Available Commands");
  });
});

// ─── Time Command ───────────────────────────────────────────────────────────

describe("Time Command", () => {
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.login("c1", "Player");
    conn.clear();
  });

  it("should show server time", () => {
    engine.processCommand(conn.entity!, "time");
    const text = conn.lastText();
    expect(text).toContain("Server Time");
    // Should contain a GMT/UTC reference
    expect(text).toContain("GMT");
  });

  it("should work with date alias", () => {
    engine.processCommand(conn.entity!, "date");
    expect(conn.lastText()).toContain("Server Time");
  });
});

// ─── Uptime Command ─────────────────────────────────────────────────────────

describe("Uptime Command", () => {
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.login("c1", "Player");
    conn.clear();
  });

  it("should show server uptime", () => {
    engine.processCommand(conn.entity!, "uptime");
    const text = conn.lastText();
    expect(text).toContain("Server Uptime");
    expect(text).toContain("s");
  });
});

// ─── Macro Cycle Detection ──────────────────────────────────────────────────

describe("Macro Cycle Detection", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  const dbPath = `/tmp/marina-macro-cycle-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.login("c1", "Tester");
    conn.clear();
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("should create and run a macro by name (direct dispatch)", () => {
    engine.processCommand(conn.entity!, "macro create greet say hello");
    conn.clear();
    engine.processCommand(conn.entity!, "greet");
    const allTexts = conn.allText();
    expect(allTexts.some((t) => t.includes("hello"))).toBe(true);
  });
});

// ─── Semantic Grid Room Connections ──────────────────────────────────────────

import auditRoom from "../worlds/default/audit/room";
import hubCrossroads from "../worlds/default/hub/crossroads";
import observatory from "../worlds/default/observatory";

describe("Semantic Grid World Connections", () => {
  it("hub/crossroads should connect to all adjacent rooms", () => {
    expect(hubCrossroads.exits?.north as string).toBe("knowledge/hub");
    expect(hubCrossroads.exits?.south as string).toBe("coord/center");
    expect(hubCrossroads.exits?.east as string).toBe("markets/floor");
    expect(hubCrossroads.exits?.west as string).toBe("craft/studio");
  });

  it("observatory (corner 0,0) should only have south and east exits", () => {
    expect(hubCrossroads.exits?.north).toBeDefined();
    expect(observatory.exits?.east as string).toBe("research/lab");
    expect(observatory.exits?.south as string).toBe("craft/forge");
    expect(observatory.exits?.north).toBeUndefined();
    expect(observatory.exits?.west).toBeUndefined();
  });

  it("audit/room (corner 4,4) should only have north and west exits", () => {
    expect(auditRoom.exits?.north as string).toBe("integration/bay");
    expect(auditRoom.exits?.west as string).toBe("memory/vault");
    expect(auditRoom.exits?.south).toBeUndefined();
    expect(auditRoom.exits?.east).toBeUndefined();
  });
});
