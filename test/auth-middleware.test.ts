// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import {
  authenticateRequest,
  DESKTOP_OPERATOR_ENTITY_ID,
  isOperatorPrincipal,
  OPEN_API_ENTITY_ID,
  refuseOpenApiWrite,
} from "../src/net/auth-middleware";
import { clientIp } from "../src/net/http-utils";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

describe("authenticateRequest — dashboard auth gate", () => {
  let db: MarinaDB;
  let engine: Engine;
  const dbPath = `/tmp/marina-authmw-test-${Date.now()}.db`;
  const prevOpenApi = process.env.MARINA_OPEN_API;
  const prevDesktopToken = process.env.MARINA_DESKTOP_API_TOKEN;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });

  afterEach(() => {
    if (prevOpenApi === undefined) delete process.env.MARINA_OPEN_API;
    else process.env.MARINA_OPEN_API = prevOpenApi;
    if (prevDesktopToken === undefined) delete process.env.MARINA_DESKTOP_API_TOKEN;
    else process.env.MARINA_DESKTOP_API_TOKEN = prevDesktopToken;
    db.close();
    cleanupDb(dbPath);
  });

  const reqWith = (token?: string) =>
    new Request("http://localhost/api/keys", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  it("rejects a missing token when open API is disabled", () => {
    process.env.MARINA_OPEN_API = "false";
    const result = authenticateRequest(reqWith(), engine);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.status).toBe(401);
  });

  it("allows a missing token through with the sentinel when open API is enabled", () => {
    process.env.MARINA_OPEN_API = "true";
    const result = authenticateRequest(reqWith(), engine);
    expect("entityId" in result).toBe(true);
    if ("entityId" in result) expect(result.entityId).toBe(OPEN_API_ENTITY_ID);
  });

  it("allows an invalid token through when open API is enabled", () => {
    process.env.MARINA_OPEN_API = "true";
    const result = authenticateRequest(reqWith("bogus-token"), engine);
    expect("entityId" in result).toBe(true);
    if ("entityId" in result) expect(result.entityId).toBe(OPEN_API_ENTITY_ID);
  });

  it("always honors a valid token with its real entity id, even in open mode", () => {
    process.env.MARINA_OPEN_API = "true";
    const conn = new MockConnection("c1");
    engine.addConnection(conn);
    const login = engine.login("c1", "Alice");
    if (!("token" in login) || "error" in login) throw new Error("login failed");

    const result = authenticateRequest(reqWith(login.token), engine);
    expect("entityId" in result).toBe(true);
    if ("entityId" in result) {
      expect(result.entityId).toBe(login.entityId);
      expect(result.entityId).not.toBe(OPEN_API_ENTITY_ID);
    }
  });

  it("rejects an invalid token when open API is disabled", () => {
    process.env.MARINA_OPEN_API = "false";
    const result = authenticateRequest(reqWith("bogus-token"), engine);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.status).toBe(401);
  });

  it("accepts only the process-scoped desktop capability token", () => {
    process.env.MARINA_OPEN_API = "false";
    process.env.MARINA_DESKTOP_API_TOKEN = "desktop-capability-token-at-least-32-chars";
    const valid = authenticateRequest(
      new Request("http://localhost/api/keys", {
        headers: { "X-Marina-Desktop-Token": process.env.MARINA_DESKTOP_API_TOKEN },
      }),
      engine,
    );
    const invalid = authenticateRequest(
      new Request("http://localhost/api/keys", {
        headers: { "X-Marina-Desktop-Token": "wrong-token-with-at-least-32-characters" },
      }),
      engine,
    );

    // The desktop capability token resolves to the trusted operator sentinel —
    // distinct from the dev-open bypass — so it can authorize privileged ops.
    expect("entityId" in valid && valid.entityId).toBe(DESKTOP_OPERATOR_ENTITY_ID);
    expect("entityId" in valid && isOperatorPrincipal(valid.entityId)).toBe(true);
    expect("error" in invalid && invalid.error.status).toBe(401);
  });

  it("classifies the open-API sentinel as non-operator (reads only)", () => {
    expect(isOperatorPrincipal(OPEN_API_ENTITY_ID)).toBe(false);
    expect(isOperatorPrincipal(DESKTOP_OPERATOR_ENTITY_ID)).toBe(true);
  });
});

describe("refuseOpenApiWrite — dev-open sentinel is read-only", () => {
  it("returns a 403 naming MARINA_OPEN_API for the open-API sentinel only", async () => {
    const refused = refuseOpenApiWrite(OPEN_API_ENTITY_ID, "http://localhost:5173");
    expect(refused?.status).toBe(403);
    const body = (await refused!.json()) as { error: string };
    expect(body.error).toContain("MARINA_OPEN_API");
    expect(body.error).toContain("read-only");
    // A provisioned desktop operator and a real entity are not refused.
    expect(refuseOpenApiWrite(DESKTOP_OPERATOR_ENTITY_ID, null)).toBeNull();
    expect(refuseOpenApiWrite("e_42" as EntityId, null)).toBeNull();
  });
});

describe("clientIp — socket peer unless MARINA_TRUST_PROXY", () => {
  const prev = process.env.MARINA_TRUST_PROXY;
  afterEach(() => {
    if (prev === undefined) delete process.env.MARINA_TRUST_PROXY;
    else process.env.MARINA_TRUST_PROXY = prev;
  });

  const spoofed = () =>
    new Request("http://localhost/api/x", {
      headers: { "X-Forwarded-For": "1.2.3.4, 5.6.7.8", "X-Real-IP": "9.9.9.9" },
    });
  const server = { requestIP: () => ({ address: "203.0.113.5" }) };

  it("uses the TCP peer and ignores forwarding headers by default", () => {
    delete process.env.MARINA_TRUST_PROXY;
    expect(clientIp(spoofed(), server)).toBe("203.0.113.5");
    expect(clientIp(spoofed(), "203.0.113.6")).toBe("203.0.113.6");
    expect(clientIp(spoofed())).toBe("unknown");
  });

  it("honors the first X-Forwarded-For hop only behind a declared trusted proxy", () => {
    process.env.MARINA_TRUST_PROXY = "true";
    expect(clientIp(spoofed(), server)).toBe("1.2.3.4");
    // No forwarding header ⇒ falls back to the peer even when trusting the proxy.
    expect(clientIp(new Request("http://localhost/api/x"), server)).toBe("203.0.113.5");
  });
});
