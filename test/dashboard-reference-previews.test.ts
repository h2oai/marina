// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The reads behind a reference preview in the dashboard: one channel post by
// id, and one tell by id — the tell for its sender and recipient only, with
// the same 404 for anyone else as for an id that does not exist.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { resetHttpRateLimitersForTests } from "../src/net/http-utils";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, tempDbPath } from "./helpers";

const TEST_DB = tempDbPath("test_dashboard_reference_previews.db");

describe("reference preview reads", () => {
  let db: MarinaDB;
  let engine: Engine;
  const prevOpenApi = process.env.MARINA_OPEN_API;
  const tokens = new Map<string, string>();
  const conns = new Map<string, MockConnection>();

  beforeEach(() => {
    resetHttpRateLimitersForTests();
    delete process.env.MARINA_OPEN_API;
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    for (const name of ["Alice", "Bob", "Carol"]) {
      const conn = new MockConnection(`ref-${name}`);
      engine.addConnection(conn);
      const login = engine.login(conn.id, name);
      if ("error" in login) throw new Error(login.error);
      tokens.set(name, login.token);
      conns.set(name, conn);
    }
  });

  afterEach(() => {
    if (prevOpenApi === undefined) delete process.env.MARINA_OPEN_API;
    else process.env.MARINA_OPEN_API = prevOpenApi;
    db.close();
    cleanupDb(TEST_DB);
  });

  const get = async (path: string, as: string) => {
    const url = new URL(`http://localhost:3300${path}`);
    const req = new Request(url.toString(), {
      headers: { Authorization: `Bearer ${tokens.get(as)}` },
    });
    return (await handleDashboardApi(req, url, "GET", engine, db))!;
  };
  const entity = (name: string) => conns.get(name)!.entity!;

  it("reads one post of a channel by id, with what it answers", async () => {
    engine.processCommand(entity("Alice"), "channel create general");
    engine.processCommand(entity("Bob"), "channel join general");
    engine.processCommand(entity("Alice"), "channel send general Merge it? yes or no");
    const id = conns.get("Bob")!.messages.at(-1)!.data?.messageId as number;
    const res = await get(`/api/coordination/channels/general/messages/${id}`, "Bob");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id,
      channel: "general",
      sender_name: "Alice",
      content: "Merge it? yes or no",
    });
    expect((await get(`/api/coordination/channels/general/messages/999999`, "Bob")).status).toBe(
      404,
    );
    expect((await get(`/api/coordination/channels/nope/messages/${id}`, "Bob")).status).toBe(404);
  });

  it("a tell previews for its sender and recipient only", async () => {
    engine.processCommand(entity("Alice"), "tell Bob the key is in the drawer");
    const id = conns.get("Bob")!.messages.find((p) => p.tag === "tell")!.data?.messageId as number;
    for (const reader of ["Alice", "Bob"]) {
      const res = await get(`/api/coordination/tells/${id}`, reader);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id,
        sender_name: "Alice",
        target_name: "Bob",
        content: "the key is in the drawer",
      });
    }
    const outsider = await get(`/api/coordination/tells/${id}`, "Carol");
    const missing = await get("/api/coordination/tells/999999", "Carol");
    expect(outsider.status).toBe(404);
    expect(await outsider.json()).toEqual(await missing.json());
  });

  it("channel reads are for its members and operators only", async () => {
    engine.processCommand(entity("Alice"), "channel create inner");
    engine.processCommand(entity("Bob"), "channel join inner");
    engine.processCommand(entity("Alice"), "channel send inner members only");
    const id = conns.get("Bob")!.messages.at(-1)!.data?.messageId as number;
    const paths = [
      "/api/coordination/channels/inner",
      "/api/coordination/channels/inner/messages",
      `/api/coordination/channels/inner/messages/${id}`,
    ];
    for (const path of paths) {
      expect((await get(path, "Bob")).status).toBe(200);
      // A non-member is answered as if the channel did not exist.
      expect((await get(path, "Carol")).status).toBe(404);
    }
    const listed = async (as: string) =>
      ((await (await get("/api/coordination/channels", as)).json()) as { name: string }[]).map(
        (c) => c.name,
      );
    expect(await listed("Bob")).toContain("inner");
    expect(await listed("Carol")).not.toContain("inner");
    const found = async (as: string) =>
      ((await (await get("/api/search?q=inner", as)).json()) as { kind: string }[]).filter(
        (r) => r.kind === "channel",
      ).length;
    expect(await found("Bob")).toBe(1);
    expect(await found("Carol")).toBe(0);
    // An operator (a person at rank 9) reads every channel.
    engine.entities.get(entity("Carol"))!.properties.rank = 9;
    for (const path of paths) expect((await get(path, "Carol")).status).toBe(200);
    expect(await listed("Carol")).toContain("inner");
  });
});
