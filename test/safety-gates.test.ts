// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { OPEN_POSTURE_CORE } from "../src/engine/autonomy";
import {
  checkGate,
  checkGateForExecution,
  checkUnattendedGate,
  getGateProgress,
  grant,
  grantGatesForRank,
  listGates,
  recordApprovedDemonstration,
  recordDemonstration,
  revoke,
  SAFETY_GATES,
} from "../src/engine/safety-gates";
import { resetTrustProfileForTests, setTrustProfile } from "../src/engine/trust-profile";
import { MarinaDB } from "../src/persistence/database";
import { GRANTED_DEMONSTRATIONS, isGrantedCompetence } from "../src/persistence/db-competence";
import { cleanupDb, tempDbPath } from "./helpers";
import { scopeProcessState } from "./process-state";

const TEST_DB = tempDbPath("test_safety_gates.db");

/** Seed an entity's standing via the existing task path. */
function seedStanding(db: MarinaDB, entityId: string, name: string, amount: number): void {
  const taskId = db.createTask({ title: "seed", creatorId: entityId, creatorName: name });
  db.recordStandingEarned(entityId, name, taskId, amount);
}

describe("Safety gates", () => {
  let db: MarinaDB;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("registry includes all migrated commands", () => {
    const ids = listGates();
    expect(ids).toContain("shell.exec");
    expect(ids).toContain("agent.run");
    expect(ids).toContain("agent.spawn");
    expect(ids).toContain("adapter.enable");
    expect(ids).toContain("connect.manage");
    expect(ids).toContain("gateway.connect");
    expect(ids).toContain("key.manage");
    expect(ids).toContain("admin.destructive");
  });

  it("rejects unknown gate ids", () => {
    const result = checkGate(db, "e_alice", "fake.gate");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Unknown");
  });

  it("entity with no standing and no competence is denied", () => {
    const result = checkGate(db, "e_nobody", "agent.run");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("standing");
  });

  it("grant() unconditionally authorizes an entity for a gate", () => {
    grant(db, "e_operator", "shell.exec");
    const result = checkGate(db, "e_operator", "shell.exec");
    expect(result.ok).toBe(true);
    expect(result.supervisedOnly).toBeUndefined();
  });

  it("standing alone does not unlock — first attempt is supervised-only", () => {
    seedStanding(db, "e_alice", "Alice", 120);
    const result = checkGate(db, "e_alice", "agent.run");
    expect(result.ok).toBe(true);
    expect(result.supervisedOnly).toBe(true);
  });

  it("recordDemonstration increments and unlocks at the threshold", () => {
    seedStanding(db, "e_alice", "Alice", 120);

    // agent.run.demoThreshold === 3
    expect(checkGate(db, "e_alice", "agent.run").supervisedOnly).toBe(true);
    recordDemonstration(db, "e_alice", "agent.run");
    expect(checkGate(db, "e_alice", "agent.run").supervisedOnly).toBe(true);
    recordDemonstration(db, "e_alice", "agent.run");
    expect(checkGate(db, "e_alice", "agent.run").supervisedOnly).toBe(true);
    recordDemonstration(db, "e_alice", "agent.run");

    const final = checkGate(db, "e_alice", "agent.run");
    expect(final.ok).toBe(true);
    expect(final.supervisedOnly).toBeUndefined();
  });

  // ── Finding 3: supervised gates cannot be self-certified ──
  describe("checkUnattendedGate (no self-certification)", () => {
    it("refuses a standing-only holder — supervisedOnly is downgraded to a denial", () => {
      seedStanding(db, "e_alice", "Alice", 120);
      // checkGate would say "ok, but supervised"; the unattended check refuses.
      expect(checkGate(db, "e_alice", "agent.run").supervisedOnly).toBe(true);
      const unattended = checkUnattendedGate(db, "e_alice", "agent.run");
      expect(unattended.ok).toBe(false);
      expect(unattended.reason).toContain("Supervised-only");
      expect(unattended.reason?.toLowerCase()).toContain("cannot be self-certified");
    });

    it("passes only when the entity already holds unsupervised competence", () => {
      grant(db, "e_op", "code.exec");
      const result = checkUnattendedGate(db, "e_op", "code.exec");
      expect(result.ok).toBe(true);
      expect(result.supervisedOnly).toBeUndefined();
    });

    it("still refuses an entity with no standing (same as checkGate)", () => {
      const result = checkUnattendedGate(db, "e_nobody", "agent.spawn");
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("standing");
    });

    it("running an op under supervision never auto-unlocks it (no self-report path)", () => {
      seedStanding(db, "e_alice", "Alice", 120);
      // Simulate the OLD vulnerability: an entity 'running' code.exec many times.
      // With no witnessed demonstrations, it stays refused forever.
      for (let i = 0; i < 10; i++) {
        expect(checkUnattendedGate(db, "e_alice", "code.exec").ok).toBe(false);
      }
      // No demonstrations were minted by the refusals.
      expect(db.getCompetence("e_alice", "code.exec")?.demonstrations ?? 0).toBe(0);
    });
  });

  describe("recordApprovedDemonstration (approvals are the proof)", () => {
    it("refuses self-approval", () => {
      seedStanding(db, "e_alice", "Alice", 120);
      expect(recordApprovedDemonstration(db, "e_alice", "agent.run", "e_alice")).toBe(false);
      expect(db.getCompetence("e_alice", "agent.run")?.demonstrations ?? 0).toBe(0);
    });

    it("never builds an operator-grant gate", () => {
      for (const gateId of OPEN_POSTURE_CORE) {
        expect(recordApprovedDemonstration(db, "e_alice", gateId, "e_operator")).toBe(false);
        recordDemonstration(db, "e_alice", gateId);
        expect(db.getCompetence("e_alice", gateId)).toBeUndefined();
      }
    });

    it("approved runs advance the entity to unsupervised at the threshold", () => {
      seedStanding(db, "e_alice", "Alice", 120);
      // agent.run.demoThreshold === 3; the approver needs no competence row of its own.
      expect(recordApprovedDemonstration(db, "e_alice", "agent.run", "e_person")).toBe(true);
      expect(recordApprovedDemonstration(db, "e_alice", "agent.run", "e_person")).toBe(true);
      expect(checkUnattendedGate(db, "e_alice", "agent.run").ok).toBe(false);
      expect(recordApprovedDemonstration(db, "e_alice", "agent.run", "e_person")).toBe(true);
      expect(checkUnattendedGate(db, "e_alice", "agent.run").ok).toBe(true);
    });
  });

  it("operator-grant gates have no standing or demonstration path", () => {
    seedStanding(db, "e_rich", "Rich", 5000);
    for (const gateId of OPEN_POSTURE_CORE) {
      const result = checkGate(db, "e_rich", gateId);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("Operator grant");
      grant(db, "e_rich", gateId);
      expect(checkGate(db, "e_rich", gateId)).toEqual({ ok: true });
    }
  });

  it("revoke removes an explicit grant", () => {
    grant(db, "e_alice", "shell.exec");
    expect(checkGate(db, "e_alice", "shell.exec").ok).toBe(true);
    revoke(db, "e_alice", "shell.exec");
    // Without standing, denial returns to the "not enough standing" reason.
    const result = checkGate(db, "e_alice", "shell.exec");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("standing");
  });

  it("each gate has a sane definition; operator-grant gates are exactly the open-posture core", () => {
    for (const id of listGates()) {
      const gate = SAFETY_GATES[id]!;
      expect(gate.id).toBe(id);
      expect(gate.description.length).toBeGreaterThan(5);
      if (gate.operatorGrant) {
        expect(OPEN_POSTURE_CORE.has(id)).toBe(true);
        expect(gate.minStanding).toBe(0);
        expect(gate.demoThreshold).toBe(0);
      } else {
        expect(OPEN_POSTURE_CORE.has(id)).toBe(false);
        expect(gate.minStanding).toBeGreaterThan(0);
        expect(gate.demoThreshold).toBeGreaterThan(0);
      }
    }
  });

  it("earnable floors are reachable through verified work (2026-10-14 table)", () => {
    const floors = Object.fromEntries(
      Object.values(SAFETY_GATES)
        .filter((g) => !g.operatorGrant)
        .map((g) => [g.id, g.minStanding]),
    );
    expect(floors).toEqual({
      "code.exec": 3,
      "agent.spawn": 10,
      "role.edit": 10,
      "world.lineage": 10,
      "agent.run": 20,
      "decisions.configure": 30,
      "adapter.enable": 30,
      "connect.manage": 30,
      "gateway.connect": 30,
    });
  });

  it("grantGatesForRank below the safety threshold is a no-op", () => {
    grantGatesForRank(db, "e_alice", 4);
    for (const id of listGates()) {
      expect(db.getCompetence("e_alice", id)).toBeUndefined();
    }
  });

  it("grantGatesForRank(5) grants shell.exec and agent.spawn", () => {
    grantGatesForRank(db, "e_alice", 5);
    expect(db.getCompetence("e_alice", "shell.exec")?.supervised_only).toBe(0);
    expect(db.getCompetence("e_alice", "agent.spawn")?.supervised_only).toBe(0);
    expect(db.getCompetence("e_alice", "agent.run")).toBeUndefined();
    expect(db.getCompetence("e_alice", "admin.destructive")).toBeUndefined();
  });

  it("agent.spawn unlocks below the rank-4 ceiling (standing 10, supervised first)", () => {
    // Under the floor (10) → denied outright.
    seedStanding(db, "e_low", "LowStanding", 5);
    const denied = checkGate(db, "e_low", "agent.spawn");
    expect(denied.ok).toBe(false);
    expect(denied.reason).toContain("standing");

    // Clear of the threshold → may attempt, but supervised until demonstrated.
    seedStanding(db, "e_org", "Organizer", 60);
    const supervised = checkGate(db, "e_org", "agent.spawn");
    expect(supervised.ok).toBe(true);
    expect(supervised.supervisedOnly).toBe(true);

    // agent.spawn.demoThreshold === 3 → unsupervised after three clean spawns.
    recordDemonstration(db, "e_org", "agent.spawn");
    recordDemonstration(db, "e_org", "agent.spawn");
    recordDemonstration(db, "e_org", "agent.spawn");
    const unlocked = checkGate(db, "e_org", "agent.spawn");
    expect(unlocked.ok).toBe(true);
    expect(unlocked.supervisedOnly).toBeUndefined();
  });

  it("grantGatesForRank(7) grants shell.exec, agent.run, plus the rank-7 trio", () => {
    grantGatesForRank(db, "e_steward", 7);
    for (const id of [
      "shell.exec",
      "agent.run",
      "adapter.enable",
      "connect.manage",
      "gateway.connect",
    ]) {
      expect(db.getCompetence("e_steward", id)?.supervised_only).toBe(0);
    }
    expect(db.getCompetence("e_steward", "key.manage")).toBeUndefined();
    expect(db.getCompetence("e_steward", "admin.destructive")).toBeUndefined();
  });

  it("grantGatesForRank(9) grants every RANK-TIERED gate but not code.exec.unrestricted", () => {
    grantGatesForRank(db, "e_sov", 9);
    // Every rank-tiered gate is granted to a sovereign...
    for (const id of [
      "shell.exec",
      "agent.spawn",
      "code.exec",
      "agent.run",
      "adapter.enable",
      "connect.manage",
      "gateway.connect",
      "key.manage",
      "admin.destructive",
    ]) {
      expect(db.getCompetence("e_sov", id)?.supervised_only).toBe(0);
    }
    // ...but the arbitrary-exec gate is NEVER granted by rank, not even for a
    // sovereign — it is earned or granted explicitly, and fenced by the approver.
    expect(db.getCompetence("e_sov", "code.exec.unrestricted")).toBeUndefined();
  });

  it("registers code.exec.unrestricted as operator-grant only, off the rank ladder", () => {
    expect(listGates()).toContain("code.exec.unrestricted");
    const gate = SAFETY_GATES["code.exec.unrestricted"]!;
    expect(gate.operatorGrant).toBe(true);
    expect(gate.minStanding).toBe(0);
    expect(gate.demoThreshold).toBe(0);
    seedStanding(db, "e_rich", "Rich", 5000);
    const refused = checkGate(db, "e_rich", "code.exec.unrestricted");
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain("Operator grant");
    // It sorts last on the ladder (operator-grant gates follow the earnable ones).
    expect(getGateProgress(db, "e_rich").at(-1)!.id).toBe("code.exec.unrestricted");
  });

  // ── getGateProgress: the visible "what's next past rank 4" ladder ──
  describe("getGateProgress", () => {
    it("locks every gate for a fresh entity and reports the standing gap", () => {
      const progress = getGateProgress(db, "e_fresh");
      expect(progress.every((g) => g.status === "locked")).toBe(true);
      // Ordered by reachability — code.exec (min 3) first; operator-grant gates
      // follow the earnable ones, the arbitrary-exec gate last.
      expect(progress[0]!.id).toBe("code.exec");
      expect(progress.at(-1)!.id).toBe("code.exec.unrestricted");
      const spawn = progress.find((g) => g.id === "agent.spawn")!;
      expect(spawn.standing).toBe(0);
      expect(spawn.minStanding).toBe(10);
      expect(progress.find((g) => g.id === "shell.exec")!.operatorGrant).toBe(true);
    });

    it("flips a gate to supervised once standing crosses its threshold", () => {
      seedStanding(db, "e_org", "org", 50); // ≥ agent.spawn (10); shell.exec is operator-grant
      const progress = getGateProgress(db, "e_org");
      const byId = Object.fromEntries(progress.map((g) => [g.id, g]));
      expect(byId["agent.spawn"]!.status).toBe("supervised");
      expect(byId["agent.spawn"]!.demonstrations).toBe(0);
      expect(byId["shell.exec"]!.status).toBe("locked");
    });

    it("reports unlocked after enough demonstrations", () => {
      seedStanding(db, "e_builder", "builder", 120);
      // Demonstrate agent.spawn to threshold (3) → unlocked.
      for (let i = 0; i < SAFETY_GATES["agent.spawn"]!.demoThreshold; i++) {
        recordDemonstration(db, "e_builder", "agent.spawn");
      }
      const progress = getGateProgress(db, "e_builder");
      const spawn = progress.find((g) => g.id === "agent.spawn")!;
      expect(spawn.status).toBe("unlocked");
      expect(spawn.demonstrations).toBeGreaterThanOrEqual(3);
    });
  });

  // ── Standing re-check on unsupervised holders (decay never un-flips competence) ──
  describe("standing re-check on demonstrated (flipped) holders", () => {
    let processState: DisposableStack | undefined;

    const DAY = 24 * 60 * 60 * 1000;
    /** Four half-lives later: standing / 16 — well below every gate's bar. */
    const LATER = Date.now() + 240 * DAY;

    /** Flip agent.run (threshold 3) for an entity with standing 120 via demonstrations. */
    function flipAgentRun(entityId: string, name: string): void {
      seedStanding(db, entityId, name, 120);
      for (let i = 0; i < SAFETY_GATES["agent.run"]!.demoThreshold; i++) {
        recordDemonstration(db, entityId, "agent.run");
      }
      expect(db.getCompetence(entityId, "agent.run")?.supervised_only).toBe(0);
    }

    const prevAutonomy = process.env.MARINA_AUTONOMY;
    beforeEach(() => {
      using pendingProcessState = scopeProcessState();

      delete process.env.MARINA_AUTONOMY;
      resetTrustProfileForTests();

      processState = pendingProcessState.move();
    });
    afterEach(() => {
      using _processState = processState;
      processState = undefined;

      if (prevAutonomy === undefined) delete process.env.MARINA_AUTONOMY;
      else process.env.MARINA_AUTONOMY = prevAutonomy;
    });

    it("a flipped holder with standing at or above the bar passes solo", () => {
      flipAgentRun("e_alice", "Alice");
      const now = checkGate(db, "e_alice", "agent.run");
      expect(now).toEqual({ ok: true });
      expect(checkGateForExecution(db, "e_alice", "agent.run")).toEqual({
        ok: true,
        mode: "unattended",
      });
    });

    it("a flipped holder whose standing decayed below the bar is supervised-only, row untouched", () => {
      flipAgentRun("e_alice", "Alice");
      const before = db.getCompetence("e_alice", "agent.run")!;

      const decayed = checkGate(db, "e_alice", "agent.run", LATER);
      expect(decayed.ok).toBe(true);
      expect(decayed.supervisedOnly).toBe(true);
      expect(decayed.standingDecayed).toBe(true);
      expect(decayed.reason).toContain("standing decayed below 20");
      expect(decayed.reason).toContain("no re-demonstration");

      // Competence is a proof of demonstrations — decay never flips it back.
      const after = db.getCompetence("e_alice", "agent.run")!;
      expect(after.supervised_only).toBe(0);
      expect(after.demonstrations).toBe(before.demonstrations);

      // Unattended sites refuse, naming the decay rather than "cannot be self-certified".
      const unattended = checkUnattendedGate(db, "e_alice", "agent.run", LATER);
      expect(unattended.ok).toBe(false);
      expect(unattended.standingDecayed).toBe(true);
      expect(unattended.reason).toContain("standing decayed below 20");

      // The execution check (guarded posture, shared profile): refused, decay named.
      const exec = checkGateForExecution(db, "e_alice", "agent.run", LATER);
      expect(exec.ok).toBe(false);
      expect(exec.mode).toBeUndefined();
      expect(exec.standingDecayed).toBe(true);
      expect(exec.reason).toContain("standing decayed below 20");
    });

    it("recovery: standing climbing back over the bar passes again with no re-demonstration", () => {
      flipAgentRun("e_alice", "Alice");
      expect(checkGate(db, "e_alice", "agent.run", LATER).supervisedOnly).toBe(true);
      // Fresh contribution (a ledger write invalidates the standing cache):
      // 2000 / 16 = 125 ≥ 20 at LATER.
      seedStanding(db, "e_alice", "Alice", 2000);
      expect(checkGate(db, "e_alice", "agent.run", LATER)).toEqual({ ok: true });
      expect(checkGateForExecution(db, "e_alice", "agent.run", LATER).mode).toBe("unattended");
      // Still exactly the three demonstrations that flipped it.
      expect(db.getCompetence("e_alice", "agent.run")?.demonstrations).toBe(3);
    });

    it("the decayed holder is reported as locked + decayed on the progress ladder", () => {
      flipAgentRun("e_alice", "Alice");
      const fresh = getGateProgress(db, "e_alice").find((g) => g.id === "agent.run")!;
      expect(fresh.status).toBe("unlocked");
      expect(fresh.decayed).toBeUndefined();
      const later = getGateProgress(db, "e_alice", LATER).find((g) => g.id === "agent.run")!;
      expect(later.status).toBe("locked");
      expect(later.decayed).toBe(true);
      expect(later.demonstrations).toBe(3);
    });

    it("operator grants are distinguishable (sentinel) and exempt from the re-check in every profile", () => {
      using _processState = scopeProcessState();

      grant(db, "e_operator", "agent.run");
      const row = db.getCompetence("e_operator", "agent.run")!;
      expect(row.demonstrations).toBe(GRANTED_DEMONSTRATIONS);
      expect(isGrantedCompetence(row)).toBe(true);
      // A demonstrated flip is NOT a grant.
      flipAgentRun("e_alice", "Alice");
      expect(isGrantedCompetence(db.getCompetence("e_alice", "agent.run"))).toBe(false);

      // Zero standing, far future, shared (default) profile: the grant still passes.
      expect(checkGate(db, "e_operator", "agent.run", LATER)).toEqual({ ok: true });
      expect(checkGateForExecution(db, "e_operator", "agent.run", LATER)).toEqual({
        ok: true,
        mode: "unattended",
      });
      expect(
        getGateProgress(db, "e_operator", LATER).find((g) => g.id === "agent.run")!.status,
      ).toBe("unlocked");

      // Public profile: same — grants are admin overrides; `revoke` is their revocation.
      setTrustProfile("public");
      expect(checkGate(db, "e_operator", "agent.run", LATER)).toEqual({ ok: true });
      expect(checkGateForExecution(db, "e_operator", "agent.run", LATER).mode).toBe("unattended");
      // ...while the demonstrated holder is re-checked under public too.
      expect(checkGate(db, "e_alice", "agent.run", LATER).standingDecayed).toBe(true);
      expect(checkGateForExecution(db, "e_alice", "agent.run", LATER).ok).toBe(false);
    });

    it("under the local ungated profile a decayed holder still executes (profile-local), but checkGate stays honest", () => {
      using _processState = scopeProcessState();

      flipAgentRun("e_alice", "Alice");
      setTrustProfile("local");
      const exec = checkGateForExecution(db, "e_alice", "agent.run", LATER);
      expect(exec).toEqual({ ok: true, mode: "profile-local" });
      // The read-only check reports the decay regardless of profile.
      expect(checkGate(db, "e_alice", "agent.run", LATER).standingDecayed).toBe(true);
    });

    it("under the open posture a decayed holder passes earnable gates as posture-open, core gates are refused", () => {
      seedStanding(db, "e_org", "Organizer", 60);
      for (let i = 0; i < 3; i++) recordDemonstration(db, "e_org", "agent.spawn");
      process.env.MARINA_AUTONOMY = "open";
      expect(checkGateForExecution(db, "e_org", "agent.spawn", LATER).mode).toBe("posture-open");
      const core = checkGateForExecution(db, "e_org", "shell.exec", LATER);
      expect(core.ok).toBe(false);
      expect(core.reason).toContain("Operator grant");
    });

    it("RANK_GATES are untouched: grantGatesForRank(9) still grants the nine tiered gates as grants", () => {
      grantGatesForRank(db, "e_sov", 9);
      for (const id of [
        "shell.exec",
        "agent.spawn",
        "code.exec",
        "agent.run",
        "adapter.enable",
        "connect.manage",
        "gateway.connect",
        "key.manage",
        "admin.destructive",
      ]) {
        expect(isGrantedCompetence(db.getCompetence("e_sov", id))).toBe(true);
        expect(checkGate(db, "e_sov", id, LATER)).toEqual({ ok: true });
      }
      expect(db.getCompetence("e_sov", "code.exec.unrestricted")).toBeUndefined();
    });
  });
});
