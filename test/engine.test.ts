// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom, stripAnsi } from "./helpers";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Engine", () => {
  let engine: Engine;
  let conn: MockConnection;

  beforeEach(() => {
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });

    // Register two connected rooms
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({
        short: "Starting Room",
        long: "You are in the starting room. It hums with potential.",
        items: { wall: "A smooth metallic wall." },
        exits: { north: roomId("test/north") },
      }),
    );

    engine.registerRoom(
      roomId("test/north"),
      makeTestRoom({
        short: "Northern Room",
        long: "A room to the north. Cool air flows here.",
        exits: { south: roomId("test/start") },
      }),
    );

    conn = new MockConnection("c1");
    engine.addConnection(conn);
  });

  describe("connection & spawn", () => {
    it("should spawn entity and assign to connection", () => {
      const entity = engine.spawnEntity("c1", "TestAgent");
      expect(entity).toBeDefined();
      expect(entity?.name).toBe("TestAgent");
      expect(entity?.room).toBe(roomId("test/start"));
      expect(conn.entity).toBe(entity!.id);
    });
  });

  describe("look command", () => {
    it("should show room description", () => {
      const entity = engine.spawnEntity("c1", "TestAgent")!;
      conn.clear();
      engine.processCommand(entity.id, "look");
      const text = conn.lastText();
      expect(text).toContain("Starting Room");
      expect(text).toContain("hums with potential");
      expect(text).toContain("north");
    });

    it("should examine room items", () => {
      const entity = engine.spawnEntity("c1", "TestAgent")!;
      conn.clear();
      engine.processCommand(entity.id, "look wall");
      expect(conn.lastText()).toContain("smooth metallic wall");
    });
  });

  describe("movement", () => {
    it("should move between rooms", () => {
      const entity = engine.spawnEntity("c1", "TestAgent")!;
      conn.clear();
      engine.processCommand(entity.id, "north");
      // After moving north, we get auto-look of northern room
      const text = conn.allTextJoined();
      expect(text).toContain("Northern Room");
      expect(entity.room).toBe(roomId("test/north"));
    });

    it("should reject invalid directions", () => {
      const entity = engine.spawnEntity("c1", "TestAgent")!;
      conn.clear();
      engine.processCommand(entity.id, "west");
      expect(conn.lastText()).toContain("can't go that way");
    });

    it("should handle shorthand directions", () => {
      const entity = engine.spawnEntity("c1", "TestAgent")!;
      conn.clear();
      engine.processCommand(entity.id, "n");
      expect(entity.room).toBe(roomId("test/north"));
    });
  });

  describe("say command", () => {
    it("should echo back to speaker", () => {
      const entity = engine.spawnEntity("c1", "TestAgent")!;
      conn.clear();
      engine.processCommand(entity.id, "say hello world");
      expect(stripAnsi(conn.lastText())).toContain("You say: hello world");
      expect(conn.messages[conn.messages.length - 1]!.tag).toBe("say");
    });

    it("should broadcast to others in room", () => {
      const entity1 = engine.spawnEntity("c1", "Agent1")!;

      const conn2 = new MockConnection("c2");
      engine.addConnection(conn2);
      const _entity2 = engine.spawnEntity("c2", "Agent2")!;

      conn2.clear();
      engine.processCommand(entity1.id, "say hi there");
      expect(stripAnsi(conn2.lastText())).toContain("Agent1 says: hi there");
      expect(conn2.messages[conn2.messages.length - 1]!.tag).toBe("say");
    });
  });

  describe("tell command", () => {
    it("should send private message", () => {
      engine.spawnEntity("c1", "Agent1")!;

      const conn2 = new MockConnection("c2");
      engine.addConnection(conn2);
      engine.spawnEntity("c2", "Agent2")!;

      conn.clear();
      conn2.clear();

      engine.processCommand(conn.entity!, "tell Agent2 secret message");
      expect(stripAnsi(conn.lastText())).toContain("You tell Agent2: secret message");
      expect(stripAnsi(conn2.lastText())).toContain("Agent1 tells you: secret message");
      expect(conn.messages[conn.messages.length - 1]!.tag).toBe("tell");
      expect(conn2.messages[conn2.messages.length - 1]!.tag).toBe("tell");
    });
  });

  describe("who command", () => {
    it("should list online agents", () => {
      engine.spawnEntity("c1", "Agent1")!;

      const conn2 = new MockConnection("c2");
      engine.addConnection(conn2);
      engine.spawnEntity("c2", "Agent2")!;

      conn.clear();
      engine.processCommand(conn.entity!, "who");
      const text = conn.lastText();
      expect(text).toContain("Agent1");
      expect(text).toContain("Agent2");
      expect(text).toContain("2");
    });
  });

  describe("help command", () => {
    it("should list all commands", () => {
      const entity = engine.spawnEntity("c1", "TestAgent")!;
      conn.clear();
      engine.processCommand(entity.id, "help");
      const text = conn.lastText();
      expect(text).toContain("look");
      expect(text).toContain("say");
      expect(text).toContain("move");
    });

    it("should show specific command help", () => {
      const entity = engine.spawnEntity("c1", "TestAgent")!;
      conn.clear();
      engine.processCommand(entity.id, "help look");
      expect(conn.lastText()).toContain("look");
    });
  });

  describe("unknown command", () => {
    it("should show error for unknown commands", () => {
      const entity = engine.spawnEntity("c1", "TestAgent")!;
      conn.clear();
      engine.processCommand(entity.id, "xyzzy");
      expect(conn.lastText()).toContain("Unknown command");
    });
  });

  describe("tick loop", () => {
    it("should process queued commands on tick", async () => {
      const shortTickEngine = new Engine({ startRoom: roomId("test/start"), tickInterval: 20 });
      shortTickEngine.registerRoom(
        roomId("test/start"),
        makeTestRoom({
          short: "Starting Room",
          long: "You are in the starting room.",
        }),
      );
      const tickConn = new MockConnection("tc1");
      shortTickEngine.addConnection(tickConn);
      const entity = shortTickEngine.spawnEntity("tc1", "TickAgent")!;
      tickConn.clear();

      shortTickEngine.queueCommand(entity.id, "look");
      shortTickEngine.start();
      await Bun.sleep(50);
      shortTickEngine.stop();

      expect(tickConn.messages.length).toBeGreaterThan(0);
    });
  });

  describe("room custom commands", () => {
    it("should execute room-specific commands", () => {
      engine.registerRoom(
        roomId("test/custom"),
        makeTestRoom({
          short: "Custom Room",
          long: "A room with a custom command.",
          commands: {
            hack: (ctx, input) => {
              ctx.send(input.entity, "You hack the mainframe. Access granted.");
            },
          },
        }),
      );

      const entity = engine.spawnEntity("c1", "TestAgent")!;
      engine.entities.move(entity.id, roomId("test/custom"));
      conn.clear();

      engine.processCommand(entity.id, "hack");
      expect(conn.lastText()).toContain("Access granted");
    });
  });

  describe("actionable event notices", () => {
    it("routes pending canvas intents to running agents as message perceptions", () => {
      const alice = engine.spawnEntity("c1", "Alice")!;
      const bobConn = new MockConnection("c2");
      engine.addConnection(bobConn);
      const bob = engine.spawnEntity("c2", "Bob")!;
      bobConn.clear();

      (engine.agentRuntime as unknown as { list: () => unknown[] }).list = () => [
        {
          name: "Bob",
          entityId: bob.id,
          state: "idle",
          model: "test",
          role: "",
          focus: null,
          goal: null,
          uptime: 0,
          toolCalls: 0,
          errors: 0,
        },
      ];

      engine.logEvent({
        type: "canvas_intent",
        entity: alice.id,
        canvasId: "canvas-1",
        nodeId: "node-intent-1",
        prompt: "Inspect this dataset.",
        status: "pending",
        timestamp: Date.now(),
      });

      const text = stripAnsi(bobConn.lastText());
      expect(text).toContain("Pending canvas intent");
      expect(text).toContain("canvas intent claim node-int");
    });
  });

  describe("disconnect", () => {
    it("unbinds connection immediately and defers entity removal for reconnect grace", () => {
      const entity = engine.spawnEntity("c1", "TestAgent")!;
      expect(engine.entities.get(entity.id)).toBeDefined();

      engine.removeConnection("c1");
      // Connection is gone immediately so peers see the departure; entity
      // lingers for RECONNECT_GRACE_MS so a token-bearing reconnect can
      // reclaim the same EntityId. Eviction is verified by the unit test
      // for the timer path; here we just confirm the connection unbind.
      expect(engine.getConnections().has("c1")).toBe(false);
    });
  });
});
