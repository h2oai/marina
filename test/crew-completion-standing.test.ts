// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getStanding, recordFromEvent } from "../src/agent/standing";
import { ChannelManager } from "../src/coordination/channel-manager";
import { CrewManager } from "../src/coordination/crew-manager";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { entityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi, tempDbPath } from "./helpers";

const TEST_DB = tempDbPath("test_crew_completion_standing.db");
const IDS: Record<string, string> = { alice: "e_alice", bob: "e_bob" };
const OWNER = entityId("e_alice");

/**
 * A crew declares its own result, so completing a crew earns no standing —
 * not the members, not the lead, however real the work (standing is earned by
 * work someone independent verified; crew work earns through the tasks an
 * independent creator approves). Stage and artifact events are progress
 * signals only. Rows already in the ledger keep decaying out.
 */
describe("CrewManager.complete earns no standing", () => {
  let db: MarinaDB;
  let crews: CrewManager;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    crews = new CrewManager({
      channels: new ChannelManager(db, () => {}),
      db,
      resolveAgentId: (name) => IDS[name],
    });
  });

  afterEach(() => {
    crews.stop();
    db.close();
    cleanupDb(TEST_DB);
  });

  it("an undispatched crew completes, writes its note, and pays nothing", () => {
    const crew = crews.create({
      name: "farm",
      goal: "nothing",
      owner: OWNER,
      members: [{ agentName: "alice", role: "owner" }],
    });
    const result = crews.complete(crew.id, "done", "alice");
    expect(result.resultNoteId).toBeDefined();
    expect(crew.state).toBe("dissolved");
    expect(getStanding(db, "e_alice")).toBe(0);
  });

  it("a dispatched two-member crew with real stages, artifacts and deposits pays nothing", () => {
    const crew = crews.create({
      name: "real",
      goal: "ship",
      owner: OWNER,
      members: [{ agentName: "alice", role: "owner" }, { agentName: "bob" }],
    });
    crews.dispatch(crew.id, "go");
    crews.recordStageCompleted(crew.id, "draft", "bob");
    crews.recordArtifactDeposit(crew.id, "bob", "note:1", "draft");
    crews.onMemberPoolDeposit("bob", "findings", "the deliverable");
    crews.complete(crew.id, "shipped", "alice");
    expect(getStanding(db, "e_alice")).toBe(0);
    expect(getStanding(db, "e_bob")).toBe(0);
    expect(db.ledgerForEntity("e_alice", 10)).toHaveLength(0);
    expect(db.ledgerForEntity("e_bob", 10)).toHaveLength(0);
  });

  it("stage and artifact events do not reach the ledger", () => {
    for (const event of [
      {
        type: "crew_stage_completed" as const,
        crew: "c1",
        stage: "draft",
        agentName: "bob",
        timestamp: Date.now(),
      },
      {
        type: "crew_artifact_deposited" as const,
        crew: "c1",
        artifactRef: "note:1",
        agentName: "bob",
        timestamp: Date.now(),
      },
    ])
      recordFromEvent(db, event as never, (name) => IDS[name]);
    expect(db.ledgerForEntity("e_bob", 10)).toHaveLength(0);
  });
});

describe("crew complete command reply", () => {
  const CMD_DB = tempDbPath("test_crew_completion_cmd.db");
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;

  beforeEach(() => {
    cleanupDb(CMD_DB);
    db = new MarinaDB(CMD_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("c-alice");
    const bob = new MockConnection("c-bob");
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

  it("completes on a one-liner and pays no standing", () => {
    // bob is invited but never accepts — the crew is alice alone, never dispatched.
    engine.processCommand(alice.entity!, "crew create farm bob -- nothing");
    alice.clear();
    engine.processCommand(alice.entity!, "crew complete farm -- done");
    const out = stripAnsi(alice.allTextJoined());
    expect(out).toContain('Crew "farm" completed');
    expect(out).not.toContain("standing");
    expect(getStanding(db, String(alice.entity!))).toBe(0);
  });
});
