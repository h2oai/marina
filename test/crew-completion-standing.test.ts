// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getStanding } from "../src/agent/standing";
import { ChannelManager } from "../src/coordination/channel-manager";
import { CrewManager } from "../src/coordination/crew-manager";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { entityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_crew_completion_standing.db";
const IDS: Record<string, string> = { alice: "e_alice", bob: "e_bob" };
const OWNER = entityId("e_alice");

/**
 * `crew complete` used to pay crew_complete_member (5) + crew_complete_lead
 * (10) to the owner of ANY crew — `crew create` + `crew complete` with no
 * work farmed 15 standing per fresh crew id at rank 0. Standing now requires
 * an active (dispatched) crew with >= 2 distinct members and at least one
 * completed dispatch (stage / artifact / member pool deposit). Completion
 * itself still succeeds; the reply says why nothing was credited.
 */
describe("CrewManager.complete standing preconditions", () => {
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

  it("farm case: create + complete with no dispatch writes the note but pays nothing", () => {
    const crew = crews.create({
      name: "farm",
      goal: "nothing",
      owner: OWNER,
      members: [{ agentName: "alice", role: "owner" }],
    });
    const result = crews.complete(crew.id, "done", "alice");

    expect(result.resultNoteId).toBeDefined();
    expect(result.standingCredited).toBe(false);
    expect(result.standingSkippedReason).toContain("never dispatched");
    expect(crew.state).toBe("dissolved");
    expect(getStanding(db, "e_alice")).toBe(0);
  });

  it("dispatched single-member crew pays nothing", () => {
    const crew = crews.create({
      name: "solo",
      goal: "g",
      owner: OWNER,
      members: [{ agentName: "alice", role: "owner" }],
    });
    crews.dispatch(crew.id, "go");
    crews.recordStageCompleted(crew.id, "draft", "alice");
    const result = crews.complete(crew.id, "done", "alice");
    expect(result.standingCredited).toBe(false);
    expect(result.standingSkippedReason).toContain("2 distinct members");
    expect(getStanding(db, "e_alice")).toBe(0);
  });

  it("dispatched two-member crew with no completed work pays nothing", () => {
    const crew = crews.create({
      name: "idle",
      goal: "g",
      owner: OWNER,
      members: [{ agentName: "alice", role: "owner" }, { agentName: "bob" }],
    });
    crews.dispatch(crew.id, "go");
    const result = crews.complete(crew.id, "done", "alice");
    expect(result.standingCredited).toBe(false);
    expect(result.standingSkippedReason).toContain("no dispatch was completed");
    expect(getStanding(db, "e_alice")).toBe(0);
    expect(getStanding(db, "e_bob")).toBe(0);
  });

  it("legitimate completion credits every member and the lead bonus to the owner", () => {
    const crew = crews.create({
      name: "real",
      goal: "ship",
      owner: OWNER,
      members: [{ agentName: "alice", role: "owner" }, { agentName: "bob" }],
    });
    crews.dispatch(crew.id, "go");
    crews.recordStageCompleted(crew.id, "draft", "bob");
    const result = crews.complete(crew.id, "shipped", "alice");

    expect(result.standingCredited).toBe(true);
    expect(result.standingSkippedReason).toBeUndefined();
    const alice = getStanding(db, "e_alice");
    const bob = getStanding(db, "e_bob");
    expect(bob).toBeGreaterThan(0);
    // Owner gets member credit + lead bonus.
    expect(alice).toBeGreaterThan(bob);
  });

  it("a member pool deposit while active counts as completed work", () => {
    const crew = crews.create({
      name: "deposit",
      goal: "ship",
      owner: OWNER,
      members: [{ agentName: "alice", role: "owner" }, { agentName: "bob" }],
    });
    crews.dispatch(crew.id, "go");
    crews.onMemberPoolDeposit("bob", "findings", "the deliverable");
    expect(crews.complete(crew.id, "shipped", "alice").standingCredited).toBe(true);
  });

  it("work evidence survives a restart for persisted crews (via the crew channel)", () => {
    const crew = crews.create({
      name: "durable",
      goal: "ship",
      lifetime: "persisted",
      owner: OWNER,
      members: [{ agentName: "alice", role: "owner" }, { agentName: "bob" }],
    });
    crews.dispatch(crew.id, "go");
    crews.onMemberPoolDeposit("bob", "crew:durable", "the deliverable");
    crews.stop();

    const reloaded = new CrewManager({
      channels: new ChannelManager(db, () => {}),
      db,
      resolveAgentId: (name) => IDS[name],
    });
    reloaded.loadFromDb();
    const again = reloaded.getByName("durable")!;
    expect(again.state).toBe("active");
    expect(reloaded.complete(again.id, "shipped", "alice").standingCredited).toBe(true);
    reloaded.stop();
  });
});

describe("crew complete command reply", () => {
  const CMD_DB = "test_crew_completion_cmd.db";
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

  it("reports the skip reason on a one-liner and pays no standing", () => {
    // bob is invited but never accepts — the crew is alice alone, never dispatched.
    engine.processCommand(alice.entity!, "crew create farm bob -- nothing");
    alice.clear();
    engine.processCommand(alice.entity!, "crew complete farm -- done");
    const out = stripAnsi(alice.allTextJoined());
    expect(out).toContain('Crew "farm" completed');
    expect(out).toContain("no standing credited:");
    expect(getStanding(db, String(alice.entity!))).toBe(0);
  });
});
