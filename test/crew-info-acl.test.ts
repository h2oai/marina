// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_crew_info_acl.db";

/**
 * `crew info <name>` for a crew with no live row and no `crew:<name>` pool
 * falls back to a full-note search for `[crew:<name>` tags. That search is
 * unscoped, so the results must be filtered by the caller's read predicate —
 * a private note that merely mentions the tag must not leak to other callers.
 */
describe("crew info <dissolved> respects note ACL", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let bob: MockConnection;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("c-alice");
    bob = new MockConnection("c-bob");
    engine.addConnection(alice);
    engine.addConnection(bob);
    engine.spawnEntity("c-alice", "alice");
    engine.spawnEntity("c-bob", "bob");
    db.createNote(
      "alice",
      "[crew:ghost formation:pipeline] secret plan for the merger",
      undefined,
      {
        importance: 6,
      },
    );
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(TEST_DB);
  });

  function run(conn: MockConnection, cmd: string): string {
    conn.clear();
    engine.processCommand(conn.entity!, cmd);
    return stripAnsi(conn.allTextJoined());
  }

  it("does not leak another entity's private tagged note", () => {
    const out = run(bob, "crew info ghost");
    expect(out).not.toContain("secret plan");
    expect(out).toContain('Crew "ghost" not found.');
  });

  it("the note owner still sees their own tagged note", () => {
    const out = run(alice, "crew info ghost");
    expect(out).toContain("secret plan");
  });

  it("tradition-pool notes (open pool) stay visible to everyone", () => {
    db.createMemoryPool("pool_orch_pipeline", "orchestration:pipeline", "system");
    db.addPoolNote(
      "pool_orch_pipeline",
      "alice",
      "[crew:ghost formation:pipeline] shipped in two stages",
      6,
      "reflection",
    );
    const out = run(bob, "crew info ghost");
    expect(out).toContain("shipped in two stages");
    expect(out).not.toContain("secret plan");
  });
});
