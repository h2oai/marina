// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetChallengesForTests } from "../src/engine/challenges";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import { createTestEngine } from "./engine-fixture";
import { MockConnection } from "./helpers";

describe("GET /api/challenges/mine", () => {
  let world: ReturnType<typeof createTestEngine>;
  beforeEach(() => {
    resetHttpRateLimitersForTests();
    resetChallengesForTests();
    world = createTestEngine();
  });
  afterEach(() => world.dispose());

  function login(name: string) {
    const connection = new MockConnection(crypto.randomUUID());
    world.engine.addConnection(connection);
    const result = world.engine.login(connection.id, name);
    if ("error" in result) throw new Error(result.error);
    return result;
  }

  async function mine(bearer: string) {
    const url = new URL("http://localhost:3300/api/challenges/mine");
    const req = new Request(url, { headers: { Authorization: `Bearer ${bearer}` } });
    const resp = (await handleDashboardApi(req, url, "GET", world.engine, world.db))!;
    return {
      status: resp.status,
      body: (await resp.json()) as { answerable: unknown[]; raised: unknown[] },
    };
  }

  it("serves any session its own holds, never another's, and never the held input", async () => {
    const resident = login("Resident");
    const other = login("Other");
    // A rank-floored command from a newcomer is held, not refused outright.
    await world.engine.dispatchCommand(resident.entityId, "role create secretrole-v2");

    const own = await mine(resident.token);
    expect(own.status).toBe(200);
    expect(own.body.raised.length).toBe(1);
    const hold = own.body.raised[0] as Record<string, unknown>;
    expect(hold.requester).toBe("Resident");
    expect(Object.keys(hold).sort()).toEqual(
      ["expiresAt", "kind", "reason", "requester", "summary", "token"].sort(),
    );
    expect(JSON.stringify(own.body)).not.toContain('"command"');

    const theirs = await mine(other.token);
    expect(theirs.status).toBe(200);
    expect(theirs.body.raised).toEqual([]);
  });

  it("an empty world answers with two empty lists", async () => {
    const { token } = login("Quiet");
    expect((await mine(token)).body).toEqual({ answerable: [], raised: [] });
  });
});
