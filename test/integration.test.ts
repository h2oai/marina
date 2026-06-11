import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { TelnetServer } from "../src/net/telnet-server";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import type { EntityId } from "../src/types";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_DB = "test_integration.db";

// ─── WebSocket Integration Tests ──────────────────────────────────────────────

describe("WebSocket Integration", () => {
  let engine: Engine;
  let wsServer: WebSocketServer;
  let db: MarinaDB;
  const WS_PORT = 13300;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({
      startRoom: roomId("test/start"),
      tickInterval: 60_000,
      db,
    });

    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({
        short: "Starting Room",
        long: "You are in the starting room.",
        items: { wall: "A test wall." },
        exits: { north: roomId("test/north") },
      }),
    );

    engine.registerRoom(
      roomId("test/north"),
      makeTestRoom({
        short: "Northern Room",
        long: "A room to the north.",
        exits: { south: roomId("test/start") },
      }),
    );

    wsServer = new WebSocketServer(engine, WS_PORT);
    wsServer.start();
    engine.start();
  });

  afterEach(() => {
    engine.stop();
    wsServer.stop();
    db.close();
    cleanupDb(TEST_DB);
  });

  it("should accept WebSocket connection and send welcome", async () => {
    const ws = new WebSocket(`ws://localhost:${WS_PORT}/ws`);
    const messages: string[] = [];

    await new Promise<void>((resolve) => {
      ws.onmessage = (event) => {
        messages.push(event.data as string);
        if (messages.length === 1) resolve();
      };
      ws.onerror = () => resolve();
    });

    expect(messages.length).toBeGreaterThanOrEqual(1);
    const welcome = JSON.parse(messages[0]!);
    expect(welcome.kind).toBe("system");
    expect(welcome.data.text).toContain("Welcome");

    ws.close();
    await Bun.sleep(50);
  });

  it("should login and receive room description", async () => {
    const ws = new WebSocket(`ws://localhost:${WS_PORT}/ws`);
    const messages: string[] = [];

    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "login", name: "IntegrationBot" }));
      };
      ws.onmessage = (event) => {
        messages.push(event.data as string);
        // Wait for welcome + login confirmation + room look
        if (messages.length >= 3) resolve();
      };
      setTimeout(resolve, 2000);
    });

    // Should have at least: welcome, login confirmation, room description
    expect(messages.length).toBeGreaterThanOrEqual(3);

    // Check login confirmation
    const loginMsg = JSON.parse(messages[1]!);
    expect(loginMsg.kind).toBe("system");
    expect(loginMsg.data.text).toContain("IntegrationBot");

    ws.close();
    await Bun.sleep(50);
  });

  it("should process commands via WebSocket", async () => {
    const ws = new WebSocket(`ws://localhost:${WS_PORT}/ws`);
    const messages: string[] = [];

    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "login", name: "CmdBot" }));
      };
      ws.onmessage = (event) => {
        messages.push(event.data as string);
        if (messages.length >= 4) {
          // Now send a command (after system + look + brief messages)
          ws.send(JSON.stringify({ type: "command", command: "who" }));
        }
        if (messages.length >= 5) resolve();
      };
      setTimeout(resolve, 2000);
    });

    expect(messages.length).toBeGreaterThanOrEqual(5);
    const whoMsg = JSON.parse(messages[messages.length - 1]!);
    expect(whoMsg.data.text).toContain("CmdBot");

    ws.close();
    await Bun.sleep(50);
  });

  it("should handle movement via WebSocket", async () => {
    const ws = new WebSocket(`ws://localhost:${WS_PORT}/ws`);
    const messages: string[] = [];

    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "login", name: "MoveBot" }));
      };
      ws.onmessage = (event) => {
        messages.push(event.data as string);
        if (messages.length === 4) {
          ws.send(JSON.stringify({ type: "command", command: "north" }));
        }
        if (messages.length >= 5) resolve();
      };
      setTimeout(resolve, 2000);
    });

    // After moving north, should receive the northern room description
    const allText = messages.map((m) => JSON.parse(m).data?.text ?? "").join("\n");
    expect(allText).toContain("Northern Room");

    ws.close();
    await Bun.sleep(50);
  });

  it("should reject commands before login", async () => {
    const ws = new WebSocket(`ws://localhost:${WS_PORT}/ws`);
    const messages: string[] = [];

    await new Promise<void>((resolve) => {
      ws.onmessage = (event) => {
        messages.push(event.data as string);
        if (messages.length === 1) {
          // Send command without login
          ws.send(JSON.stringify({ type: "command", command: "look" }));
        }
        if (messages.length >= 2) resolve();
      };
      setTimeout(resolve, 2000);
    });

    const errorMsg = JSON.parse(messages[1]!);
    expect(errorMsg.kind).toBe("error");
    expect(errorMsg.data.text).toContain("Enter your name");

    ws.close();
    await Bun.sleep(50);
  });

  it("should return health check", async () => {
    const response = await fetch(`http://localhost:${WS_PORT}/health`);
    const data = await response.json();
    expect(data.status).toBe("ok");
    expect(data.rooms).toBeGreaterThan(0);
  });
});

