// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { handleDashboardApi, projectEnvValueForRead } from "../src/net/dashboard-api";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_dashboard_api.db";

describe("dashboard-api HTTP authorization hardening", () => {
  let db: MarinaDB;
  let engine: Engine;
  const prevOpenApi = process.env.MARINA_OPEN_API;
  const prevDesktopToken = process.env.MARINA_DESKTOP_API_TOKEN;
  const prevAnthropic = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    delete process.env.MARINA_OPEN_API;
    delete process.env.MARINA_DESKTOP_API_TOKEN;
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });

  afterEach(() => {
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore("MARINA_OPEN_API", prevOpenApi);
    restore("MARINA_DESKTOP_API_TOKEN", prevDesktopToken);
    restore("ANTHROPIC_API_KEY", prevAnthropic);
    db.close();
    cleanupDb(TEST_DB);
  });

  let connCounter = 0;
  function loginToken(name: string): string {
    const conn = new MockConnection(`api-${connCounter++}`);
    engine.addConnection(conn);
    const login = engine.login(conn.id, name);
    if ("error" in login) throw new Error(`login failed: ${login.error}`);
    return login.token;
  }

  function jsonReq(
    path: string,
    method: string,
    opts?: { token?: string; desktopToken?: string; body?: unknown },
  ): [Request, URL, string] {
    const url = new URL(`http://localhost:3300${path}`);
    const headers: Record<string, string> = {};
    if (opts?.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts?.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts?.desktopToken) headers["X-Marina-Desktop-Token"] = opts.desktopToken;
    const req = new Request(url.toString(), {
      method,
      headers,
      body: opts?.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    return [req, url, method];
  }

  // ─── Finding 4: pre-auth ingress must not mint a usable token ──────────────

  it("does not return a session token from the unauthenticated /api/command ingress", async () => {
    const [req, url, method] = jsonReq("/api/command", "POST", {
      body: { name: "Ingressor", command: "look" },
    });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(200);
    const body = (await resp!.json()) as Record<string, unknown>;
    expect(body.token).toBeUndefined();
    expect(typeof body.name).toBe("string");
  });

  it("does not return a token from /api/ask either", async () => {
    const [req, url, method] = jsonReq("/api/ask", "POST", {
      body: { name: "Asker", query: "hello" },
    });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(200);
    const body = (await resp!.json()) as Record<string, unknown>;
    expect(body.token).toBeUndefined();
  });

  // ─── Finding 4: name-scoped memory reads are owner-only ────────────────────

  it("denies reading another entity's core memory / notes with a valid token", async () => {
    const aliceToken = loginToken("Alice");
    loginToken("Bob");
    db.setCoreMemory("Bob", "secret", "bob-only");
    db.createNote("Bob", "bob private note", roomId("test/start"));

    const [coreReq, coreUrl, coreMethod] = jsonReq("/api/memory/core/Bob", "GET", {
      token: aliceToken,
    });
    const coreResp = await handleDashboardApi(coreReq, coreUrl, coreMethod, engine, db);
    expect(coreResp?.status).toBe(403);

    const [notesReq, notesUrl, notesMethod] = jsonReq("/api/memory/notes/Bob", "GET", {
      token: aliceToken,
    });
    const notesResp = await handleDashboardApi(notesReq, notesUrl, notesMethod, engine, db);
    expect(notesResp?.status).toBe(403);

    const [selfReq, selfUrl, selfMethod] = jsonReq("/api/memory/core/Alice", "GET", {
      token: aliceToken,
    });
    const selfResp = await handleDashboardApi(selfReq, selfUrl, selfMethod, engine, db);
    expect(selfResp?.status).toBe(200);
  });

  it("lets the desktop operator read any entity's memory", async () => {
    const desktopToken = "desktop-capability-token-at-least-32-chars";
    process.env.MARINA_DESKTOP_API_TOKEN = desktopToken;
    loginToken("Bob");
    db.setCoreMemory("Bob", "secret", "bob-only");
    const [req, url, method] = jsonReq("/api/memory/core/Bob", "GET", { desktopToken });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(200);
  });

  // ─── Finding 5: /api/env is gated; security keys are always rejected ───────

  it("denies /api/env PUT without an operator capability", async () => {
    const token = loginToken("Rando");
    const [req, url, method] = jsonReq("/api/env", "PUT", {
      token,
      body: { vars: { START_ROOM: "hub/x" } },
    });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(403);
  });

  it("rejects editing security-relevant keys even for the desktop operator", async () => {
    const desktopToken = "desktop-capability-token-at-least-32-chars";
    process.env.MARINA_DESKTOP_API_TOKEN = desktopToken;
    const [req, url, method] = jsonReq("/api/env", "PUT", {
      desktopToken,
      body: { vars: { MARINA_ADMINS: "attacker" } },
    });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(403);
    // Never applied to the live process.
    expect(process.env.MARINA_ADMINS).not.toBe("attacker");
  });

  it("denies /api/env GET under the dev-open bypass (privileged, not read-open)", async () => {
    process.env.MARINA_OPEN_API = "true";
    const [req, url, method] = jsonReq("/api/env", "GET");
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(403);
  });

  // ─── SHOULD: GET /api/env never leaks a secret fragment ────────────────────

  it("projects secret env values to a bucket only — never a plaintext fragment", () => {
    const secret = projectEnvValueForRead(
      "ANTHROPIC_API_KEY",
      "sk-ant-supersecretvalue-abcdef123456",
      true,
    );
    expect(secret.value).toBe("");
    expect(secret.lengthBucket).toBe("medium");

    const unsetSecret = projectEnvValueForRead("DASHBOARD_PASSWORD", "", false);
    expect(unsetSecret.value).toBe("");
    expect(unsetSecret.lengthBucket).toBe("empty");

    // Non-secret operational vars keep their real value so the panel stays usable.
    const plain = projectEnvValueForRead("START_ROOM", "hub/crossroads", true);
    expect(plain.value).toBe("hub/crossroads");
    expect(plain.lengthBucket).toBeUndefined();
  });

  it("gates GET /api/env behind an operator capability and leaks no fragment", async () => {
    const desktopToken = "desktop-capability-token-at-least-32-chars";
    process.env.MARINA_DESKTOP_API_TOKEN = desktopToken;
    const [req, url, method] = jsonReq("/api/env", "GET", { desktopToken });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(200);
    const entries = (await resp!.json()) as Array<{
      key: string;
      value: string;
      isSecret: boolean;
      lengthBucket?: string;
    }>;
    for (const e of entries) {
      if (e.isSecret) expect(e.value).toBe("");
    }
  });

  // ─── Finding 5 / item 5: OPEN_API sentinel cannot spawn / manage keys ──────

  it("denies key management under the dev-open bypass", async () => {
    process.env.MARINA_OPEN_API = "true";
    const [req, url, method] = jsonReq("/api/keys", "POST", {
      body: { name: "k", provider: "anthropic", value: "v" },
    });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(403);
  });

  it("denies POST /api/keys/:id/test without the key.manage capability", async () => {
    // Testing a stored provider key probes upstream with the operator's key
    // (can trigger spend) — a plain authenticated caller must be refused.
    const aliceToken = loginToken("Alice");
    const [req, url, method] = jsonReq("/api/keys/anthropic/test", "POST", { token: aliceToken });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(403);
  });

  it("denies POST /api/keys/:id/test under the dev-open bypass", async () => {
    process.env.MARINA_OPEN_API = "true";
    const [req, url, method] = jsonReq("/api/keys/anthropic/test", "POST");
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(403);
  });

  // ─── Finding 3: /api/notes/:id is owner/operator-scoped for private notes ──

  it("denies /api/notes/:id for another entity's private note", async () => {
    const aliceToken = loginToken("Alice");
    loginToken("Bob");
    const noteId = db.createNote("Bob", "bob private note", roomId("test/start"));

    const [req, url, method] = jsonReq(`/api/notes/${noteId}`, "GET", { token: aliceToken });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(403);
  });

  it("allows /api/notes/:id for a shared-pool note (intentionally readable)", async () => {
    const aliceToken = loginToken("Alice");
    loginToken("Bob");
    db.createMemoryPool("pool-shared", "shared", "Bob");
    const noteId = db.addPoolNote("pool-shared", "Bob", "shared coordination note");

    const [req, url, method] = jsonReq(`/api/notes/${noteId}`, "GET", { token: aliceToken });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(200);
    const body = (await resp!.json()) as { content: string; poolId: string | null };
    expect(body.content).toBe("shared coordination note");
    expect(body.poolId).toBe("pool-shared");
  });

  it("lets the owner read their own private note via /api/notes/:id", async () => {
    const bobToken = loginToken("Bob");
    const noteId = db.createNote("Bob", "bob private note", roomId("test/start"));
    const [req, url, method] = jsonReq(`/api/notes/${noteId}`, "GET", { token: bobToken });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(200);
  });

  // ─── Finding 4: /api/entities/:name/brief hides goal/focus from non-owners ─

  it("strips goal/focus from another entity's brief for a non-owner", async () => {
    const aliceToken = loginToken("Alice");
    loginToken("Bob");
    db.setCoreMemory("Bob", "goal", "conquer the market");
    db.setCoreMemory("Bob", "focus", "the secret plan");

    const [req, url, method] = jsonReq("/api/entities/Bob/brief", "GET", { token: aliceToken });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(200);
    const body = (await resp!.json()) as { goal: unknown; focus: unknown; poolCount: number };
    expect(body.goal).toBeNull();
    expect(body.focus).toBeNull();
    // Non-sensitive counts are still returned so the panel stays useful.
    expect(typeof body.poolCount).toBe("number");
  });

  it("shows goal/focus to the entity itself on its own brief", async () => {
    const bobToken = loginToken("Bob");
    db.setCoreMemory("Bob", "goal", "conquer the market");
    db.setCoreMemory("Bob", "focus", "the secret plan");

    const [req, url, method] = jsonReq("/api/entities/Bob/brief", "GET", { token: bobToken });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(200);
    const body = (await resp!.json()) as { goal: unknown; focus: unknown };
    expect(body.goal).toBe("conquer the market");
    expect(body.focus).toBe("the secret plan");
  });

  // ─── authorizePrivileged must reject a standing-only (supervisedOnly) gate ──

  it("denies /api/agents/spawn for a standing-only (supervisedOnly) gate holder", async () => {
    const token = loginToken("Farmer");
    const entityId = engine.authenticate(token)!;
    // Standing >= agent.spawn.minStanding (40) but NO unsupervised competence →
    // checkGate().ok would be true (supervisedOnly); checkUnattendedGate().ok is false.
    const taskId = db.createTask({ title: "t", creatorId: entityId, creatorName: "Farmer" });
    db.recordStandingEarned(entityId, "Farmer", taskId, 80);

    const [req, url, method] = jsonReq("/api/agents/spawn", "POST", {
      token,
      body: { name: "helper", model: "x/y" },
    });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(403);
    const body = (await resp!.json()) as { error: string };
    expect(body.error).toContain("agent.spawn");
  });

  it("allows /api/agents/spawn once agent.spawn is granted (unsupervised)", async () => {
    const { grant } = await import("../src/engine/safety-gates");
    const token = loginToken("Grantee");
    const entityId = engine.authenticate(token)!;
    grant(db, entityId, "agent.spawn");

    const [req, url, method] = jsonReq("/api/agents/spawn", "POST", {
      token,
      body: { name: "helper", model: "x/y" },
    });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    // Authorization passed — whatever handleAgentSpawn returns, it is NOT the
    // authorizePrivileged 403 "requires an admin or the ... capability" refusal.
    if (resp?.status === 403) {
      const body = (await resp.json()) as { error: string };
      expect(body.error).not.toContain("requires an admin");
    }
  });

  // ─── Finding 5: global-config mutation routes require an operator gate ──────

  it("denies /api/default-model PUT without an operator capability", async () => {
    const token = loginToken("Rando");
    const [req, url, method] = jsonReq("/api/default-model", "PUT", {
      token,
      body: { model: "openrouter/openai/gpt-4o" },
    });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(403);
    // Setting was never written.
    expect(db.getSetting("default_model")).toBeUndefined();
  });

  it("denies /api/default-model DELETE without an operator capability", async () => {
    const token = loginToken("Rando");
    const [req, url, method] = jsonReq("/api/default-model", "DELETE", { token });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(403);
  });

  it("denies /api/default-model PUT for the dev-open (OPEN_API) sentinel", async () => {
    process.env.MARINA_OPEN_API = "true";
    const [req, url, method] = jsonReq("/api/default-model", "PUT", {
      body: { model: "openrouter/openai/gpt-4o" },
    });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(403);
    expect(db.getSetting("default_model")).toBeUndefined();
  });

  it("denies /api/model-endpoint PUT without an operator capability", async () => {
    const token = loginToken("Rando");
    const [req, url, method] = jsonReq("/api/model-endpoint", "PUT", {
      token,
      body: { mode: "open" },
    });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(403);
  });

  it("denies /api/adapters POST without an operator capability", async () => {
    const token = loginToken("Rando");
    const [req, url, method] = jsonReq("/api/adapters", "POST", {
      token,
      body: { type: "discord", enabled: true },
    });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(403);
  });

  it("denies /api/adapters POST for the dev-open (OPEN_API) sentinel", async () => {
    process.env.MARINA_OPEN_API = "true";
    const [req, url, method] = jsonReq("/api/adapters", "POST", {
      body: { type: "discord", enabled: true },
    });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(403);
  });

  it("denies /api/adapters PATCH and DELETE without an operator capability", async () => {
    const token = loginToken("Rando");
    const [patchReq, patchUrl, patchMethod] = jsonReq("/api/adapters/discord", "PATCH", {
      token,
      body: { enabled: false },
    });
    const patchResp = await handleDashboardApi(patchReq, patchUrl, patchMethod, engine, db);
    expect(patchResp?.status).toBe(403);

    const [delReq, delUrl, delMethod] = jsonReq("/api/adapters/discord", "DELETE", { token });
    const delResp = await handleDashboardApi(delReq, delUrl, delMethod, engine, db);
    expect(delResp?.status).toBe(403);
  });

  it("lets the desktop operator mutate global config (default-model PUT)", async () => {
    const desktopToken = "desktop-capability-token-at-least-32-chars";
    process.env.MARINA_DESKTOP_API_TOKEN = desktopToken;
    const [req, url, method] = jsonReq("/api/default-model", "PUT", {
      desktopToken,
      body: { model: "openrouter/openai/gpt-4o" },
    });
    const resp = await handleDashboardApi(req, url, method, engine, db);
    expect(resp?.status).toBe(200);
    expect(db.getSetting("default_model")).toBe("openrouter/openai/gpt-4o");
  });

  // ─── Canvas-scope authorization: GET /api/entities/:name/canvas ────────────
  // This route resolves (and lazily creates) an entity's PRIVATE scope:"entity"
  // workspace. It must apply the same owner/operator predicate as the canvas WS
  // + HTTP surfaces, and must NOT materialize a canvas on a non-owner's behalf.
  describe("per-entity canvas resolution scoping", () => {
    it("denies a non-owner authenticated GET (404) and does NOT create the canvas", async () => {
      loginToken("Alice");
      const bobToken = loginToken("Bob");
      const alice = engine.findEntityGlobal("Alice")!;
      const [req, url, method] = jsonReq("/api/entities/Alice/canvas", "GET", { token: bobToken });
      const resp = await handleDashboardApi(req, url, method, engine, db, "203.0.113.9");
      expect(resp?.status).toBe(404);
      // Must not have lazily materialized Alice's private workspace.
      expect(db.getEntityCanvas(alice.id)).toBeUndefined();
    });

    it("allows the owner to resolve (and lazily create) their own canvas", async () => {
      const aliceToken = loginToken("Alice");
      const alice = engine.findEntityGlobal("Alice")!;
      const [req, url, method] = jsonReq("/api/entities/Alice/canvas", "GET", {
        token: aliceToken,
      });
      const resp = await handleDashboardApi(req, url, method, engine, db, "203.0.113.9");
      expect(resp?.status).toBe(200);
      const body = (await resp!.json()) as { scope: string; scopeId: string };
      expect(body.scope).toBe("entity");
      expect(body.scopeId).toBe(alice.id);
      expect(db.getEntityCanvas(alice.id)).toBeDefined();
    });

    it("allows the desktop operator (zero-config desktop) to resolve any entity's canvas", async () => {
      const desktopToken = "desktop-capability-token-at-least-32-chars";
      process.env.MARINA_DESKTOP_API_TOKEN = desktopToken;
      loginToken("Alice");
      const [req, url, method] = jsonReq("/api/entities/Alice/canvas", "GET", { desktopToken });
      const resp = await handleDashboardApi(req, url, method, engine, db, "127.0.0.1");
      expect(resp?.status).toBe(200);
    });

    it("returns an EXISTING private canvas to the owner but 404 to a non-owner", async () => {
      const aliceToken = loginToken("Alice");
      const bobToken = loginToken("Bob");
      const alice = engine.findEntityGlobal("Alice")!;
      // Pre-create Alice's private canvas so the read path (not creation) is tested.
      db.ensureEntityCanvas(alice.id, alice.name, alice.name);

      const [oReq, oUrl, oMethod] = jsonReq("/api/entities/Alice/canvas", "GET", {
        token: aliceToken,
      });
      const ownerResp = await handleDashboardApi(oReq, oUrl, oMethod, engine, db, "203.0.113.9");
      expect(ownerResp?.status).toBe(200);

      const [bReq, bUrl, bMethod] = jsonReq("/api/entities/Alice/canvas", "GET", {
        token: bobToken,
      });
      const bobResp = await handleDashboardApi(bReq, bUrl, bMethod, engine, db, "203.0.113.9");
      expect(bobResp?.status).toBe(404);
    });
  });
});
