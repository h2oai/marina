// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ChannelManager } from "../src/coordination/channel-manager";
import { CrewManager } from "../src/coordination/crew-manager";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { entityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

/**
 * A persisted crew is a standing team (a serving crew behind a model
 * endpoint, a project crew fed task after task). Completion used to dissolve
 * it like an ephemeral crew, and any MEMBER may complete — so a lead closing
 * one task ended the team, deleted its row, and every later dispatch replied
 * `Crew "<name>" not found.` with the work silently lost. Completion now
 * closes the unit of work and keeps a persisted crew; ephemeral crews still
 * dissolve.
 */
const TEST_DB = "test_crew_persisted_completion.db";
const IDS: Record<string, string> = { alice: "e_alice", bob: "e_bob" };
const OWNER = entityId("e_alice");

describe("CrewManager.complete keeps persisted crews", () => {
  let db: MarinaDB;
  let channels: ChannelManager;
  let crews: CrewManager;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    channels = new ChannelManager(db, () => {});
    crews = new CrewManager({
      channels,
      db,
      resolveAgentId: (name) => IDS[name],
    });
  });

  afterEach(() => {
    crews.stop();
    db.close();
    cleanupDb(TEST_DB);
  });

  it("a persisted crew survives completion, stays active, and takes the next dispatch", () => {
    const crew = crews.create({
      name: "serving",
      goal: "serve requests",
      lifetime: "persisted",
      owner: OWNER,
      members: [{ agentName: "alice", role: "owner" }, { agentName: "bob" }],
    });
    crews.dispatch(crew.id, "task one");
    crews.onMemberPoolDeposit("bob", "crew:serving", "task one result");

    const result = crews.complete(crew.id, "task one done", "bob");
    expect(result.retained).toBe(true);
    expect(result.resultNoteId).toBeDefined();
    expect(crews.getByName("serving")?.state).toBe("active");

    // The next task reaches the same crew and channel.
    crews.dispatch(crew.id, "task two");
    const history = channels.getHistory(crew.channelId!, 50);
    expect(history.some((m) => m.content.includes("[crew-task] task two"))).toBe(true);

    // The row survives a restart.
    crews.stop();
    const reloaded = new CrewManager({
      channels: new ChannelManager(db, () => {}),
      db,
      resolveAgentId: (name) => IDS[name],
    });
    reloaded.loadFromDb();
    expect(reloaded.getByName("serving")?.state).toBe("active");
    reloaded.stop();
  });

  it("a later completion needs fresh work evidence for standing", () => {
    const crew = crews.create({
      name: "serving",
      goal: "serve requests",
      lifetime: "persisted",
      owner: OWNER,
      members: [{ agentName: "alice", role: "owner" }, { agentName: "bob" }],
    });
    crews.dispatch(crew.id, "task one");
    crews.onMemberPoolDeposit("bob", "crew:serving", "task one result");
    expect(crews.complete(crew.id, "one", "alice").standingCredited).toBe(true);

    crews.dispatch(crew.id, "task two");
    const second = crews.complete(crew.id, "two, with no work", "alice");
    expect(second.standingCredited).toBe(false);
    expect(second.retained).toBe(true);
  });

  it("an ephemeral crew still dissolves on completion", () => {
    const crew = crews.create({
      name: "oneshot",
      goal: "one task",
      owner: OWNER,
      members: [{ agentName: "alice", role: "owner" }, { agentName: "bob" }],
    });
    crews.dispatch(crew.id, "go");
    const result = crews.complete(crew.id, "done", "alice");
    expect(result.retained).toBe(false);
    expect(crew.state).toBe("dissolved");
    expect(crews.getByName("oneshot")).toBeUndefined();
  });
});

describe("crew complete → crew dispatch on a persisted crew", () => {
  const CMD_DB = "test_crew_persisted_completion_cmd.db";
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let bob: MockConnection;

  beforeEach(() => {
    cleanupDb(CMD_DB);
    db = new MarinaDB(CMD_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("c-alice");
    bob = new MockConnection("c-bob");
    engine.addConnection(alice);
    engine.addConnection(bob);
    engine.spawnEntity("c-alice", "alice");
    engine.spawnEntity("c-bob", "bob");
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(CMD_DB);
  });

  it("a member completing one task does not lose the next dispatch", () => {
    engine.processCommand(alice.entity!, "crew create desk bob persist -- serve requests");
    engine.processCommand(bob.entity!, "crew join desk");
    engine.processCommand(alice.entity!, "crew dispatch desk TASK 1");

    bob.clear();
    engine.processCommand(bob.entity!, "crew complete desk -- TASK 1 done");
    const done = stripAnsi(bob.allTextJoined());
    expect(done).toContain('Crew "desk" completed');
    expect(done).toContain("Crew stays (persisted)");

    alice.clear();
    engine.processCommand(alice.entity!, "crew dispatch desk TASK 2");
    expect(stripAnsi(alice.allTextJoined())).toContain('Dispatched to crew "desk"');
    const crew = engine.crewManager!.getByName("desk")!;
    const history = engine.channelManager!.getHistory(crew.channelId!, 50);
    expect(history.some((m) => m.content.includes("[crew-task] TASK 2"))).toBe(true);
  });
});
