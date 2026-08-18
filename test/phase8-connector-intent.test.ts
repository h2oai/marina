// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MarinaDB } from "../src/persistence/database";
import { seedConnector, seedTabH2OConnector } from "../worlds/seed";
import { cleanupDb } from "./helpers";

const TEST_DB = "test-p8.db";

describe("seedConnector", () => {
  let db: MarinaDB;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("creates a connector row when none exists", () => {
    seedConnector(db, {
      name: "test-service",
      url: "https://example.com/api",
    });
    const row = db.getConnectorByName("test-service");
    expect(row).toBeTruthy();
    expect(row?.url).toBe("https://example.com/api");
    expect(row?.transport).toBe("http");
    expect(row?.created_by).toBe("system");
  });

  it("is idempotent — re-seeding doesn't create duplicates", () => {
    seedConnector(db, { name: "test", url: "https://example.com" });
    seedConnector(db, { name: "test", url: "https://example.com" });
    const matches = db.listConnectors().filter((c) => c.name === "test");
    expect(matches.length).toBe(1);
  });

  it("populates auth header when env var is set", () => {
    const envVar = "P8_TEST_KEY";
    process.env[envVar] = "secret123";
    try {
      seedConnector(db, {
        name: "test-auth",
        url: "https://example.com",
        authHeaderName: "Authorization",
        authEnvVar: envVar,
        authPrefix: "Bearer ",
      });
      const row = db.getConnectorByName("test-auth");
      expect(row?.auth_type).toBe("bearer");
      const headers = JSON.parse(row!.auth_data!) as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer secret123");
    } finally {
      process.env[envVar] = undefined;
    }
  });

  it("leaves auth null when env var is missing — discoverable but inactive", () => {
    const envVar = "P8_MISSING_KEY";
    process.env[envVar] = undefined;
    seedConnector(db, {
      name: "test-no-auth",
      url: "https://example.com",
      authHeaderName: "Authorization",
      authEnvVar: envVar,
      authPrefix: "Bearer ",
    });
    const row = db.getConnectorByName("test-no-auth");
    expect(row).toBeTruthy();
    expect(row?.auth_type).toBeNull();
    expect(row?.auth_data).toBeNull();
  });
});

describe("seedTabH2OConnector", () => {
  let db: MarinaDB;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("registers tabh2o with the default endpoint", () => {
    seedTabH2OConnector(db);
    const row = db.getConnectorByName("tabh2o");
    expect(row).toBeTruthy();
    expect(row?.url).toContain("tabh2o");
  });

  it("respects TABH2O_ENDPOINT override", () => {
    process.env.TABH2O_ENDPOINT = "https://custom.example.com/predict";
    try {
      seedTabH2OConnector(db);
      const row = db.getConnectorByName("tabh2o");
      expect(row?.url).toBe("https://custom.example.com/predict");
    } finally {
      process.env.TABH2O_ENDPOINT = undefined;
    }
  });

  it("is idempotent across multiple world seed calls", () => {
    seedTabH2OConnector(db);
    seedTabH2OConnector(db);
    seedTabH2OConnector(db);
    const matches = db.listConnectors().filter((c) => c.name === "tabh2o");
    expect(matches.length).toBe(1);
  });
});
