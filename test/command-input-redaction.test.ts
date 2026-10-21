// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import type { EngineEvent, EntityId } from "../src/types";
import { createTestEngine } from "./engine-fixture";
import { MockConnection } from "./helpers";
import { noProviderEnv } from "./hermetic-env";
import { scopeProcessState } from "./process-state";

const SECRET = "plainprovidersecret0123456789";

function commandInputs(events: readonly EngineEvent[]): string[] {
  return events.flatMap((e) => (e.type === "command" ? [e.input] : []));
}

describe("recorded command input never carries credentials", () => {
  let world: ReturnType<typeof createTestEngine> | undefined;
  afterEach(async () => {
    await world?.dispose();
    world = undefined;
  });

  it("key add and connect auth are recorded as <verb> <sub> [redacted]", async () => {
    using _state = scopeProcessState({
      trustProfile: "local",
      env: { MARINA_AUTONOMY: undefined, ...noProviderEnv() },
    });
    world = createTestEngine();
    const { entityId } = world.login("KeyOwner");
    await world.engine.processCommand(entityId, `key add mykey openai ${SECRET}`);
    await world.engine.processCommand(entityId, `connect auth svc bearer ${SECRET}`);
    await world.engine.processCommand(entityId, "say token sk-abcdefghijklmnopqrstu here");

    const live = commandInputs(world.engine.getEventLog());
    const stored = commandInputs(world.db.getRecentEvents(500));
    for (const inputs of [live, stored]) {
      expect(inputs.join("\n")).not.toContain(SECRET);
      expect(inputs.join("\n")).not.toContain("sk-abcdefghijklmnopqrstu");
      expect(inputs).toContain("key add [redacted]");
      expect(inputs).toContain("connect auth [redacted]");
    }
    expect(world.db.getApiKey("mykey")).toBeTruthy();
  });

  it("stored command events with a credential form in clear are removed on start", async () => {
    world = createTestEngine();
    const entity = "e_1" as EntityId;
    const at = Date.now();
    world.db.logEvent({
      type: "command",
      entity,
      input: `key add old openai ${SECRET}`,
      timestamp: at,
    });
    world.db.logEvent({
      type: "command",
      entity,
      input: `KEY ADD up openai ${SECRET}`,
      timestamp: at,
    });
    world.db.logEvent({
      type: "command",
      entity,
      input: `conn auth s bearer ${SECRET}`,
      timestamp: at,
    });
    world.db.logEvent({ type: "command", entity, input: "key add [redacted]", timestamp: at });
    world.db.logEvent({ type: "command", entity, input: "key list", timestamp: at });
    world.db.logEvent({ type: "command", entity, input: "look", timestamp: at });
    world.engine.start();
    world.engine.stop();
    const inputs = commandInputs(world.db.getRecentEvents(500));
    expect(inputs.join("\n")).not.toContain(SECRET);
    expect(inputs).toEqual(["key add [redacted]", "key list", "look"]);
  });
});

describe("GET /api/events", () => {
  let world: ReturnType<typeof createTestEngine> | undefined;
  afterEach(async () => {
    await world?.dispose();
    world = undefined;
  });

  it("never serves command events, to a resident or an operator", async () => {
    resetHttpRateLimitersForTests();
    world = createTestEngine();
    const { engine, db } = world;
    const login = (name: string) => {
      const connection = new MockConnection(crypto.randomUUID());
      engine.addConnection(connection);
      const result = engine.login(connection.id, name);
      if ("error" in result) throw new Error(result.error);
      return result;
    };
    const residentConn = login("Resident");
    const operatorConn = login("Operator");
    engine.entities.get(operatorConn.entityId)!.properties.rank = 9;
    await engine.processCommand(residentConn.entityId, "say hello there");
    await engine.processCommand(operatorConn.entityId, "say hi");
    expect(commandInputs(engine.getEventLog()).length).toBeGreaterThan(0);

    for (const { token } of [residentConn, operatorConn]) {
      const url = new URL("http://localhost:3300/api/events?limit=500");
      const req = new Request(url, { headers: { Authorization: `Bearer ${token}` } });
      const resp = await handleDashboardApi(req, url, "GET", engine, db);
      expect(resp?.status).toBe(200);
      const events = (await resp!.json()) as Array<{ type: string }>;
      expect(events.some((e) => e.type === "command")).toBe(false);
    }
  });
});
