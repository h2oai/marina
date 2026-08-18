// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { findLatestSample } from "../src/resolvers";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

describe("probe command (integration)", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  const dbPath = `/tmp/marina-probe-cmd-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("c-alice");
    engine.addConnection(alice);
    engine.spawnEntity("c-alice", "alice");
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  function output(): string {
    return stripAnsi(alice.allTextJoined());
  }

  it("probe with no args lists registered resolvers", async () => {
    alice.clear();
    await engine.processCommand(alice.entity!, "probe");
    const out = output();
    expect(out).toContain("Registered resolvers");
    expect(out).toContain("echoing");
    expect(out).toContain("resolving"); // kalshi/polymarket binary-market resolution
  });

  it("probe with unknown kind reports the kind and lists alternatives", async () => {
    alice.clear();
    await engine.processCommand(alice.entity!, "probe nonsense foo:bar");
    expect(output()).toContain("Unknown resolver kind: nonsense");
  });

  it("probe with bad args returns the resolver's parse error", async () => {
    alice.clear();
    await engine.processCommand(alice.entity!, "probe echoing");
    expect(output()).toContain("payload");
  });

  it("probe echoing payload:hello writes a fact-tier sample note and emits a feed event", async () => {
    alice.clear();
    await engine.processCommand(alice.entity!, "probe echoing payload:hello");
    const out = output();
    expect(out).toContain("[sample:echoing hello]");
    expect(out).toContain("changed");

    const latest = findLatestSample(db, "echoing", "hello");
    expect(latest).toBeDefined();
    expect(latest?.sample.status).toBe("changed");
    expect(latest?.sample.value).toMatchObject({ echoed: "hello" });

    const note = db.getNote(latest!.noteId)!;
    expect(note.tier).toBe("fact"); // changed → fact
    expect(note.entity_name).toBe("alice");

    const feedEvents = db.queryFeedEvents({
      since: Date.now() - 60_000,
      kind: "sample.changed",
      limit: 5,
    });
    expect(feedEvents.length).toBeGreaterThan(0);
    expect(feedEvents[0]?.ref).toBe("sample:echoing/hello");
  });

  it("probe twice with same args links the second sample to the first via supersedes", async () => {
    await engine.processCommand(alice.entity!, "probe echoing payload:chain");
    const first = findLatestSample(db, "echoing", "chain");
    expect(first).toBeDefined();

    await engine.processCommand(alice.entity!, "probe echoing payload:chain");
    const second = findLatestSample(db, "echoing", "chain");
    expect(second?.noteId).not.toBe(first!.noteId);

    const links = db.getNoteLinks(second!.noteId);
    const supersedes = links.find((l) => l.relationship === "supersedes");
    expect(supersedes?.target_id).toBe(first!.noteId);
  });

  it("probe is rank 0 (callable from a fresh entity with no rank progression)", async () => {
    // alice was just spawned — rank 0 by default. If the command had a higher
    // minRank, processCommand would refuse with a permission error. Guardrail
    // against accidental rank bumps in future refactors.
    alice.clear();
    await engine.processCommand(alice.entity!, "probe echoing payload:smoke");
    expect(output().toLowerCase()).not.toContain("rank required");
    expect(output().toLowerCase()).not.toContain("permission denied");
    expect(findLatestSample(db, "echoing", "smoke")).toBeDefined();
  });
});
