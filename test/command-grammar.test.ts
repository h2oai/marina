// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Command-surface consistency: every migrated command accepts BOTH its
 * historical argument spelling and the canonical `key:value` modifier grammar
 * from src/engine/parse-input.ts, and the canonical subcommand verbs
 * (list/show/delete) plus their accepted alternates resolve to one handler.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

describe("command argument grammar (old + canonical spellings)", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let bob: MockConnection;
  const dbPath = `/tmp/marina-command-grammar-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("c-alice");
    bob = new MockConnection("c-bob");
    engine.addConnection(alice);
    engine.addConnection(bob);
    engine.spawnEntity("c-alice", "alice");
    engine.spawnEntity("c-bob", "bob");
    alice.clear();
    bob.clear();
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(dbPath);
  });

  const run = (conn: MockConnection, cmd: string): string => {
    conn.clear();
    engine.processCommand(conn.entity!, cmd);
    return stripAnsi(conn.allTextJoined());
  };

  // ── feed ──
  it("feed list: --since 1h and since:1h are the same window; ls = list", () => {
    const old = run(alice, "feed list --since 1h --limit 5");
    const canon = run(alice, "feed list since:1h limit:5");
    const ls = run(alice, "feed ls since=1h");
    for (const text of [old, canon, ls]) expect(text).toContain("in the last 1h");
    expect(run(alice, "feed list since:soon")).toContain("since: expected a duration");
    expect(run(alice, "feed frob")).toContain('Unknown feed subcommand "frob"');
  });

  // ── tell ──
  it("tell: --ttl=30s, --ttl 30s and ttl:30s all set the deadline; ttl: inside the message is text", () => {
    run(alice, "tell bob --ttl=30s first");
    run(alice, "tell bob ttl:30s second");
    run(alice, "tell bob --ttl 30s third");
    for (const id of [1, 2, 3]) {
      const row = db.getDirectMessage(id)!;
      expect(row.deadline_at! - row.created_at).toBeGreaterThanOrEqual(29_990);
      expect(row.deadline_at! - row.created_at).toBeLessThanOrEqual(30_010);
    }
    run(alice, "tell bob remember ttl:7m is a token here");
    const plain = db.getDirectMessage(4)!;
    expect(plain.content).toBe("remember ttl:7m is a token here");
    // Not 7 minutes — the store's default 5-minute deadline applies.
    expect(plain.deadline_at! - plain.created_at).toBeGreaterThanOrEqual(299_990);
    expect(plain.deadline_at! - plain.created_at).toBeLessThanOrEqual(300_010);
    expect(run(alice, "tell bob ttl:soon hi")).toContain("expected a duration");
  });

  // ── crew ──
  it("crew create: formation=pipeline persist and formation:pipeline --persist agree; show/view = info", () => {
    run(alice, "crew create beta bob formation=pipeline persist -- run pipeline");
    run(alice, "crew create gamma bob formation:pipeline --persist -- run pipeline");
    // (delta stays ephemeral — owners are capped at two persisted crews.)
    run(alice, "crew create delta bob --formation pipeline -- run --kind pipeline");
    for (const name of ["beta", "gamma", "delta"]) {
      expect(engine.crewManager?.getByName(name)?.formation).toBe("pipeline");
    }
    for (const name of ["beta", "gamma"]) {
      expect(engine.crewManager?.getByName(name)?.lifetime).toBe("persisted");
    }
    // `--formation` must not be mistaken for the `--` goal terminator.
    expect(engine.crewManager?.getByName("delta")?.goal).toBe("run --kind pipeline");
    const info = run(alice, "crew info beta");
    expect(run(alice, "crew show beta")).toBe(info);
    expect(run(alice, "crew view beta")).toBe(info);
    expect(run(alice, "crew frob")).toContain('Unknown crew subcommand "frob"');
  });

  // ── task ──
  it("task goal: !p7 and priority:7 set the same priority; show/view = info, ls = list", () => {
    expect(run(alice, "task goal Explore | Visit every sector !p7")).toContain("(priority 7)");
    expect(run(alice, "task goal Explore | Visit every sector priority:7")).toContain(
      "(priority 7)",
    );
    expect(run(alice, "task goal Explore --priority 9")).toContain("(priority 9)");
    const info = run(alice, "task info 1");
    expect(info).toContain("Explore");
    expect(run(alice, "task show 1")).toBe(info);
    expect(run(alice, "task view 1")).toBe(info);
    expect(run(alice, "task ls mine")).toContain("Explore");
    expect(run(alice, "task create Fix | Bounty work !5 bounty")).toContain("[bounty !5]");
    expect(run(alice, "task create Fix | Bounty work standing:5 bounty:true")).toContain(
      "[bounty !5]",
    );
    expect(run(alice, "task frob")).toContain('Unknown task subcommand "frob"');
  });

  // ── pool ──
  it("pool add: trailing `importance 7` and `importance:7` store the same note; ls = list", () => {
    run(alice, "pool create tips");
    run(alice, "pool tips add First discovery importance 7");
    run(alice, "pool tips add Second discovery importance:7");
    run(alice, "pool tips add Third discovery --importance 7");
    const pool = db.getMemoryPool("tips")!;
    const notes = db.getPoolNotes(pool.id);
    expect(notes.map((n) => n.importance)).toEqual([7, 7, 7]);
    expect(notes.map((n) => n.content).sort()).toEqual([
      "First discovery",
      "Second discovery",
      "Third discovery",
    ]);
    expect(run(alice, "pool tips ls")).toContain("First discovery");
    expect(run(alice, "pool ls")).toContain("tips");
    expect(run(alice, "pool tips frob")).toContain('Unknown pool subcommand "frob"');
  });

  // ── note ──
  it("note claim: trailing `confidence 0.7 source URL` and `confidence:0.7 source:URL` agree; `note remove …` stays a note", () => {
    const a = run(
      alice,
      "note claim Tides are weekly confidence 0.7 source https://example.test/t",
    );
    // Distinct texts — createNote dedups identical (entity, type, content).
    const b = run(alice, "note claim Tides are lunar confidence:0.7 source:https://example.test/t");
    expect(a).toContain("confidence=0.70, sourced");
    expect(b).toContain("confidence=0.70, sourced");
    const notes = db.getNotesByEntity("alice").filter((n) => n.content.startsWith("Tides"));
    expect(notes.map((n) => n.content).sort()).toEqual(["Tides are lunar", "Tides are weekly"]);
    for (const n of notes) expect(n.confidence).toBe(0.7);
    expect(run(alice, "note ls")).toContain("Tides are weekly");
    // `note` takes free text, so `rm`/`remove` are NOT aliased to delete here:
    // "note remove the old config" must be saved as a note, not routed to delete.
    const saved = run(alice, "note remove the old config before deploying");
    expect(saved.toLowerCase()).not.toContain("delet");
    expect(run(alice, "note ls")).toContain("remove the old config before deploying");
    const del = run(alice, `note delete ${notes[0]!.id}`);
    expect(del.toLowerCase()).toContain("delet");
  });

  // ── memory kv ──
  it("memory kv is the canonical KV home; bare set/get/list keep working and list hints", () => {
    expect(run(alice, "memory kv set goal Find the cipher")).toContain('"goal" set');
    expect(run(alice, "memory set pace slow")).toContain('"pace" set');
    expect(run(alice, "memory kv get goal")).toContain("Find the cipher");
    expect(run(alice, "memory get pace")).toContain("slow");
    const list = run(alice, "memory list");
    expect(list).toContain("goal");
    expect(list).toContain("key-value beliefs");
    expect(list).toContain("memory query");
    expect(run(alice, "memory ls")).toContain("pace");
    expect(run(alice, "memory kv list")).toContain("pace");
    expect(run(alice, "memory kv delete pace")).toContain('"pace" deleted');
    expect(run(alice, "memory rm goal")).toContain('"goal" deleted');
    run(alice, "memory kv set a 1");
    run(alice, "memory kv set b 2");
    expect(run(alice, "memory kv clear")).toContain("Cleared 2");
    expect(db.listCoreMemory("alice")).toHaveLength(0);
    expect(run(alice, "memory frob")).toContain('Unknown memory subcommand "frob"');
    // help: KV block labelled, which-verb table present
    const help = run(alice, "help memory full");
    expect(help).toContain("Key-value beliefs");
    expect(help).toContain("Which verb?");
    expect(help).toContain("memory kv set");
  });

  // ── market ──
  it("market show/view/info are one handler; unknown sub uses the shared shape", () => {
    db.createMarket({ id: "market:tech", roomId: "test/start", question: "Will it ship?" });
    const show = run(alice, "market show market:tech");
    expect(show).toContain("Will it ship?");
    expect(run(alice, "market view market:tech")).toBe(show);
    expect(run(alice, "market info market:tech")).toBe(show);
    expect(run(alice, "market frob")).toContain('Unknown market subcommand "frob"');
  });
});
