// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Split from websocket.test.ts ("WebSocket Server" describe). Assertions
// unchanged; shared fixtures live in websocket-helpers.ts.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isLoopbackConnection } from "../src/engine/commands/code";
import { Engine } from "../src/engine/engine";
import { DESKTOP_OPERATOR_ENTITY_ID, OPEN_API_ENTITY_ID } from "../src/net/auth-middleware";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";
import { openWs, parse, tmpDbPath } from "./websocket-helpers";

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
