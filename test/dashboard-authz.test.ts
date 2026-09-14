// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { setRank } from "../src/engine/permissions";
import { grant } from "../src/engine/safety-gates";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_dashboard_authz.db";

describe("dashboard privileged-op authorization (spawn)", () => {
  let db: MarinaDB;
  let engine: Engine;

  beforeEach(() => {
    delete process.env.MARINA_OPEN_API;
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

  // Mint a real session token for a fresh rank-0 entity via a direct login.
  // (The pre-auth /api/command ingress deliberately no longer returns a usable
  // token — see the "ingress" test below — so tests mint one the normal way.)
  let connCounter = 0;
  function loginToken(name: string): string {
    const conn = new MockConnection(`authz-${connCounter++}`);
    engine.addConnection(conn);
    const login = engine.login(conn.id, name);
    if ("error" in login) throw new Error(`login failed: ${login.error}`);
    return login.token;
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

  it("denies spawn under MARINA_OPEN_API: dev-open must not auto-authorize privileged ops", async () => {
    // The dev bypass may open reads, but privileged/destructive operations
    // (agent spawn, key/env management) require a real operator credential —
    // otherwise an exposed dev instance hands full control to any anonymous caller.
    process.env.MARINA_OPEN_API = "true";
    const [url, method, req] = spawnReq();
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(403);
  });

  // ─── Memory job cancel (src/net/memory-observability.ts) ────────────────────
  it("only the requester or an operator may cancel a memory assistance job", async () => {
    const ownerToken = await loginToken("Owner");
    const helperToken = await loginToken("Helper");
    const randoToken = await loginToken("Rando");
    const created = await residentMemoryOperation(db, "Owner", {
      operation: "assist_create",
      key: "authz-create",
      input: { role: "librarian", worker_name: "Helper", task: "Find the deployment note" },
    });
    const jobId = (created.result as { id: string }).id;
    const cancelReq = (token?: string): [URL, string, Request] => {
      const url = new URL(`http://localhost:3300/api/memory/jobs/${jobId}/cancel`);
      const req = new Request(url.toString(), {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      return [url, "POST", req];
    };

    // No session → 401; unrelated resident → the job does not exist for it.
    let [url, method, req] = cancelReq();
    expect((await handleDashboardApi(req, url, method, engine, db))?.status).toBe(401);
    [url, method, req] = cancelReq(randoToken);
    expect((await handleDashboardApi(req, url, method, engine, db))?.status).toBe(404);
    // The worker may see the job but not withdraw it.
    [url, method, req] = cancelReq(helperToken);
    expect((await handleDashboardApi(req, url, method, engine, db))?.status).toBe(403);
    // Dev-open opens reads only — never a write.
    process.env.MARINA_OPEN_API = "true";
    [url, method, req] = cancelReq();
    expect((await handleDashboardApi(req, url, method, engine, db))?.status).toBe(403);
    delete process.env.MARINA_OPEN_API;
    // Still open after every refusal; the requester withdraws it.
    [url, method, req] = cancelReq(ownerToken);
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(200);
    expect(await resp!.json()).toMatchObject({ id: jobId, state: "cancelled", workOpen: false });
    // The task text is visible to the requester on its own job view.
    const [gUrl, gMethod, gReq] = [
      new URL(`http://localhost:3300/api/memory/jobs/${jobId}`),
      "GET",
      new Request(`http://localhost:3300/api/memory/jobs/${jobId}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      }),
    ] as const;
    const view = (await (await handleDashboardApi(gReq, gUrl, gMethod, engine, db))!.json()) as {
      task?: string;
      state: string;
    };
    expect(view).toMatchObject({ state: "cancelled", task: "Find the deployment note" });
  });
});
