// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Split from websocket.test.ts (Connection Limits, Rate Limiting and HTTP
// surface hardening describes). Assertions unchanged.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { RateLimiter } from "../src/auth/rate-limiter";
import { WS_MAX_CONNECTIONS_PER_IP, WS_MAX_TOTAL_CONNECTIONS } from "../src/engine/constants";
import { Engine } from "../src/engine/engine";
import {
  DASHBOARD_CSP_ENV,
  HTML_CSP,
  htmlCsp,
  inlineScriptHashes,
  resetHttpRateLimitersForTests,
} from "../src/net/http-utils";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import { LocalStorageProvider } from "../src/storage/local-provider";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";
import { openWs, parse, tmpDbPath } from "./websocket-helpers";

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
    for (const path of [
      "/chat",
      "/ask",
      "/dashboard",
      "/canvas",
      "/who/Someone",
      "/who",
      "/terminal",
    ]) {
      const resp = await fetch(`http://localhost:${HARDEN_PORT}${path}`);
      expect(resp.headers.get("Content-Type")).toContain("text/html");
      expect(resp.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(resp.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
      const csp = resp.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
      expect(resp.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    }
  });

  it("sends the exact HTML_CSP on the SPA routes (built or placeholder) and hash-grants only /chat and /ask", async () => {
    for (const path of ["/dashboard", "/canvas", "/who/Someone"]) {
      const resp = await fetch(`http://localhost:${HARDEN_PORT}${path}`);
      expect(resp.headers.get("Content-Security-Policy")).toBe(HTML_CSP);
      expect(HTML_CSP).not.toContain("sha256-");
    }
    // The two static pages carry inline <script> blocks: their CSP is the same
    // policy with the scripts' digests appended to script-src — never
    // 'unsafe-inline', and the digest must match the served bytes.
    for (const path of ["/chat", "/ask"]) {
      const resp = await fetch(`http://localhost:${HARDEN_PORT}${path}`);
      const csp = resp.headers.get("Content-Security-Policy") ?? "";
      const hashes = inlineScriptHashes(await resp.text());
      expect(hashes.length).toBeGreaterThan(0);
      for (const h of hashes) expect(csp).toContain(`'sha256-${h}'`);
      expect(csp).toBe(htmlCsp({ inlineScriptHashes: hashes }) ?? "");
      // script-src stays hash-only — no 'unsafe-inline' anywhere in the policy.
      expect(csp).not.toContain("'unsafe-inline' 'sha256-");
      expect(csp.match(/script-src [^;]*/)?.[0] ?? "").not.toContain("'unsafe-inline'");
    }
  });

  it("honors MARINA_DASHBOARD_CSP: `off` drops the header, a custom policy is sent verbatim", async () => {
    const prev = process.env[DASHBOARD_CSP_ENV];
    try {
      process.env[DASHBOARD_CSP_ENV] = "off";
      let resp = await fetch(`http://localhost:${HARDEN_PORT}/dashboard`);
      expect(resp.headers.get("Content-Security-Policy")).toBeNull();
      expect(resp.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
      resp = await fetch(`http://localhost:${HARDEN_PORT}/chat`);
      expect(resp.headers.get("Content-Security-Policy")).toBeNull();

      process.env[DASHBOARD_CSP_ENV] = "default-src 'self' https://cdn.example.test";
      resp = await fetch(`http://localhost:${HARDEN_PORT}/who/Someone`);
      expect(resp.headers.get("Content-Security-Policy")).toBe(
        "default-src 'self' https://cdn.example.test",
      );
      // Verbatim: no hashes are appended to an operator policy.
      resp = await fetch(`http://localhost:${HARDEN_PORT}/ask`);
      expect(resp.headers.get("Content-Security-Policy")).toBe(
        "default-src 'self' https://cdn.example.test",
      );
    } finally {
      if (prev === undefined) delete process.env[DASHBOARD_CSP_ENV];
      else process.env[DASHBOARD_CSP_ENV] = prev;
    }
  });

  it("gates /api/orchestration/* behind the dashboard session auth and answers JSON", async () => {
    const anon = await fetch(`http://localhost:${HARDEN_PORT}/api/orchestration/patterns`);
    expect(anon.status).toBe(401);

    const conn = new MockConnection("orch-conn");
    engine.addConnection(conn);
    const login = engine.login(conn.id, "Orchestrator");
    if ("error" in login) throw new Error("login failed");
    const resp = await fetch(`http://localhost:${HARDEN_PORT}/api/orchestration/patterns`, {
      headers: { Authorization: `Bearer ${login.token}` },
    });
    // 200 once src/net/orchestration-api.ts is present; a clean 404 (never a
    // 500 / stack page) while it is not.
    expect([200, 404]).toContain(resp.status);
    expect(resp.headers.get("Content-Type")).toContain("application/json");
    const body = (await resp.json()) as Record<string, unknown>;
    if (resp.status === 404) expect(body.error).toBe("not_found");
    else expect(body).toBeTruthy();
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
