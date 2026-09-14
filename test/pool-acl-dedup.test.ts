// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_pool_acl_dedup.db";

/**
 * Phase 0: group-scoped pools are enforceable end to end — `pool create <name>
 * group <g>` scopes a pool, `share` honors the same ACL as `pool <name> add`,
 * and identical same-author deposits collapse onto one row.
 */
describe("group-scoped pools + share ACL + deposit dedup", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let bob: MockConnection;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("c1");
    bob = new MockConnection("c2");
    engine.addConnection(alice);
    engine.addConnection(bob);
    engine.spawnEntity("c1", "Alice");
    engine.spawnEntity("c2", "Bob");
    alice.clear();
    bob.clear();
  });

  afterEach(() => {
    engine.shutdown();
    db.close();
    cleanupDb(TEST_DB);
  });

  const last = (c: MockConnection) => stripAnsi(c.allTextJoined());

  it("pool create <name> group <g> requires membership and scopes the pool", () => {
    engine.processCommand(alice.entity!, "group create explorers Exploration Team");
    alice.clear();

    // Bob is not a member — cannot fence a pool behind a group he's not in.
    engine.processCommand(bob.entity!, "pool create secrets group explorers");
    expect(last(bob)).toContain("not found or you are not a member");
    expect(db.getMemoryPool("secrets")).toBeUndefined();

    // Alice (leader) can.
    engine.processCommand(alice.entity!, "pool create secrets group explorers");
    expect(last(alice)).toContain('"secrets" created');
    expect(last(alice)).toContain("members-only");
    const pool = db.getMemoryPool("secrets")!;
    expect(pool.group_id).toBe("explorers");
  });

  it("malformed group syntax is rejected with usage", () => {
    engine.processCommand(alice.entity!, "pool create secrets grp explorers");
    expect(last(alice)).toContain("Usage: pool create <name> [group <groupName>]");
    expect(db.getMemoryPool("secrets")).toBeUndefined();
  });

  it("non-members cannot recall from, add to, or share into a group pool; members can", () => {
    engine.processCommand(alice.entity!, "group create explorers Exploration Team");
    engine.processCommand(alice.entity!, "pool create secrets group explorers");
    engine.processCommand(alice.entity!, "pool secrets add The vault code is blue importance 7");
    alice.clear();

    engine.processCommand(bob.entity!, "pool secrets recall vault");
    expect(last(bob)).toContain('Pool "secrets" not found or inaccessible');
    bob.clear();
    engine.processCommand(bob.entity!, "pool secrets add Bob was here");
    expect(last(bob)).toContain("not found or inaccessible");
    bob.clear();
    engine.processCommand(bob.entity!, "share secrets Bob was here too");
    expect(last(bob)).toContain('Pool "secrets" not found or inaccessible');
    expect(db.getPoolNotes(db.getMemoryPool("secrets")!.id).length).toBe(1);
    bob.clear();

    // Bob joins the group → the pool becomes visible and writable.
    engine.processCommand(bob.entity!, "group join explorers");
    bob.clear();
    engine.processCommand(bob.entity!, "pool secrets recall vault");
    expect(last(bob)).toContain("vault code is blue");
    bob.clear();
    engine.processCommand(bob.entity!, "share secrets Bob confirms the vault code");
    expect(last(bob)).toContain("Shared to secrets");
    expect(db.getPoolNotes(db.getMemoryPool("secrets")!.id).length).toBe(2);
  });

  it("share dedups identical same-author content within a pool", () => {
    engine.processCommand(alice.entity!, "pool create findings");
    alice.clear();
    engine.processCommand(alice.entity!, "share findings kalshi spread tightens on close");
    const first = last(alice);
    expect(first).toContain("Shared to findings");
    const id = Number(first.match(/Posted as #(\d+)/)?.[1]);
    expect(id).toBeGreaterThan(0);
    alice.clear();

    engine.processCommand(alice.entity!, "share findings kalshi spread tightens on close");
    expect(last(alice)).toContain(`Already shared to findings as #${id}`);
    const pool = db.getMemoryPool("findings")!;
    expect(db.getPoolNotes(pool.id).length).toBe(1);

    // A different author depositing the same line is a distinct row.
    engine.processCommand(bob.entity!, "share findings kalshi spread tightens on close");
    expect(db.getPoolNotes(pool.id).length).toBe(2);
  });

  it("pool add dedups against share (and vice versa) for the same author", () => {
    engine.processCommand(alice.entity!, "pool create findings");
    engine.processCommand(alice.entity!, "share findings the decode room accepts binary");
    alice.clear();
    engine.processCommand(alice.entity!, "pool findings add the decode room accepts binary");
    expect(last(alice)).toMatch(/Already shared as #\d+ in pool "findings"/);
    alice.clear();
    engine.processCommand(alice.entity!, "pool findings add the decode room accepts binary");
    expect(last(alice)).toMatch(/Already shared as #\d+/);
    expect(db.getPoolNotes(db.getMemoryPool("findings")!.id).length).toBe(1);
  });

  it("[compaction] summaries are exempt from pool dedup", () => {
    engine.processCommand(alice.entity!, "pool create findings");
    const pool = db.getMemoryPool("findings")!;
    db.addPoolNote(pool.id, "Alice", "[compaction] window 1 summary", 3);
    db.addPoolNote(pool.id, "Alice", "[compaction] window 1 summary", 3);
    expect(db.getPoolNotes(pool.id).length).toBe(2);
  });

  it("dedup ignores superseded rows, so a re-deposit after correction is a new row", () => {
    engine.processCommand(alice.entity!, "pool create findings");
    const pool = db.getMemoryPool("findings")!;
    const id = db.addPoolNote(pool.id, "Alice", "the sky is green", 5);
    // reviseNote marks the original superseded.
    const revised = db.reviseNote("Alice", id, "the sky is blue");
    expect(revised).toBeDefined();
    expect(db.getNote(id)?.verification_status).toBe("superseded");
    const again = db.addPoolNote(pool.id, "Alice", "the sky is green", 5);
    expect(again).not.toBe(id);
    // …while the live revision still dedups.
    expect(db.addPoolNote(pool.id, "Alice", "the sky is blue", 5)).toBe(revised!);
  });

  it("project pools are scoped to the project group", () => {
    engine.processCommand(alice.entity!, "project create Beta | A scoped project");
    const project = db.getProjectByName("Beta")!;
    const pool = db.getMemoryPoolById(project.pool_id!)!;
    expect(pool.group_id).toBe(project.group_id);

    bob.clear();
    engine.processCommand(bob.entity!, "share project:Beta an outsider's note");
    expect(last(bob)).toContain("not found or inaccessible");
    bob.clear();
    engine.processCommand(bob.entity!, "project Beta join");
    bob.clear();
    engine.processCommand(bob.entity!, "share project:Beta a member's note");
    expect(last(bob)).toContain("Shared to project:Beta");
  });
});
