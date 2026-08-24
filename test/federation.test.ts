// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Engine } from "../src/engine/engine";
import { handleDashboardApi } from "../src/net/dashboard-api";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

const TEST_DB = "test_federation.db";

describe("federation discovery and trust", () => {
  let db: MarinaDB;
  let engine: Engine;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({
      db,
      startRoom: roomId("test/start"),
      instanceName: "Test Marina",
      tickInterval: 60_000,
    });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
  });

  afterEach(() => {
    delete process.env.MARINA_FEDERATION_SIGNING_KEY;
    engine.shutdown();
    db.close();
    cleanupDb(TEST_DB);
  });

  test("publishes a verifiable signed v2 manifest when explicitly configured", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    process.env.MARINA_FEDERATION_SIGNING_KEY = privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");
    const url = new URL("https://marina.example/api/federation/manifest");
    const response = await handleDashboardApi(new Request(url), url, "GET", engine, db);
    const manifest = (await response?.json()) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schema: "marina.federation.manifest.v2",
      signature: { algorithm: "Ed25519" },
      trustBoundary: expect.stringContaining("not operator trust"),
    });
  });

  test("publishes a stable, explicitly unsigned manifest without authentication", async () => {
    const url = new URL("https://marina.example/api/federation/manifest");
    const first = await handleDashboardApi(new Request(url), url, "GET", engine, db);
    const second = await handleDashboardApi(new Request(url), url, "GET", engine, db);
    expect(first?.status).toBe(200);
    const manifest = (await first?.json()) as Record<string, unknown>;
    const repeated = (await second?.json()) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schema: "marina.federation.manifest.v1",
      name: "Test Marina",
      baseUrl: "https://marina.example",
      publicKey: null,
      trustBoundary: expect.stringContaining("Unsigned discovery manifest"),
    });
    expect(repeated.worldId).toBe(manifest.worldId);
  });

  test("keeps imported peers unverified until an explicit operator decision", () => {
    const peer = db.upsertFederationPeer({
      worldId: "world-b",
      name: "Marina B",
      baseUrl: "https://b.example",
      manifest: { schema: "marina.federation.manifest.v1" },
    });
    expect(peer.trust_status).toBe("unverified");
    expect(db.setFederationTrust("world-b", "trusted")?.trust_status).toBe("trusted");
    expect(db.setFederationTrust("world-b", "blocked")?.trust_status).toBe("blocked");
  });
});
