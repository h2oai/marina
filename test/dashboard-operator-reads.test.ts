// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import { createTestEngine } from "./engine-fixture";
import { MockConnection } from "./helpers";

const OPERATOR_READS = [
  "/api/keys",
  "/api/principals",
  "/api/federation/peers",
  "/api/operations/alerts",
];

describe("operator-only dashboard reads", () => {
  let world: ReturnType<typeof createTestEngine>;
  beforeEach(() => {
    resetHttpRateLimitersForTests();
    world = createTestEngine();
  });
  afterEach(() => world.dispose());

  function token(name: string, rank?: number): string {
    const connection = new MockConnection(crypto.randomUUID());
    world.engine.addConnection(connection);
    const result = world.engine.login(connection.id, name);
    if ("error" in result) throw new Error(result.error);
    if (rank !== undefined) world.engine.entities.get(result.entityId)!.properties.rank = rank;
    return result.token;
  }

  async function get(path: string, bearer: string): Promise<Response> {
    const url = new URL(`http://localhost:3300${path}`);
    const req = new Request(url, { headers: { Authorization: `Bearer ${bearer}` } });
    return (await handleDashboardApi(req, url, "GET", world.engine, world.db))!;
  }

  it("refuse an ordinary session with 403", async () => {
    world.db.saveApiKey({
      name: "prod",
      provider: "openai",
      encryptedValue: "x-1234",
      setBy: "Op",
    });
    const resident = token("Resident");
    for (const path of [...OPERATOR_READS, "/api/models?refresh=1"]) {
      const resp = await get(path, resident);
      expect({ path, status: resp.status }).toEqual({ path, status: 403 });
      expect(await resp.text()).not.toContain("prod");
    }
  });

  it("serve an operator", async () => {
    const operator = token("Boss", 9);
    for (const path of OPERATOR_READS) {
      const resp = await get(path, operator);
      expect({ path, status: resp.status }).toEqual({ path, status: 200 });
    }
  });
});
