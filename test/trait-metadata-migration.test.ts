// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { TraitCapabilities } from "../src/persistence/database";
import { MarinaDB } from "../src/persistence/database";
import {
  seedAnswererCrew,
  seedChroniclerRole,
  seedDecompositionTraitsAndRoles,
  seedOrchestrationCrews,
  seedTabH2OForecasting,
  seedTraitsAndRoles,
  seedWatchingRole,
} from "../worlds/seed";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_trait_metadata_migration.db";

/** Seed every trait-creating source so the invariant covers the full set. */
function seedAllTraits(db: MarinaDB): void {
  seedTraitsAndRoles(db);
  seedDecompositionTraitsAndRoles(db);
  seedTabH2OForecasting(db);
  seedWatchingRole(db);
  seedChroniclerRole(db);
  seedAnswererCrew(db);
  seedOrchestrationCrews(db);
}

describe("seeded trait typed-metadata migration", () => {
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
  });
  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("every seeded trait with classic capabilities also declares typed behaviors", () => {
    seedAllTraits(db);
    const traits = db.getAllTraits();
    expect(traits.length).toBeGreaterThanOrEqual(31);

    const missing = traits
      .map((t) => ({ name: t.name, caps: JSON.parse(t.capabilities || "{}") as TraitCapabilities }))
      .filter(({ caps }) => {
        const hasClassic =
          (caps.strengths?.length ?? 0) > 0 ||
          (caps.preferences?.length ?? 0) > 0 ||
          (caps.avoids?.length ?? 0) > 0;
        return hasClassic && (caps.behaviors?.length ?? 0) === 0;
      })
      .map(({ name }) => name);

    expect(missing).toEqual([]);
  });

  it("seeds domains on the traits that have a clear subject area", () => {
    seedAllTraits(db);
    const byName = new Map(
      db
        .getAllTraits()
        .map((t) => [t.name, JSON.parse(t.capabilities || "{}") as TraitCapabilities]),
    );
    expect(byName.get("source-integrity")?.domains).toContain("research");
    expect(byName.get("room-building")?.domains).toContain("building");
    expect(byName.get("economic-systems")?.domains).toContain("trading");
    expect(byName.get("chronicling")?.domains).toContain("writing");
  });

  it("does NOT task-gate any seeded trait (autonomy: descriptive domains only)", () => {
    // Phase 2 decision: no shared seed trait opts into task-category activation,
    // so PRISM gating never silences a capability a generalist role might need.
    seedAllTraits(db);
    const gated = db
      .getAllTraits()
      .map((t) => ({ name: t.name, caps: JSON.parse(t.capabilities || "{}") as TraitCapabilities }))
      .filter(({ caps }) =>
        (caps.activation ?? []).map((a) => a.toLowerCase()).includes("task-category"),
      )
      .map(({ name }) => name);
    expect(gated).toEqual([]);
  });
});
