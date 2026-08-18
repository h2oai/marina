// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  isSeedDisabled,
  listDisabledSeedAgents,
  setSeedDisabled,
} from "../src/agent/seed-registry";
import { MarinaDB } from "../src/persistence/database";
import { seedOrchestrationCrews, seedSystemAgent } from "../worlds/seed";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_seed_registry.db";

describe("seed-registry disable markers", () => {
  let db: MarinaDB;
  const prevEnv = process.env.MARINA_DISABLED_AGENTS;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });
  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
    if (prevEnv === undefined) delete process.env.MARINA_DISABLED_AGENTS;
    else process.env.MARINA_DISABLED_AGENTS = prevEnv;
  });

  it("is not disabled by default; persists a marker; clears it", () => {
    expect(isSeedDisabled(db, "Chronicler")).toBe(false);
    setSeedDisabled(db, "Chronicler", true);
    expect(isSeedDisabled(db, "Chronicler")).toBe(true);
    expect(listDisabledSeedAgents(db)).toContain("Chronicler");
    setSeedDisabled(db, "Chronicler", false);
    expect(isSeedDisabled(db, "Chronicler")).toBe(false);
    expect(listDisabledSeedAgents(db)).not.toContain("Chronicler");
  });

  it("honors the MARINA_DISABLED_AGENTS env overlay", () => {
    delete process.env.MARINA_DISABLED_AGENTS;
    expect(isSeedDisabled(db, "Decomposer")).toBe(false);
    process.env.MARINA_DISABLED_AGENTS = "Decomposer, Meridian";
    expect(isSeedDisabled(db, "Decomposer")).toBe(true);
    expect(isSeedDisabled(db, "Meridian")).toBe(true);
    expect(listDisabledSeedAgents(db)).toEqual(expect.arrayContaining(["Decomposer", "Meridian"]));
  });
});

describe("seedSystemAgent (unified seed policy)", () => {
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });
  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  const cfg = (goal: string) => ({
    name: "Chronicler",
    model: "marina/default",
    role: "chronicler",
    goal,
  });

  it("creates the system config on first seed", () => {
    seedSystemAgent(db, cfg("v1"));
    const row = db.getAgentConfig("Chronicler");
    expect(row?.spawned_by).toBe("system");
    expect(row?.goal).toBe("v1");
  });

  it("refreshes system fields on reseed but preserves operator key_name/room", () => {
    seedSystemAgent(db, cfg("v1"));
    // Simulate an operator having set a key + room on the prior boot's config.
    db.saveAgentConfig({
      name: "Chronicler",
      model: "marina/default",
      role: "chronicler",
      goal: "v1",
      keyName: "my-key",
      room: "library",
      spawnedBy: "system",
    });
    seedSystemAgent(db, cfg("v2"));
    const row = db.getAgentConfig("Chronicler");
    expect(row?.goal).toBe("v2"); // refreshed from seed
    expect(row?.key_name).toBe("my-key"); // preserved
    expect(row?.room).toBe("library"); // preserved
  });

  it("skips a disabled agent — the removal sticks across reseeds", () => {
    setSeedDisabled(db, "Chronicler", true);
    seedSystemAgent(db, cfg("v1"));
    expect(db.getAgentConfig("Chronicler")).toBeUndefined();
  });

  it("leaves a user-customized config untouched", () => {
    db.saveAgentConfig({
      name: "Chronicler",
      model: "anthropic/claude-sonnet-4-6",
      role: "chronicler",
      goal: "my custom chronicler",
      spawnedBy: "alice",
    });
    seedSystemAgent(db, cfg("seed-goal"));
    const row = db.getAgentConfig("Chronicler");
    expect(row?.spawned_by).toBe("alice");
    expect(row?.goal).toBe("my custom chronicler");
  });
});

describe("seedOrchestrationCrews (MARINA_ENDPOINTS gating)", () => {
  const DB = "test_orch_endpoints.db";
  let db: MarinaDB;
  let prevEnv: string | undefined;

  beforeEach(() => {
    cleanupDb(DB);
    db = new MarinaDB(DB);
    prevEnv = process.env.MARINA_ENDPOINTS;
  });
  afterEach(() => {
    db.close();
    cleanupDb(DB);
    if (prevEnv === undefined) delete process.env.MARINA_ENDPOINTS;
    else process.env.MARINA_ENDPOINTS = prevEnv;
  });

  it("seeds all three coordinators by default (env unset)", () => {
    delete process.env.MARINA_ENDPOINTS;
    seedOrchestrationCrews(db);
    expect(db.getAgentConfig("Councilor")).toBeTruthy();
    expect(db.getAgentConfig("Debater")).toBeTruthy();
    expect(db.getAgentConfig("Decomposer")).toBeTruthy();
    // Specialists always seed.
    expect(db.getAgentConfig("Historian")).toBeTruthy();
    expect(db.getAgentConfig("Skeptic")).toBeTruthy();
  });

  it("seeds only the listed coordinators and removes the rest", () => {
    process.env.MARINA_ENDPOINTS = "decompose";
    seedOrchestrationCrews(db);
    expect(db.getAgentConfig("Decomposer")).toBeTruthy();
    expect(db.getAgentConfig("Councilor")).toBeUndefined();
    expect(db.getAgentConfig("Debater")).toBeUndefined();
    // Specialists unaffected.
    expect(db.getAgentConfig("Historian")).toBeTruthy();
    expect(db.getAgentConfig("Verifier")).toBeTruthy();
  });

  it("removes a previously-seeded coordinator when it's later disabled", () => {
    delete process.env.MARINA_ENDPOINTS;
    seedOrchestrationCrews(db);
    expect(db.getAgentConfig("Councilor")).toBeTruthy();
    // Re-seed with council disabled — its config must be cleared so it won't respawn.
    process.env.MARINA_ENDPOINTS = "decompose";
    seedOrchestrationCrews(db);
    expect(db.getAgentConfig("Councilor")).toBeUndefined();
  });

  it("'none' seeds no coordinators", () => {
    process.env.MARINA_ENDPOINTS = "none";
    seedOrchestrationCrews(db);
    expect(db.getAgentConfig("Councilor")).toBeUndefined();
    expect(db.getAgentConfig("Debater")).toBeUndefined();
    expect(db.getAgentConfig("Decomposer")).toBeUndefined();
    expect(db.getAgentConfig("Historian")).toBeTruthy();
  });
});
