// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Host header validation on the main listener (HTTP routes + WebSocket
// upgrades) and the shared allowlist module it uses with the MCP listener.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { connect } from "node:net";
import { Engine } from "../src/engine/engine";
import { isTrustedBrowserOrigin } from "../src/net/cors";
import {
  hostHeaderAllowed,
  loopbackBindFromEnv,
  mainListenerHostPolicy,
  resolveBindHostname,
  transportAuthRequired,
} from "../src/net/host-allowlist";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";
import { scopeProcessState } from "./process-state";
import { tmpDbPath } from "./websocket-helpers";

/** The RFC 6455 sample handshake nonce ("the sample nonce"), built at runtime. */
const SAMPLE_WS_KEY = btoa("the sample nonce");

/** Send one raw HTTP/1.1 request and return the status code of the reply. */
function rawStatus(port: number, lines: string[], body = ""): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buf += chunk;
      const m = buf.match(/^HTTP\/1\.1 (\d{3})/);
      if (m) {
        socket.destroy();
        resolve(Number(m[1]));
      }
    });
    socket.on("error", reject);
    socket.write(`${lines.join("\r\n")}\r\n\r\n${body}`);
  });
}

function upgradeLines(path: string, host: string, origin?: string): string[] {
  return [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${SAMPLE_WS_KEY}`,
    "Sec-WebSocket-Version: 13",
    ...(origin ? [`Origin: ${origin}`] : []),
  ];
}

describe("Host header validation on the main listener (loopback bind)", () => {
  let engine: Engine;
  let server: WebSocketServer;
  let db: MarinaDB;
  let dbPath: string;
  let port: number;
  let scope: DisposableStack;

  beforeAll(() => {
    scope = scopeProcessState({
      env: {
        WS_HOST: undefined,
        MARINA_HOST: undefined,
        MARINA_PUBLIC: undefined,
        MARINA_ALLOWED_HOSTS: undefined,
      },
    });
    dbPath = tmpDbPath();
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/lobby"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/lobby"), makeTestRoom({ short: "L", long: "L" }));
    server = new WebSocketServer(engine, 0);
    server.start();
    port = server.getPort();
  });

  afterAll(() => {
    server.stop();
    db.close();
    cleanupDb(dbPath);
    scope.dispose();
  });

  it("refuses an HTTP request whose Host is not a loopback or allowlisted name", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/connect`, {
      headers: { Host: `evil.example:${port}` },
    });
    expect(res.status).toBe(421);
    expect(await res.text()).toContain("MARINA_ALLOWED_HOSTS");
  });

  it("refuses a pre-auth POST with a foreign Host and a matching Origin", async () => {
    const body = JSON.stringify({ command: "look" });
    const status = await rawStatus(
      port,
      [
        "POST /api/command HTTP/1.1",
        `Host: evil.example:${port}`,
        `Origin: http://evil.example:${port}`,
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Connection: close",
      ],
      body,
    );
    expect(status).toBe(421);
  });

  it("refuses WebSocket upgrades with a foreign Host and a matching Origin", async () => {
    for (const path of ["/ws", "/dashboard-ws", "/canvas-ws?canvas=c1"]) {
      const host = `evil.example:${port}`;
      const status = await rawStatus(port, upgradeLines(path, host, `http://${host}`));
      expect(status).toBe(421);
    }
  });

  it("accepts loopback Host names on any port", async () => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, "localhost:5173", "[::1]"]) {
      const status = await rawStatus(port, [
        "GET /api/connect HTTP/1.1",
        `Host: ${host}`,
        "Connection: close",
      ]);
      expect(status).toBe(200);
    }
    // A loopback WebSocket upgrade still completes (101 Switching Protocols).
    const ws = await rawStatus(
      port,
      upgradeLines("/ws", `127.0.0.1:${port}`, `http://127.0.0.1:${port}`),
    );
    expect(ws).toBe(101);
  });

  it("accepts a Host named in MARINA_ALLOWED_HOSTS", async () => {
    using _env = scopeProcessState({ env: { MARINA_ALLOWED_HOSTS: "marina.lan, other.lan:9000" } });
    const ok = await fetch(`http://127.0.0.1:${port}/api/connect`, {
      headers: { Host: `marina.lan:${port}` },
    });
    expect(ok.status).toBe(200);
    const wrongPort = await fetch(`http://127.0.0.1:${port}/api/connect`, {
      headers: { Host: "other.lan:9001" },
    });
    expect(wrongPort.status).toBe(421);
  });
});

