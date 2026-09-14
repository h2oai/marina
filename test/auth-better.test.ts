// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { record as recordStanding } from "../src/agent/standing";
import {
  createBetterAuthProvider,
  type IdentitySession,
  type MarinaAuthProvider,
} from "../src/auth/better-auth-provider";
import { Engine } from "../src/engine/engine";
import { handleAuthApi } from "../src/net/auth-api";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

// Full bridge loop against the real better-auth provider: sign up → exchange a
// verified identity for a Marina session token bound to a NAMED entity.
describe("better-auth bridge", () => {
  const authDbPath = `/tmp/marina-ba-auth-${Date.now()}.db`;
  const marinaDbPath = `/tmp/marina-ba-main-${Date.now()}.db`;
  let provider: MarinaAuthProvider;
  let db: MarinaDB;
  let engine: Engine;

  const url = (path: string) => new URL(`http://localhost:3300${path}`);

  async function signUp(email: string, password: string, name: string): Promise<string> {
    const res = await provider.handler(
      new Request("http://localhost:3300/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name }),
      }),
    );
    expect(res.status).toBe(200);
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }

  beforeAll(() => {
    process.env.BETTER_AUTH_SECRET = "x".repeat(40);
    process.env.BETTER_AUTH_DB_PATH = authDbPath;
    provider = createBetterAuthProvider();
    db = new MarinaDB(marinaDbPath);
    engine = new Engine({
      startRoom: roomId("test/start"),
      tickInterval: 60_000,
      db,
      authRequired: true,
    });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });

  afterAll(() => {
    db.close();
    cleanupDb(marinaDbPath);
    cleanupDb(authDbPath);
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_DB_PATH;
  });

  it("reports auth required with the email method", async () => {
    const res = await handleAuthApi(
      new Request(url("/api/auth-status")),
      url("/api/auth-status"),
      "GET",
      engine,
      db,
      provider,
    );
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { required: boolean; methods: string[] };
    expect(body.required).toBe(true);
    expect(body.methods).toContain("email");
  });

  it("exchanges a signed-in identity for a Marina token bound to a named entity", async () => {
    const cookie = await signUp("creator@example.com", "supersecret123", "Creator");
    const req = new Request(url("/api/auth-session"), {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ handle: "creator" }),
    });
    const res = await handleAuthApi(req, url("/api/auth-session"), "POST", engine, db, provider);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { token: string; name: string };
    expect(body.name).toBe("creator");

    // The token resolves to the NAMED entity (not the email/auth user).
    const entityId = engine.authenticate(body.token);
    expect(entityId).toBeTruthy();
    expect(engine.entities.get(entityId!)?.name).toBe("creator");
    // The handle is bound to the verified subject + email for stable future logins.
    const user = db.getUserByName("creator");
    expect(user?.auth_email).toBe("creator@example.com");
    expect(user?.auth_subject).toBeTruthy();
    expect(db.getUserByAuthSubject(user!.auth_subject!)?.name).toBe("creator");
  });

  it("rejects exchange without a session", async () => {
    const req = new Request(url("/api/auth-session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "ghost" }),
    });
    const res = await handleAuthApi(req, url("/api/auth-session"), "POST", engine, db, provider);
    expect(res?.status).toBe(401);
  });

  it("refuses a handle already claimed by another identity", async () => {
    const cookie = await signUp("intruder@example.com", "supersecret123", "Intruder");
    const req = new Request(url("/api/auth-session"), {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ handle: "creator" }), // already bound above
    });
    const res = await handleAuthApi(req, url("/api/auth-session"), "POST", engine, db, provider);
    expect(res?.status).toBe(409);
  });
});

