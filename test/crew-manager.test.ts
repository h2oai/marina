// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ChannelManager } from "../src/coordination/channel-manager";
import { CrewError, CrewManager } from "../src/coordination/crew-manager";
import { MarinaDB } from "../src/persistence/database";
import type { EngineEvent } from "../src/types";
import { entityId } from "../src/types";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_crew_manager.db";

const OWNER = entityId("e_owner");

describe("CrewManager", () => {
  let db: MarinaDB;
  let channels: ChannelManager;
  let events: EngineEvent[];
  let crews: CrewManager;
  let now = 0;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    channels = new ChannelManager(db, () => {});
    events = [];
    now = 1_700_000_000_000;
    crews = new CrewManager({
      channels,
      onEvent: (e) => events.push(e),
      now: () => now,
    });
  });

  afterEach(() => {
    crews.stop();
    db.close();
    cleanupDb(TEST_DB);
  });

  it("creates an ephemeral crew with members and emits lifecycle events", () => {
    const crew = crews.create({
      name: "alpha",
      goal: "ship phase 1",
      owner: OWNER,
      members: [{ agentName: "alice" }, { agentName: "bob", role: "reviewer" }],
    });

    expect(crew.name).toBe("alpha");
    expect(crew.lifetime).toBe("ephemeral");
    expect(crew.formation).toBe("freeform");
    expect(crew.state).toBe("assembling");
    expect(crew.members).toHaveLength(2);
    expect(crew.members[1]!.role).toBe("reviewer");

    const types = events.map((e) => e.type);
    expect(types).toContain("crew_created");
    expect(types.filter((t) => t === "crew_member_joined")).toHaveLength(2);
  });

  it("rejects duplicate names", () => {
    crews.create({ name: "alpha", goal: "", owner: OWNER, members: [{ agentName: "alice" }] });
    expect(() =>
      crews.create({ name: "alpha", goal: "", owner: OWNER, members: [{ agentName: "bob" }] }),
    ).toThrow(CrewError);
  });

  it("rejects empty member list", () => {
    expect(() => crews.create({ name: "alpha", goal: "", owner: OWNER, members: [] })).toThrow(
      /at least one member/,
    );
  });

  it("enforces ephemeral cap per owner", () => {
    for (let i = 0; i < 5; i++) {
      crews.create({
        name: `crew-${i}`,
        goal: "",
        owner: OWNER,
        members: [{ agentName: "alice" }],
      });
    }
    expect(() =>
      crews.create({
        name: "overflow",
        goal: "",
        owner: OWNER,
        members: [{ agentName: "alice" }],
      }),
    ).toThrow(/cap/);
  });

  it("dispatch lazily creates the crew channel and flips state to active", () => {
    const crew = crews.create({
      name: "alpha",
      goal: "",
      owner: OWNER,
      members: [{ agentName: "alice" }],
    });
    expect(crew.channelId).toBeUndefined();

    crews.dispatch(crew.id, "go");
    expect(crew.channelId).toBe(`crew:${crew.id}`);
    expect(crew.state).toBe("active");

    const channel = channels.getChannel(crew.channelId!);
    expect(channel?.type).toBe("crew");
    const history = channels.getHistory(crew.channelId!, 10);
    expect(history.at(-1)?.content).toStartWith("[crew-task] go");
  });

  it("forAgent indexes membership and excludes dissolved crews", () => {
    const a = crews.create({
      name: "alpha",
      goal: "",
      owner: OWNER,
      members: [{ agentName: "alice" }, { agentName: "bob" }],
    });
    const _b = crews.create({
      name: "beta",
      goal: "",
      owner: OWNER,
      members: [{ agentName: "alice" }],
    });

    expect(
      crews
        .forAgent("alice")
        .map((c) => c.name)
        .sort(),
    ).toEqual(["alpha", "beta"]);
    expect(crews.forAgent("bob").map((c) => c.name)).toEqual(["alpha"]);

    crews.dissolve(a.id, "test");
    expect(crews.forAgent("alice").map((c) => c.name)).toEqual(["beta"]);
  });

  it("addMember/removeMember update the index and emit events", () => {
    const crew = crews.create({
      name: "alpha",
      goal: "",
      owner: OWNER,
      members: [{ agentName: "alice" }],
    });

    events.length = 0;
    crews.addMember(crew.id, "carol", "lead");
    expect(crew.members).toHaveLength(2);
    expect(crews.forAgent("carol").map((c) => c.name)).toEqual(["alpha"]);
    expect(events.find((e) => e.type === "crew_member_joined")).toBeDefined();

    crews.removeMember(crew.id, "carol", "left");
    expect(crew.members).toHaveLength(1);
    expect(crews.forAgent("carol")).toEqual([]);
    expect(events.find((e) => e.type === "crew_member_left")).toBeDefined();
  });

  it("auto-dissolves when the last member leaves", () => {
    const crew = crews.create({
      name: "alpha",
      goal: "",
      owner: OWNER,
      members: [{ agentName: "alice" }],
    });
    crews.removeMember(crew.id, "alice", "stopped");
    expect(crew.state).toBe("dissolved");
    expect(events.find((e) => e.type === "crew_dissolved")).toBeDefined();
  });

  it("onAgentStopped removes the agent from every crew it was in", () => {
    const a = crews.create({
      name: "alpha",
      goal: "",
      owner: OWNER,
      members: [{ agentName: "alice" }, { agentName: "bob" }],
    });
    const b = crews.create({
      name: "beta",
      goal: "",
      owner: OWNER,
      members: [{ agentName: "alice" }],
    });

    crews.onAgentStopped("alice");

    expect(a.members.map((m) => m.agentName)).toEqual(["bob"]);
    // beta had only alice → auto-dissolved
    expect(b.state).toBe("dissolved");
  });

  it("tick GCs ephemeral crews idle longer than the timeout", () => {
    const crew = crews.create({
      name: "alpha",
      goal: "",
      owner: OWNER,
      members: [{ agentName: "alice" }],
    });
    crews.dispatch(crew.id, "go");
    expect(crew.state).toBe("active");

    // Advance past idle window
    now += 11 * 60 * 1000;
    crews.tick();
    expect(crew.state).toBe("dissolved");

    // Next tick drops the dissolved crew from the map
    crews.tick();
    expect(crews.get(crew.id)).toBeUndefined();
  });

  it("tick does not GC assembling (never-dispatched) ephemeral crews", () => {
    const crew = crews.create({
      name: "alpha",
      goal: "",
      owner: OWNER,
      members: [{ agentName: "alice" }],
    });
    now += 60 * 60 * 1000; // 1 hour later
    crews.tick();
    expect(crew.state).toBe("assembling");
  });

  it("rejects dispatch on a dissolved crew", () => {
    const crew = crews.create({
      name: "alpha",
      goal: "",
      owner: OWNER,
      members: [{ agentName: "alice" }],
    });
    crews.dissolve(crew.id, "test");
    expect(() => crews.dispatch(crew.id, "go")).toThrow(/dissolved/);
  });

  it("dispatch posts the formation brief on first activation", () => {
    const crew = crews.create({
      name: "alpha",
      goal: "ship phase 2",
      formation: "pipeline",
      owner: OWNER,
      members: [{ agentName: "alice" }],
    });
    crews.dispatch(crew.id, "begin");

    const history = channels.getHistory(crew.channelId!, 10);
    // First message: formation brief; then dispatch goal.
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0]!.content).toContain("[formation:pipeline]");
    expect(history[0]!.content).toContain("ship phase 2");
    expect(history[1]!.content).toStartWith("[crew-task] begin");
  });

  it("re-dispatch does NOT re-post the formation brief", () => {
    const crew = crews.create({
      name: "alpha",
      goal: "task",
      formation: "debate",
      owner: OWNER,
      members: [{ agentName: "alice" }],
    });
    crews.dispatch(crew.id, "first");
    crews.dispatch(crew.id, "second");

    const history = channels.getHistory(crew.channelId!, 10);
    const formationCount = history.filter((m) => m.content.startsWith("[formation:")).length;
    expect(formationCount).toBe(1);
  });

  it("setFormation re-posts the brief and updates the formation", () => {
    const crew = crews.create({
      name: "alpha",
      goal: "task",
      formation: "freeform",
      owner: OWNER,
      members: [{ agentName: "alice" }],
    });
    crews.dispatch(crew.id, "go");

    crews.setFormation(crew.id, "chorus");
    expect(crew.formation).toBe("chorus");

    const history = channels.getHistory(crew.channelId!, 10);
    const briefs = history.filter((m) => m.content.startsWith("[formation:"));
    expect(briefs.length).toBe(2);
    expect(briefs[0]!.content).toContain("freeform");
    expect(briefs[1]!.content).toContain("chorus");
  });

  it("setFormation is a no-op when formation is unchanged", () => {
    const crew = crews.create({
      name: "alpha",
      goal: "task",
      formation: "swarm",
      owner: OWNER,
      members: [{ agentName: "alice" }],
    });
    crews.dispatch(crew.id, "go");
    const before = channels.getHistory(crew.channelId!, 10).length;
    crews.setFormation(crew.id, "swarm");
    const after = channels.getHistory(crew.channelId!, 10).length;
    expect(after).toBe(before);
  });
});

