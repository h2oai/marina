// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { decisionHealth } from "../src/decisions/health";
import { Engine } from "../src/engine/engine";
import { computeReadiness } from "../src/engine/readiness";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { MarinaDB } from "../src/persistence/database";
import type { EngineEvent } from "../src/types";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = `test_macros_api_${process.pid}.db`;

describe("GET /api/macros is scoped to the caller", () => {
  let db: MarinaDB;
  let engine: Engine;
  let n = 0;

  beforeEach(() => {
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

  function login(name: string): { token: string; id: string } {
    const conn = new MockConnection(`macro-${n++}`);
    engine.addConnection(conn);
    const result = engine.login(conn.id, name);
    if ("error" in result) throw new Error(result.error);
    return { token: result.token, id: conn.entity! };
  }

  async function list(token?: string): Promise<string[]> {
    const url = new URL("http://localhost:3300/api/macros");
    const req = new Request(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const res = await handleDashboardApi(req, url, "GET", engine, db);
    expect(res?.status).toBe(200);
    return ((await res!.json()) as { name: string }[]).map((m) => m.name);
  }

  it("returns the caller's own macros plus shared system ones — never another entity's", async () => {
    const alice = login("Alice");
    const bob = login("Bob");
    engine.processCommand(alice.id as never, "macro create morning brief social");
    engine.processCommand(bob.id as never, "macro create secretplan tell Alice hi");
    db.createMacro("tour", "system", "guide");

    expect(await list(alice.token)).toEqual(["morning", "tour"]);
    expect(await list(bob.token)).toEqual(["secretplan", "tour"]);
  });

  it("gives the dev-open sentinel only the shared macros", async () => {
    const alice = login("Alice");
    engine.processCommand(alice.id as never, "macro create morning brief social");
    db.createMacro("tour", "system", "guide");
    process.env.MARINA_OPEN_API = "true";
    expect(await list()).toEqual(["tour"]);
  });
});

describe("decision backend health", () => {
  const at = 1_000_000_000;
  const decision = (error?: string, t = at): EngineEvent => ({
    type: "agent_decision",
    name: "Builder",
    stage: "gate",
    verdict: error ? "block" : "allow",
    subject: "marina_command",
    reason: "",
    signals: {},
    ...(error ? { error } : {}),
    timestamp: t,
  });

  it("is degraded only with enough failures that are most of the recent decisions", () => {
    expect(decisionHealth([], at).status).toBe("ok");
    const two = [decision("timeout"), decision("timeout")];
    expect(decisionHealth(two, at).status).toBe("ok"); // below the minimum count
    const three = [...two, decision("HTTP 401")];
    expect(decisionHealth(three, at)).toMatchObject({
      status: "degraded",
      total: 3,
      errors: 3,
      lastError: "HTTP 401",
    });
    const mostlyFine = [...three, ...Array.from({ length: 4 }, () => decision())];
    expect(decisionHealth(mostlyFine, at).status).toBe("ok"); // 3 of 7 < 50%
    const stale = three.map((e) => ({ ...e, timestamp: at - 16 * 60_000 }));
    expect(decisionHealth(stale, at).total).toBe(0); // outside the 15 min window
  });

  it("marks the readiness check degraded so the header badge warns", () => {
    const keys = ["MARINA_DECISIONS", "MARINA_DECISION_BASE_URL", "MARINA_DECISION_MODEL"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.MARINA_DECISIONS = "decisions-api";
    process.env.MARINA_DECISION_BASE_URL = "http://localhost:9";
    process.env.MARINA_DECISION_MODEL = "stub-jev";
    const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000 });
    try {
      const check = () => computeReadiness(engine).checks.find((c) => c.id === "decisions");
      expect(check()?.status).toBe("ok");
      for (let i = 0; i < 3; i++) engine.logEvent(decision("decision call timed out", Date.now()));
      expect(check()).toMatchObject({ status: "degraded" });
      expect(check()?.detail).toContain("3 of the last 3 decisions failed");
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
