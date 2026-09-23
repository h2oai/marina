// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ChannelManager } from "../src/coordination/channel-manager";
import { CrewManager } from "../src/coordination/crew-manager";
import { gatherRetrievalContext } from "../src/engine/commands/retrieval-core";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, entityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

/**
 * Crew pools are members-only. Every persisted crew's `crew:<name>` pool is
 * scoped by a same-id group whose roster mirrors the crew (owner + members),
 * so the existing group-pool ACL (`memoryAccess().pool`,
 * `gatherRetrievalContext`) fences crew memory from outsiders.
 */
describe("CrewManager: crew pool group", () => {
  const DB_PATH = "test_crew_pool_group.db";
  const OWNER = entityId("e_owner");
  const IDS: Record<string, string> = { alice: "e_alice", bob: "e_bob", carol: "e_carol" };

  beforeEach(() => cleanupDb(DB_PATH));
  afterEach(() => cleanupDb(DB_PATH));

  function manager(db: MarinaDB): CrewManager {
    return new CrewManager({
      channels: new ChannelManager(db, () => {}),
      db,
      resolveAgentId: (name) => IDS[name],
    });
  }

  function roster(db: MarinaDB, groupId: string): string[] {
    return db
      .getGroupMembers(groupId)
      .map((m) => m.entity_id)
      .sort();
  }

  it("provisions a same-id group on pool creation with owner + members", () => {
    const db = new MarinaDB(DB_PATH);
    const crews = manager(db);
    const crew = crews.create({
      name: "alpha",
      goal: "ship",
      lifetime: "persisted",
      owner: OWNER,
      members: [{ agentName: "alice" }, { agentName: "bob", role: "reviewer" }],
    });

    const pool = db.getMemoryPool("crew:alpha")!;
    expect(pool).toBeDefined();
    expect(crew.poolId).toBe(pool.id);
    expect(pool.group_id).toBe("crew:alpha");

    const group = db.getGroup("crew:alpha")!;
    expect(group).toBeDefined();
    expect(group.leader_id).toBe(String(OWNER));
    expect(roster(db, "crew:alpha")).toEqual(["e_alice", "e_bob", "e_owner"]);
    // Owner is the group leader (rank 2); members are plain members.
    expect(db.getGroupMember("crew:alpha", String(OWNER))?.rank).toBe(2);
    expect(db.getGroupMember("crew:alpha", "e_alice")?.rank).toBe(0);

    crews.stop();
    db.close();
  });

  it("ephemeral crews get neither pool nor group", () => {
    const db = new MarinaDB(DB_PATH);
    const crews = manager(db);
    crews.create({ name: "eph", goal: "", owner: OWNER, members: [{ agentName: "alice" }] });
    expect(db.getMemoryPool("crew:eph")).toBeUndefined();
    expect(db.getGroup("crew:eph")).toBeUndefined();
    crews.stop();
    db.close();
  });

  it("syncs the roster on add / remove / dissolve, keeping the final roster past dissolution", () => {
    const db = new MarinaDB(DB_PATH);
    const crews = manager(db);
    const crew = crews.create({
      name: "alpha",
      goal: "ship",
      lifetime: "persisted",
      owner: OWNER,
      members: [{ agentName: "alice" }],
    });
    expect(roster(db, "crew:alpha")).toEqual(["e_alice", "e_owner"]);

    crews.addMember(crew.id, "bob");
    expect(roster(db, "crew:alpha")).toEqual(["e_alice", "e_bob", "e_owner"]);

    // An unresolvable name (agent offline) is skipped, not an error.
    crews.addMember(crew.id, "ghost");
    expect(roster(db, "crew:alpha")).toEqual(["e_alice", "e_bob", "e_owner"]);

    crews.removeMember(crew.id, "alice", "left");
    expect(roster(db, "crew:alpha")).toEqual(["e_bob", "e_owner"]);

    crews.dissolve(crew.id, "done");
    // Pool + notes survive (generational memory); the group keeps whoever was
    // in the crew at the end so reads stay scoped to former members.
    expect(db.getMemoryPool("crew:alpha")?.group_id).toBe("crew:alpha");
    expect(db.getGroup("crew:alpha")).toBeDefined();
    expect(roster(db, "crew:alpha")).toEqual(["e_bob", "e_owner"]);

    crews.stop();
    db.close();
  });

  it("a successor crew of the same name inherits the pool and re-syncs the group", () => {
    const db = new MarinaDB(DB_PATH);
    const crews = manager(db);
    const first = crews.create({
      name: "alpha",
      goal: "v1",
      lifetime: "persisted",
      owner: OWNER,
      members: [{ agentName: "alice" }],
    });
    const poolId = first.poolId;
    crews.dissolve(first.id, "done");
    crews.tick();

    const second = crews.create({
      name: "alpha",
      goal: "v2",
      lifetime: "persisted",
      owner: OWNER,
      members: [{ agentName: "carol" }],
    });
    expect(second.poolId).toBe(poolId);
    expect(roster(db, "crew:alpha")).toEqual(["e_carol", "e_owner"]);
    crews.stop();
    db.close();
  });

  it("backfills a pre-existing ungrouped crew pool on boot, idempotently", () => {
    // Simulate a crew persisted before the group object existed: pool row
    // with group_id NULL, crew row pointing at it, no group.
    const db1 = new MarinaDB(DB_PATH);
    const m1 = manager(db1);
    const crew = m1.create({
      name: "legacy",
      goal: "old",
      lifetime: "persisted",
      owner: OWNER,
      members: [{ agentName: "alice" }, { agentName: "bob" }],
    });
    const poolId = crew.poolId!;
    db1.setMemoryPoolGroup(poolId, null);
    db1.deleteGroup("crew:legacy");
    expect(db1.getMemoryPool("crew:legacy")?.group_id).toBeNull();
    expect(db1.getGroup("crew:legacy")).toBeUndefined();
    m1.stop();
    db1.close();

    // Boot 1: group attached, roster populated from the live crew.
    const db2 = new MarinaDB(DB_PATH);
    const m2 = manager(db2);
    expect(m2.loadFromDb()).toBe(1);
    expect(db2.getMemoryPool("crew:legacy")?.group_id).toBe("crew:legacy");
    expect(db2.getGroup("crew:legacy")?.leader_id).toBe(String(OWNER));
    expect(roster(db2, "crew:legacy")).toEqual(["e_alice", "e_bob", "e_owner"]);
    const groupCreatedAt = db2.getGroup("crew:legacy")!.created_at;
    m2.stop();
    db2.close();

    // Boot 2: nothing changes — same group row, same roster, no duplicates.
    const db3 = new MarinaDB(DB_PATH);
    const m3 = manager(db3);
    expect(m3.loadFromDb()).toBe(1);
    expect(db3.getGroup("crew:legacy")!.created_at).toBe(groupCreatedAt);
    expect(roster(db3, "crew:legacy")).toEqual(["e_alice", "e_bob", "e_owner"]);
    expect(db3.getAllGroups().filter((g) => g.id === "crew:legacy")).toHaveLength(1);
    m3.stop();
    db3.close();
  });

  it("re-syncs transient entity ids when a member deposits or the crew dispatches", () => {
    const ids: Record<string, string> = { alice: "e_alice_1" };
    const db = new MarinaDB(DB_PATH);
    const crews = new CrewManager({
      channels: new ChannelManager(db, () => {}),
      db,
      resolveAgentId: (name) => ids[name],
    });
    const crew = crews.create({
      name: "alpha",
      goal: "ship",
      lifetime: "persisted",
      owner: OWNER,
      members: [{ agentName: "alice" }],
    });
    expect(roster(db, "crew:alpha")).toEqual(["e_alice_1", "e_owner"]);

    // alice reconnects and is re-minted with a new entity id.
    ids.alice = "e_alice_2";
    crews.dispatch(crew.id, "go");
    expect(roster(db, "crew:alpha")).toEqual(["e_alice_2", "e_owner"]);

    ids.alice = "e_alice_3";
    crews.onMemberPoolDeposit("alice", "crew:alpha", "finding");
    expect(roster(db, "crew:alpha")).toEqual(["e_alice_3", "e_owner"]);
    crews.stop();
    db.close();
  });
});

