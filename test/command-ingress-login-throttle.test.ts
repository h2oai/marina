// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RateLimiter } from "../src/auth/rate-limiter";
import { Engine } from "../src/engine/engine";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { makeTestRoom } from "./helpers";

describe("/api/command login attempts", () => {
  let db: MarinaDB;
  let engine: Engine;
  beforeEach(() => {
    resetHttpRateLimitersForTests();
    db = new MarinaDB(":memory:");
    engine = new Engine({
      db,
      startRoom: roomId("test/start"),
      tickInterval: 60_000,
      loginRateLimiter: new RateLimiter({ maxTokens: 3, refillRate: 3, refillInterval: 60_000 }),
    });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
  });
  afterEach(async () => {
    engine.stop();
    await engine.drainCommands();
    await engine.shutdown();
    db.close();
  });

  async function post(name: string, peerIp: string): Promise<Response> {
    const url = new URL("http://localhost:3300/api/command");
    const req = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, command: "look" }),
    });
    return (await handleDashboardApi(req, url, "POST", engine, db, peerIp))!;
  }

  it("count against the per-IP login-attempt budget across requests", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await post(`Caller${i}`, "203.0.113.5")).status);
    expect(statuses).toEqual([200, 200, 200, 400]);
    const refused = (await post("Caller9", "203.0.113.5")).clone();
    expect(String(((await refused.json()) as { error?: string }).error)).toMatch(/login/i);
    // Another client address has its own budget.
    expect((await post("Other", "203.0.113.6")).status).toBe(200);
  });
});
