// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 5c: sleep-time precompute. An idle agent with a focus pre-builds its
 * prompt context (`context_preview` with `warm`); the entry lives for hours
 * instead of seconds, is served by the next prompt build for the same query
 * and budget while the memory revision is unchanged, and is invalidated by a
 * memory write like any entry. The stats count what it served.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { previewParticipantContext } from "../src/engine/commands/context";
import { Engine } from "../src/engine/engine";
import {
  CONTEXT_CACHE_TTL_MS,
  CONTEXT_PRECOMPUTE_TTL_MS,
  contextCacheStats,
} from "../src/memory/context-cache";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, tempDbPath } from "./helpers";

const TEST_DB = tempDbPath("test_memory_dream_precompute.db");

describe("sleep-time precompute", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let ada: EntityId;
  const realNow = Date.now;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Ada");
    ada = conn.entity!;
    // A durable account: the evidence tiers need one (world_identity_required otherwise).
    db.ensurePrincipal({ type: "human", displayName: "Ada", principalId: "u_Ada" });
    if (!db.durableKeyForName("Ada")) db.createUser({ id: "u_Ada", name: "Ada", rank: 1 });
    db.createNote("Ada", "The amber deployment listens on port 8443 behind the staging proxy");
  });

  afterEach(() => {
    Date.now = realNow;
    db.close();
    cleanupDb(TEST_DB);
  });

  const preview = (warm: boolean) =>
    previewParticipantContext(
      { db, getEntity: (id: EntityId) => engine.entities.get(id) },
      ada,
      { query: "amber deployment staging", budgetBytes: 2048, ...(warm ? { warm: true } : {}) },
      "prompt",
    );

  it("a warm build is cached for hours; the next prompt build is served from it until memory changes", async () => {
    const warmed = await preview(true);
    expect(warmed.context.tiers.some((t) => t.items.length > 0)).toBe(true);
    let stats = contextCacheStats(db);
    expect(stats.precomputed).toBe(1);
    expect(stats.precomputedHits).toBe(0);
    expect(stats.precomputeMaxAgeMs).toBe(CONTEXT_PRECOMPUTE_TTL_MS);

    // Well past the ordinary TTL, the prompt build still hits the precomputed entry.
    const base = realNow();
    Date.now = () => base + CONTEXT_CACHE_TTL_MS * 10;
    const served = await preview(false);
    expect(served.context.tiers).toEqual(warmed.context.tiers);
    stats = contextCacheStats(db);
    expect(stats.precomputedHits).toBe(1);
    expect(stats.hits).toBe(1);

    // A memory write invalidates it like any entry; the rebuild is an ordinary one.
    db.createNote("Ada", "The amber deployment moved to port 9443 behind the staging proxy");
    const rebuilt = await preview(false);
    expect(JSON.stringify(rebuilt.context.tiers)).toContain("9443");
    stats = contextCacheStats(db);
    expect(stats.precomputedHits).toBe(1);
    expect(stats.invalidations).toBe(1);
    expect(stats.misses).toBe(2);

    // Past the precompute TTL a warm entry is gone too.
    await preview(true);
    Date.now = () => base + CONTEXT_PRECOMPUTE_TTL_MS + CONTEXT_CACHE_TTL_MS * 11;
    await preview(false);
    expect(contextCacheStats(db).precomputedHits).toBe(1);
  });

  it("warm is honoured on the prompt surface only, and never changes the result", async () => {
    const plain = await previewParticipantContext(
      { db, getEntity: (id: EntityId) => engine.entities.get(id) },
      ada,
      { query: "amber deployment staging", budgetBytes: 2048, warm: true },
      "context",
    );
    expect(contextCacheStats(db).precomputed).toBe(0);
    const warmed = await preview(true);
    expect(warmed.context.tiers).toEqual(plain.context.tiers);
    expect(contextCacheStats(db).precomputed).toBe(1);
  });
});
