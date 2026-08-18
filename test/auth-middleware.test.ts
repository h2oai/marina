// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { authenticateRequest, OPEN_API_ENTITY_ID } from "../src/net/auth-middleware";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

describe("authenticateRequest — dashboard auth gate", () => {
  let db: MarinaDB;
  let engine: Engine;
  const dbPath = `/tmp/marina-authmw-test-${Date.now()}.db`;
  const prevOpenApi = process.env.MARINA_OPEN_API;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });

  afterEach(() => {
    if (prevOpenApi === undefined) delete process.env.MARINA_OPEN_API;
    else process.env.MARINA_OPEN_API = prevOpenApi;
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
});
