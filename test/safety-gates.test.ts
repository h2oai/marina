// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  canWitness,
  checkGate,
  checkUnattendedGate,
  getGateProgress,
  grant,
  grantGatesForRank,
  listGates,
  recordDemonstration,
  recordWitnessedDemonstration,
  revoke,
  SAFETY_GATES,
} from "../src/engine/safety-gates";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_safety_gates.db";

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
    const result = checkGate(db, "e_nobody", "shell.exec");
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
    const result = checkGate(db, "e_alice", "shell.exec");
    expect(result.ok).toBe(true);
    expect(result.supervisedOnly).toBe(true);
  });

  it("recordDemonstration increments and unlocks at the threshold", () => {
    seedStanding(db, "e_alice", "Alice", 120);

    // shell.exec.demoThreshold === 3
    expect(checkGate(db, "e_alice", "shell.exec").supervisedOnly).toBe(true);
    recordDemonstration(db, "e_alice", "shell.exec");
    expect(checkGate(db, "e_alice", "shell.exec").supervisedOnly).toBe(true);
    recordDemonstration(db, "e_alice", "shell.exec");
    expect(checkGate(db, "e_alice", "shell.exec").supervisedOnly).toBe(true);
    recordDemonstration(db, "e_alice", "shell.exec");

    const final = checkGate(db, "e_alice", "shell.exec");
    expect(final.ok).toBe(true);
    expect(final.supervisedOnly).toBeUndefined();
  });

  // ── Finding 3: supervised gates cannot be self-certified ──
  describe("checkUnattendedGate (no self-certification)", () => {
    it("refuses a standing-only holder — supervisedOnly is downgraded to a denial", () => {
      seedStanding(db, "e_alice", "Alice", 120);
      // checkGate would say "ok, but supervised"; the unattended check refuses.
      expect(checkGate(db, "e_alice", "shell.exec").supervisedOnly).toBe(true);
      const unattended = checkUnattendedGate(db, "e_alice", "shell.exec");
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

  describe("recordWitnessedDemonstration (external attestation only)", () => {
    it("refuses self-witnessing", () => {
      seedStanding(db, "e_alice", "Alice", 120);
      expect(recordWitnessedDemonstration(db, "e_alice", "shell.exec", "e_alice")).toBe(false);
      expect(db.getCompetence("e_alice", "shell.exec")?.demonstrations ?? 0).toBe(0);
    });

    it("refuses an unqualified witness (not unsupervised on the gate)", () => {
      seedStanding(db, "e_alice", "Alice", 120);
      seedStanding(db, "e_bob", "Bob", 120); // has standing but no competence row
      expect(recordWitnessedDemonstration(db, "e_alice", "shell.exec", "e_bob")).toBe(false);
      expect(db.getCompetence("e_alice", "shell.exec")?.demonstrations ?? 0).toBe(0);
    });

    it("a qualified witness advances the entity to unsupervised at the threshold", () => {
      seedStanding(db, "e_alice", "Alice", 120);
      grant(db, "e_witness", "shell.exec"); // unsupervised → qualified witness
      // shell.exec.demoThreshold === 3
      expect(recordWitnessedDemonstration(db, "e_alice", "shell.exec", "e_witness")).toBe(true);
      expect(recordWitnessedDemonstration(db, "e_alice", "shell.exec", "e_witness")).toBe(true);
      expect(checkUnattendedGate(db, "e_alice", "shell.exec").ok).toBe(false);
      expect(recordWitnessedDemonstration(db, "e_alice", "shell.exec", "e_witness")).toBe(true);
      // Now unsupervised → unattended execution permitted.
      expect(checkUnattendedGate(db, "e_alice", "shell.exec").ok).toBe(true);
    });
  });

  it("canWitness returns true only for unsupervised entities on the same gate", () => {
    expect(canWitness(db, "e_nobody", "shell.exec")).toBe(false);

    grant(db, "e_witness", "shell.exec");
    expect(canWitness(db, "e_witness", "shell.exec")).toBe(true);
    // Authority on one gate does not transfer.
    expect(canWitness(db, "e_witness", "key.manage")).toBe(false);
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

  it("each gate has a sane definition", () => {
    for (const id of listGates()) {
      const gate = SAFETY_GATES[id]!;
      expect(gate.id).toBe(id);
      expect(gate.minStanding).toBeGreaterThan(0);
      expect(gate.demoThreshold).toBeGreaterThan(0);
      expect(gate.description.length).toBeGreaterThan(5);
    }
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

  it("agent.spawn unlocks below the rank-4 ceiling (standing 40, supervised first)", () => {
    // Well under the threshold (40) → denied outright. shell.exec (100)
    // would also deny here — agent.spawn is the more reachable gate.
    seedStanding(db, "e_low", "LowStanding", 20);
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

  it("registers code.exec.unrestricted but keeps it off the rank ladder", () => {
    expect(listGates()).toContain("code.exec.unrestricted");
    const gate = SAFETY_GATES["code.exec.unrestricted"]!;
    expect(gate.minStanding).toBe(251);
    expect(gate.demoThreshold).toBe(5);
    // Highest minStanding → it sorts last on the reachability ladder.
    const ordered = Object.values(SAFETY_GATES).sort((a, b) => a.minStanding - b.minStanding);
    expect(ordered.at(-1)!.id).toBe("code.exec.unrestricted");
  });

  // ── getGateProgress: the visible "what's next past rank 4" ladder ──
  describe("getGateProgress", () => {
    it("locks every gate for a fresh entity and reports the standing gap", () => {
      const progress = getGateProgress(db, "e_fresh");
      expect(progress.every((g) => g.status === "locked")).toBe(true);
      // Ordered by reachability — code.exec (min 5) first, and the arbitrary-exec
      // gate (min 251) sorts last, after admin.destructive (250).
      expect(progress[0]!.id).toBe("code.exec");
      expect(progress.at(-1)!.id).toBe("code.exec.unrestricted");
      const spawn = progress.find((g) => g.id === "agent.spawn")!;
      expect(spawn.standing).toBe(0);
      expect(spawn.minStanding).toBe(40);
    });

    it("flips a gate to supervised once standing crosses its threshold", () => {
      seedStanding(db, "e_org", "org", 50); // ≥ agent.spawn (40), < shell.exec (100)
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
});
