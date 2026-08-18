// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RateLimiter } from "../src/auth/rate-limiter";
import { WS_MAX_CONNECTIONS_PER_IP, WS_MAX_TOTAL_CONNECTIONS } from "../src/engine/constants";
import { Engine } from "../src/engine/engine";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let dbCounter = 0;
function tmpDbPath(): string {
  return `/tmp/marina-ws-test-${Date.now()}-${++dbCounter}.db`;
}

/** Open a WebSocket and collect messages until a condition or timeout. */
function openWs(
  port: number,
  opts?: { path?: string },
): {
  ws: WebSocket;
  messages: string[];
  waitFor: (pred: (msgs: string[]) => boolean, ms?: number) => Promise<void>;
  close: () => Promise<void>;
} {
  const path = opts?.path ?? "/ws";
  const ws = new WebSocket(`ws://localhost:${port}${path}`);
  const messages: string[] = [];

  ws.onmessage = (event) => {
    messages.push(event.data as string);
  };

  const waitFor = (pred: (msgs: string[]) => boolean, ms = 3000) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (pred(messages)) return resolve();
      };
      ws.onmessage = (event) => {
        messages.push(event.data as string);
        check();
      };
      check();
      setTimeout(resolve, ms);
    });

  const close = async () => {
    ws.close();
    await Bun.sleep(50);
  };

  return { ws, messages, waitFor, close };
}

