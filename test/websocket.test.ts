// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { RateLimiter } from "../src/auth/rate-limiter";
import { isLoopbackConnection } from "../src/engine/commands/code";
import { WS_MAX_CONNECTIONS_PER_IP, WS_MAX_TOTAL_CONNECTIONS } from "../src/engine/constants";
import { Engine } from "../src/engine/engine";
import { DESKTOP_OPERATOR_ENTITY_ID, OPEN_API_ENTITY_ID } from "../src/net/auth-middleware";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import {
  isLoopbackHostname,
  resolveWsBindHostname,
  WebSocketServer,
} from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import { LocalStorageProvider } from "../src/storage/local-provider";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

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

describe("WebSocket bind hostname (secure-by-default loopback)", () => {
  it("resolveWsBindHostname defaults to loopback (127.0.0.1) when unset", () => {
    expect(resolveWsBindHostname({} as NodeJS.ProcessEnv)).toBe("127.0.0.1");
    expect(resolveWsBindHostname({ WS_HOST: "  " } as NodeJS.ProcessEnv)).toBe("127.0.0.1");
  });

  it("resolveWsBindHostname honors WS_HOST / MARINA_HOST when explicitly set", () => {
    expect(resolveWsBindHostname({ WS_HOST: "127.0.0.1" } as NodeJS.ProcessEnv)).toBe("127.0.0.1");
    expect(resolveWsBindHostname({ MARINA_HOST: "127.0.0.1" } as NodeJS.ProcessEnv)).toBe(
      "127.0.0.1",
    );
    // WS_HOST wins over MARINA_HOST.
    expect(
      resolveWsBindHostname({ WS_HOST: "127.0.0.1", MARINA_HOST: "0.0.0.0" } as NodeJS.ProcessEnv),
    ).toBe("127.0.0.1");
  });

  it("public exposure is an explicit opt-in (WS_HOST=0.0.0.0 or MARINA_PUBLIC=true)", () => {
    expect(resolveWsBindHostname({ WS_HOST: "0.0.0.0" } as NodeJS.ProcessEnv)).toBe("0.0.0.0");
    expect(resolveWsBindHostname({ MARINA_PUBLIC: "true" } as NodeJS.ProcessEnv)).toBe("0.0.0.0");
    // Explicit host wins over MARINA_PUBLIC.
    expect(
      resolveWsBindHostname({ WS_HOST: "127.0.0.1", MARINA_PUBLIC: "true" } as NodeJS.ProcessEnv),
    ).toBe("127.0.0.1");
  });

  it("isLoopbackHostname classifies loopback vs public binds", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("0.0.0.0")).toBe(false);
    expect(isLoopbackHostname("192.168.1.5")).toBe(false);
  });

  it("binds loopback-only by default (no WS_HOST/MARINA_PUBLIC set)", () => {
    const prevHost = process.env.WS_HOST;
    const prevMarinaHost = process.env.MARINA_HOST;
    const prevPublic = process.env.MARINA_PUBLIC;
    delete process.env.WS_HOST;
    delete process.env.MARINA_HOST;
    delete process.env.MARINA_PUBLIC;
    const dbPath = tmpDbPath();
    const db = new MarinaDB(dbPath);
    const engine = new Engine({ startRoom: roomId("test/lobby"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/lobby"), makeTestRoom({ short: "L", long: "L" }));
    const server = new WebSocketServer(engine, 15398);
    try {
      server.start();
      expect(server.getBoundHostname()).toBe("127.0.0.1");
    } finally {
      server.stop();
      db.close();
      cleanupDb(dbPath);
      if (prevHost === undefined) delete process.env.WS_HOST;
      else process.env.WS_HOST = prevHost;
      if (prevMarinaHost === undefined) delete process.env.MARINA_HOST;
      else process.env.MARINA_HOST = prevMarinaHost;
      if (prevPublic === undefined) delete process.env.MARINA_PUBLIC;
      else process.env.MARINA_PUBLIC = prevPublic;
    }
  });

  it("WS_HOST=127.0.0.1 causes the running server to bind loopback only", () => {
    const prev = process.env.WS_HOST;
    process.env.WS_HOST = "127.0.0.1";
    const dbPath = tmpDbPath();
    const db = new MarinaDB(dbPath);
    const engine = new Engine({ startRoom: roomId("test/lobby"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/lobby"), makeTestRoom({ short: "L", long: "L" }));
    const server = new WebSocketServer(engine, 15399);
    try {
      server.start();
      expect(server.getBoundHostname()).toBe("127.0.0.1");
    } finally {
      server.stop();
      db.close();
      cleanupDb(dbPath);
      if (prev === undefined) delete process.env.WS_HOST;
      else process.env.WS_HOST = prev;
    }
  });
});

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

  // ─── Live-stream upgrade principal gate (Cluster B seam) ───────────────

  it("admits a loopback canvas-ws upgrade with zero config (desktop-first)", async () => {
    // A local client on loopback must connect to the canvas live stream without
    // any token — the zero-config desktop path. The upgrade gate resolves a
    // LOOPBACK_PRINCIPAL rather than rejecting.
    const ws = new WebSocket(`ws://localhost:${WS_PORT}/canvas-ws?canvas=test`);
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      setTimeout(() => resolve(ws.readyState === WebSocket.OPEN), 1500);
    });
    expect(opened).toBe(true);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    await Bun.sleep(50);
  });

  it("admits a loopback dashboard-ws upgrade with zero config (desktop-first)", async () => {
    const ws = new WebSocket(`ws://localhost:${WS_PORT}/dashboard-ws`);
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      setTimeout(() => resolve(ws.readyState === WebSocket.OPEN), 1500);
    });
    expect(opened).toBe(true);
    ws.close();
    await Bun.sleep(50);
  });

  // ─── Private-canvas subscription authorization (real open() path) ───────
  // These exercise the wired control end-to-end: the runtime open() handler
  // builds a principal from ws.data.principal and calls addClient(auth). The
  // authorizeCanvasSubscription unit lives in canvas-api-auth.test.ts; here we
  // prove it actually runs and closes the socket on denial.

  it("denies a non-owner authenticated peer a private entity-canvas subscription", async () => {
    // Bob owns a private (scope: entity) canvas.
    const bobConn = new MockConnection("bob-conn");
    engine.addConnection(bobConn);
    const bob = engine.login(bobConn.id, "Bob");
    if ("error" in bob) throw new Error("bob login failed");
    db.createCanvas({
      id: "bob-private",
      name: "bob's canvas",
      scope: "entity",
      scopeId: bob.entityId,
      creatorName: "Bob",
    });

    // Alice authenticates but is not the owner — with a real token, the upgrade
    // resolves her real entityId (not the loopback operator sentinel).
    const aliceConn = new MockConnection("alice-conn");
    engine.addConnection(aliceConn);
    const alice = engine.login(aliceConn.id, "Alice");
    if ("error" in alice) throw new Error("alice login failed");

    const ws = new WebSocket(
      `ws://localhost:${WS_PORT}/canvas-ws?canvas=bob-private&token=${alice.token}`,
    );
    const denied = await new Promise<boolean>((resolve) => {
      ws.onclose = () => resolve(true);
      ws.onerror = () => resolve(true);
      setTimeout(
        () => resolve(ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING),
        1500,
      );
    });
    expect(denied).toBe(true);
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
    // The denied socket was never registered as a subscriber.
    expect(wsServer.canvasBroadcaster.clientCount("bob-private")).toBe(0);
    ws.close();
    await Bun.sleep(50);
  });

  it("admits the owner to their own private entity-canvas subscription", async () => {
    const bobConn = new MockConnection("bob-owner-conn");
    engine.addConnection(bobConn);
    const bob = engine.login(bobConn.id, "BobOwner");
    if ("error" in bob) throw new Error("bob login failed");
    db.createCanvas({
      id: "bobowner-private",
      name: "bobowner's canvas",
      scope: "entity",
      scopeId: bob.entityId,
      creatorName: "BobOwner",
    });

    const ws = new WebSocket(
      `ws://localhost:${WS_PORT}/canvas-ws?canvas=bobowner-private&token=${bob.token}`,
    );
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      setTimeout(() => resolve(ws.readyState === WebSocket.OPEN), 1500);
    });
    expect(opened).toBe(true);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    await Bun.sleep(50);
  });

  it("admits a loopback peer to a private entity-canvas (zero-config desktop owner)", async () => {
    db.createCanvas({
      id: "someone-private",
      name: "someone's canvas",
      scope: "entity",
      scopeId: "e_other",
      creatorName: "sys",
    });
    // No token: a genuine loopback peer resolves to LOOPBACK_PRINCIPAL, which
    // buildCanvasPrincipal treats as a local operator — must still see canvases.
    const ws = new WebSocket(`ws://localhost:${WS_PORT}/canvas-ws?canvas=someone-private`);
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      setTimeout(() => resolve(ws.readyState === WebSocket.OPEN), 1500);
    });
    expect(opened).toBe(true);
    ws.close();
    await Bun.sleep(50);
  });

  // ─── Finding 2: desktop token → operator sentinel on the upgrade path ───
  it("resolves the desktop capability token to the operator sentinel (consistent with authenticateRequest)", () => {
    const desktopToken = "desktop-capability-token-at-least-32-chars";
    const prev = process.env.MARINA_DESKTOP_API_TOKEN;
    process.env.MARINA_DESKTOP_API_TOKEN = desktopToken;
    try {
      const req = new Request("http://localhost/canvas-ws?canvas=x", {
        headers: { "X-Marina-Desktop-Token": desktopToken },
      });
      const url = new URL("http://localhost/canvas-ws?canvas=x");
      const resolveUpgradePrincipal = (
        wsServer as unknown as {
          resolveUpgradePrincipal: (r: Request, u: URL, p?: string) => string | null;
        }
      ).resolveUpgradePrincipal.bind(wsServer);
      // A non-loopback peer so the loopback fallback cannot mask the desktop branch.
      const principal = resolveUpgradePrincipal(req, url, "203.0.113.5");
      expect(principal).toBe(DESKTOP_OPERATOR_ENTITY_ID);
      expect(principal).not.toBe(OPEN_API_ENTITY_ID);
    } finally {
      if (prev === undefined) delete process.env.MARINA_DESKTOP_API_TOKEN;
      else process.env.MARINA_DESKTOP_API_TOKEN = prev;
    }
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

  // ─── Exec trust anchor: peerIp vs. spoofable conn.ip ──────────────────

  it("a spoofed X-Forwarded-For sets conn.ip (display) but NOT peerIp (real socket, the trust anchor)", async () => {
    // Bun's WebSocket honors a `headers` option. Forge an X-Forwarded-For that
    // would previously have poisoned the loopback trust check. conn.ip follows
    // the header; conn.peerIp follows the real TCP socket (localhost here).
    const ws = new WebSocket(`ws://localhost:${WS_PORT}/ws`, {
      headers: { "X-Forwarded-For": "203.0.113.99" },
    } as unknown as string[]);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("ws error"));
      });
      ws.send(JSON.stringify({ type: "login", name: "SpoofBob" }));
      await Bun.sleep(150);

      const conn = [...engine.connections.values()]
        .filter((c) => c.protocol === "websocket" && c.entity)
        .at(-1)!;
      expect(conn).toBeDefined();
      // conn.ip is the SPOOFED, header-derived value — never a trust anchor.
      expect(conn.ip).toBe("203.0.113.99");
      // peerIp is the REAL socket peer (loopback in this test), independent of the header.
      expect(conn.peerIp).toBeDefined();
      expect(conn.peerIp).not.toBe("203.0.113.99");
      const peer = conn.peerIp!;
      expect(peer === "127.0.0.1" || peer === "::1" || peer.startsWith("::ffff:127.")).toBe(true);
      // Trust follows the real socket peer, not the forged header.
      expect(isLoopbackConnection(conn)).toBe(true);
    } finally {
      ws.close();
      await Bun.sleep(50);
    }
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

  // ─── Browser Origin gate on every upgrade path ─────────────────────────

  /** Open a socket with an explicit Origin header; resolve true iff it opened. */
  async function opensWithOrigin(path: string, origin: string): Promise<boolean> {
    const ws = new WebSocket(`ws://localhost:${WS_PORT}${path}`, {
      headers: { Origin: origin },
    } as unknown as string[]);
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      ws.onclose = () => resolve(false);
      setTimeout(() => resolve(ws.readyState === WebSocket.OPEN), 1500);
    });
    if (opened) ws.close();
    await Bun.sleep(30);
    return opened;
  }

  it("refuses /ws, /dashboard-ws and /canvas-ws upgrades from a foreign browser Origin", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      expect(await opensWithOrigin("/ws", "https://evil.example")).toBe(false);
      expect(await opensWithOrigin("/dashboard-ws", "https://evil.example")).toBe(false);
      expect(await opensWithOrigin("/canvas-ws?canvas=test", "https://evil.example")).toBe(false);
    } finally {
      console.warn = origWarn;
    }
    expect(warnings.filter((w) => w.includes("https://evil.example")).length).toBe(3);
    // The refused upgrade never became a connection.
    expect([...engine.connections.values()].filter((c) => c.protocol === "websocket")).toHaveLength(
      0,
    );
  });

  it("returns 403 Forbidden origin (not 401) on the refused handshake", async () => {
    const resp = await fetch(`http://localhost:${WS_PORT}/ws`, {
      headers: {
        Origin: "https://evil.example",
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(resp.status).toBe(403);
    expect(await resp.text()).toBe("Forbidden origin");
  });

  it("admits same-origin, loopback (loopback bind) and ALLOWED_ORIGINS browser Origins", async () => {
    // Same origin as the listener.
    expect(await opensWithOrigin("/ws", `http://localhost:${WS_PORT}`)).toBe(true);
    // The dashboard dev server on another loopback port — the listener binds
    // loopback in tests (secure default), so loopback origins are trusted.
    expect(await opensWithOrigin("/dashboard-ws", "http://localhost:5173")).toBe(true);
    expect(await opensWithOrigin("/canvas-ws?canvas=test", "http://127.0.0.1:5173")).toBe(true);

    const prev = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = "https://dash.example.com";
    try {
      expect(await opensWithOrigin("/ws", "https://dash.example.com")).toBe(true);
      expect(await opensWithOrigin("/ws", "https://other.example.com")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ALLOWED_ORIGINS;
      else process.env.ALLOWED_ORIGINS = prev;
    }
  });

  // ─── Non-WS Routes ────────────────────────────────────────────────────

  it("should direct the root path to the dashboard", async () => {
    const resp = await fetch(`http://localhost:${WS_PORT}/`, { redirect: "manual" });
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("/dashboard");
  });

  it("should serve the compact webchat on /chat", async () => {
    const resp = await fetch(`http://localhost:${WS_PORT}/chat`);
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

describe("HTTP surface hardening (headers, body cap, public-read throttle)", () => {
  let engine: Engine;
  let wsServer: WebSocketServer;
  let db: MarinaDB;
  let dbPath: string;
  const HARDEN_PORT = 15303;
  const ASSET_DIR = `/tmp/marina-ws-hardening-assets-${process.pid}`;
  const prevBody = process.env.MARINA_MAX_REQUEST_BODY_BYTES;
  const prevUpload = process.env.MARINA_MAX_UPLOAD_BYTES;

  beforeEach(async () => {
    process.env.MARINA_MAX_REQUEST_BODY_BYTES = "1024";
    process.env.MARINA_MAX_UPLOAD_BYTES = "1024";
    resetHttpRateLimitersForTests();
    dbPath = tmpDbPath();
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/lobby"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/lobby"), makeTestRoom({ short: "Lobby", long: "Lobby." }));
    const storage = new LocalStorageProvider(ASSET_DIR);
    await storage.init();
    wsServer = new WebSocketServer(engine, HARDEN_PORT);
    wsServer.setDb(db);
    wsServer.setStorage(storage);
    wsServer.start();
    engine.start();
  });

  afterEach(async () => {
    engine.stop();
    wsServer.stop();
    db.close();
    cleanupDb(dbPath);
    rmSync(ASSET_DIR, { recursive: true, force: true });
    if (prevBody === undefined) delete process.env.MARINA_MAX_REQUEST_BODY_BYTES;
    else process.env.MARINA_MAX_REQUEST_BODY_BYTES = prevBody;
    if (prevUpload === undefined) delete process.env.MARINA_MAX_UPLOAD_BYTES;
    else process.env.MARINA_MAX_UPLOAD_BYTES = prevUpload;
    resetHttpRateLimitersForTests();
    await Bun.sleep(100);
  });

  it("serves HTML documents with nosniff, SAMEORIGIN framing and the document CSP", async () => {
    for (const path of ["/chat", "/ask", "/dashboard", "/who/Someone"]) {
      const resp = await fetch(`http://localhost:${HARDEN_PORT}${path}`);
      expect(resp.headers.get("Content-Type")).toContain("text/html");
      expect(resp.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(resp.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
      expect(resp.headers.get("Content-Security-Policy")).toBe(
        "frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
      );
      expect(resp.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    }
  });

  it("serves stored assets non-executable: normalized type, nosniff, sandbox CSP, attachment", async () => {
    // Bypass the upload API and plant an HTML file directly in storage — even a
    // pre-allowlist row (or a compromised store) must not come back as text/html.
    const storage = new LocalStorageProvider(ASSET_DIR);
    await storage.put("planted.html", new TextEncoder().encode("<script>1</script>"), "text/html");
    const resp = await fetch(`http://localhost:${HARDEN_PORT}/assets/planted.html`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(resp.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(resp.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(resp.headers.get("Content-Disposition")).toStartWith("attachment;");
  });

  it("caps request bodies at MARINA_MAX_REQUEST_BODY_BYTES instead of Bun's 128 MiB default", async () => {
    const huge = JSON.stringify({ name: "Big", command: "x".repeat(4096) });
    const resp = await fetch(`http://localhost:${HARDEN_PORT}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: huge,
    }).catch(() => null);
    // Bun answers 413 (or drops the connection) — either way the handler never
    // buffers the payload. A small body on the same route still works.
    if (resp) expect(resp.status).toBe(413);
    const small = await fetch(`http://localhost:${HARDEN_PORT}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Small", command: "look" }),
    });
    expect(small.status).toBe(200);
  });

  it("answers malformed JSON on a bare-json route with a JSON error, never a stack page", async () => {
    const resp = await fetch(`http://localhost:${HARDEN_PORT}/api/connect/negotiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ nope",
    });
    expect(resp.status).toBe(400);
    expect(((await resp.json()) as { error: string }).error).toBe("Invalid JSON");
  });

  it("rate-limits the public /api/entity/* reads per client IP (30 / 10 s)", async () => {
    let limited: Response | undefined;
    for (let i = 0; i < 31; i++) {
      const resp = await fetch(`http://localhost:${HARDEN_PORT}/api/entity/nobody-${i}/profile`);
      if (resp.status === 429) {
        limited = resp;
        break;
      }
      expect(resp.status).toBe(404);
    }
    expect(limited?.status).toBe(429);
  });
});
