// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Autonomy posture + witness ladder — the earnable path through safety gates.
 *
 * Contracts under test:
 * - `open` posture auto-passes non-core gates on ZERO standing, while the
 *   destructive core (key.manage, admin.destructive, shell.exec,
 *   code.exec.unrestricted) stays gated even under `open`.
 * - `guarded` posture refuses a standing-only holder with a refusal that
 *   names the walkable path, honors a witness-granted window exactly once,
 *   credits the granting witness, and flips the gate at demoThreshold.
 * - `earned` posture runs optimistically and records a pending attestation;
 *   only a qualified external witness's attestation advances the flip.
 * - Self-witnessing and unqualified witnessing are refused everywhere.
 * - The engine router defers minRank to the gate for gated commands under
 *   earned/open, and does NOT under guarded.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getAutonomyPosture, OPEN_POSTURE_CORE } from "../src/engine/autonomy";
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

describe("autonomy posture", () => {
  let db: MarinaDB;

  beforeEach(() => {
    delete process.env.MARINA_AUTONOMY;
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

  it("guarded: standing-only is refused with the walkable path named", () => {
    const agent = makeEntity("e_learner", "Learner");
    db.saveEntity(agent);
    giveStanding(db, agent, 80); // above agent.spawn's 40
    const result = checkGateForExecution(db, agent.id, "agent.spawn");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("witness request agent.spawn");
  });

  it("guarded: a witness window authorizes exactly one demonstration, credited to the witness, and flips at threshold", () => {
    const witness = makeEntity("e_mentor", "Mentor");
    const learner = makeEntity("e_learner", "Learner");
    db.saveEntity(witness);
    db.saveEntity(learner);
    grant(db, witness.id, "agent.spawn"); // mentor holds the gate solo
    giveStanding(db, learner, 80);

    const threshold = SAFETY_GATES["agent.spawn"]!.demoThreshold;
    for (let demo = 1; demo <= threshold; demo++) {
      db.createWitnessRow({
        entityId: learner.id,
        gate: "agent.spawn",
        kind: "window",
        witnessId: witness.id,
        expiresAt: Date.now() + 60_000,
      });
      const result = checkGateForExecution(db, learner.id, "agent.spawn");
      expect(result.ok).toBe(true);
      if (demo < threshold) expect(result.mode).toBe("windowed");
      recordGateExecution(db, learner.id, "agent.spawn", result, `demo ${demo}`);
    }
    // Threshold reached — the gate is now unattended, no window needed.
    expect(db.getCompetence(learner.id, "agent.spawn")?.supervised_only).toBe(0);
    const solo = checkGateForExecution(db, learner.id, "agent.spawn");
    expect(solo.ok).toBe(true);
    expect(solo.mode).toBe("unattended");

    // A window is single-use: without a fresh one, a second learner is refused.
    const other = makeEntity("e_other", "Other");
    db.saveEntity(other);
    giveStanding(db, other, 80);
    db.createWitnessRow({
      entityId: other.id,
      gate: "agent.spawn",
      kind: "window",
      witnessId: witness.id,
      expiresAt: Date.now() + 60_000,
    });
    const first = checkGateForExecution(db, other.id, "agent.spawn");
    expect(first.mode).toBe("windowed");
    recordGateExecution(db, other.id, "agent.spawn", first, "demo");
    const second = checkGateForExecution(db, other.id, "agent.spawn");
    expect(second.ok).toBe(false);
  });

  it("earned: runs optimistically, records a pending attestation, and only external attestation advances the flip", () => {
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

    // The witness command attests it — competence advances.
    const sent = new Map<string, string[]>();
    const ctx = {
      send: (target: EntityId, message: string) => {
        const list = sent.get(String(target)) ?? [];
        list.push(message);
        sent.set(String(target), list);
      },
    } as unknown as RoomContext;
    const entities = new Map<string, Entity>([
      [String(learner.id), learner],
      [String(mentor.id), mentor],
    ]);
    const command = witnessCommand({
      db,
      getEntity: (id) => entities.get(String(id)),
      getAllEntities: () => [...entities.values()],
      resolveEntityIdByName: (name) =>
        [...entities.values()].find((e) => e.name.toLowerCase() === name.toLowerCase())?.id,
    });
    const invoke = (actor: Entity, args: string) =>
      command.handler(ctx, {
        raw: `witness ${args}`,
        verb: "witness",
        args,
        tokens: args.split(/\s+/),
        entity: actor.id,
        room: roomId("test/start"),
      } as CommandInput);

    // Self-attestation is refused.
    invoke(learner, `attest ${pending[0]!.id}`);
    expect(db.getCompetence(learner.id, "agent.spawn")?.demonstrations ?? 0).toBe(0);

    // Qualified external attestation counts.
    invoke(mentor, `attest ${pending[0]!.id}`);
    expect(db.getCompetence(learner.id, "agent.spawn")?.demonstrations).toBe(1);
    expect(db.getWitnessRow(pending[0]!.id)?.status).toBe("attested");

    // Rejected demonstrations never count.
    const again = checkGateForExecution(db, learner.id, "agent.spawn");
    recordGateExecution(db, learner.id, "agent.spawn", again, "agent spawn Scout2");
    const pending2 = db.listOpenWitnessRows({ kind: "pending", entityId: learner.id });
    expect(pending2).toHaveLength(1);
    invoke(mentor, `reject ${pending2[0]!.id} not a real demonstration`);
    expect(db.getCompetence(learner.id, "agent.spawn")?.demonstrations).toBe(1);
    expect(db.getWitnessRow(pending2[0]!.id)?.status).toBe("rejected");
  });

  it("witness grant requires qualification and refuses self-supervision", () => {
    const learner = makeEntity("e_learner", "Learner");
    const poser = makeEntity("e_poser", "Poser");
    db.saveEntity(learner);
    db.saveEntity(poser);
    giveStanding(db, learner, 80);
    giveStanding(db, poser, 500); // standing alone does not qualify a witness

    const sent: string[] = [];
    const ctx = {
      send: (_t: EntityId, m: string) => sent.push(m),
    } as unknown as RoomContext;
    const entities = new Map<string, Entity>([
      [String(learner.id), learner],
      [String(poser.id), poser],
    ]);
    const command = witnessCommand({
      db,
      getEntity: (id) => entities.get(String(id)),
      getAllEntities: () => [...entities.values()],
      resolveEntityIdByName: (name) =>
        [...entities.values()].find((e) => e.name.toLowerCase() === name.toLowerCase())?.id,
    });
    command.handler(ctx, {
      raw: "witness grant Learner agent.spawn",
      verb: "witness",
      args: "grant Learner agent.spawn",
      tokens: ["grant", "Learner", "agent.spawn"],
      entity: poser.id,
      room: roomId("test/start"),
    } as CommandInput);
    expect(sent.join("\n")).toContain("witness only gates you hold solo");
    expect(db.getOpenSupervisionWindow(learner.id, "agent.spawn")).toBeUndefined();
  });

  it("router defers minRank to the gate for gated commands under open, not under guarded", async () => {
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

      process.env.MARINA_AUTONOMY = "guarded";
      await engine.processCommand(conn.entity!, "posture-probe");
      expect(executed).toBe(1); // guarded: minRank 5 blocks a rank-0 caller again
    } finally {
      engine.stop();
    }
  });
});
