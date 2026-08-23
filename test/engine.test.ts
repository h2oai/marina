// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RateLimiter } from "../src/auth/rate-limiter";
import { Engine } from "../src/engine/engine";
import { getRank } from "../src/engine/permissions";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

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

  describe("modal routing bypass", () => {
    it("routes commands through the active modal by default", async () => {
      const entity = engine.spawnEntity("c1", "TestAgent")!;
      entity.properties.active_modal = "code";
      conn.clear();
      // Without the bypass, "look" is rewritten to "code look" — so the room
      // description must NOT appear.
      await engine.processCommand(entity.id, "look");
      expect(stripAnsi(conn.lastText())).not.toContain("Starting Room");
    });

    it("bypassModal executes engine-initiated commands untouched inside a modal", async () => {
      const entity = engine.spawnEntity("c1", "TestAgent")!;
      entity.properties.active_modal = "code";
      conn.clear();
      // "look" is registered; without the bypass it would become "code look".
      await engine.processCommand(entity.id, "look", { bypassModal: true });
      expect(stripAnsi(conn.lastText())).toContain("Starting Room");
    });

    it("sendLook and sendBrief are not captured by the code modal", async () => {
      const entity = engine.spawnEntity("c1", "TestAgent")!;
      entity.properties.active_modal = "code";
      conn.clear();
      engine.sendLook(entity.id);
      await Bun.sleep(10);
      expect(stripAnsi(conn.lastText())).toContain("Starting Room");
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

// ─── Ingress posture & identity (security findings 8, 4, MCP throttle) ────────

describe("Passwordless login rank posture", () => {
  let engine: Engine;
  let db: MarinaDB;
  let dbPath: string;
  let counter = 0;

  const addConn = (id: string, peerIp: string) => {
    const conn = new MockConnection(id);
    conn.peerIp = peerIp;
    conn.ip = peerIp;
    engine.addConnection(conn);
    return conn;
  };

  beforeEach(() => {
    dbPath = `/tmp/marina-engine-ingress-${Date.now()}-${++counter}.db`;
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "S", long: "S" }));
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("forces rank 0 on a REMOTE passwordless re-login (never inherits stored rank)", () => {
    // First login creates the user; promote them in the persisted row.
    addConn("c1", "127.0.0.1");
    const first = engine.login("c1", "Operator");
    expect("entityId" in first).toBe(true);
    const user = db.getUserByName("Operator")!;
    db.updateUserRank(user.id, 4);
    engine.removeConnection("c1");

    // A REMOTE (non-loopback) passwordless name-login must NOT restore rank 4.
    addConn("c2", "203.0.113.9");
    const second = engine.login("c2", "Operator");
    expect("entityId" in second).toBe(true);
    if ("entityId" in second) {
      expect(getRank(engine.entities.get(second.entityId)!)).toBe(0);
    }
  });

  it("restores stored rank for a genuine LOCAL (loopback) passwordless re-login", () => {
    addConn("c1", "127.0.0.1");
    const first = engine.login("c1", "LocalOp");
    expect("entityId" in first).toBe(true);
    const user = db.getUserByName("LocalOp")!;
    db.updateUserRank(user.id, 4);
    engine.removeConnection("c1");

    addConn("c2", "127.0.0.1");
    const second = engine.login("c2", "LocalOp");
    expect("entityId" in second).toBe(true);
    if ("entityId" in second) {
      expect(getRank(engine.entities.get(second.entityId)!)).toBe(4);
    }
  });

  it("does NOT restore elevated rank from a REMOTE passwordless-minted token", () => {
    // Operator has an elevated persisted rank (e.g. promoted earlier by an admin).
    addConn("c0", "127.0.0.1");
    const bootstrap = engine.login("c0", "Operator");
    expect("entityId" in bootstrap).toBe(true);
    const user = db.getUserByName("Operator")!;
    db.updateUserRank(user.id, 4);
    engine.removeConnection("c0");

    // A REMOTE passwordless login is capped at rank 0 but still mints a token…
    addConn("c1", "203.0.113.9");
    const remote = engine.login("c1", "Operator");
    if (!("token" in remote)) throw new Error("expected token");
    expect(getRank(engine.entities.get(remote.entityId)!)).toBe(0);
    engine.removeConnection("c1");

    // …and reconnecting with that token must NOT launder the cap into rank 4.
    addConn("c2", "203.0.113.9");
    const recon = engine.reconnect("c2", remote.token);
    expect("entityId" in recon).toBe(true);
    if ("entityId" in recon) {
      expect(getRank(engine.entities.get(recon.entityId)!)).toBe(0);
    }
  });

  it("restores stored rank from a LOOPBACK-minted token even on a remote reconnect", () => {
    addConn("c0", "127.0.0.1");
    const bootstrap = engine.login("c0", "LocalOp");
    expect("entityId" in bootstrap).toBe(true);
    const user = db.getUserByName("LocalOp")!;
    db.updateUserRank(user.id, 3);
    engine.removeConnection("c0");

    // A genuine loopback login restores rank 3 and mints a token carrying that grant.
    addConn("c1", "127.0.0.1");
    const local = engine.login("c1", "LocalOp");
    if (!("token" in local)) throw new Error("expected token");
    expect(getRank(engine.entities.get(local.entityId)!)).toBe(3);
    engine.removeConnection("c1");

    // Reconnect from a remote peer with the loopback-minted token → rank restored,
    // capped at the granted rank the token carries.
    addConn("c2", "203.0.113.9");
    const recon = engine.reconnect("c2", local.token);
    expect("entityId" in recon).toBe(true);
    if ("entityId" in recon) {
      expect(getRank(engine.entities.get(recon.entityId)!)).toBe(3);
    }
  });

  it("restores stored rank when the RECONNECTING connection is a loopback anchor", () => {
    addConn("c0", "127.0.0.1");
    const bootstrap = engine.login("c0", "DeskOp");
    expect("entityId" in bootstrap).toBe(true);
    const user = db.getUserByName("DeskOp")!;
    db.updateUserRank(user.id, 4);
    engine.removeConnection("c0");

    // Remote login → rank-0 token (grantedRank 0).
    addConn("c1", "203.0.113.9");
    const remote = engine.login("c1", "DeskOp");
    if (!("token" in remote)) throw new Error("expected token");
    engine.removeConnection("c1");

    // The desktop operator reconnects over loopback → identity re-established by
    // the trusted anchor, so full rank is restored regardless of the token's grant.
    addConn("c2", "127.0.0.1");
    const recon = engine.reconnect("c2", remote.token);
    expect("entityId" in recon).toBe(true);
    if ("entityId" in recon) {
      expect(getRank(engine.entities.get(recon.entityId)!)).toBe(4);
    }
  });
});

describe("MARINA_ADMINS name-promotion posture", () => {
  let engine: Engine;
  let db: MarinaDB;
  let dbPath: string;
  let counter = 0;
  let prevAdmins: string | undefined;

  const addConn = (id: string, peerIp: string) => {
    const conn = new MockConnection(id);
    conn.peerIp = peerIp;
    engine.addConnection(conn);
    return conn;
  };

  beforeEach(() => {
    prevAdmins = process.env.MARINA_ADMINS;
    process.env.MARINA_ADMINS = "Root";
    dbPath = `/tmp/marina-engine-admins-${Date.now()}-${++counter}.db`;
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "S", long: "S" }));
  });

  afterEach(() => {
    if (prevAdmins === undefined) delete process.env.MARINA_ADMINS;
    else process.env.MARINA_ADMINS = prevAdmins;
    db.close();
    cleanupDb(dbPath);
  });

  it("refuses name-based sovereign promotion for a REMOTE connection", () => {
    addConn("c1", "203.0.113.9");
    const result = engine.login("c1", "Root");
    expect("entityId" in result).toBe(true);
    if ("entityId" in result) {
      expect(getRank(engine.entities.get(result.entityId)!)).toBe(0);
    }
  });

  it("honors name-based promotion for a genuine LOCAL (loopback) operator", () => {
    addConn("c1", "127.0.0.1");
    const result = engine.login("c1", "Root");
    expect("entityId" in result).toBe(true);
    if ("entityId" in result) {
      expect(getRank(engine.entities.get(result.entityId)!)).toBe(9);
    }
  });
});

