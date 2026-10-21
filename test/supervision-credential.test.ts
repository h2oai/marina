// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { grantGatesForRank } from "../src/engine/safety-gates";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import { MarinaDB } from "../src/persistence/database";
import { openSupervision } from "../src/routing/supervision-credential";
import { RoutingApiError } from "../src/sdk/routing-client";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";
import { scopeProcessState } from "./process-state";

const ON = { MARINA_SUPERVISED_RESIDENTS: "on" };
const OFF = { MARINA_SUPERVISED_RESIDENTS: undefined };

let directory: string;
let db: MarinaDB;
let engine: Engine;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "marina-supervision-"));
  db = new MarinaDB(join(directory, "world.db"));
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  resetHttpRateLimitersForTests();
});
afterEach(async () => {
  await engine.shutdown();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function person(name: string, conn = new MockConnection(`c-${name}`)) {
  engine.addConnection(conn);
  const login = engine.login(conn.id, name);
  if ("error" in login) throw new Error(login.error);
  const entity = engine.entities.get(login.entityId)!;
  entity.properties.rank = 9;
  grantGatesForRank(db, entity.id, 9);
  return { conn, entity, token: login.token };
}

/** The same person logging in again elsewhere: their world session is replaced. */
function loginAgain(token: string, name: string) {
  const conn = new MockConnection(`again-${name}-${Math.random()}`);
  engine.addConnection(conn);
  const result = engine.reconnect(conn.id, token);
  if ("error" in result) throw new Error(result.error);
  return result.token;
}

const inProcess = (async (input, init) => {
  const req = new Request(input, init);
  return (await handleDashboardApi(req, new URL(req.url), req.method, engine, db))!;
}) as typeof fetch;

async function call(token: string, path: string, method = "POST", body: unknown = {}) {
  const req = new Request(`http://local.test${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
  const res = (await handleDashboardApi(req, new URL(req.url), method, engine, db))!;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("supervision credential", () => {
  it("survives the person's next login; their old session token does not", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const owner = person("Owner");
    owner.conn.close?.();
    const hold = await openSupervision({
      url: "http://local.test",
      sessionToken: owner.token,
      fetch: inProcess,
    });
    expect(hold.held).toBe(true);
    const supervisor = await hold.client.join({
      clientKey: "supervisor:test",
      kind: "supervisor",
      label: "Local agents",
    });

    engine.removeConnection(owner.conn.id);
    const fresh = loginAgain(owner.token, "Owner");
    expect((await call(owner.token, "/api/routing/overview", "GET")).status).toBe(401);

    // The supervisor keeps working, as the same account.
    const run = await hold.client.join({ clientKey: "run:wren", kind: "claude", label: "worker" });
    expect(run.ownerId).toBe(supervisor.ownerId);
    expect((await call(fresh, `/api/routing/sessions/${run.id}`, "GET")).status).toBe(200);
    await hold.close();
  });

  it("can still enrol and revoke residents after the person logged in again", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const owner = person("Owner");
    const hold = await openSupervision({
      url: "http://local.test",
      sessionToken: owner.token,
      fetch: inProcess,
    });
    const run = await hold.client.join({ clientKey: "run:wren", kind: "claude", label: "worker" });
    const enrolled = await hold.client.enrolResident({ sessionId: run.id, name: "Wren" });
    expect(db.verifyWorkloadCredential(enrolled.credential.token)?.display_name).toBe("Wren");

    engine.removeConnection(owner.conn.id);
    const again = new MockConnection("c-again");
    engine.addConnection(again);
    const relogin = engine.reconnect(again.id, owner.token);
    if ("error" in relogin) throw new Error(relogin.error);
    // The person leaves; their entity is evicted while the supervisor runs on.
    engine.removeConnection(again.id, "explicit");
    expect(engine.entities.findAgentByName("Owner")).toBeUndefined();

    const second = await hold.client.join({ clientKey: "run:fern", kind: "codex", label: "w2" });
    const fern = await hold.client.enrolResident({ sessionId: second.id, name: "Fern" });
    expect(db.getAgentConfig("Fern")?.spawned_by).toBe("Owner");
    expect((await hold.client.revokeResident("Fern", second.id)).revoked).toBeGreaterThan(0);
    expect(db.verifyWorkloadCredential(fern.credential.token)).toBeUndefined();
    expect((await hold.client.revokeResident("Wren", run.id)).revoked).toBeGreaterThan(0);
    expect(db.verifyWorkloadCredential(enrolled.credential.token)).toBeUndefined();
    await hold.close();
  });

  it("reaches the routing API only and never speaks for the person", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const owner = person("Owner");
    const issued = await call(owner.token, "/api/routing/supervision");
    const token = issued.body.token as string;
    expect(token.startsWith("marina-routing-")).toBe(true);

    // Not a world session: no login, reconnect, dashboard or command surface.
    expect(engine.authenticate(token)).toBeNull();
    const conn = new MockConnection("c-replay");
    engine.addConnection(conn);
    expect("error" in engine.reconnect(conn.id, token)).toBe(true);
    for (const path of ["/api/ops/overview", "/api/entities", "/api/challenges"]) {
      const res = await call(token, path, "GET");
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("unauthorized");
    }

    // Inside routing: no controls, sends or channel posts, and no minting more.
    const run = (
      await call(token, "/api/routing/sessions", "POST", {
        clientKey: "run:x",
        kind: "claude",
        label: "x",
      })
    ).body as { id: string };
    for (const path of [
      `/api/routing/sessions/${run.id}/control`,
      `/api/routing/sessions/${run.id}/messages`,
      `/api/routing/sessions/${run.id}/channels/c1/messages`,
    ]) {
      const res = await call(token, path, "POST", {});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("supervision_scope");
    }
    // Reads and lifecycle calls the supervisor never makes answer only the
    // person's own session (an explicit allowlist, not a denylist).
    for (const [path, method] of [
      ["/api/routing/overview", "GET"],
      ["/api/routing/sessions", "GET"],
      [`/api/routing/sessions/${run.id}`, "GET"],
      [`/api/routing/sessions/${run.id}/events`, "GET"],
      [`/api/routing/sessions/${run.id}/inbox`, "GET"],
      [`/api/routing/sessions/${run.id}/heartbeat`, "POST"],
      ["/api/routing/room-log", "GET"],
    ] as const) {
      const res = await call(token, path, method, method === "POST" ? {} : undefined);
      expect({ path, status: res.status, code: res.body.code }).toEqual({
        path,
        status: 403,
        code: "supervision_scope",
      });
    }
    // Publishing the run's own output stays open to the supervisor.
    const published = await call(token, `/api/routing/sessions/${run.id}/events`, "POST", {
      events: [{ id: "e1", kind: "status", payload: { state: "idle" } }],
    });
    expect(published.status).toBe(200);
    expect((await call(token, "/api/routing/supervision")).body.code).toBe("session_required");
  });

  it("renews into a fresh credential, revokes on close, and refuses agents and banned people", async () => {
    using _state = scopeProcessState({ env: ON, rateLimitBypass: true });
    const owner = person("Owner");
    const first = (await call(owner.token, "/api/routing/supervision")).body;
    const renewed = (await call(first.token as string, "/api/routing/supervision/renew")).body;
    expect(renewed.token).not.toBe(first.token);
    // A live credential is out of scope here (403); a revoked one is unknown (401).
    expect((await call(first.token as string, "/api/routing/overview", "GET")).status).toBe(401);
    expect((await call(renewed.token as string, "/api/routing/overview", "GET")).status).toBe(403);
    expect((await call(renewed.token as string, "/api/routing/supervision/revoke")).body).toEqual({
      revoked: true,
    });
    expect((await call(renewed.token as string, "/api/routing/overview", "GET")).status).toBe(401);

    // An agent account never supervises.
    db.ensurePrincipal({ type: "agent", displayName: "Helper" });
    const helper = person("Helper");
    const refused = await call(helper.token, "/api/routing/supervision");
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("person_required");

    // A banned person's credential stops working.
    const live = (await call(owner.token, "/api/routing/supervision")).body.token as string;
    db.addBan("Owner", "Operator", "test");
    expect((await call(live, "/api/routing/overview", "GET")).status).toBe(401);
  });
});

describe("switch off", () => {
  it("offers no supervision endpoint and keeps the session token", async () => {
    using _state = scopeProcessState({ env: OFF, rateLimitBypass: true });
    const owner = person("Owner");
    const unknown = await call(owner.token, "/api/routing/nonexistent");
    expect(await call(owner.token, "/api/routing/supervision")).toEqual(unknown);
    // A supervision-shaped bearer is just an invalid session token.
    const invalid = await call("not-a-session", "/api/routing/overview", "GET");
    expect(await call("marina-routing-x", "/api/routing/overview", "GET")).toEqual(invalid);
    const hold = await openSupervision({
      url: "http://local.test",
      sessionToken: owner.token,
      fetch: inProcess,
    });
    expect(hold.held).toBe(false);
    await expect(hold.client.overview()).resolves.toBeDefined();
    await hold.close();
  });

  it("an older server without the endpoint leaves the supervisor on its session token", async () => {
    using _state = scopeProcessState({ env: OFF, rateLimitBypass: true });
    const owner = person("Owner");
    const hold = await openSupervision({
      url: "http://local.test",
      sessionToken: owner.token,
      fetch: (async () =>
        Response.json({ error: "Unknown", code: "not_found" }, { status: 404 })) as never,
    });
    expect(hold.held).toBe(false);
    await expect(
      openSupervision({
        url: "http://local.test",
        sessionToken: owner.token,
        fetch: (async () => Response.json({ error: "x" }, { status: 500 })) as never,
      }),
    ).rejects.toBeInstanceOf(RoutingApiError);
  });
});
