// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { McpServerAdapter } from "../src/net/mcp-server";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

const TEST_DB = "test_connect_api.db";
describe("Connect API", () => {
  let engine: Engine;
  let wsServer: WebSocketServer;
  let mcpServer: McpServerAdapter;
  let db: MarinaDB;
  let wsPort: number;
  let mcpPort: number;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({
      startRoom: roomId("test/start"),
      tickInterval: 60_000,
      db,
    });

    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({ short: "Start", long: "Starting room." }),
    );

    wsServer = new WebSocketServer(engine, 0);
    wsServer.start();
    wsPort = wsServer.getPort();

    mcpServer = new McpServerAdapter(engine, 0);
    mcpServer.start();
    mcpPort = mcpServer.getPort();

    engine.start();
  });

  afterEach(() => {
    engine.stop();
    wsServer.stop();
    mcpServer.stop();
    db.close();
    cleanupDb(TEST_DB);
  });

  // ── /api/connect ──────────────────────────────────────────────────────────

  it("GET /api/connect returns manifest from WS port", async () => {
    const res = await fetch(`http://localhost:${wsPort}/api/connect`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    // No ACAO header when ALLOWED_ORIGINS is not set (same-origin only)
    expect(res.headers.get("access-control-allow-origin")).toBeNull();

    const body = await res.json();
    expect(body.name).toBe("Marina");
    expect(body.description).toContain("shared space");
    expect(body.agentContract.version).toBe(1);
    expect(body.agentContract.promptVersion).toMatch(/^[a-f0-9]{12}$/);
    expect(body.agentContract.capabilityLayers.required).toContain("communication");
    expect(body.agentContract.capabilityLayers.optional).toContain("memory");
    expect(body.agentContract.toolPolicy.read.readOnly).toBe(true);
    expect(body.agentContract.toolPolicy.consequential.destructive).toBe(true);
    expect(body.protocols.mcp.url).toContain("/mcp");
    expect(body.protocols.mcp.url).toContain(`:${mcpPort}/mcp`);
    expect(body.protocols.mcp.config.mcpServers.marina.url).toContain("/mcp");
    expect(body.protocols.websocket.url).toContain("/ws");
    expect(body.protocols.websocket.url).toContain(`:${wsPort}/ws`);
    expect(body.protocols.telnet.port).toBe(4000);
    expect(body.skill).toBe("/api/skill");
    expect(body.health).toBe("/health");
    expect(body.dashboard).toBe("/dashboard");
    expect(typeof body.world.rooms).toBe("number");
    expect(typeof body.world.entities).toBe("number");
    expect(typeof body.world.agents).toBe("number");
  });

  it("GET /api/connect returns manifest from MCP port", async () => {
    const res = await fetch(`http://localhost:${mcpPort}/api/connect`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.name).toBe("Marina");
    expect(body.protocols.mcp).toBeDefined();
    expect(body.protocols.websocket).toBeDefined();
    expect(body.protocols.telnet).toBeDefined();
  });

  it("manifest world section reflects live engine state", async () => {
    const res = await fetch(`http://localhost:${wsPort}/api/connect`);
    const body = await res.json();
    expect(body.world.rooms).toBe(engine.rooms.size);
    expect(body.world.entities).toBe(engine.entities.size);
  });

  it("manifest host derives from request Host header", async () => {
    const res = await fetch(`http://localhost:${wsPort}/api/connect`, {
      headers: { Host: "marina.ai:3300" },
    });
    const body = await res.json();
    expect(body.protocols.mcp.url).toContain("marina.ai");
    expect(body.protocols.websocket.url).toContain("marina.ai");
    expect(body.protocols.telnet.host).toBe("marina.ai");
  });

  it("actively negotiates opportunistic runtime capability layers", async () => {
    const res = await fetch(`http://localhost:${wsPort}/api/connect/negotiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "visitor",
        capabilities: ["identity", "world", "communication", "memory", "unknown"],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.canEnter).toBe(true);
    expect(body.mode).toBe("full");
    expect(body.accepted).toEqual(["identity", "world", "communication", "memory"]);
  });

  it("reports missing minimum layers without assuming a model or prompt", async () => {
    const res = await fetch(`http://localhost:${wsPort}/api/connect/negotiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capabilities: ["identity", "memory"] }),
    });
    const body = await res.json();
    expect(body.canEnter).toBe(false);
    expect(body.missingRequired).toEqual(["world", "communication"]);
  });

  // ── /api/skill ────────────────────────────────────────────────────────────

  it("GET /api/skill returns SKILL.md from WS port", async () => {
    const res = await fetch(`http://localhost:${wsPort}/api/skill`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    // No ACAO header when ALLOWED_ORIGINS is not set (same-origin only)
    expect(res.headers.get("access-control-allow-origin")).toBeNull();

    const text = await res.text();
    expect(text).toContain("# Marina");
    expect(text).toContain("## Entering");
  });

  it("GET /api/skill returns SKILL.md from MCP port", async () => {
    const res = await fetch(`http://localhost:${mcpPort}/api/skill`);
    expect(res.status).toBe(200);

    const text = await res.text();
    expect(text).toContain("# Marina");
  });

  // ── Welcome message enrichment ────────────────────────────────────────────

  it("WebSocket welcome includes skill and connect fields", async () => {
    const ws = new WebSocket(`ws://localhost:${wsPort}/ws`);

    const welcome = await new Promise<Record<string, unknown>>((resolve) => {
      ws.onmessage = (event) => {
        resolve(JSON.parse(event.data as string));
      };
    });

    expect(welcome.kind).toBe("system");
    const data = welcome.data as Record<string, unknown>;
    expect(data.text).toContain("Welcome");
    expect(data.skill).toBe("/api/skill");
    expect(data.connect).toBe("/api/connect");

    ws.close();
    await Bun.sleep(50);
  });
});
