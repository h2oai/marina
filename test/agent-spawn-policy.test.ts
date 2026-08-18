// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MAX_AGENTS } from "../src/agent/agent-runtime";
import { lineageDepth, spawnBudget } from "../src/engine/commands/agent";
import { Engine } from "../src/engine/engine";
import { grant } from "../src/engine/safety-gates";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

describe("agent spawn policy — budget formula", () => {
  it("earned spawners get floor(standing / 25), at least 1", () => {
    expect(spawnBudget(0, false)).toBe(1); // floor below threshold still allows one
    expect(spawnBudget(40, false)).toBe(1); // gate entry standing
    expect(spawnBudget(60, false)).toBe(2);
    expect(spawnBudget(100, false)).toBe(4);
    expect(spawnBudget(250, false)).toBe(10);
  });

  it("clamps to the global agent cap", () => {
    expect(spawnBudget(1_000_000, false)).toBe(MAX_AGENTS);
  });

  it("operators holding the gate by grant are exempt (full cap)", () => {
    expect(spawnBudget(0, true)).toBe(MAX_AGENTS);
  });
});

describe("agent spawn policy — lineage depth", () => {
  const dbPath = `/tmp/marina-lineage-${Date.now()}.db`;
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
  });
  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  function saveChild(name: string, spawnedBy: string): void {
    db.saveAgentConfig({ name, model: "x/y", spawnedBy });
  }

  it("world-seeded / unknown entities resolve to depth 0", () => {
    expect(lineageDepth(db, "nobody")).toBe(0);
    saveChild("root", "system");
    expect(lineageDepth(db, "root")).toBe(0);
  });

  it("counts hops up the spawned_by chain", () => {
    saveChild("a", "system");
    saveChild("b", "a");
    saveChild("c", "b");
    saveChild("d", "c");
    expect(lineageDepth(db, "a")).toBe(0);
    expect(lineageDepth(db, "b")).toBe(1);
    expect(lineageDepth(db, "c")).toBe(2);
    expect(lineageDepth(db, "d")).toBe(3);
  });

  it("tolerates a cycle without looping forever", () => {
    saveChild("x", "y");
    saveChild("y", "x");
    // Walk terminates via the seen-set guard rather than hanging.
    expect(lineageDepth(db, "x")).toBeLessThanOrEqual(MAX_AGENTS);
  });
});

describe("agent spawn policy — db query", () => {
  const dbPath = `/tmp/marina-spawnedby-${Date.now()}.db`;
  let db: MarinaDB;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
  });
  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("getAgentConfigsBySpawnedBy returns only that parent's direct children", () => {
    db.saveAgentConfig({ name: "kid1", model: "x/y", spawnedBy: "parent" });
    db.saveAgentConfig({ name: "kid2", model: "x/y", spawnedBy: "parent" });
    db.saveAgentConfig({ name: "other", model: "x/y", spawnedBy: "system" });
    const children = db.getAgentConfigsBySpawnedBy("parent");
    expect(children.map((c) => c.name).sort()).toEqual(["kid1", "kid2"]);
  });
});

describe("agent spawn command — permission layer (integration)", () => {
  const dbPath = `/tmp/marina-spawn-cmd-${Date.now()}.db`;
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;

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

  it("refuses an entity with no standing on the agent.spawn gate", async () => {
    alice.clear();
    await engine.processCommand(alice.entity!, "agent spawn helper");
    expect(output()).toContain("standing");
  });

  it("refuses spawning past the lineage depth cap", async () => {
    // Grant the gate so the gate check passes; depth is enforced independently.
    grant(db, alice.entity!, "agent.spawn");
    // Place alice at depth 3 (a → b → c → alice).
    db.saveAgentConfig({ name: "a", model: "x/y", spawnedBy: "system" });
    db.saveAgentConfig({ name: "b", model: "x/y", spawnedBy: "a" });
    db.saveAgentConfig({ name: "c", model: "x/y", spawnedBy: "b" });
    db.saveAgentConfig({ name: "alice", model: "x/y", spawnedBy: "c" });

    alice.clear();
    await engine.processCommand(alice.entity!, "agent spawn helper");
    expect(output()).toContain("depth limit");
  });

  it("rejects names that would be silently truncated at world login", async () => {
    grant(db, alice.entity!, "agent.spawn");
    alice.clear();
    await engine.processCommand(alice.entity!, "agent spawn this_name_is_over_twenty_chars");
    expect(output()).toContain("1-20 characters");
    expect(db.getAgentConfig("this_name_is_over_twenty_chars")).toBeUndefined();
  });
});
