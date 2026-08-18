// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  createBetterAuthProvider,
  type MarinaAuthProvider,
} from "../src/auth/better-auth-provider";
import { Engine } from "../src/engine/engine";
import { handleAuthApi } from "../src/net/auth-api";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

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
    process.env.BETTER_AUTH_SECRET = undefined;
    process.env.BETTER_AUTH_DB_PATH = undefined;
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
    const cookie = await signUp("creator@h2o.ai", "supersecret123", "Creator");
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
    expect(user?.auth_email).toBe("creator@h2o.ai");
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
    const cookie = await signUp("intruder@h2o.ai", "supersecret123", "Intruder");
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