function parse(msg: string): { kind: string; data: Record<string, unknown> } {
  return JSON.parse(msg);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WebSocket Server", () => {
  let engine: Engine;
  let wsServer: WebSocketServer;
  let db: MarinaDB;
  let dbPath: string;
  const WS_PORT = 15300;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = new MarinaDB(dbPath);
    engine = new Engine({
      startRoom: roomId("test/lobby"),
      tickInterval: 60_000,
      db,
    });

    engine.registerRoom(
      roomId("test/lobby"),
      makeTestRoom({
        short: "The Lobby",
        long: "A spacious lobby for testing.",
        items: { desk: "A reception desk." },
        exits: { north: roomId("test/corridor") },
      }),
    );

    engine.registerRoom(
      roomId("test/corridor"),
      makeTestRoom({
        short: "Corridor",
        long: "A long corridor.",
        exits: { south: roomId("test/lobby") },
      }),
    );

    wsServer = new WebSocketServer(engine, WS_PORT);
    wsServer.start();
    engine.start();
  });

  afterEach(async () => {
    engine.stop();
    wsServer.stop();
    db.close();
    cleanupDb(dbPath);
    await Bun.sleep(100);
  });

  // ─── Connection ───────────────────────────────────────────────────────

  it("should accept connection and send welcome message", async () => {
    const { messages, waitFor, close } = openWs(WS_PORT);
    await waitFor((m) => m.length >= 1);

    expect(messages.length).toBeGreaterThanOrEqual(1);
    const welcome = parse(messages[0]!);
    expect(welcome.kind).toBe("system");
    expect(welcome.data.text).toContain("Welcome");

    await close();
  });

  it("should include skill and connect endpoints in welcome", async () => {
    const { messages, waitFor, close } = openWs(WS_PORT);
    await waitFor((m) => m.length >= 1);

    const welcome = parse(messages[0]!);
    expect(welcome.data.skill).toBe("/api/skill");
    expect(welcome.data.connect).toBe("/api/connect");

    await close();
  });

  // ─── Login Flow ───────────────────────────────────────────────────────

  it("should login successfully and receive entityId + token", async () => {
    const { ws, messages, waitFor, close } = openWs(WS_PORT);
    await waitFor((m) => m.length >= 1);

    ws.send(JSON.stringify({ type: "login", name: "Alice" }));
    await waitFor((m) => m.length >= 2);

    const loginMsg = parse(messages[1]!);
    expect(loginMsg.kind).toBe("system");
    expect(loginMsg.data.text).toContain("Alice");
    expect(loginMsg.data.entityId).toBeDefined();
    expect(loginMsg.data.token).toBeDefined();

    await close();
  });

  it("should receive room look + brief after login", async () => {
    const { ws, messages, waitFor, close } = openWs(WS_PORT);
    await waitFor((m) => m.length >= 1);

    ws.send(JSON.stringify({ type: "login", name: "Bob" }));
    // welcome + login + look + brief = at least 4 messages
    await waitFor((m) => m.length >= 4);

    expect(messages.length).toBeGreaterThanOrEqual(4);

    // One of the messages after login should contain room description
    const allText = messages.map((m) => parse(m).data?.text ?? "").join("\n");
    expect(allText).toContain("The Lobby");

    await close();
  });

  // ─── Message Parsing ──────────────────────────────────────────────────

  it("should parse JSON command messages", async () => {
    const { ws, messages, waitFor, close } = openWs(WS_PORT);
    await waitFor((m) => m.length >= 1);

    ws.send(JSON.stringify({ type: "login", name: "JsonBot" }));
    await waitFor((m) => m.length >= 4);

    ws.send(JSON.stringify({ type: "command", command: "who" }));
    await waitFor((m) => m.length >= 5);

    const allText = messages.map((m) => parse(m).data?.text ?? "").join("\n");
    expect(allText).toContain("JsonBot");

    await close();
  });

  it("should treat plain text as command", async () => {
    const { ws, messages, waitFor, close } = openWs(WS_PORT);
    await waitFor((m) => m.length >= 1);

    ws.send(JSON.stringify({ type: "login", name: "PlainBot" }));
    await waitFor((m) => m.length >= 4);

    // Send plain text (not JSON)
    ws.send("who");
    await waitFor((m) => m.length >= 5);

    const allText = messages.map((m) => parse(m).data?.text ?? "").join("\n");
    expect(allText).toContain("PlainBot");

    await close();
  });

  it("should handle malformed JSON gracefully (as plain text command)", async () => {
    const { ws, messages, waitFor, close } = openWs(WS_PORT);
    await waitFor((m) => m.length >= 1);

    ws.send(JSON.stringify({ type: "login", name: "MalBot" }));
    await waitFor((m) => m.length >= 4);

    // Send broken JSON — should be treated as a plain text command
    ws.send("{broken json");
    await Bun.sleep(100);

    // Connection should remain alive — send a real command
    const prevLen = messages.length;
    ws.send(JSON.stringify({ type: "command", command: "who" }));
    await waitFor((m) => m.length > prevLen);

    const allText = messages.map((m) => parse(m).data?.text ?? "").join("\n");
    expect(allText).toContain("MalBot");

    await close();
  });

  // ─── Auth & Pre-login ─────────────────────────────────────────────────

  it("should reject commands before login", async () => {
    const { ws, messages, waitFor, close } = openWs(WS_PORT);
    await waitFor((m) => m.length >= 1);

    ws.send(JSON.stringify({ type: "command", command: "look" }));
    await waitFor((m) => m.length >= 2);

    const errMsg = parse(messages[1]!);
    expect(errMsg.kind).toBe("error");
    expect(errMsg.data.text).toContain("Enter your name");

    await close();
  });

  it("should support reconnect with session token", async () => {
    const { ws, messages, waitFor, close } = openWs(WS_PORT);
    await waitFor((m) => m.length >= 1);

    ws.send(JSON.stringify({ type: "login", name: "TokenBot" }));
    await waitFor((m) => m.length >= 2);

    const loginMsg = parse(messages[1]!);
    const token = loginMsg.data.token as string;
    expect(token).toBeDefined();

    await close();

    // Reconnect with the same token
    const ws2 = openWs(WS_PORT);
    await ws2.waitFor((m) => m.length >= 1);

    ws2.ws.send(JSON.stringify({ type: "auth", token }));
    await ws2.waitFor((m) => m.length >= 2);

    const reconnMsg = parse(ws2.messages[1]!);
    expect(reconnMsg.kind).toBe("system");
    expect(reconnMsg.data.text).toContain("Reconnected");
    expect(reconnMsg.data.text).toContain("TokenBot");

    await ws2.close();
  });

  // ─── Disconnect ───────────────────────────────────────────────────────

  it("unbinds connection on disconnect; entity removal is deferred for reconnect grace", async () => {
    const { ws, waitFor, close } = openWs(WS_PORT);
    await waitFor((m) => m.length >= 1);

    ws.send(JSON.stringify({ type: "login", name: "DiscoBot" }));
    await waitFor((m) => m.length >= 4);

    const entity = engine.entities.findAgentByName("DiscoBot");
    expect(entity).toBeDefined();

    await close();
    await Bun.sleep(100);

    // Connection is gone; entity lingers within RECONNECT_GRACE_MS so a
    // reconnect with a valid token can rebind to the same EntityId.
    expect(engine.connections.size).toBe(0);
  });

  // ─── Multiple Connections ─────────────────────────────────────────────

  it("should reject duplicate login name", async () => {
    const client1 = openWs(WS_PORT);
    await client1.waitFor((m) => m.length >= 1);
    client1.ws.send(JSON.stringify({ type: "login", name: "DupeBot" }));
    await client1.waitFor((m) => m.length >= 4);

    const client2 = openWs(WS_PORT);
    await client2.waitFor((m) => m.length >= 1);
    client2.ws.send(JSON.stringify({ type: "login", name: "DupeBot" }));
    await client2.waitFor((m) => m.length >= 2);

    const errMsg = parse(client2.messages[1]!);
    expect(errMsg.kind).toBe("auth_error");
    expect(errMsg.data.text).toContain("already in use");

    await client1.close();
    await client2.close();
  });

  it("should support multiple users connected simultaneously", async () => {
    const c1 = openWs(WS_PORT);
    await c1.waitFor((m) => m.length >= 1);
    c1.ws.send(JSON.stringify({ type: "login", name: "UserA" }));
    await c1.waitFor((m) => m.length >= 4);

    const c2 = openWs(WS_PORT);
    await c2.waitFor((m) => m.length >= 1);
    c2.ws.send(JSON.stringify({ type: "login", name: "UserB" }));
    await c2.waitFor((m) => m.length >= 4);

    // Wait for UserA to receive the "UserB connects" notification
    await Bun.sleep(100);

    // Both should appear in 'who'
    const prevLen = c1.messages.length;
    c1.ws.send(JSON.stringify({ type: "command", command: "who" }));
    await c1.waitFor((m) => m.length > prevLen);

    const allText = c1.messages.map((m) => parse(m).data?.text ?? "").join("\n");
    expect(allText).toContain("UserA");
    expect(allText).toContain("UserB");

    await c1.close();
    await c2.close();
  });

  // ─── Movement ─────────────────────────────────────────────────────────

  it("should handle movement between rooms", async () => {
    const { ws, messages, waitFor, close } = openWs(WS_PORT);
    await waitFor((m) => m.length >= 1);

    ws.send(JSON.stringify({ type: "login", name: "MoveBot" }));
    await waitFor((m) => m.length >= 4);

    ws.send(JSON.stringify({ type: "command", command: "north" }));
    await waitFor((m) => m.length >= 5);

    const allText = messages.map((m) => parse(m).data?.text ?? "").join("\n");
    expect(allText).toContain("Corridor");

    await close();
  });

  // ─── Health Check ─────────────────────────────────────────────────────

  it("should respond to health check", async () => {
    const resp = await fetch(`http://localhost:${WS_PORT}/health`);
    const data = await resp.json();
    expect(resp.status).toBe(200);
    expect(data.status).toBe("ok");
    expect(typeof data.uptime).toBe("number");
    expect(typeof data.connections).toBe("number");
    expect(typeof data.rooms).toBe("number");
  });

  // ─── CORS Preflight ───────────────────────────────────────────────────

  it("should handle CORS preflight", async () => {
    const resp = await fetch(`http://localhost:${WS_PORT}/api/anything`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000" },
    });
    expect(resp.status).toBe(200);
    // Always includes allowed methods regardless of ALLOWED_ORIGINS config
    expect(resp.headers.get("Access-Control-Allow-Methods")).toBeTruthy();
    expect(resp.headers.get("Access-Control-Allow-Headers")).toBeTruthy();
  });

  // ─── Non-WS Routes ────────────────────────────────────────────────────

  it("should serve webchat on root path", async () => {
    const resp = await fetch(`http://localhost:${WS_PORT}/`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("text/html");
  });
});