// ─── Telnet Integration Tests ─────────────────────────────────────────────────

describe("Telnet Integration", () => {
  let engine: Engine;
  let telnetServer: TelnetServer;
  let db: MarinaDB;
  const TELNET_PORT = 14000;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({
      startRoom: roomId("test/start"),
      tickInterval: 60_000,
      db,
    });

    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({
        short: "Starting Room",
        long: "You are in the starting room.",
      }),
    );

    telnetServer = new TelnetServer(engine, TELNET_PORT);
    telnetServer.start();
    engine.start();
  });

  afterEach(() => {
    engine.stop();
    telnetServer.stop();
    db.close();
    cleanupDb(TEST_DB);
  });

  it("should accept telnet connection and show banner", async () => {
    const socket = await Bun.connect({
      hostname: "localhost",
      port: TELNET_PORT,
      socket: {
        data(_socket, data) {
          received += new TextDecoder().decode(data);
        },
        open() {},
        close() {},
        error() {},
      },
    });

    let received = "";
    await Bun.sleep(200);

    expect(received).toContain("M A R I N A");
    expect(received).toContain("Enter your name");

    socket.end();
    await Bun.sleep(50);
  });

  it("should login and show room on telnet", async () => {
    let received = "";
    const socket = await Bun.connect({
      hostname: "localhost",
      port: TELNET_PORT,
      socket: {
        data(_socket, data) {
          received += new TextDecoder().decode(data);
        },
        open() {},
        close() {},
        error() {},
      },
    });

    await Bun.sleep(200);
    socket.write("TelnetBot\n");
    await Bun.sleep(200);

    expect(received).toContain("Welcome");
    expect(received).toContain("Starting Room");

    socket.end();
    await Bun.sleep(50);
  });

  it("should process commands on telnet", async () => {
    let received = "";
    const socket = await Bun.connect({
      hostname: "localhost",
      port: TELNET_PORT,
      socket: {
        data(_socket, data) {
          received += new TextDecoder().decode(data);
        },
        open() {},
        close() {},
        error() {},
      },
    });

    await Bun.sleep(200);
    socket.write("TelnetCmd\n");
    await Bun.sleep(200);
    socket.write("who\n");
    await Bun.sleep(200);

    expect(received).toContain("TelnetCmd");

    socket.end();
    await Bun.sleep(50);
  });
});

// ─── Persistence Integration Tests ────────────────────────────────────────────

