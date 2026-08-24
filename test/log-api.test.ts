// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_log_api.db";

describe("structured log API", () => {
  let db: MarinaDB;
  let engine: Engine;
  let token: string;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ db, startRoom: roomId("test/start"), tickInterval: 60_000 });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    const connection = new MockConnection("log-reader");
    engine.addConnection(connection);
    const login = engine.login(connection.id, "LogReader");
    if ("error" in login) throw new Error(login.error);
    token = login.token;
    db.appendStructuredLog({
      timestamp: 100,
      level: "error",
      category: "provider",
      message: "request timed out",
      traceId: "trace-api",
      spanId: "span-api",
      requestId: "request-api",
      data: { errorKind: "timeout" },
    });
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  const call = (path: string, authenticated = true) => {
    const url = new URL(`http://localhost:3300${path}`);
    return handleDashboardApi(
      new Request(url, authenticated ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      url,
      "GET",
      engine,
      db,
    );
  };

  it("requires authentication and returns bounded correlated records", async () => {
    expect((await call("/api/logs", false))?.status).toBe(401);
    const response = await call("/api/logs?level=error&traceId=trace-api&limit=1");
    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({
      source: "structured_logs",
      logs: [
        {
          level: "error",
          category: "provider",
          traceId: "trace-api",
          spanId: "span-api",
          requestId: "request-api",
        },
      ],
      page: { limit: 1, hasMore: false },
      otlp: { enabled: false, pendingLogs: 0 },
    });
  });

  it("validates filters and exports correlated OTLP JSON", async () => {
    expect((await call("/api/logs?level=fatal"))?.status).toBe(400);
    expect((await call("/api/logs?cursor=invalid"))?.status).toBe(400);
    const response = await call("/api/logs?format=otlp-json&download=1");
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-disposition")).toContain("marina-logs-otlp.json");
    const body = await response!.text();
    expect(body).toContain("request timed out");
    expect(body).toContain("trace-api");
  });
});