// ─── Connection Limits ──────────────────────────────────────────────────────

describe("WebSocket Connection Limits", () => {
  let engine: Engine;
  let wsServer: WebSocketServer;
  let db: MarinaDB;
  let dbPath: string;
  const LIMIT_PORT = 15301;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = new MarinaDB(dbPath);
    engine = new Engine({
      startRoom: roomId("test/lobby"),
      tickInterval: 60_000,
      db,
    });
    engine.registerRoom(
      roomId("test/lobby"),
      makeTestRoom({ short: "Lobby", long: "Test lobby." }),
    );
    wsServer = new WebSocketServer(engine, LIMIT_PORT);
    wsServer.start();
    engine.start();
  });

  afterEach(async () => {
    engine.stop();
    wsServer.stop();
    db.close();
    cleanupDb(dbPath);
    await Bun.sleep(100);
  });

  it("should enforce per-IP connection limit", async () => {
    // Open WS_MAX_CONNECTIONS_PER_IP connections, then one more should fail.
    // Default cap is now 100 (env-overridable), so give the test extra headroom.
    const clients: { ws: WebSocket; close: () => Promise<void> }[] = [];

    for (let i = 0; i < WS_MAX_CONNECTIONS_PER_IP; i++) {
      const c = openWs(LIMIT_PORT);
      await c.waitFor((m) => m.length >= 1);
      clients.push(c);
    }

    // The overflow connection should be rejected
    const overflow = new WebSocket(`ws://localhost:${LIMIT_PORT}/ws`);
    const closed = new Promise<boolean>((resolve) => {
      overflow.onclose = () => resolve(true);
      overflow.onerror = () => resolve(true);
      overflow.onopen = () => resolve(false);
      setTimeout(() => resolve(false), 1000);
    });

    const result = await closed;
    // The overflow connection should be rejected (closed or error)
    expect(result).toBe(true);

    // Cleanup
    overflow.close();
    for (const c of clients) {
      await c.close();
    }
  }, 30_000);

  it("constants have expected default values", () => {
    // WS_MAX_CONNECTIONS_PER_IP is env-overridable; default bumped to 100
    // so localhost multi-agent benchmark stacks (14+ providers) fit under it.
    expect(WS_MAX_CONNECTIONS_PER_IP).toBe(100);
    expect(WS_MAX_TOTAL_CONNECTIONS).toBe(1000);
  });
});