describe("Persistence Integration", () => {
  afterEach(() => {
    cleanupDb(TEST_DB);
  });

  it("should save and restore world state across engine restarts", () => {
    // Create first engine instance, spawn entity, save
    const db1 = new MarinaDB(TEST_DB);
    const engine1 = new Engine({
      startRoom: roomId("test/start"),
      tickInterval: 60_000,
      db: db1,
    });
    engine1.registerRoom(
      roomId("test/start"),
      makeTestRoom({ short: "Start", long: "Start room." }),
    );

    // Manually create and restore an NPC entity via DB
    const testEntity = {
      id: "e_100" as EntityId,
      kind: "npc" as const,
      name: "PersistBot",
      short: "PersistBot stands here.",
      long: "A persistent bot.",
      room: roomId("test/start"),
      properties: { test: true },
      inventory: [],
      createdAt: Date.now(),
    };
    db1.saveEntity(testEntity);
    db1.setRoomStoreValue(roomId("test/start"), "counter", 42);

    // Load world state into engine
    engine1.loadWorldState();

    // Verify entity was restored
    const restored = engine1.entities.get("e_100" as EntityId);
    expect(restored).toBeDefined();
    expect(restored!.name).toBe("PersistBot");

    // Verify room store was restored
    const room = engine1.rooms.get(roomId("test/start"));
    expect(room).toBeDefined();
    expect(room!.store.get<number>("counter")).toBe(42);

    // Save world state
    engine1.saveWorldState();
    db1.close();

    // Create second engine instance and verify state persisted
    const db2 = new MarinaDB(TEST_DB);
    const engine2 = new Engine({
      startRoom: roomId("test/start"),
      tickInterval: 60_000,
      db: db2,
    });
    engine2.registerRoom(
      roomId("test/start"),
      makeTestRoom({ short: "Start", long: "Start room." }),
    );

    engine2.loadWorldState();

    const restored2 = engine2.entities.get("e_100" as EntityId);
    expect(restored2).toBeDefined();
    expect(restored2!.name).toBe("PersistBot");

    const room2 = engine2.rooms.get(roomId("test/start"));
    expect(room2!.store.get<number>("counter")).toBe(42);

    db2.close();
  });

  it("should persist events to database", () => {
    const db = new MarinaDB(TEST_DB);
    const engine = new Engine({
      startRoom: roomId("test/start"),
      tickInterval: 60_000,
      db,
    });
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({ short: "Start", long: "Start room." }),
    );

    // Process a command to generate events
    const conn = {
      id: "test_conn",
      protocol: "websocket" as const,
      entity: null as EntityId | null,
      connectedAt: Date.now(),
      send() {},
      close() {},
    };
    engine.addConnection(conn);
    engine.spawnEntity("test_conn", "EventBot");

    // Check that events were logged to DB
    const events = db.getRecentEvents(100);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "connect")).toBe(true);

    db.close();
  });
});

// ─── Session Manager Tests ────────────────────────────────────────────────────

describe("Session Manager", () => {
  // Imported inline to test
  let SessionManager: typeof import("../src/auth/session-manager").SessionManager;

  beforeAll(async () => {
    const mod = await import("../src/auth/session-manager");
    SessionManager = mod.SessionManager;
  });

  afterEach(() => {
    cleanupDb(TEST_DB);
  });

  it("should create and validate sessions", () => {
    const mgr = new SessionManager();
    const session = mgr.create("e_1" as EntityId, "TestAgent");
    expect(session.token).toBeDefined();
    expect(session.entityId).toBe("e_1" as EntityId);
    expect(session.name).toBe("TestAgent");

    const validated = mgr.validate(session.token);
    expect(validated).toBeDefined();
    expect(validated!.entityId).toBe("e_1" as EntityId);
  });

  it("should revoke sessions", () => {
    const mgr = new SessionManager();
    const session = mgr.create("e_1" as EntityId, "TestAgent");
    expect(mgr.revoke(session.token)).toBe(true);
    expect(mgr.validate(session.token)).toBeUndefined();
  });

  it("should revoke by entity", () => {
    const mgr = new SessionManager();
    mgr.create("e_1" as EntityId, "TestAgent");
    mgr.revokeByEntity("e_1" as EntityId);
    expect(mgr.getByEntity("e_1" as EntityId)).toBeUndefined();
  });

  it("should persist sessions to database", () => {
    const db = new MarinaDB(TEST_DB);
    const mgr = new SessionManager(db);
    const session = mgr.create("e_1" as EntityId, "TestAgent");

    // Load from DB directly
    const loaded = db.loadSession(session.token);
    expect(loaded).toBeDefined();
    expect(loaded!.entityId).toBe("e_1" as EntityId);

    db.close();
  });

  it("should clean up expired sessions", () => {
    const mgr = new SessionManager(undefined, { sessionTtlMs: 1 });
    const session = mgr.create("e_1" as EntityId, "TestAgent");

    // Force the session into the past so cleanup considers it expired.
    // Use Number.MIN_SAFE_INTEGER to handle broken Date.now() returning INT32_MIN.
    session.expiresAt = Number.MIN_SAFE_INTEGER;

    const removed = mgr.cleanup();
    expect(removed).toBe(1);
  });
});