describe("CrewManager: formation mediators", () => {
  let db: MarinaDB;
  let channels: ChannelManager;
  let crews: CrewManager;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    channels = new ChannelManager(db, () => {});
    crews = new CrewManager({ channels, onEvent: () => {}, now: () => 1_700_000_000_000 });
  });

  afterEach(() => {
    crews.stop();
    db.close();
    cleanupDb(TEST_DB);
  });

  function texts(crewChannelId: string): string[] {
    return channels.getHistory(crewChannelId, 20).map((m) => m.content);
  }

  it("posts a structural nudge on dispatch for mediated formations", () => {
    const crew = crews.create({
      name: "mr",
      goal: "sum the shards",
      owner: OWNER,
      formation: "mapreduce",
      members: [{ agentName: "lead", role: "lead" }, { agentName: "worker" }],
    });
    crews.dispatch(crew.id, "go");
    const history = texts(crew.channelId!);
    expect(history.some((t) => t.startsWith("[formation-mediator]"))).toBe(true);
    expect(history.some((t) => t.includes("independent chunks"))).toBe(true);
  });

  it("stays silent for unmediated formations (freeform)", () => {
    const crew = crews.create({
      name: "ff",
      goal: "anything",
      owner: OWNER,
      members: [{ agentName: "solo" }],
    });
    crews.dispatch(crew.id, "go");
    expect(texts(crew.channelId!).some((t) => t.startsWith("[formation-mediator]"))).toBe(false);
  });

  it("nudges the next pipeline stage owner on stage completion", () => {
    const crew = crews.create({
      name: "pl",
      goal: "staged build",
      owner: OWNER,
      formation: "pipeline",
      members: [{ agentName: "alice" }, { agentName: "bob" }],
    });
    crews.dispatch(crew.id, "go");
    crews.recordStageCompleted(crew.id, "draft", "alice");
    const history = texts(crew.channelId!);
    expect(history.some((t) => t.includes('Stage "draft" completed by alice'))).toBe(true);
  });

  it("guides mapreduce merge on map/reduce artifact deposits", () => {
    const crew = crews.create({
      name: "mr2",
      goal: "merge results",
      owner: OWNER,
      formation: "mapreduce",
      members: [{ agentName: "lead", role: "lead" }, { agentName: "worker" }],
    });
    crews.dispatch(crew.id, "go");
    crews.recordArtifactDeposit(crew.id, "worker", "note:1", "map");
    crews.recordArtifactDeposit(crew.id, "lead", "note:2", "reduce");
    const history = texts(crew.channelId!);
    expect(history.some((t) => t.includes("Map chunk landed from worker"))).toBe(true);
    expect(history.some((t) => t.includes("Reduce deposited by lead"))).toBe(true);
  });

  it("every formation brief carries its runtime crew brief", () => {
    const crew = crews.create({
      name: "db8",
      goal: "settle it",
      owner: OWNER,
      formation: "debate",
      members: [{ agentName: "a" }, { agentName: "b" }, { agentName: "judge" }],
    });
    crews.dispatch(crew.id, "go");
    const brief = texts(crew.channelId!).find((t) => t.startsWith("[formation:debate]"));
    expect(brief).toBeDefined();
    expect(brief!).toContain("SEALED positions");
    expect(brief!).toContain("takes precedence over formation process");
  });
});

