// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MarinaDB } from "../src/persistence/database";
import { seedWatchingRole } from "../worlds/seed";
import { cleanupDb } from "./helpers";

describe("seedWatchingRole — watching trait + watcher role", () => {
  let db: MarinaDB;
  const TEST_DB = `/tmp/marina-watching-role-${process.pid}.db`;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("seeds the watching trait with a single-word gerund identifier", () => {
    seedWatchingRole(db);
    const trait = db.getTrait("watching");
    expect(trait).toBeDefined();
    // Voice-friendly invariant per feedback_natural_language_commands
    expect(trait?.name).toBe("watching");
    expect(trait?.name).not.toMatch(/[-_]/);
    expect(trait?.category).toBe("methodology");
  });

  it("trait prompt encodes filter-at-source discipline", () => {
    seedWatchingRole(db);
    const trait = db.getTrait("watching");
    expect(trait?.prompt).toMatch(/watch due/i);
    expect(trait?.prompt).toMatch(/probe/i);
    // Must instruct the agent to trust the framework and NOT manually
    // update timestamps or check retirement.
    expect(trait?.prompt).toMatch(/framework/i);
    expect(trait?.prompt).toMatch(/verbatim/i);
  });

  it("seeds the watcher role composing watching + observation traits", () => {
    seedWatchingRole(db);
    const role = db.getRole("watcher");
    expect(role).toBeDefined();
    expect(role?.name).toBe("watcher");
    expect(role?.name).not.toMatch(/[-_]/);
    // RoleRow stores arrays as JSON-encoded strings; parse before asserting.
    const traits = JSON.parse(role!.traits) as string[];
    expect(traits).toContain("watching");
  });

  it("watcher role guidelines include the 'watch due first' loop step", () => {
    seedWatchingRole(db);
    const role = db.getRole("watcher");
    const guidelines = JSON.parse(role!.guidelines) as string[];
    const allGuidelines = guidelines.join(" ").toLowerCase();
    expect(allGuidelines).toContain("watch due");
    expect(allGuidelines).toContain("probe");
  });

  it("is idempotent — calling twice does not throw or duplicate", () => {
    seedWatchingRole(db);
    seedWatchingRole(db);
    const trait = db.getTrait("watching");
    expect(trait).toBeDefined();
    const role = db.getRole("watcher");
    expect(role).toBeDefined();
  });
});