describe("better-auth social providers", () => {
  const dbPath = `/tmp/marina-ba-social-${Date.now()}.db`;
  const prev = {
    secret: process.env.BETTER_AUTH_SECRET,
    dbPath: process.env.BETTER_AUTH_DB_PATH,
    gid: process.env.GOOGLE_CLIENT_ID,
    gsec: process.env.GOOGLE_CLIENT_SECRET,
  };

  beforeAll(() => {
    process.env.BETTER_AUTH_SECRET = "x".repeat(40);
    process.env.BETTER_AUTH_DB_PATH = dbPath;
    process.env.GOOGLE_CLIENT_ID = "dummy-id";
    process.env.GOOGLE_CLIENT_SECRET = "dummy-secret";
  });
  afterAll(() => {
    cleanupDb(dbPath);
    process.env.BETTER_AUTH_SECRET = prev.secret;
    process.env.BETTER_AUTH_DB_PATH = prev.dbPath;
    process.env.GOOGLE_CLIENT_ID = prev.gid;
    process.env.GOOGLE_CLIENT_SECRET = prev.gsec;
  });

  it("enables a configured provider and yields an authorize URL", async () => {
    const provider = createBetterAuthProvider();
    expect(provider.socialProviders).toContain("google");
    expect(provider.methods).toEqual(expect.arrayContaining(["email", "google"]));

    const res = await provider.handler(
      new Request("http://localhost:3300/api/auth/sign-in/social", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "google",
          callbackURL: "http://localhost:3300/dashboard",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url?: string };
    expect(body.url).toContain("accounts.google.com");
    // The OAuth callback target is on our origin, as registered with the provider.
    expect(decodeURIComponent(body.url ?? "")).toContain("/api/auth/callback/google");
  });
});

describe("better-auth schema upgrades", () => {
  const dbPath = `/tmp/marina-ba-upgrade-${Date.now()}.db`;
  const previousSecret = process.env.BETTER_AUTH_SECRET;
  const previousDbPath = process.env.BETTER_AUTH_DB_PATH;

  afterAll(() => {
    cleanupDb(dbPath);
    if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = previousSecret;
    if (previousDbPath === undefined) delete process.env.BETTER_AUTH_DB_PATH;
    else process.env.BETTER_AUTH_DB_PATH = previousDbPath;
  });

  it("preserves provider keys when opening an auth database created by better-auth 1.6", () => {
    const legacy = new Database(dbPath);
    legacy.exec(`
      create table "account" (
        "id" text not null primary key,
        "accountId" text not null,
        "providerId" text not null,
        "userId" text not null,
        "accessToken" text, "refreshToken" text, "idToken" text,
        "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date,
        "scope" text, "password" text,
        "createdAt" date not null,
        "updatedAt" date not null
      );
      insert into "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt") values
        ('credential-row', 'user-1', 'credential', 'user-1', 0, 0),
        ('oauth-row', 'oauth-1', 'github', 'user-1', 0, 0);
    `);
    legacy.close();

    process.env.BETTER_AUTH_SECRET = "x".repeat(40);
    process.env.BETTER_AUTH_DB_PATH = dbPath;
    createBetterAuthProvider();

    const upgraded = new Database(dbPath, { readonly: true });
    const rows = upgraded.query(`SELECT "id", "providerId" FROM "account" ORDER BY "id"`).all() as {
      id: string;
      providerId: string;
    }[];
    upgraded.close();

    expect(rows).toEqual([
      { id: "credential-row", providerId: "credential" },
      { id: "oauth-row", providerId: "github" },
    ]);
  });
});

describe("better-auth 1.7 account migration", () => {
  const dbPath = `/tmp/marina-ba-173-${Date.now()}.db`;
  const previousSecret = process.env.BETTER_AUTH_SECRET;
  const previousDbPath = process.env.BETTER_AUTH_DB_PATH;
  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = "migration-test-secret".repeat(3);
    process.env.BETTER_AUTH_DB_PATH = dbPath;
  });
  afterEach(() => {
    cleanupDb(dbPath);
    if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = previousSecret;
    if (previousDbPath === undefined) delete process.env.BETTER_AUTH_DB_PATH;
    else process.env.BETTER_AUTH_DB_PATH = previousDbPath;
  });
  const emailRequest = (action: string, email = "existing@example.com") =>
    new Request(`http://localhost:3300/api/auth/${action}/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "preserved-password", name: "Existing" }),
    });

  function restoreOldAccountSchema(db: Database): void {
    // Recreate Marina's 1.7.0-1.7.2 layout around real password/session records.
    db.exec(`
      DROP TABLE marina_auth_schema;
      DROP INDEX account_providerId_accountId_idx;
      ALTER TABLE account ADD COLUMN issuer text NOT NULL DEFAULT 'local:credential';
      CREATE UNIQUE INDEX account_issuer_accountId_idx ON account (issuer, accountId);
    `);
  }

  it("preserves credentials and sessions, permits new sign-ups, and is idempotent", async () => {
    const original = createBetterAuthProvider();
    const signup = await original.handler(emailRequest("sign-up"));
    expect(signup.status).toBe(200);
    const cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
    const headers = new Headers({ cookie });
    const identity = await original.getIdentity(headers);
    expect(identity?.subject).toBeTruthy();
    const raw = new Database(dbPath);
    try {
      const before = raw.query(`SELECT id, userId, password FROM account`).get();
      restoreOldAccountSchema(raw);
      const upgraded = createBetterAuthProvider();
      expect(await upgraded.getIdentity(headers)).toEqual(identity);
      expect(raw.query(`SELECT id, userId, password FROM account`).get()).toEqual(before);
      expect((await upgraded.handler(emailRequest("sign-in"))).status).toBe(200);
      expect((await upgraded.handler(emailRequest("sign-up", "new@example.com"))).status).toBe(200);
      const reopened = createBetterAuthProvider();
      expect(await reopened.getIdentity(headers)).toEqual(identity);
      expect(raw.query(`SELECT version FROM marina_auth_schema ORDER BY version`).all()).toEqual([
        { version: 1 },
        { version: 2 },
      ]);
      expect(
        (raw.query(`PRAGMA table_info(account)`).all() as { name: string }[]).some(
          (column) => column.name === "issuer",
        ),
      ).toBe(false);
    } finally {
      raw.close();
    }
  });

  it("refuses ambiguous account keys atomically without merging identities", async () => {
    const original = createBetterAuthProvider();
    expect((await original.handler(emailRequest("sign-up"))).status).toBe(200);
    const raw = new Database(dbPath);
    try {
      restoreOldAccountSchema(raw);
      raw.exec(`
        INSERT INTO account (id, issuer, accountId, providerId, userId, createdAt, updatedAt)
        SELECT 'ambiguous', 'different-issuer', accountId, providerId, userId, createdAt, updatedAt
        FROM account LIMIT 1;
      `);
      const before = raw.query(`SELECT * FROM account ORDER BY id`).all();
      expect(() => createBetterAuthProvider()).toThrow("Resolve duplicate account keys");
      expect(raw.query(`SELECT * FROM account ORDER BY id`).all()).toEqual(before);
      expect(
        raw.query(`SELECT name FROM sqlite_master WHERE name = 'marina_auth_schema'`).get(),
      ).toBeNull();
      expect(
        raw
          .query(`SELECT name FROM sqlite_master WHERE name = 'account_issuer_accountId_idx'`)
          .get(),
      ).toBeTruthy();
    } finally {
      raw.close();
    }
  });
});

// FIX 2 — a verified identity must NOT be able to adopt a pre-existing ELEVATED
// entity (rank > 0 or standing-bearing) by claiming its handle. A stub provider
// lets us control the identity + emailVerified directly (real email sign-ups are
// unverified, so we can't mint an operator identity through the live provider).
describe("handle-claim elevation guard", () => {
  const dbPath = `/tmp/marina-ba-elevated-${Date.now()}.db`;
  let db: MarinaDB;
  let engine: Engine;
  let identity: IdentitySession;
  const prevAdmins = process.env.MARINA_AUTH_ADMIN_EMAILS;

  const url = (path: string) => new URL(`http://localhost:3300${path}`);

  // Minimal provider surface: only getIdentity is exercised by the claim path.
  const stubProvider: MarinaAuthProvider = {
    methods: ["email"],
    socialProviders: [],
    handler: async () => new Response(null, { status: 404 }),
    getIdentity: async () => identity,
  };

  async function claim(handle: string): Promise<Response> {
    const req = new Request(url("/api/auth-session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle }),
    });
    const res = await handleAuthApi(
      req,
      url("/api/auth-session"),
      "POST",
      engine,
      db,
      stubProvider,
    );
    return res!;
  }

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    identity = {
      subject: "new-verified-user",
      email: "newcomer@example.com",
      emailVerified: true,
    };
    delete process.env.MARINA_AUTH_ADMIN_EMAILS;
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
    if (prevAdmins === undefined) delete process.env.MARINA_AUTH_ADMIN_EMAILS;
    else process.env.MARINA_AUTH_ADMIN_EMAILS = prevAdmins;
  });

  it("refuses claiming a rank-elevated handle for a non-operator identity", async () => {
    db.createUser({ id: "u_boss", name: "boss", rank: 3 });

    const res = await claim("boss");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("handleElevated");
    expect(body.message).toContain("operator linking required");
  });

  it("refuses claiming a standing-bearing (rank-0) handle for a non-operator", async () => {
    // An online rank-0 entity that has accrued standing is still 'elevated'.
    const conn = new MockConnection("c_rich");
    engine.addConnection(conn);
    const login = engine.login("c_rich", "richie");
    expect("entityId" in login).toBe(true);
    const entityId = (login as { entityId: EntityId }).entityId;
    recordStanding(db, entityId, "richie", "task_complete", "task:1", 25);
    expect(db.getUserByName("richie")?.rank).toBe(0); // rank stays 0

    const res = await claim("richie");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("handleElevated");
  });

  it("lets an authorized operator email claim an elevated handle", async () => {
    db.createUser({ id: "u_boss2", name: "chief", rank: 4 });
    process.env.MARINA_AUTH_ADMIN_EMAILS = "newcomer@example.com";

    const res = await claim("chief");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; token: string };
    expect(body.name).toBe("chief");
    expect(body.token).toBeTruthy();
  });

  it("lets a fresh rank-0 no-standing handle be claimed normally", async () => {
    const res = await claim("freshname");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("freshname");
  });

  it("still rejects a handle bound to a different identity (handleTaken)", async () => {
    db.createUser({ id: "u_other", name: "owned", rank: 0 });
    db.bindAuthSubject("u_other", "some-other-subject", "owner@example.com");

    const res = await claim("owned");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("handleTaken");
  });
});