describe("CrewManager: deposit echo (dedup visibility)", () => {
  let db: MarinaDB;
  let channels: ChannelManager;
  let crews: CrewManager;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    channels = new ChannelManager(db, () => {});
    crews = new CrewManager({ channels, onEvent: () => {}, now: () => 1_700_000_000_000 });
  });

  afterEach(() => {
    crews.stop();
    db.close();
    cleanupDb(TEST_DB);
  });

  it("echoes a member's pool deposit on the active crew channel", () => {
    const crew = crews.create({
      name: "dedup",
      goal: "one deposit only",
      owner: OWNER,
      members: [{ agentName: "alice" }, { agentName: "bob" }],
    });
    crews.dispatch(crew.id, "do the task");
    crews.onMemberPoolDeposit("alice", "eval-artifacts", "T1 PRIMES: 83, 89, 97");
    const history = channels.getHistory(crew.channelId!, 10).map((m) => m.content);
    const echo = history.find((c) => c.startsWith("[crew-deposit]"));
    expect(echo).toBeDefined();
    expect(echo!).toContain("alice → eval-artifacts");
    expect(echo!).toContain("do not");
    expect(echo!).toContain("83, 89, 97");
  });

  it("dispatch pre-assigns a designated depositor and rotates it per dispatch", () => {
    const crew = crews.create({
      name: "assign",
      goal: "one deliverable",
      owner: OWNER,
      members: [{ agentName: "alice" }, { agentName: "bob" }, { agentName: "cara" }],
    });
    crews.dispatch(crew.id, "task one");
    crews.dispatch(crew.id, "task two");
    crews.dispatch(crew.id, "task three");
    crews.dispatch(crew.id, "task four");
    const dispatches = channels
      .getHistory(crew.channelId!, 20)
      .map((m) => m.content)
      .filter((c) => c.startsWith("[crew-task]"));
    expect(dispatches).toHaveLength(4);
    const depositors = dispatches.map((d) => d.match(/Designated depositor: (\w+)\./)?.[1]);
    // Round-robin across all three members, wrapping on the fourth.
    expect(depositors).toEqual(["alice", "bob", "cara", "alice"]);
    expect(dispatches[0]!).toContain("only alice writes the final deliverable");
    expect(dispatches[0]!).toContain("Never write a competing deliverable");
    expect(dispatches[0]!).toContain("Everyone works the task");
  });

  it("stays silent for non-members and inactive crews", () => {
    const crew = crews.create({
      name: "quiet",
      goal: "g",
      owner: OWNER,
      members: [{ agentName: "alice" }],
    });
    // Not yet dispatched — no channel, must not throw.
    crews.onMemberPoolDeposit("alice", "pool-x", "content");
    crews.dispatch(crew.id, "go");
    const before = channels.getHistory(crew.channelId!, 20).length;
    // Non-member deposit — no echo.
    crews.onMemberPoolDeposit("mallory", "pool-x", "content");
    expect(channels.getHistory(crew.channelId!, 20).length).toBe(before);
  });

  it("truncates long deposit snippets", () => {
    const crew = crews.create({
      name: "trunc",
      goal: "g",
      owner: OWNER,
      members: [{ agentName: "alice" }],
    });
    crews.dispatch(crew.id, "go");
    crews.onMemberPoolDeposit("alice", "p", "x".repeat(300));
    const echo = channels
      .getHistory(crew.channelId!, 10)
      .map((m) => m.content)
      .find((c) => c.startsWith("[crew-deposit]"));
    expect(echo!.length).toBeLessThan(220);
    expect(echo!).toContain("…");
  });
});

