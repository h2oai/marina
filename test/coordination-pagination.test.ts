// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

const TEST_DB = "test_coordination_pagination.db";

/**
 * The Coordination panel's lists/detail views "load more" instead of silently
 * truncating. These tests pin the paginated endpoints: a bounded `?limit=`
 * page plus the true `total`, so the UI can show "N of M" and stop when done.
 */
describe("coordination pagination endpoints", () => {
  let db: MarinaDB;
  let engine: Engine;
  let prevOpenApi: string | undefined;

  beforeEach(() => {
    prevOpenApi = process.env.MARINA_OPEN_API;
    process.env.MARINA_OPEN_API = "true"; // open the auth gate for GET routes
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
    if (prevOpenApi === undefined) delete process.env.MARINA_OPEN_API;
    else process.env.MARINA_OPEN_API = prevOpenApi;
  });

  const get = async (path: string) => {
    const url = new URL(`http://localhost:3300${path}`);
    const req = new Request(url.toString(), { method: "GET" });
    const resp = await handleDashboardApi(req, url, "GET", engine, db);
    expect(resp?.status).toBe(200);
    return resp!.json();
  };

  it("tasks: paged variant returns a bounded page plus true total", async () => {
    for (let i = 0; i < 130; i++) {
      db.createTask({ title: `task ${i}`, creatorId: "e_1", creatorName: "Alice" });
    }
    // Back-compat: no `paged` → bare array, capped at 50.
    const legacy = (await get("/api/coordination/tasks")) as unknown[];
    expect(Array.isArray(legacy)).toBe(true);
    expect(legacy.length).toBe(50);

    // Paged: bounded items, full total.
    const page1 = (await get("/api/coordination/tasks?paged=1&limit=50")) as {
      items: unknown[];
      total: number;
    };
    expect(page1.items.length).toBe(50);
    expect(page1.total).toBe(130);

    // Growing the limit loads more, up to the total.
    const page2 = (await get("/api/coordination/tasks?paged=1&limit=200")) as {
      items: unknown[];
      total: number;
    };
    expect(page2.items.length).toBe(130);
    expect(page2.total).toBe(130);
  });

  it("board posts: bounded page plus true total", async () => {
    db.createBoard({ id: "b_1", name: "ideas" });
    for (let i = 0; i < 12; i++) {
      db.createBoardPost({
        boardId: "b_1",
        authorId: "e_1",
        authorName: "Alice",
        body: `post ${i}`,
      });
    }
    const page = (await get("/api/coordination/boards/ideas/posts?limit=5")) as {
      items: unknown[];
      total: number;
    };
    expect(page.items.length).toBe(5);
    expect(page.total).toBe(12);
  });

  it("channel messages: bounded page plus true total", async () => {
    db.createChannel({ id: "c_1", type: "custom", name: "war-room" });
    for (let i = 0; i < 9; i++) {
      db.addChannelMessage("c_1", "e_1", "Alice", `msg ${i}`);
    }
    const page = (await get("/api/coordination/channels/war-room/messages?limit=4")) as {
      items: unknown[];
      total: number;
    };
    expect(page.items.length).toBe(4);
    expect(page.total).toBe(9);
  });
});
