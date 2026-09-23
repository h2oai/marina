// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Split from integration.test.ts (WebSocket Integration describe). Assertions
// are unchanged; the fixed 2000 ms fallbacks became `until()` polls.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { WebSocketServer } from "../src/net/websocket-server";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom, until } from "./helpers";

const TEST_DB = "test_integration_ws.db";

/** Open a socket, record every message, optionally log in on open. */
function collect(url: string, loginName?: string): { ws: WebSocket; messages: string[] } {
  const ws = new WebSocket(url);
  const messages: string[] = [];
  ws.onmessage = (event) => {
    messages.push(event.data as string);
  };
  if (loginName) {
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "login", name: loginName }));
    };
  }
  return { ws, messages };
}

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
    const { ws, messages } = collect(`ws://localhost:${WS_PORT}/ws`, "IntegrationBot");
    // Wait for welcome + login confirmation + room look
    await until(() => messages.length >= 3, { timeoutMs: 2000 });

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
    const { ws, messages } = collect(`ws://localhost:${WS_PORT}/ws`, "CmdBot");
    // Now send a command (after system + look + brief messages)
    await until(() => messages.length >= 4, { timeoutMs: 2000 });
    ws.send(JSON.stringify({ type: "command", command: "who" }));
    await until(() => messages.length >= 5, { timeoutMs: 2000 });

    expect(messages.length).toBeGreaterThanOrEqual(5);
    const whoMsg = JSON.parse(messages[messages.length - 1]!);
    expect(whoMsg.data.text).toContain("CmdBot");

    ws.close();
    await Bun.sleep(50);
  });

  it("should handle movement via WebSocket", async () => {
    const { ws, messages } = collect(`ws://localhost:${WS_PORT}/ws`, "MoveBot");
    await until(() => messages.length >= 4, { timeoutMs: 2000 });
    ws.send(JSON.stringify({ type: "command", command: "north" }));
    await until(() => messages.length >= 5, { timeoutMs: 2000 });

    // After moving north, should receive the northern room description
    const allText = messages.map((m) => JSON.parse(m).data?.text ?? "").join("\n");
    expect(allText).toContain("Northern Room");

    ws.close();
    await Bun.sleep(50);
  });

  it("should reject commands before login", async () => {
    const { ws, messages } = collect(`ws://localhost:${WS_PORT}/ws`);
    await until(() => messages.length >= 1, { timeoutMs: 2000 });
    // Send command without login
    ws.send(JSON.stringify({ type: "command", command: "look" }));
    await until(() => messages.length >= 2, { timeoutMs: 2000 });

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