describe("CrewManager: persistence", () => {
  const PERSIST_DB = "test_crew_persist.db";

  beforeEach(() => cleanupDb(PERSIST_DB));
  afterEach(() => cleanupDb(PERSIST_DB));

  function freshManager(): { db: MarinaDB; channels: ChannelManager; crews: CrewManager } {
    const db = new MarinaDB(PERSIST_DB);
    const channels = new ChannelManager(db, () => {});
    const crews = new CrewManager({ channels, db });
    return { db, channels, crews };
  }

  it("persisted crew survives a manager restart", () => {
    const { db: db1, crews: m1 } = freshManager();
    const crew = m1.create({
      name: "alpha",
      goal: "ship phase 3",
      formation: "pipeline",
      lifetime: "persisted",
      owner: entityId("e_owner"),
      members: [{ agentName: "alice" }, { agentName: "bob", role: "reviewer" }],
    });
    m1.dispatch(crew.id, "go");
    const channelId = crew.channelId!;
    m1.stop();
    db1.close();

    // Restart: new DB instance + new manager
    const db2 = new MarinaDB(PERSIST_DB);
    const channels2 = new ChannelManager(db2, () => {});
    const m2 = new CrewManager({ channels: channels2, db: db2 });
    const loaded = m2.loadFromDb();
    expect(loaded).toBe(1);

    const reloaded = m2.getByName("alpha");
    expect(reloaded).toBeDefined();
    expect(reloaded!.formation).toBe("pipeline");
    expect(reloaded!.goal).toBe("ship phase 3");
    expect(reloaded!.state).toBe("active");
    expect(reloaded!.channelId).toBe(channelId);
    expect(reloaded!.members.map((m) => m.agentName).sort()).toEqual(["alice", "bob"]);
    expect(reloaded!.members.find((m) => m.agentName === "bob")!.role).toBe("reviewer");

    // Channel still has its history
    expect(channels2.getChannel(channelId)).toBeDefined();
    db2.close();
  });

  it("ephemeral crew does NOT survive a restart", () => {
    const { db: db1, crews: m1 } = freshManager();
    m1.create({
      name: "alpha",
      goal: "",
      lifetime: "ephemeral",
      owner: entityId("e_owner"),
      members: [{ agentName: "alice" }],
    });
    db1.close();

    const db2 = new MarinaDB(PERSIST_DB);
    const channels2 = new ChannelManager(db2, () => {});
    const m2 = new CrewManager({ channels: channels2, db: db2 });
    const loaded = m2.loadFromDb();
    expect(loaded).toBe(0);
    expect(m2.getByName("alpha")).toBeUndefined();
    db2.close();
  });

  it("persist() upgrades ephemeral → persisted, creates a pool, survives restart", () => {
    const { db: db1, crews: m1 } = freshManager();
    const crew = m1.create({
      name: "alpha",
      goal: "task",
      lifetime: "ephemeral",
      owner: entityId("e_owner"),
      members: [{ agentName: "alice" }],
    });
    m1.persist(crew.id);
    expect(crew.lifetime).toBe("persisted");
    expect(crew.poolId).toBeDefined();
    expect(db1.getMemoryPool("crew:alpha")).toBeDefined();
    db1.close();

    const db2 = new MarinaDB(PERSIST_DB);
    const channels2 = new ChannelManager(db2, () => {});
    const m2 = new CrewManager({ channels: channels2, db: db2 });
    m2.loadFromDb();
    const reloaded = m2.getByName("alpha");
    expect(reloaded?.lifetime).toBe("persisted");
    expect(reloaded?.poolId).toBeDefined();
    db2.close();
  });

  it("member churn write-through round-trips", () => {
    const { db: db1, crews: m1 } = freshManager();
    const crew = m1.create({
      name: "alpha",
      goal: "task",
      lifetime: "persisted",
      owner: entityId("e_owner"),
      members: [{ agentName: "alice" }],
    });
    m1.addMember(crew.id, "carol", "lead");
    m1.removeMember(crew.id, "alice", "stopped");
    db1.close();

    const db2 = new MarinaDB(PERSIST_DB);
    const channels2 = new ChannelManager(db2, () => {});
    const m2 = new CrewManager({ channels: channels2, db: db2 });
    m2.loadFromDb();
    const reloaded = m2.getByName("alpha");
    expect(reloaded?.members.map((m) => m.agentName)).toEqual(["carol"]);
    expect(reloaded?.members[0]?.role).toBe("lead");
    db2.close();
  });

  it("complete() writes a result note + dissolves the crew", () => {
    const { db, crews } = freshManager();
    const crew = crews.create({
      name: "alpha",
      goal: "ship",
      lifetime: "persisted",
      owner: entityId("e_owner"),
      members: [{ agentName: "alice" }],
    });
    crews.dispatch(crew.id, "go");
    const result = crews.complete(crew.id, "shipped phase 3", "alice");
    expect(result.resultNoteId).toBeDefined();
    expect(crew.state).toBe("dissolved");

    // Note exists in the crew pool
    const pool = db.getMemoryPool("crew:alpha");
    expect(pool).toBeDefined();
    db.close();
  });

  it("persist() rejects already-persisted crews", () => {
    const { db, crews } = freshManager();
    const crew = crews.create({
      name: "alpha",
      goal: "",
      lifetime: "persisted",
      owner: entityId("e_owner"),
      members: [{ agentName: "alice" }],
    });
    expect(() => crews.persist(crew.id)).toThrow(CrewError);
    db.close();
  });

  it("dissolve() removes the row from DB for persisted crews", () => {
    const { db, crews } = freshManager();
    const crew = crews.create({
      name: "alpha",
      goal: "",
      lifetime: "persisted",
      owner: entityId("e_owner"),
      members: [{ agentName: "alice" }],
    });
    expect(db.getCrewByName("alpha")).toBeDefined();
    crews.dissolve(crew.id, "test");
    expect(db.getCrewByName("alpha")).toBeUndefined();
    db.close();
  });
});
