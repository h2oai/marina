// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Autonomy posture — the earnable path through safety gates.
 *
 * Contracts under test:
 * - `open` posture auto-passes earnable gates on ZERO standing, while the
 *   operator-grant core (key.manage, admin.destructive, shell.exec,
 *   code.exec.unrestricted, world.code) stays gated even under `open`.
 * - `guarded` posture holds a standing-only attempt for approval, naming the
 *   path; legacy supervision windows no longer authorize anything (approved
 *   runs are the proof — test/gates-approvals-as-proof.test.ts).
 * - `earned` posture runs earnable gates optimistically and records a pending
 *   demonstration; only an operator (a person) may count it.
 * - `witness` subcommands keep working as compatibility pointers.
 * - The engine router defers minRank to the gate for gated commands in EVERY
 *   posture: the gate is the single authority (no guarded double-lock).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getAutonomyPosture, OPEN_POSTURE_CORE } from "../src/engine/autonomy";
import { resetChallengesForTests } from "../src/engine/challenges";
import { witnessCommand } from "../src/engine/commands/witness";
import { Engine } from "../src/engine/engine";
import {
  checkGateForExecution,
  grant,
  recordGateExecution,
  SAFETY_GATES,
} from "../src/engine/safety-gates";
import { MarinaDB } from "../src/persistence/database";
import type { CommandInput, Entity, EntityId, RoomContext } from "../src/types";
import { entityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const DB_PATH = `/tmp/marina-autonomy-${process.pid}.db`;
const savedPosture = process.env.MARINA_AUTONOMY;

function makeEntity(id: string, name: string): Entity {
  return {
    id: entityId(id),
    kind: "agent",
    name,
    short: name,
    long: name,
    room: roomId("test/start"),
    properties: {},
    inventory: [],
    createdAt: Date.now(),
  };
}

function giveStanding(db: MarinaDB, entity: Entity, amount: number): void {
  const taskId = db.createTask({ title: "t", creatorId: entity.id, creatorName: entity.name });
  db.recordStandingEarned(entity.id, entity.name, taskId, amount);
}

function witnessHarness(db: MarinaDB, people: Entity[]) {
  const sent: string[] = [];
  const ctx = { send: (_t: EntityId, m: string) => sent.push(m) } as unknown as RoomContext;
  const entities = new Map<string, Entity>(people.map((e) => [String(e.id), e]));
  const command = witnessCommand({
    db,
    getEntity: (id) => entities.get(String(id)),
    getAllEntities: () => [...entities.values()],
    resolveEntityIdByName: (name) =>
      [...entities.values()].find((e) => e.name.toLowerCase() === name.toLowerCase())?.id,
  });
  const run = (actor: Entity, args: string) =>
    command.handler(ctx, {
      raw: `witness ${args}`.trim(),
      verb: "witness",
      args,
      tokens: args ? args.split(/\s+/) : [],
      entity: actor.id,
      room: roomId("test/start"),
    } as CommandInput);
  return { sent, run };
}

describe("autonomy posture", () => {
  let db: MarinaDB;

  beforeEach(() => {
    delete process.env.MARINA_AUTONOMY;
    // No challenge host from an earlier file: principal kinds read "agent".
    resetChallengesForTests();
    db = new MarinaDB(DB_PATH);
  });

  afterEach(() => {
    if (savedPosture === undefined) delete process.env.MARINA_AUTONOMY;
    else process.env.MARINA_AUTONOMY = savedPosture;
    db.close();
    cleanupDb(DB_PATH);
  });

  it("parses the env strictly and defaults to guarded", () => {
    expect(getAutonomyPosture({})).toBe("guarded");
    expect(getAutonomyPosture({ MARINA_AUTONOMY: "open" })).toBe("open");
    expect(getAutonomyPosture({ MARINA_AUTONOMY: "EARNED " })).toBe("earned");
    expect(getAutonomyPosture({ MARINA_AUTONOMY: "yolo" })).toBe("guarded");
  });

  it("open posture auto-passes non-core gates on zero standing, core stays gated", () => {
    process.env.MARINA_AUTONOMY = "open";
    const agent = makeEntity("e_zero", "Zero");
    db.saveEntity(agent);
    // Zero standing, no competence — non-core gates open anyway.
    for (const gateId of Object.keys(SAFETY_GATES)) {
      const result = checkGateForExecution(db, agent.id, gateId);
      if (OPEN_POSTURE_CORE.has(gateId)) {
        expect(result.ok).toBe(false);
      } else {
        expect(result.ok).toBe(true);
        expect(result.mode).toBe("posture-open");
      }
    }
    // posture-open records nothing.
    const result = checkGateForExecution(db, agent.id, "agent.spawn");
    recordGateExecution(db, agent.id, "agent.spawn", result, "test");
    expect(db.getCompetence(agent.id, "agent.spawn")?.demonstrations ?? 0).toBe(0);
    expect(db.listOpenWitnessRows({ entityId: agent.id })).toEqual([]);
  });

  it("guarded: standing-only is held for approval with the walkable path named", () => {
    const agent = makeEntity("e_learner", "Learner");
    db.saveEntity(agent);
    giveStanding(db, agent, 80); // above agent.spawn's floor
    const result = checkGateForExecution(db, agent.id, "agent.spawn");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Approval needed");
    expect(result.reason).toContain("approved run");
    expect(result.reason).not.toContain("witness request");
  });

  it("guarded: a legacy supervision-window row no longer authorizes a run", () => {
    const mentor = makeEntity("e_mentor", "Mentor");
    const learner = makeEntity("e_learner", "Learner");
    db.saveEntity(mentor);
    db.saveEntity(learner);
    grant(db, mentor.id, "agent.spawn");
    giveStanding(db, learner, 80);
    db.createWitnessRow({
      entityId: learner.id,
      gate: "agent.spawn",
      kind: "window",
      witnessId: mentor.id,
      expiresAt: Date.now() + 60_000,
    });
    const result = checkGateForExecution(db, learner.id, "agent.spawn");
    expect(result.ok).toBe(false);
    expect(db.getCompetence(learner.id, "agent.spawn")?.demonstrations ?? 0).toBe(0);
  });

  it("earned: the operator-grant core gets NO optimistic mode — grant or local profile only", () => {
    process.env.MARINA_AUTONOMY = "earned";
    const learner = makeEntity("e_core_learner", "CoreLearner");
    const mentor = makeEntity("e_core_mentor", "CoreMentor");
    db.saveEntity(learner);
    db.saveEntity(mentor);
    giveStanding(db, learner, 400);
    for (const gateId of OPEN_POSTURE_CORE) {
      expect(SAFETY_GATES[gateId]!.operatorGrant).toBe(true);
      const refused = checkGateForExecution(db, learner.id, gateId);
      expect(refused.ok).toBe(false);
      expect(refused.mode).toBeUndefined();
      expect(refused.reason).toContain("Operator grant");
      expect(refused.reason).not.toContain("needs standing");
      expect(refused.reason).not.toContain("MARINA_AUTONOMY=earned");
      grant(db, mentor.id, gateId);
    }
    // Earnable gates keep optimistic supervision under earned.
    const spawn = checkGateForExecution(db, learner.id, "agent.spawn");
    expect(spawn.ok).toBe(true);
    expect(spawn.mode).toBe("optimistic");
    // A grant holder passes unattended.
    const granted = checkGateForExecution(db, mentor.id, "shell.exec");
    expect(granted.ok).toBe(true);
    expect(granted.mode).toBe("unattended");
  });

  it("earned: runs optimistically and records a pending demonstration an agent cannot attest", () => {
    process.env.MARINA_AUTONOMY = "earned";
    const learner = makeEntity("e_learner", "Learner");
    const mentor = makeEntity("e_mentor", "Mentor");
    db.saveEntity(learner);
    db.saveEntity(mentor);
    giveStanding(db, learner, 80);
    grant(db, mentor.id, "agent.spawn");

    const result = checkGateForExecution(db, learner.id, "agent.spawn");
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("optimistic");
    recordGateExecution(db, learner.id, "agent.spawn", result, "agent spawn Scout");

    // The run recorded a PENDING row — no competence yet.
    const pending = db.listOpenWitnessRows({ kind: "pending", entityId: learner.id });
    expect(pending).toHaveLength(1);
    expect(db.getCompetence(learner.id, "agent.spawn")?.demonstrations ?? 0).toBe(0);

    const { sent, run } = witnessHarness(db, [learner, mentor]);
    // Self-review is refused; a gate-holding AGENT is not an operator.
    run(learner, `attest ${pending[0]!.id}`);
    run(mentor, `attest ${pending[0]!.id}`);
    expect(db.getCompetence(learner.id, "agent.spawn")?.demonstrations ?? 0).toBe(0);
    expect(db.getWitnessRow(pending[0]!.id)?.status).toBe("open");
    expect(sent.join("\n")).toContain("takes an operator");
  });

  it("witness subcommands are compatibility pointers: no window or request row is opened", () => {
    const learner = makeEntity("e_learner", "Learner");
    const holder = makeEntity("e_holder", "Holder");
    db.saveEntity(learner);
    db.saveEntity(holder);
    grant(db, holder.id, "agent.spawn");
    const { sent, run } = witnessHarness(db, [learner, holder]);
    run(holder, "grant Learner agent.spawn");
    expect(sent.join("\n")).toContain("Supervision windows are retired");
    expect(db.getOpenSupervisionWindow(learner.id, "agent.spawn")).toBeUndefined();
    sent.length = 0;
    run(learner, "request agent.spawn");
    expect(sent.join("\n")).toContain("approved runs");
    expect(db.listOpenWitnessRows({ entityId: learner.id })).toEqual([]);
    sent.length = 0;
    run(learner, "request shell.exec");
    expect(sent.join("\n")).toContain("operator-grant");
    sent.length = 0;
    run(learner, "queue");
    expect(sent.join("\n")).toContain("Witness queue");
    sent.length = 0;
    run(learner, "");
    expect(sent.join("\n")).toContain("Your gate ladder");
  });

  it("router defers minRank to the gate for gated commands in every posture", async () => {
    process.env.MARINA_AUTONOMY = "open";
    const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom());
    try {
      let executed = 0;
      engine.commands.registerBuiltin({
        name: "posture-probe",
        category: "Test",
        minRank: 5,
        gate: "gateway.connect",
        help: "test",
        handler: () => {
          executed++;
        },
      });
      const conn = new MockConnection("c1");
      engine.addConnection(conn);
      engine.spawnEntity("c1", "Rookie"); // rank 0, zero standing
      await engine.processCommand(conn.entity!, "posture-probe");
      expect(executed).toBe(1); // gate is the authority; posture-open passes it

      // guarded: the gate still decides — a rank-0 caller without it is refused
      // by the gate (not by minRank) ...
      process.env.MARINA_AUTONOMY = "guarded";
      conn.clear();
      await engine.processCommand(conn.entity!, "posture-probe");
      expect(executed).toBe(1);
      expect(conn.allTextJoined()).toContain("Not yet");
      expect(conn.allTextJoined()).not.toContain("rank 5");

      // ... and the same rank-0 caller holding the gate runs it: no double-lock.
      grant(db, conn.entity!, "gateway.connect");
      await engine.processCommand(conn.entity!, "posture-probe");
      expect(executed).toBe(2);
    } finally {
      engine.stop();
    }
  });
});
