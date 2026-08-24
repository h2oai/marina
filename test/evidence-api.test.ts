// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Engine } from "../src/engine/engine";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_evidence_api.db";

describe("evidence receipts API", () => {
  let db: MarinaDB;
  let engine: Engine;
  let token: string;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ db, startRoom: roomId("test/start"), tickInterval: 60_000 });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    const connection = new MockConnection("evidence-reader");
    engine.addConnection(connection);
    const login = engine.login(connection.id, "EvidenceReader");
    if ("error" in login) throw new Error(login.error);
    token = login.token;
  });

  afterEach(() => {
    engine.shutdown();
    db.close();
    cleanupDb(TEST_DB);
  });

  test("requires authentication and discloses the local trust boundary", async () => {
    const url = new URL("http://localhost/api/evidence/receipts");
    expect((await handleDashboardApi(new Request(url), url, "GET", engine, db))?.status).toBe(401);

    db.appendEvidenceReceipt({ eventType: "decision", ref: "trace:1", payload: { ok: true } });
    const response = await handleDashboardApi(
      new Request(url, { headers: { Authorization: `Bearer ${token}` } }),
      url,
      "GET",
      engine,
      db,
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      receipts: unknown[];
      verification: { valid: boolean; entries: number; headHash: string };
      trustBoundary: string;
    };
    expect(body.receipts).toHaveLength(1);
    expect(body.verification).toMatchObject({ valid: true, entries: 1 });
    expect(body.verification.headHash).toHaveLength(64);
    expect(body.trustBoundary).toContain("independently anchor");
  });

  test("exports a truthful, unsigned checkpoint for independent witnessing", async () => {
    db.appendEvidenceReceipt({ eventType: "decision", ref: "trace:1", payload: { ok: true } });
    const url = new URL("http://localhost/api/evidence/checkpoint?download=1");
    const response = await handleDashboardApi(
      new Request(url, { headers: { Authorization: `Bearer ${token}` } }),
      url,
      "GET",
      engine,
      db,
    );
    expect(response?.headers.get("content-disposition")).toContain(
      "marina-evidence-checkpoint.json",
    );
    expect(await response?.json()).toMatchObject({
      schema: "marina.evidence.checkpoint.v1",
      algorithm: "sha256",
      entries: 1,
      valid: true,
      trustBoundary: expect.stringContaining("Unsigned local checkpoint"),
    });
  });
});