describe("crew pool group: membership guard (integration)", () => {
  const DB_PATH = "test_crew_pool_group_engine.db";
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let bob: MockConnection;
  let carol: MockConnection;

  beforeEach(() => {
    cleanupDb(DB_PATH);
    db = new MarinaDB(DB_PATH);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("c-alice");
    bob = new MockConnection("c-bob");
    carol = new MockConnection("c-carol");
    engine.addConnection(alice);
    engine.addConnection(bob);
    engine.addConnection(carol);
    engine.spawnEntity("c-alice", "alice");
    engine.spawnEntity("c-bob", "bob");
    engine.spawnEntity("c-carol", "carol");
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(DB_PATH);
  });

  const out = (c: MockConnection) => stripAnsi(c.allTextJoined());
  const clearAll = () => {
    alice.clear();
    bob.clear();
    carol.clear();
  };

  /** alice (owner+lead) + bob (member) in persisted crew `alpha`; carol outside. */
  function setupCrewWithNote(): void {
    engine.processCommand(alice.entity!, "crew create alpha bob persist -- ship the rebalance");
    engine.processCommand(bob.entity!, "crew join alpha");
    engine.processCommand(alice.entity!, "crew dispatch alpha go");
    engine.processCommand(
      alice.entity!,
      "pool crew:alpha add The shard rebalance needs a warm cache before cutover importance 7",
    );
    clearAll();
  }

  it("scopes the crew pool to owner + members", () => {
    setupCrewWithNote();
    const pool = db.getMemoryPool("crew:alpha")!;
    expect(pool.group_id).toBe("crew:alpha");
    const members = db.getGroupMembers("crew:alpha").map((m) => m.entity_id);
    expect(members).toContain(alice.entity!);
    expect(members).toContain(bob.entity!);
    expect(members).not.toContain(carol.entity!);
    expect(db.getGroup("crew:alpha")?.leader_id).toBe(alice.entity!);
  });

  it("pool crew:<name> recall — member allowed, non-member refused", () => {
    setupCrewWithNote();
    engine.processCommand(bob.entity!, "pool crew:alpha recall rebalance");
    expect(out(bob)).toContain("warm cache");

    engine.processCommand(carol.entity!, "pool crew:alpha recall rebalance");
    expect(out(carol)).toContain("not found or inaccessible");
    expect(out(carol)).not.toContain("warm cache");

    // The pool is invisible to outsiders in `pool list`, visible to members.
    clearAll();
    engine.processCommand(carol.entity!, "pool list");
    expect(out(carol)).not.toContain("crew:alpha");
    engine.processCommand(bob.entity!, "pool list");
    expect(out(bob)).toContain("crew:alpha");
  });

  it("gatherRetrievalContext skips the crew pool for non-members", () => {
    setupCrewWithNote();
    const forBob = gatherRetrievalContext(
      db,
      { id: bob.entity! as EntityId, name: "bob" },
      "rebalance",
      { world: 0, chronicle: 0 },
    );
    expect(forBob.pools.some((h) => h.pool === "crew:alpha")).toBe(true);

    const forCarol = gatherRetrievalContext(
      db,
      { id: carol.entity! as EntityId, name: "carol" },
      "rebalance",
      { world: 0, chronicle: 0 },
    );
    expect(forCarol.pools.some((h) => h.pool === "crew:alpha")).toBe(false);
  });

  it("recap surfaces crew pool notes to members only", () => {
    setupCrewWithNote();
    engine.processCommand(bob.entity!, "recap rebalance");
    expect(out(bob)).toContain("warm cache");

    engine.processCommand(carol.entity!, "recap rebalance");
    expect(out(carol)).not.toContain("warm cache");
  });

  it("crew info on a dissolved crew shows notes to former members only", () => {
    setupCrewWithNote();
    engine.processCommand(alice.entity!, "crew dissolve alpha done");
    for (let i = 0; i < 2; i++) engine.crewManager?.tick();
    expect(engine.crewManager?.getByName("alpha")).toBeUndefined();
    clearAll();

    engine.processCommand(bob.entity!, "crew info alpha");
    expect(out(bob)).toContain("dissolved");
    expect(out(bob)).toContain("warm cache");

    engine.processCommand(carol.entity!, "crew info alpha");
    expect(out(carol)).toContain("members-only");
    expect(out(carol)).not.toContain("warm cache");
  });

  it("a member who leaves loses access; the owner keeps it", () => {
    setupCrewWithNote();
    engine.processCommand(bob.entity!, "crew leave alpha");
    clearAll();
    engine.processCommand(bob.entity!, "pool crew:alpha recall rebalance");
    expect(out(bob)).toContain("not found or inaccessible");
    engine.processCommand(alice.entity!, "pool crew:alpha recall rebalance");
    expect(out(alice)).toContain("warm cache");
  });

  it("coordinator deposit + crew-channel echo keep working under the group scope", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob persist -- ship it");
    engine.processCommand(bob.entity!, "crew join alpha");
    engine.processCommand(alice.entity!, "crew dispatch alpha go");
    clearAll();

    engine.processCommand(
      bob.entity!,
      "pool crew:alpha add Cutover checklist drafted importance 6",
    );
    expect(out(bob)).toContain("Added note");
    const crew = engine.crewManager!.getByName("alpha")!;
    const history = engine.channelManager!.getHistory(crew.channelId!, 20);
    expect(history.some((m) => m.content.includes("[crew-deposit] bob"))).toBe(true);

    // Completion result lands in the (grouped) pool and is readable by members.
    clearAll();
    engine.processCommand(alice.entity!, "crew complete alpha -- shipped with warm cache");
    expect(out(alice)).toContain("completed");
    engine.processCommand(bob.entity!, "pool crew:alpha recall shipped");
    expect(out(bob)).toContain("shipped with warm cache");
    engine.processCommand(carol.entity!, "pool crew:alpha recall shipped");
    expect(out(carol)).not.toContain("shipped with warm cache");
  });
});