describe("host-allowlist policy", () => {
  it("validates on a loopback bind, and on a public bind only with an allowlist", () => {
    const loop = mainListenerHostPolicy("127.0.0.1", true, false, {});
    expect(loop).not.toBeNull();
    expect(hostHeaderAllowed("localhost:3300", loop)).toBe(true);
    expect(hostHeaderAllowed("127.0.0.1", loop)).toBe(true);
    expect(hostHeaderAllowed("[::1]:3300", loop)).toBe(true);
    expect(hostHeaderAllowed("evil.example:3300", loop)).toBe(false);
    // The operator-declared public URL's host is accepted on a loopback bind.
    const signIn = mainListenerHostPolicy("127.0.0.1", true, false, {
      BETTER_AUTH_URL: "https://marina.example.com",
    });
    expect(hostHeaderAllowed("marina.example.com", signIn)).toBe(true);
    expect(hostHeaderAllowed("evil.example", signIn)).toBe(false);
    expect(hostHeaderAllowed("127.0.0.1.nip.io:3300", loop)).toBe(false);
    expect(hostHeaderAllowed("", loop)).toBe(false);
    expect(hostHeaderAllowed(null, loop)).toBe(false);

    // Public bind with nothing configured: unchanged (no Host validation).
    const open = mainListenerHostPolicy("0.0.0.0", false, false, {});
    expect(open).toBeNull();
    expect(hostHeaderAllowed("anything.example", open)).toBe(true);

    // Public bind with an allowlist: validated (loopback names still pass).
    const listed = mainListenerHostPolicy("0.0.0.0", false, false, {
      MARINA_ALLOWED_HOSTS: "marina.example.com",
    });
    expect(hostHeaderAllowed("marina.example.com", listed)).toBe(true);
    expect(hostHeaderAllowed("marina.example.com:443", listed)).toBe(true);
    expect(hostHeaderAllowed("localhost:3300", listed)).toBe(true);
    expect(hostHeaderAllowed("evil.example", listed)).toBe(false);

    // Local trust profile on a public bind: validated with the derived names.
    const local = mainListenerHostPolicy("0.0.0.0", false, true, {
      BETTER_AUTH_URL: "https://marina.example.com",
    });
    expect(hostHeaderAllowed("marina.example.com", local)).toBe(true);
    expect(hostHeaderAllowed("evil.example", local)).toBe(false);
  });

  it("same-origin only counts when the Host header passed validation", () => {
    const loop = mainListenerHostPolicy("127.0.0.1", true, false, {});
    const opts = { loopbackBind: true, hostPolicy: loop, allowedOrigins: null };
    expect(isTrustedBrowserOrigin("http://evil.example:3300", "evil.example:3300", opts)).toBe(
      false,
    );
    expect(isTrustedBrowserOrigin("http://localhost:3300", "localhost:3300", opts)).toBe(true);
    // Default on a loopback bind (no explicit policy): loopback Host names only.
    expect(
      isTrustedBrowserOrigin("http://evil.example:3300", "evil.example:3300", {
        loopbackBind: true,
        allowedOrigins: null,
      }),
    ).toBe(false);
    // Public bind without a policy: same-origin as before.
    expect(
      isTrustedBrowserOrigin("https://marina.example.com", "marina.example.com", {
        allowedOrigins: null,
      }),
    ).toBe(true);
  });

  it("shares the bind and MCP-auth resolution helpers", () => {
    expect(resolveBindHostname({})).toBe("127.0.0.1");
    expect(loopbackBindFromEnv({ MARINA_PUBLIC: "true" })).toBe(false);
    expect(transportAuthRequired(true, {})).toBe(false);
    expect(transportAuthRequired(true, { MODEL_API_KEYS: "k:agent" })).toBe(true);
    expect(transportAuthRequired(false, {})).toBe(true);
  });
});