describe("Login-attempt throttle keys per peer IP (MCP bypass fix)", () => {
  let engine: Engine;
  let db: MarinaDB;
  let dbPath: string;
  let counter = 0;

  beforeEach(() => {
    dbPath = `/tmp/marina-engine-throttle-${Date.now()}-${++counter}.db`;
    db = new MarinaDB(dbPath);
    // One attempt per minute so the second attempt from the same peer is blocked.
    engine = new Engine({
      startRoom: roomId("test/start"),
      tickInterval: 60_000,
      db,
      loginRateLimiter: new RateLimiter({ maxTokens: 1, refillRate: 1, refillInterval: 60_000 }),
    });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "S", long: "S" }));
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("shares one throttle bucket across sessions from the same peer IP", () => {
    // Two DISTINCT connections (as MCP sessions are) that share a peer IP must
    // share a rate-limit bucket — otherwise each new session gets a fresh bucket
    // and the throttle never fires (the MCP bypass).
    const c1 = new MockConnection("mcp_1");
    c1.ip = "198.51.100.7";
    engine.addConnection(c1);
    const c2 = new MockConnection("mcp_2");
    c2.ip = "198.51.100.7";
    engine.addConnection(c2);

    const first = engine.login("mcp_1", "SessionA");
    expect("entityId" in first).toBe(true);
    const second = engine.login("mcp_2", "SessionB");
    expect("error" in second).toBe(true);
    if ("error" in second) expect(second.error).toContain("Too many login attempts");
  });
});
