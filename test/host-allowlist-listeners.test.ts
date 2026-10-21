// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Host header validation on the standalone listeners: the memory service
// (`serveMemory`) and the log viewer (`LogServer`), loopback bind.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveMemory } from "../src/memory/server";
import { LogServer } from "../src/net/log-server";
import { scopeProcessState } from "./process-state";

/** The RFC 6455 sample handshake nonce ("the sample nonce"), built at runtime. */
const SAMPLE_WS_KEY = btoa("the sample nonce");

const envScope = () =>
  scopeProcessState({ env: { MARINA_ALLOWED_HOSTS: undefined, BETTER_AUTH_URL: undefined } });

describe("memory service listener validates Host (loopback bind)", () => {
  let dir: string;
  let memory: ReturnType<typeof serveMemory>;
  let base: string;
  let scope: DisposableStack;

  beforeAll(() => {
    scope = envScope();
    dir = mkdtempSync(join(tmpdir(), "marina-host-mem-"));
    memory = serveMemory({ dbPath: join(dir, "memory.db"), port: 0 });
    base = `http://127.0.0.1:${memory.server.port}`;
  });

  afterAll(async () => {
    await memory.close();
    rmSync(dir, { recursive: true, force: true });
    scope.dispose();
  });

  it("refuses a foreign Host with 421", async () => {
    const res = await fetch(`${base}/v1/memory/health`, {
      headers: { Host: `evil.example:${memory.server.port}` },
    });
    expect(res.status).toBe(421);
    expect(await res.text()).toContain("MARINA_ALLOWED_HOSTS");
  });

  it("answers loopback and allowlisted Hosts", async () => {
    expect((await fetch(`${base}/v1/memory/health`)).status).toBe(200);
    using _allow = scopeProcessState({ env: { MARINA_ALLOWED_HOSTS: "memory.lan" } });
    const res = await fetch(`${base}/v1/memory/health`, { headers: { Host: "memory.lan" } });
    expect(res.status).toBe(200);
  });
});

describe("log viewer listener validates Host and Origin (loopback bind)", () => {
  let server: LogServer;
  let port: number;
  let scope: DisposableStack;

  beforeAll(() => {
    scope = envScope();
    server = new LogServer({ port: 0, resolveEntity: () => undefined });
    server.start();
    // biome-ignore lint/suspicious/noExplicitAny: reads the bound port of port 0
    port = (server as any).server.port;
  });

  afterAll(() => {
    server.stop();
    scope.dispose();
  });

  const upgrade = (host: string, origin?: string) =>
    fetch(`http://127.0.0.1:${port}/ws`, {
      headers: {
        Host: host,
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": SAMPLE_WS_KEY,
        "Sec-WebSocket-Version": "13",
        ...(origin ? { Origin: origin } : {}),
      },
    });

  it("refuses a foreign Host on the page and on the feed", async () => {
    const page = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { Host: `evil.example:${port}` },
    });
    expect(page.status).toBe(421);
    const ws = await upgrade(`evil.example:${port}`, `http://evil.example:${port}`);
    expect(ws.status).toBe(421);
  });

  it("refuses a feed upgrade from a foreign Origin", async () => {
    const ws = await upgrade(`127.0.0.1:${port}`, "https://evil.example");
    expect(ws.status).toBe(403);
  });

  it("serves the page to a loopback Host", async () => {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
  });
});
