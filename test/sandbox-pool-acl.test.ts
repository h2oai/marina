// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_sandbox_pool_acl.db";
const ROOM = roomId("test/start");

/**
 * Sandboxed commands get `ctx.pool.recall/add`. Those must honour the same
 * members-only pool ACL as the `pool` command (`memoryAccess().pool`) — a
 * crew's `crew:<name>` pool is fenced by a same-id group, and a non-member
 * must see [] / have its add ignored.
 */
describe("sandbox ctx.pool honours pool ACL", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let mallory: MockConnection;

  beforeEach(() => {
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: ROOM, tickInterval: 60_000, db });
    engine.registerRoom(ROOM, makeTestRoom({ short: "Start" }));
    alice = new MockConnection("c-alice");
    mallory = new MockConnection("c-mallory");
    engine.addConnection(alice);
    engine.addConnection(mallory);
    engine.spawnEntity("c-alice", "alice");
    engine.spawnEntity("c-mallory", "mallory");

    // Members-only pool: group `crew:alpha` with alice as its only member.
    db.createGroup({ id: "crew:alpha", name: "crew:alpha", leaderId: String(alice.entity!) });
    db.addGroupMember("crew:alpha", String(alice.entity!));
    db.createMemoryPool("pool_crew_alpha", "crew:alpha", "alice", "crew:alpha");
    db.addPoolNote("pool_crew_alpha", "alice", "secret launch sequence for alpha", 7);
    // Open pool for contrast.
    db.createMemoryPool("pool_findings", "findings", "alice");
    db.addPoolNote("pool_findings", "alice", "public secret about findings", 5);
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(TEST_DB);
  });

  it("non-member recall of a members-only pool returns [] and add is a no-op", () => {
    const ctx = engine.buildCommandContext(ROOM, mallory.entity!)!;
    expect(ctx.pool.recall("crew:alpha", "secret")).toEqual([]);

    ctx.pool.add("crew:alpha", "mallory was here", 5);
    const notes = db.getPoolNotes("pool_crew_alpha");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.content).toContain("secret launch sequence");
  });

  it("member recall works and open pools stay open to everyone", () => {
    const aliceCtx = engine.buildCommandContext(ROOM, alice.entity!)!;
    const hits = aliceCtx.pool.recall("crew:alpha", "secret");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toContain("secret launch sequence");

    const malloryCtx = engine.buildCommandContext(ROOM, mallory.entity!)!;
    expect(malloryCtx.pool.recall("findings", "secret").length).toBeGreaterThan(0);
    malloryCtx.pool.add("findings", "mallory contributes", 4);
    expect(db.getPoolNotes("pool_findings")).toHaveLength(2);
  });

  it("unknown pool still returns [] without throwing", () => {
    const ctx = engine.buildCommandContext(ROOM, mallory.entity!)!;
    expect(ctx.pool.recall("nope", "x")).toEqual([]);
    expect(() => ctx.pool.add("nope", "x", 1)).not.toThrow();
  });
});
