// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

const TEST_DB = "test_command_api.db";

function makeRequest(path: string, body: unknown, token?: string): [URL, string, Request] {
  const url = new URL(`http://localhost:3300${path}`);
  const req = new Request(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return [url, "POST", req];
}

describe("Command API", () => {
  let db: MarinaDB;
  let engine: Engine;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(
      roomId("test/start"),
      makeTestRoom({
        short: "Command API Room",
        long: "A room for command API tests.",
      }),
    );
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("executes a command through a name-based short-lived session", async () => {
    const [url, method, req] = makeRequest("/api/command", {
      name: "ApiAlice",
      command: "look",
      render: "text",
    });

    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(200);
    const body = (await resp!.json()) as { token: string; text: string; name: string };

    expect(body.name).toBe("ApiAlice");
    expect(body.token).toBeTruthy();
    expect(body.text).toContain("Command API Room");
    expect(body.text).toContain("A room for command API tests.");
  });

  it("reconnects with a token and returns the rotated token", async () => {
    const [loginUrl, loginMethod, loginReq] = makeRequest("/api/command", {
      name: "ApiBob",
      command: "look",
    });
    const loginResp = await handleDashboardApi(loginReq, loginUrl, loginMethod, engine, db);
    const loginBody = (await loginResp!.json()) as { token: string };

    const [url, method, req] = makeRequest(
      "/api/command",
      {
        command: "say hello from http",
        render: "text",
      },
      loginBody.token,
    );
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(200);
    const body = (await resp!.json()) as { token: string; text: string; name: string };

    expect(body.name).toBe("ApiBob");
    expect(body.token).toBeTruthy();
    expect(body.token).not.toBe(loginBody.token);
    expect(body.text).toContain("You say");
    expect(body.text).toContain("hello from http");
  });

  it("wraps /api/ask around the ask word", async () => {
    const [url, method, req] = makeRequest("/api/ask", {
      name: "ApiAsk",
      query: "where should I start",
      render: "text",
    });

    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(200);
    const body = (await resp!.json()) as { command: string; text: string };

    expect(body.command).toBe("ask where should I start");
    expect(body.text).toContain("Ask: where should I start");
  });

  it("reports real security posture via /api/security-status", async () => {
    db.saveApiKey({
      name: "openai-default",
      provider: "openai",
      encryptedValue: "sk-test",
      isEncrypted: false,
      setBy: "test",
    });
    // The endpoint is behind the API auth gate — get a session token first.
    const [lu, lm, lr] = makeRequest("/api/command", { name: "SecAdmin", command: "look" });
    const token = (
      (await (await handleDashboardApi(lr, lu, lm, engine, db))!.json()) as {
        token: string;
      }
    ).token;

    const url = new URL("http://localhost:3300/api/security-status");
    const req = new Request(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const resp = await handleDashboardApi(req, url, "GET", engine, db);
    expect(resp?.status).toBe(200);
    const body = (await resp!.json()) as {
      authRequired: boolean;
      openApi: boolean;
      keyEncryption: boolean;
      dbKeyCount: number;
      unreadableKeys: number;
    };
    // Test engine has no auth and no key secret; the plaintext key is readable.
    expect(body.authRequired).toBe(false);
    expect(body.keyEncryption).toBe(false);
    expect(body.dbKeyCount).toBe(1);
    expect(body.unreadableKeys).toBe(0);
  });

  it("can list usecase recipes from a fresh API session", async () => {
    const [url, method, req] = makeRequest("/api/command", {
      name: "ApiUsecase",
      command: "usecase list",
      render: "text",
    });

    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(200);
    const body = (await resp!.json()) as { text: string };

    expect(body.text).toContain("Use Case Recipes");
    expect(body.text).toContain("research");
    expect(body.text).toContain("predict");
  });

  it("serves the shared work inbox for an authenticated entity", async () => {
    const [loginUrl, loginMethod, loginReq] = makeRequest("/api/command", {
      name: "ApiWorker",
      command: "memory set goal respond to requests",
    });
    const loginResp = await handleDashboardApi(loginReq, loginUrl, loginMethod, engine, db);
    const loginBody = (await loginResp!.json()) as { token: string };

    db.createCanvas({ id: "canvas-work-api", name: "requests", creatorName: "Human" });
    db.createNode({
      id: "node-intent-api",
      canvasId: "canvas-work-api",
      type: "text",
      creatorName: "Human",
      data: {
        intent: { status: "pending", prompt: "Plan the next release." },
      },
    });

    const url = new URL("http://localhost:3300/api/entities/ApiWorker/work");
    const req = new Request(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${loginBody.token}` },
    });
    const resp = await handleDashboardApi(req, url, "GET", engine, db);

    expect(resp?.status).toBe(200);
    const body = (await resp!.json()) as { items: { kind: string; action: string }[] };
    expect(body.items.some((item) => item.kind === "canvas_intent")).toBe(true);
    expect(body.items.some((item) => item.action.includes("canvas intent claim node-int"))).toBe(
      true,
    );
  });
});