// ─── Rate Limiting ──────────────────────────────────────────────────────────

describe("WebSocket Rate Limiting", () => {
  let engine: Engine;
  let wsServer: WebSocketServer;
  let db: MarinaDB;
  let dbPath: string;
  const RATE_PORT = 15302;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = new MarinaDB(dbPath);
    engine = new Engine({
      startRoom: roomId("test/lobby"),
      tickInterval: 60_000,
      db,
    });
    engine.registerRoom(
      roomId("test/lobby"),
      makeTestRoom({ short: "Lobby", long: "Test lobby." }),
    );

    // Very restrictive rate limiter: 2 tokens, no refill
    const limiter = new RateLimiter({ maxTokens: 2, refillRate: 0, refillInterval: 60_000 });
    wsServer = new WebSocketServer(engine, RATE_PORT, limiter);
    wsServer.start();
    engine.start();
  });

  afterEach(async () => {
    engine.stop();
    wsServer.stop();
    db.close();
    cleanupDb(dbPath);
    await Bun.sleep(100);
  });

  it("should rate limit rapid commands", async () => {
    const { ws, messages, waitFor, close } = openWs(RATE_PORT);
    await waitFor((m) => m.length >= 1);

    ws.send(JSON.stringify({ type: "login", name: "SpamBot" }));
    await waitFor((m) => m.length >= 4);

    // Burn through the 2-token bucket
    ws.send(JSON.stringify({ type: "command", command: "who" }));
    ws.send(JSON.stringify({ type: "command", command: "who" }));
    // This one should be rate-limited
    ws.send(JSON.stringify({ type: "command", command: "who" }));

    await waitFor((m) => m.length >= 7, 2000);

    const allText = messages.map((m) => parse(m).data?.text ?? "").join("\n");
    expect(allText).toContain("Rate limited");

    await close();
  });
});
