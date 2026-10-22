// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standing is earned by verified work: a credit needs another account to
 * verify it (every account is its own party since 2026-10-20; an agent's
 * verdict inside its own lineage needs grounding — contributor-standing.test.ts).
 * Self-dealt tasks pay nothing, a task's value is capped, resolved forecasts
 * and approved Code Mode work earn once, credits land on the durable account
 * whether or not the worker is online, every readout shows the same decayed
 * number, and an operator-set rank below 5 is a floor progression keeps.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applyRankProgression } from "../src/agent/rank-progression";
import {
  independentParties,
  ledgerFor,
  recordVerified,
  STANDING_AMOUNTS,
  standingOf,
  TASK_STANDING_MAX,
} from "../src/agent/standing";
import { TaskManager } from "../src/coordination/task-manager";
import { Engine } from "../src/engine/engine";
import { buildEntityProfile } from "../src/net/api/entity-api";
import { resolveForecast } from "../src/outcomes/forecast";
import { creditVerifiedCode } from "../src/outcomes/live";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_standing_verified_work.db";

describe("standing is earned by verified work", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let bob: MockConnection;

  const run = (conn: MockConnection, text: string) => {
    conn.clear();
    engine.processCommand(conn.entity as EntityId, text);
    return stripAnsi(conn.allTextJoined());
  };
  const join = (id: string, name: string) => {
    const conn = new MockConnection(`c-${name}`);
    db.createUser({ id, name });
    engine.addConnection(conn);
    engine.spawnEntity(conn.id, name);
    return conn;
  };

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = join("u_alice", "Alice");
    bob = join("u_bob", "Bob");
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(TEST_DB);
  });

  describe("independence", () => {
    it("a person and every agent in its spawn lineage are one party; strangers are not", () => {
      db.saveAgentConfig({ name: "Kid", model: "m", spawnedBy: "Alice" });
      db.saveAgentConfig({ name: "Grandkid", model: "m", spawnedBy: "Kid" });
      db.saveAgentConfig({ name: "Sibling", model: "m", spawnedBy: "Alice" });
      db.saveAgentConfig({ name: "Seeded", model: "m", spawnedBy: "system" });

      expect(independentParties(db, "Alice", "alice")).toBe(false);
      expect(independentParties(db, "Alice", "Kid")).toBe(false);
      expect(independentParties(db, "Grandkid", "Alice")).toBe(false); // both directions
      expect(independentParties(db, "Kid", "Sibling")).toBe(false);
      expect(independentParties(db, "Alice", "Bob")).toBe(true);
      expect(independentParties(db, "Kid", "Bob")).toBe(true);
      expect(independentParties(db, "Seeded", "Alice")).toBe(true);
    });

    it("lineage survives `agent delete` through the agent principal", () => {
      db.ensurePrincipal({ type: "human", displayName: "Alice" });
      db.saveAgentConfig({ name: "Kid", model: "m", spawnedBy: "Alice" });
      db.deleteAgentConfig("Kid");
      expect(independentParties(db, "Kid", "Alice")).toBe(false);
    });

    it("recordVerified pays another account's verdict and refuses self-verification", () => {
      // Contributors earn standing (2026-10-20): every account is its own party,
      // so only the worker's own account is refused here (contributor-standing.test.ts
      // covers the owner and sibling cases).
      const own = recordVerified(db, {
        kind: "code_verified",
        ref: "code:1",
        worker: { name: "Alice" },
        verifier: "alice",
      });
      expect(own.credited).toBe(false);
      expect(own.reason).toContain("same account");
      const paid = recordVerified(db, {
        kind: "code_verified",
        ref: "code:1",
        worker: { name: "Alice" },
        verifier: "Bob",
      });
      expect(paid).toEqual({ credited: true, amount: STANDING_AMOUNTS.code_verified });
    });
  });

  describe("tasks", () => {
    it("a self-dealt bounty (create → claim → submit → approve your own) completes and pays 0", () => {
      run(alice, `task create Mint | free standing standing:${TASK_STANDING_MAX} bounty`);
      run(alice, "task claim 1");
      run(alice, "task submit 1 done");
      const out = run(alice, "task approve 1 Alice");
      expect(out).toContain("Approved");
      expect(out).toContain("No standing paid");
      expect(db.getTask(1)?.status).toBe("completed");
      expect(standingOf(db, "Alice")).toBe(0);
      expect(ledgerFor(db, "u_alice")).toHaveLength(0);
    });

    it("a claimant in the approver's spawn lineage is paid when the approver is a person", () => {
      // Contributors earn standing (2026-10-20): the owner approving its own
      // agent's task credits the agent.
      db.saveAgentConfig({ name: "Kid", model: "m", spawnedBy: "Alice" });
      const kid = join("u_kid", "Kid");
      run(alice, "task create Chore | for my agent standing:5");
      run(kid, "task claim 1");
      run(kid, "task submit 1 done");
      expect(run(alice, "task info 1")).not.toContain("approval pays no standing");
      expect(run(alice, "task approve 1 Kid")).toContain("Kid earned 5 standing");
      expect(standingOf(db, "Kid")).toBeCloseTo(5, 3);
    });

    it("independent approval pays the task's value in every validation mode", () => {
      run(alice, "task create Creator mode | y standing:4");
      run(bob, "task claim 1");
      run(bob, "task submit 1 done");
      expect(run(alice, "task info 1")).toContain("Standing: !4");
      expect(run(alice, "task approve 1 Bob")).toContain("Bob earned 4 standing");
      expect(standingOf(db, "Bob")).toBeCloseTo(4, 3);

      // No value named: the default.
      run(alice, "task create Default | y");
      run(bob, "task claim 2");
      run(bob, "task submit 2 done");
      run(alice, "task approve 2 Bob");
      expect(standingOf(db, "Bob")).toBeCloseTo(5, 3);
    });

    it("refuses a silently huge value at create, and caps a legacy over-cap row on payout", () => {
      expect(run(alice, "task create Huge | y standing:1000 bounty")).toContain("out of range");
      expect(db.listTasks({})).toHaveLength(0);

      const tasks = new TaskManager(db);
      const legacy = tasks.create({
        title: "legacy",
        creatorId: alice.entity!,
        creatorName: "Alice",
        validationMode: "bounty",
        standing: 1000,
      });
      tasks.claim(legacy.id, bob.entity!, "Bob");
      tasks.submit(legacy.id, bob.entity!, "done");
      const approved = tasks.approve(legacy.id, bob.entity!, alice.entity!);
      expect(approved.ok && approved.credit.amount).toBe(TASK_STANDING_MAX);
      expect(standingOf(db, "Bob")).toBeCloseTo(TASK_STANDING_MAX, 3);
    });

    it("an offline claimant's submission can be approved and is credited to the account", () => {
      run(alice, "task create Remote | y standing:3");
      const tasks = new TaskManager(db);
      // Carol worked under an entity id that is gone (offline); only her account remains.
      db.createUser({ id: "u_carol", name: "Carol" });
      tasks.claim(1, "e_carol_old", "Carol");
      tasks.submit(1, "e_carol_old", "done");
      expect(run(alice, "task approve 1 Carol")).toContain("Carol earned 3 standing");
      expect(ledgerFor(db, "u_carol")[0]).toMatchObject({ kind: "task_complete", amount: 3 });
    });
  });

  describe("verified outcomes", () => {
    const fileProbability = (owner: string, p: number, evalMode?: "live" | "measure") =>
      db.saveForecastAnswer({
        entityName: owner,
        question: "q",
        kind: "probability",
        probability: p,
        answerJson: "{}",
        ...(evalMode ? { evalMode } : {}),
      });

    it("a resolved forecast credits its filer once, by skill, at most once a day", () => {
      const first = fileProbability("Bob", 0.9);
      expect(resolveForecast(db, first, { outcome: "yes" }, Date.now())).toBeDefined();
      const credit = ledgerFor(db, "u_bob").find((r) => r.kind === "forecast_resolved");
      // Brier 0.01 → skill 0.96 over a coin flip → 0.48 of the 0.5 maximum.
      expect(credit?.amount).toBeCloseTo(0.48, 3);
      expect(credit?.ref).toBe(`forecast:${first}`);
      // Settled once: re-resolving is refused and credits nothing more.
      expect(resolveForecast(db, first, { outcome: "yes" }, Date.now())).toBeUndefined();
      // A second good forecast the same UTC day is over the daily cap.
      const second = fileProbability("Bob", 0.8);
      resolveForecast(db, second, { outcome: "yes" }, Date.now());
      expect(ledgerFor(db, "u_bob").filter((r) => r.kind === "forecast_resolved")).toHaveLength(1);
    });

    it("a wrong forecast, a measurement filing, or a self-resolved market earns nothing", () => {
      resolveForecast(db, fileProbability("Alice", 0.9), { outcome: "no" }, Date.now());
      resolveForecast(db, fileProbability("Alice", 0.99, "measure"), { outcome: "yes" }, 1);
      resolveForecast(db, fileProbability("Alice", 0.99), { outcome: "yes" }, Date.now(), {
        resolvedBy: "Alice",
      });
      expect(ledgerFor(db, "u_alice")).toHaveLength(0);
    });

    it("approved Code Mode work whose checks passed credits once per attempt, never to the reviewer's party", () => {
      const worker = { name: "Bob", entityId: bob.entity! };
      expect(creditVerifiedCode(db, { runId: "r1", worker, reviewer: "Alice" }).credited).toBe(
        true,
      );
      creditVerifiedCode(db, { runId: "r1", worker, reviewer: "Alice" });
      expect(ledgerFor(db, "u_bob").filter((r) => r.kind === "code_verified")).toHaveLength(1);
      expect(creditVerifiedCode(db, { runId: "r2", worker, reviewer: "Bob" }).credited).toBe(false);
    });
  });

  describe("one readout", () => {
    it("standing, standing show (offline), standing top, task standing and /who agree", () => {
      run(alice, "task create Work | y standing:6");
      run(bob, "task claim 1");
      run(bob, "task submit 1 done");
      run(alice, "task approve 1 Bob");
      const expected = standingOf(db, "Bob").toFixed(1);
      expect(expected).toBe("6.0");

      expect(run(bob, "standing")).toContain(expected);
      expect(run(alice, "standing top")).toContain(`Bob — ${expected}`);
      expect(run(alice, "task standing")).toContain(`Bob: ${expected} standing`);
      expect(buildEntityProfile("Bob", db, engine)?.identity.standing).toBeCloseTo(6, 3);

      // Offline: the live entity is gone, the account and its standing are not.
      engine.entities.remove(bob.entity as EntityId);
      expect(run(alice, "standing show Bob")).toContain(expected);
      expect(buildEntityProfile("Bob", db, engine)?.identity.standing).toBeCloseTo(6, 3);
    });

    it("help lists what earns", () => {
      const help = run(alice, "help standing");
      expect(help).toContain("independent");
      expect(help).toContain("no longer earn");
    });
  });

  describe("operator rank floor", () => {
    it("an operator-set rank below 5 is a floor hourly progression keeps", () => {
      const op = engine.entities.get(alice.entity as EntityId)!;
      op.properties.rank = 9;
      run(alice, "rank Bob 3");
      expect(db.getUserByName("Bob")?.rank_floor).toBe(3);
      const target = engine.entities.get(bob.entity as EntityId)!;
      // No standing: derived rank 0, but the floor holds.
      expect(applyRankProgression(db, target)).toBe(false);
      expect(target.properties.rank).toBe(3);

      // Standing can still lift the rank above the floor.
      for (let i = 1; i <= 10; i++)
        recordVerified(db, {
          kind: "task_complete",
          ref: `t${i}`,
          worker: { name: "Bob" },
          verifier: "Alice",
          amount: 11,
        });
      expect(applyRankProgression(db, target)).toBe(true);
      expect(target.properties.rank).toBe(4);
    });

    it("never raises a session that was not granted the rank, and never lowers the account", () => {
      db.setUserRankFloor("u_bob", 3);
      db.updateUserRank("u_bob", 3);
      const squatter = engine.entities.get(bob.entity as EntityId)!;
      squatter.properties.rank = 0; // e.g. a passwordless remote name-login
      expect(applyRankProgression(db, squatter)).toBe(false);
      expect(squatter.properties.rank).toBe(0);
      expect(db.getUserByName("Bob")?.rank).toBe(3);
    });
  });
});
