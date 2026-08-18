// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId } from "../src/types";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

describe("RoomContext: NPC spawning", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  const dbPath = `/tmp/marina-roomctx-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));

    // Room that spawns an NPC on enter
    engine.registerRoom(
      roomId("test/npc_room"),
      makeTestRoom({
        short: "NPC Room",
        exits: { south: roomId("test/start") },
        onEnter(ctx, _entity) {
          if (!ctx.store.get("npc_spawned")) {
            const npcId = ctx.spawn({
              name: "TestNPC",
              short: "A test NPC is here.",
              long: "A test NPC for testing purposes.",
            });
            ctx.store.set("npc_spawned", true);
            ctx.store.set("npc_id", npcId);
          }
        },
      }),
    );

    // Link start to npc_room
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({
        short: "Start",
        exits: { north: roomId("test/npc_room") },
      }),
    );

    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Tester");
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("should spawn NPC via RoomContext.spawn()", () => {
    // Move to NPC room
    engine.processCommand(conn.entity!, "north");
    conn.clear();

    // Look should show the NPC
    engine.processCommand(conn.entity!, "look");
    const text = conn.lastText();
    expect(text).toContain("TestNPC");
  });

  it("should show NPC in entity list", () => {
    engine.processCommand(conn.entity!, "north");
    const npcs = engine.entities.inRoom(roomId("test/npc_room")).filter((e) => e.kind === "npc");
    expect(npcs.length).toBe(1);
    expect(npcs[0]!.name).toBe("TestNPC");
    expect(npcs[0]!.kind).toBe("npc");
  });

  it("should despawn NPC via RoomContext.despawn()", () => {
    // Room with despawn command
    engine.registerRoom(
      roomId("test/despawn_room"),
      makeTestRoom({
        short: "Despawn Room",
        commands: {
          killnpc(ctx) {
            const npcId = ctx.store.get<EntityId>("npc_id");
            if (npcId) {
              ctx.despawn(npcId);
              ctx.store.delete("npc_id");
              ctx.broadcast("The NPC vanishes.");
            }
          },
        },
        onEnter(ctx) {
          if (!ctx.store.get("npc_id")) {
            const id = ctx.spawn({
              name: "Ephemeral",
              short: "A fleeting NPC.",
              long: "It shimmers uncertainly.",
            });
            ctx.store.set("npc_id", id);
          }
        },
      }),
    );

    // Re-register start with new exit
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({
        short: "Start",
        exits: {
          north: roomId("test/npc_room"),
          east: roomId("test/despawn_room"),
        },
      }),
    );

    engine.processCommand(conn.entity!, "east");
    let npcs = engine.entities.inRoom(roomId("test/despawn_room")).filter((e) => e.kind === "npc");
    expect(npcs.length).toBe(1);

    engine.processCommand(conn.entity!, "killnpc");
    npcs = engine.entities.inRoom(roomId("test/despawn_room")).filter((e) => e.kind === "npc");
    expect(npcs.length).toBe(0);
  });

  it("should not despawn non-NPC entities", () => {
    const result = engine.despawnNpc(conn.entity!);
    expect(result).toBe(false);
    // Player should still exist
    expect(engine.entities.get(conn.entity!)).toBeDefined();
  });

  it("should expose roomId in context", () => {
    let capturedRoomId: string | undefined;
    engine.registerRoom(
      roomId("test/ctx_room"),
      makeTestRoom({
        short: "Context Room",
        commands: {
          checkroom(ctx, input) {
            capturedRoomId = ctx.roomId;
            ctx.send(input.entity, `Room: ${ctx.roomId}`);
          },
        },
      }),
    );
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({
        short: "Start",
        exits: { north: roomId("test/npc_room"), west: roomId("test/ctx_room") },
      }),
    );

    engine.processCommand(conn.entity!, "west");
    engine.processCommand(conn.entity!, "checkroom");
    expect(capturedRoomId).toBe("test/ctx_room");
  });
});

describe("RoomContext: Board API", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  const dbPath = `/tmp/marina-roomctx-board-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });

    // Room with board interaction
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({
        short: "Board Room",
        commands: {
          posttest(ctx, input) {
            if (!ctx.boards) {
              ctx.send(input.entity, "No boards available.");
              return;
            }
            const board = ctx.boards.getBoard("testboard");
            if (!board) {
              ctx.send(input.entity, "Board not found.");
              return;
            }
            const postId = ctx.boards.post(
              board.id,
              input.entity,
              "Tester",
              "Test Post",
              "Hello from room code!",
            );
            ctx.send(input.entity, `Posted #${postId}`);
          },
          searchtest(ctx, input) {
            if (!ctx.boards) return;
            const board = ctx.boards.getBoard("testboard");
            if (!board) return;
            const results = ctx.boards.search(board.id, input.args || "Hello");
            ctx.send(input.entity, `Found ${results.length} results`);
          },
        },
      }),
    );

    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Tester");

    // Create a board via the board manager
    engine.boardManager!.createBoard({ name: "testboard" });
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("should allow rooms to post to boards via ctx.boards", () => {
    engine.processCommand(conn.entity!, "posttest");
    expect(conn.lastText()).toContain("Posted #");
  });

  it("should allow rooms to search boards via ctx.boards", () => {
    engine.processCommand(conn.entity!, "posttest");
    conn.clear();
    engine.processCommand(conn.entity!, "searchtest Hello");
    expect(conn.lastText()).toContain("Found 1 results");
  });
});

describe("RoomContext: Channel API", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn1: MockConnection;
  let conn2: MockConnection;
  const dbPath = `/tmp/marina-roomctx-chan-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });

    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({
        short: "Channel Room",
        commands: {
          roomsend(ctx, input) {
            if (!ctx.channels) {
              ctx.send(input.entity, "No channels available.");
              return;
            }
            const ent = ctx.getEntity(input.entity);
            ctx.channels.send("general", input.entity, ent?.name ?? "Unknown", "Hello from room!");
            ctx.send(input.entity, "Sent to channel.");
          },
        },
      }),
    );

    conn1 = new MockConnection("c1");
    conn2 = new MockConnection("c2");
    engine.addConnection(conn1);
    engine.addConnection(conn2);
    engine.spawnEntity("c1", "Alice");
    engine.spawnEntity("c2", "Bob");

    // Create a channel and add both entities
    const ch = engine.channelManager!.createChannel({ type: "global", name: "general" });
    engine.channelManager!.addMember(ch.id, conn1.entity!);
    engine.channelManager!.addMember(ch.id, conn2.entity!);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("should allow rooms to send to channels via ctx.channels", () => {
    engine.processCommand(conn1.entity!, "roomsend");
    // Alice gets confirmation
    expect(conn1.allText().some((t) => t.includes("Sent to channel"))).toBe(true);
    // Bob gets the channel message
    expect(conn2.allText().some((t) => t.includes("Hello from room!"))).toBe(true);
  });
});
