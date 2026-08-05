import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

describe("crew command (integration)", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let bob: MockConnection;
  let carol: MockConnection;
  const dbPath = `/tmp/marina-crew-cmd-test-${Date.now()}.db`;

  beforeEach(() => {
    db = new MarinaDB(dbPath);
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
    db.close();
    cleanupDb(dbPath);
  });

  function lastFor(conn: MockConnection): string {
    return stripAnsi(conn.allTextJoined());
  }

  function accept(conn: MockConnection, crew = "alpha"): void {
    engine.processCommand(conn.entity!, `crew join ${crew}`);
  }

  it("crew create invites named agents without conscripting them", () => {
    alice.clear();
    engine.processCommand(alice.entity!, "crew create alpha bob,carol -- ship phase 1");

    const out = lastFor(alice);
    expect(out).toContain("alpha");
    expect(out).toContain("freeform/ephemeral");
    expect(out).toContain("2 invitations pending");

    const crew = engine.crewManager?.getByName("alpha");
    expect(crew).toBeDefined();
    expect(crew!.members.map((m) => m.agentName)).toEqual(["alice"]);
    expect(lastFor(bob)).toContain("crew join alpha");
    expect(engine.crewManager?.invitationsFor("bob")[0]?.status).toBe("pending");
    expect(crew!.lifetime).toBe("ephemeral");
    expect(crew!.formation).toBe("freeform");
    expect(crew!.goal).toBe("ship phase 1");
  });

  it("crew create rejects unknown agents", () => {
    alice.clear();
    engine.processCommand(alice.entity!, "crew create alpha ghost,bob -- task");
    expect(lastFor(alice)).toContain("Unknown agents");
    expect(engine.crewManager?.getByName("alpha")).toBeUndefined();
  });

  it("crew create accepts formation= and persist flags", () => {
    alice.clear();
    engine.processCommand(
      alice.entity!,
      "crew create beta bob formation=pipeline persist -- run pipeline",
    );
    const crew = engine.crewManager?.getByName("beta");
    expect(crew?.formation).toBe("pipeline");
    expect(crew?.lifetime).toBe("persisted");
  });

  it("crew dispatch provisions the channel and adds members", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob,carol -- task");
    accept(bob);
    accept(carol);
    alice.clear();
    engine.processCommand(alice.entity!, "crew dispatch alpha lets begin");

    const crew = engine.crewManager?.getByName("alpha");
    expect(crew?.channelId).toBe(`crew:${crew?.id}`);
    expect(crew?.state).toBe("active");

    const cm = engine.channelManager!;
    expect(cm.isMember(crew!.channelId!, bob.entity!)).toBe(true);
    expect(cm.isMember(crew!.channelId!, carol.entity!)).toBe(true);
    // Owner is also added so they see replies
    expect(cm.isMember(crew!.channelId!, alice.entity!)).toBe(true);

    expect(lastFor(alice)).toContain("Dispatched to crew");
  });

  it("crew info shows members and channel state", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob -- task");
    accept(bob);
    alice.clear();
    engine.processCommand(alice.entity!, "crew info alpha");
    const out = lastFor(alice);
    expect(out).toContain("alpha");
    expect(out).toContain("bob");
    expect(out).toContain("(unallocated)"); // channel not yet provisioned
  });

  it("crew join requires and accepts an invitation", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob -- task");
    carol.clear();
    engine.processCommand(carol.entity!, "crew join alpha");
    expect(lastFor(carol)).toContain("No pending invitation");
    accept(bob);
    expect(lastFor(bob)).toContain("Joined crew");

    const crew = engine.crewManager?.getByName("alpha");
    expect(crew?.members.map((m) => m.agentName).sort()).toEqual(["alice", "bob"]);
  });

  it("crew invitations are durable and can be explicitly declined", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob -- task");
    expect(db.getOpenCrewInvitations()).toHaveLength(1);
    bob.clear();
    engine.processCommand(bob.entity!, "crew invitations");
    expect(lastFor(bob)).toContain("alpha · from alice");
    engine.processCommand(bob.entity!, "crew decline alpha");
    expect(lastFor(bob)).toContain('Declined crew "alpha"');
    expect(db.getOpenCrewInvitations()).toHaveLength(0);
    expect(
      engine.crewManager?.getByName("alpha")?.members.map((member) => member.agentName),
    ).toEqual(["alice"]);
  });

  it("crew owners can issue a later role-specific invitation", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob -- task");
    engine.processCommand(bob.entity!, "crew decline alpha");
    alice.clear();
    engine.processCommand(alice.entity!, "crew invite alpha carol role=reviewer");
    expect(lastFor(alice)).toContain("Invited carol");
    expect(lastFor(carol)).toContain("as reviewer");
    accept(carol);
    expect(engine.crewManager?.getByName("alpha")?.members).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentName: "carol", role: "reviewer" })]),
    );
  });

  it("crew leave removes a member", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob,carol -- task");
    accept(bob);
    accept(carol);
    bob.clear();
    engine.processCommand(bob.entity!, "crew leave alpha");
    const crew = engine.crewManager?.getByName("alpha");
    expect(crew?.members.map((m) => m.agentName).sort()).toEqual(["alice", "carol"]);
  });

  it("crew dissolve by owner removes the crew", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob -- task");
    alice.clear();
    engine.processCommand(alice.entity!, "crew dissolve alpha shipping done");
    expect(lastFor(alice)).toContain("Dissolved crew");

    // Tick to drop the dissolved row from the in-memory map
    for (let i = 0; i < 2; i++) engine.crewManager?.tick();
    expect(engine.crewManager?.getByName("alpha")).toBeUndefined();
  });

  it("crew dissolve by non-owner low-rank is rejected", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob -- task");
    bob.clear();
    engine.processCommand(bob.entity!, "crew dissolve alpha");
    expect(lastFor(bob)).toContain("Only the owner");
    expect(engine.crewManager?.getByName("alpha")).toBeDefined();
  });

  it("who command appends a Crews section when crews exist", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob -- task");
    alice.clear();
    engine.processCommand(alice.entity!, "who");
    const out = lastFor(alice);
    expect(out).toMatch(/Crews \(\d+\)/);
    expect(out).toContain("alpha");
  });

  it("crew formation transitions and rejects unknown formations", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob -- task");
    alice.clear();
    engine.processCommand(alice.entity!, "crew formation alpha pipeline");
    expect(lastFor(alice)).toContain("formation → pipeline");
    expect(engine.crewManager?.getByName("alpha")?.formation).toBe("pipeline");

    alice.clear();
    engine.processCommand(alice.entity!, "crew formation alpha bogus");
    expect(lastFor(alice)).toContain("Unknown formation");
  });

  it("crew formation by non-owner low-rank is rejected", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob -- task");
    bob.clear();
    engine.processCommand(bob.entity!, "crew formation alpha debate");
    expect(lastFor(bob)).toContain("Only the owner");
    expect(engine.crewManager?.getByName("alpha")?.formation).toBe("freeform");
  });

  it("brief full shows a Your Crews section for crew members", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob,carol -- ship something");
    accept(bob);
    accept(carol);
    bob.clear();
    engine.processCommand(bob.entity!, "brief full");
    const out = lastFor(bob);
    expect(out).toContain("Your Crews");
    expect(out).toContain("alpha");
    expect(out).toContain("ship something");
    expect(out).toContain("carol");
  });

  it("compass brief includes a Crew: line for members", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob -- ship something");
    accept(bob);
    bob.clear();
    engine.processCommand(bob.entity!, "brief");
    const out = lastFor(bob);
    expect(out).toContain("Crew:");
    expect(out).toContain("alpha");
    expect(out).toContain("ship something");
  });

  it("next routes crew members back into an assembled crew", () => {
    engine.processCommand(bob.entity!, "memory set goal ship with the crew");
    engine.processCommand(alice.entity!, "crew create alpha bob -- ship the loop");
    accept(bob);

    bob.clear();
    engine.processCommand(bob.entity!, "next");

    const out = lastFor(bob);
    expect(out).toContain("Crew alpha is assembled but idle");
    expect(out).toContain("crew dispatch alpha ship the loop");
  });

  it("crew persist upgrades ephemeral → persisted (owner gate)", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob -- task");
    alice.clear();
    engine.processCommand(alice.entity!, "crew persist alpha");
    expect(lastFor(alice)).toContain("upgraded to persisted");

    const crew = engine.crewManager?.getByName("alpha");
    expect(crew?.lifetime).toBe("persisted");
    expect(crew?.poolId).toBeDefined();
    expect(engine.db?.getMemoryPool("crew:alpha")).toBeDefined();
  });

  it("crew persist rejects non-owner non-rank-4", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob -- task");
    bob.clear();
    engine.processCommand(bob.entity!, "crew persist alpha");
    expect(lastFor(bob)).toContain("Only the owner");
    expect(engine.crewManager?.getByName("alpha")?.lifetime).toBe("ephemeral");
  });

  it("crew complete by member writes result + dissolves", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob -- ship task");
    accept(bob);
    engine.processCommand(alice.entity!, "crew dispatch alpha go");
    bob.clear();
    engine.processCommand(bob.entity!, "crew complete alpha -- shipped it");
    expect(lastFor(bob)).toContain("completed");

    // Tick to drop dissolved crew
    for (let i = 0; i < 2; i++) engine.crewManager?.tick();
    expect(engine.crewManager?.getByName("alpha")).toBeUndefined();
  });

  it("crew info on a dissolved ephemeral crew finds tradition-pool trace", () => {
    // Ephemeral crews never provision a `crew:<name>` pool, but `crew
    // complete` writes a tagged note into the orchestration:<formation>
    // tradition pool. crew info should fall back to that trace so
    // successor agents can still recall what happened.
    engine.processCommand(
      alice.entity!,
      "crew create dissolved-ephemeral bob formation=research -- ship task",
    );
    engine.processCommand(alice.entity!, "crew dispatch dissolved-ephemeral go");
    engine.processCommand(alice.entity!, "crew complete dissolved-ephemeral -- result captured");
    // Tick to drop the crew from memory entirely
    for (let i = 0; i < 2; i++) engine.crewManager?.tick();
    expect(engine.crewManager?.getByName("dissolved-ephemeral")).toBeUndefined();

    alice.clear();
    engine.processCommand(alice.entity!, "crew info dissolved-ephemeral");
    const out = lastFor(alice);
    expect(out).toContain("dissolved-ephemeral");
    expect(out).toContain("dissolved, ephemeral");
    expect(out).toContain("result captured");
  });

  it("crew complete by non-member non-owner is rejected", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob -- task");
    carol.clear();
    engine.processCommand(carol.entity!, "crew complete alpha -- nope");
    expect(lastFor(carol)).toContain("Only the owner or a member");
    expect(engine.crewManager?.getByName("alpha")).toBeDefined();
  });

  it("crew complete requires a summary", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob -- task");
    alice.clear();
    engine.processCommand(alice.entity!, "crew complete alpha");
    expect(lastFor(alice)).toContain("Usage: crew complete");
  });

  it("crew dispatch by non-member non-owner low-rank is rejected", () => {
    // alice creates with bob as the only member; carol is neither owner nor member
    engine.processCommand(alice.entity!, "crew create alpha bob -- task");
    carol.clear();
    engine.processCommand(carol.entity!, "crew dispatch alpha go");
    expect(lastFor(carol)).toContain("Only the owner, a member");
    expect(engine.crewManager?.getByName("alpha")?.state).toBe("assembling");
  });

  it("crew dispatch by member is allowed", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob -- task");
    accept(bob);
    bob.clear();
    engine.processCommand(bob.entity!, "crew dispatch alpha go from a member");
    expect(lastFor(bob)).toContain("Dispatched to crew");
  });

  // ─── Civic event producers ─────────────────────────────────────────────

  it("crew stage by member emits crew_stage_completed and credits standing", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob -- ship");
    accept(bob);
    const captured: { type: string; agentName?: string; stage?: string }[] = [];
    engine.addEventListener((e) => {
      if (e.type === "crew_stage_completed") {
        captured.push({ type: e.type, agentName: e.agentName, stage: e.stage });
      }
    });

    alice.clear();
    bob.clear();
    engine.processCommand(bob.entity!, "crew stage alpha design");
    expect(lastFor(bob)).toContain('Stage "design"');
    expect(lastFor(alice)).toContain('bob completed crew "alpha" stage: design');
    expect(captured).toEqual([{ type: "crew_stage_completed", agentName: "bob", stage: "design" }]);

    const ledger = db.ledgerForEntity(bob.entity!, 10);
    expect(ledger.some((r) => r.kind === "crew_stage_completed")).toBe(true);
  });

  it("crew stage by non-member is rejected", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob -- ship");
    carol.clear();
    engine.processCommand(carol.entity!, "crew stage alpha design");
    expect(lastFor(carol)).toContain("Only members");
  });

  it("crew artifact records a deposit and credits standing", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob -- ship");
    accept(bob);
    const captured: { kind?: string; ref?: string }[] = [];
    engine.addEventListener((e) => {
      if (e.type === "crew_artifact_deposited") {
        captured.push({ kind: e.kind, ref: e.artifactRef });
      }
    });

    bob.clear();
    engine.processCommand(bob.entity!, "crew artifact alpha map -- shard-7.json");
    expect(lastFor(bob)).toContain("Deposited map artifact");
    expect(captured).toEqual([{ kind: "map", ref: "shard-7.json" }]);

    const ledger = db.ledgerForEntity(bob.entity!, 10);
    expect(ledger.some((r) => r.kind === "crew_artifact_deposited")).toBe(true);
  });

  it("crew artifact rejects unknown kind", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob -- ship");
    bob.clear();
    engine.processCommand(bob.entity!, "crew artifact alpha junk -- thing");
    expect(lastFor(bob)).toContain("Unknown artifact kind");
  });

  it("crew stall increments offense count; standing only debits at >= 3", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob,carol -- ship");
    accept(bob);
    accept(carol);

    // Alice (owner) flags bob three times.
    alice.clear();
    engine.processCommand(alice.entity!, "crew stall alpha bob no progress");
    engine.processCommand(alice.entity!, "crew stall alpha bob still nothing");
    expect(lastFor(alice)).not.toContain("standing penalty applied");

    let ledger = db.ledgerForEntity(bob.entity!, 10);
    expect(ledger.some((r) => r.kind === "crew_member_stalled")).toBe(false);

    alice.clear();
    engine.processCommand(alice.entity!, "crew stall alpha bob third strike");
    expect(lastFor(alice)).toContain("standing penalty applied");

    ledger = db.ledgerForEntity(bob.entity!, 10);
    expect(ledger.some((r) => r.kind === "crew_member_stalled" && r.amount < 0)).toBe(true);
  });

  it("crew stall rejects self-flagging", () => {
    engine.processCommand(alice.entity!, "crew create alpha bob -- ship");
    accept(bob);
    bob.clear();
    engine.processCommand(bob.entity!, "crew stall alpha bob laziness");
    expect(lastFor(bob)).toContain("Cannot flag yourself");
  });
});
