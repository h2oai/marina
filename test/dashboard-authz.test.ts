// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { setRank } from "../src/engine/permissions";
import { grant } from "../src/engine/safety-gates";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

const TEST_DB = "test_dashboard_authz.db";

describe("dashboard privileged-op authorization (spawn)", () => {
  let db: MarinaDB;
  let engine: Engine;

  beforeEach(() => {
    process.env.MARINA_OPEN_API = undefined;
    delete process.env.MARINA_OPEN_API;
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Room" }));
  });

  afterEach(() => {
    delete process.env.MARINA_OPEN_API;
    db.close();
    cleanupDb(TEST_DB);
  });

  // Name-login via /api/command returns a session token for a fresh rank-0 entity.
  async function loginToken(name: string): Promise<string> {
    const url = new URL("http://localhost:3300/api/command");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, command: "look" }),
    });
    const resp = await handleDashboardApi(req, url, "POST", engine, db);
    return ((await resp!.json()) as { token: string }).token;
  }

  function spawnReq(token?: string): [URL, string, Request] {
    const url = new URL("http://localhost:3300/api/agents/spawn");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ name: "NewBot", model: "google/gemini-2.0-flash" }),
    });
    return [url, "POST", req];
  }

  function entityIdByName(name: string): string {
    const e = engine.entities.all().find((x) => x.name === name);
    if (!e) throw new Error(`entity ${name} not found`);
    return e.id;
  }

  it("rejects spawn from a signed-in non-admin with 403", async () => {
    const token = await loginToken("Rando");
    const [url, method, req] = spawnReq(token);
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(403);
  });

  it("rejects spawn with no auth (401) when open-API is off", async () => {
    const [url, method, req] = spawnReq();
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(401);
  });

  it("allows a sovereign admin (rank 9) past the authz gate", async () => {
    const token = await loginToken("Admin");
    const ent = engine.entities.all().find((x) => x.name === "Admin");
    if (ent) setRank(ent, 9);
    const [url, method, req] = spawnReq(token);
    const resp = await handleDashboardApi(req, url, method, engine, db);
    // Not 403/401 — authz passed (the spawn itself may 400 for a missing key,
    // which still proves authorization succeeded).
    expect(resp?.status).not.toBe(403);
    expect(resp?.status).not.toBe(401);
  });

  it("allows a user granted the agent.spawn gate past the authz gate", async () => {
    const token = await loginToken("Granted");
    grant(db, entityIdByName("Granted"), "agent.spawn");
    const [url, method, req] = spawnReq(token);
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).not.toBe(403);
    expect(resp?.status).not.toBe(401);
  });

  it("keeps dev open: MARINA_OPEN_API bypass allows spawn without a token", async () => {
    process.env.MARINA_OPEN_API = "true";
    const [url, method, req] = spawnReq();
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).not.toBe(403);
    expect(resp?.status).not.toBe(401);
  });
});
