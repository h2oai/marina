// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Contributors earn standing (2026-10-20): for standing, every account is its
 * own party. Work another account verified credits the worker — the owner
 * approving its agent's task, another person's agent, or a sibling agent whose
 * verdict is grounded (checks that passed). Self-verification (same name or
 * same durable account) is refused, and so is an agent's ungrounded verdict
 * inside its own lineage. Safety gates keep the lineage rule: one person's
 * agents can raise each other's standing to a gate's floor, never to solo use.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CIVIC_RULE_SOURCE, chronicleCivicRuleChanges } from "../src/agent/civic-rules";
import {
  getStanding,
  independentParties,
  ledgerFor,
  recordVerified,
  STANDING_AMOUNTS,
  standingOf,
  standingVerifierRefusal,
} from "../src/agent/standing";
import { approvalDemonstrates, resetChallengesForTests } from "../src/engine/challenges";
import { Engine } from "../src/engine/engine";
import { resetGateContextForTests } from "../src/engine/gate-context";
import {
  checkGateForExecution,
  checkUnattendedGate,
  getGateProgress,
  grant,
  meetsStandingFloor,
  recordGateExecution,
  SAFETY_GATES,
} from "../src/engine/safety-gates";
import { resolveForecast } from "../src/outcomes/forecast";
import { creditVerifiedCode } from "../src/outcomes/live";
import { MarinaDB } from "../src/persistence/database";
import { type Entity, type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi, until } from "./helpers";

const TEST_DB = `test_contributor_standing_${process.pid}.db`;
const tokenIn = (text: string) => text.match(/\b(ch_[0-9a-f]{12})\b/)?.[1];

describe("contributors earn standing", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection; // a person; owns Kid and Sib
  let kid: MockConnection; // Alice's agent
  let sib: MockConnection; // Alice's other agent
  let root: MockConnection; // an operator outside Alice's lineage
  let bobBot: MockConnection; // Bob's agent
  let ran: string[];

  const run = (conn: MockConnection, text: string) => {
    conn.clear();
    engine.processCommand(conn.entity as EntityId, text);
    return stripAnsi(conn.allTextJoined());
  };
  const join = (name: string) => {
    const conn = new MockConnection(`c-${name}`);
    db.createUser({ id: `u_${name.toLowerCase()}`, name });
    engine.addConnection(conn);
    engine.spawnEntity(conn.id, name);
    conn.clear();
    return conn;
  };
  const entity = (conn: MockConnection): Entity => engine.entities.get(conn.entity as EntityId)!;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    resetChallengesForTests();
    resetGateContextForTests();
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    ran = [];
    engine.commands.registerBuiltin({
      name: "build-it",
      category: "Test",
      help: "imperatively code.exec-gated test command",
      minRank: 0,
      handler: (ctx, input) => {
        const gate = checkGateForExecution(db, input.entity, "code.exec");
        if (!gate.ok) {
          ctx.send(input.entity, gate.reason ?? "refused");
          return;
        }
        recordGateExecution(db, input.entity, "code.exec", gate, "command:build-it");
        ran.push("build-it");
        ctx.send(input.entity, "built");
      },
    });
    db.saveAgentConfig({ name: "Kid", model: "m", spawnedBy: "Alice" });
    db.saveAgentConfig({ name: "Sib", model: "m", spawnedBy: "Alice" });
    db.saveAgentConfig({ name: "BobBot", model: "m", spawnedBy: "Bob" });
    alice = join("Alice");
    kid = join("Kid");
    sib = join("Sib");
    join("Bob");
    root = join("Root");
    bobBot = join("BobBot");
    entity(root).properties.rank = 9;
  });

  afterEach(() => {
    resetChallengesForTests();
    resetGateContextForTests();
    engine.stop();
    db.close();
    cleanupDb(TEST_DB);
  });

  describe("who may credit whom", () => {
    it("the party rule: self refused, a person credits its own agents, a sibling only when grounded", () => {
      expect(standingVerifierRefusal(db, { name: "Kid" }, "kid")).toContain("same account");
      // The owner (a person) deciding on its agent's work credits it.
      expect(standingVerifierRefusal(db, { name: "Kid" }, "Alice")).toBeUndefined();
      // A sibling agent's verdict: only with grounding.
      expect(standingVerifierRefusal(db, { name: "Kid" }, "Sib")).toContain("grounded");
      expect(
        standingVerifierRefusal(db, { name: "Kid" }, "Sib", { grounded: true }),
      ).toBeUndefined();
      // An agent judging its own owner's work is inside the lineage too.
      expect(standingVerifierRefusal(db, { name: "Alice" }, "Kid")).toContain("grounded");
      // Outside the lineage, person or agent: unchanged.
      expect(standingVerifierRefusal(db, { name: "Kid" }, "Bob")).toBeUndefined();
      expect(standingVerifierRefusal(db, { name: "Kid" }, "BobBot")).toBeUndefined();
      // The gate rule is untouched: Alice and her agents are still one party there.
      expect(independentParties(db, "Kid", "Alice")).toBe(false);
      expect(independentParties(db, "Kid", "Sib")).toBe(false);
    });

    it("self-verification is refused under another name on the same durable account", () => {
      // A claim recorded under a different name from Alice's own live entity.
      const self = recordVerified(db, {
        kind: "task_complete",
        ref: "t-alias",
        worker: { name: "AliceAlias", entityId: alice.entity! },
        verifier: "Alice",
        amount: 5,
      });
      expect(self.credited).toBe(false);
      expect(self.reason).toContain("same account");
      expect(ledgerFor(db, "u_alice")).toHaveLength(0);
    });
  });

  describe("tasks", () => {
    it("an owner approving its own agent's task credits the agent", () => {
      run(alice, "task create Chore | for my agent standing:5");
      run(kid, "task claim 1");
      run(kid, "task submit 1 done");
      expect(run(alice, "task info 1")).not.toContain("approval pays no standing");
      expect(run(alice, "task approve 1 Kid")).toContain("Kid earned 5 standing");
      expect(standingOf(db, "Kid")).toBeCloseTo(5, 3);
      expect(ledgerFor(db, "u_kid")[0]).toMatchObject({ kind: "task_complete", amount: 5 });
    });

    it("a sibling agent's task approval has no grounding signal and pays nothing", () => {
      run(sib, "task create Chore | sibling work standing:5");
      run(kid, "task claim 1");
      run(kid, "task submit 1 done");
      expect(run(sib, "task info 1")).toContain("approval pays no standing");
      expect(run(sib, "task approve 1 Kid")).toContain("No standing paid");
      expect(db.getTask(1)?.status).toBe("completed");
      expect(standingOf(db, "Kid")).toBe(0);
    });

    it("another person's agent approving still pays, as before", () => {
      run(bobBot, "task create Chore | cross-lineage standing:2");
      run(kid, "task claim 1");
      run(kid, "task submit 1 done");
      expect(run(bobBot, "task approve 1 Kid")).toContain("Kid earned 2 standing");
    });

    it("approving your own claim still pays nothing", () => {
      run(alice, "task create Mint | free standing standing:10 bounty");
      run(alice, "task claim 1");
      run(alice, "task submit 1 done");
      expect(run(alice, "task approve 1 Alice")).toContain("No standing paid");
      expect(standingOf(db, "Alice")).toBe(0);
    });
  });

  describe("Code Mode, forecasts, experiments", () => {
    it("a sibling reviewer approving an attempt whose checks passed credits it (grounded)", () => {
      const worker = { name: "Kid", entityId: kid.entity! };
      expect(creditVerifiedCode(db, { runId: "r1", worker, reviewer: "Sib" })).toEqual({
        credited: true,
        amount: STANDING_AMOUNTS.code_verified,
      });
      // The owner's review credits too; the worker's own never does.
      expect(creditVerifiedCode(db, { runId: "r2", worker, reviewer: "Alice" }).credited).toBe(
        true,
      );
      expect(creditVerifiedCode(db, { runId: "r3", worker, reviewer: "Kid" }).credited).toBe(false);
      expect(ledgerFor(db, "u_kid").filter((r) => r.kind === "code_verified")).toHaveLength(2);
    });

    it("a forecast resolved by the filer's owner credits; by a sibling agent it does not", () => {
      const file = (owner: string) =>
        db.saveForecastAnswer({
          entityName: owner,
          question: "q",
          kind: "probability",
          probability: 0.9,
          answerJson: "{}",
        });
      resolveForecast(db, file("Kid"), { outcome: "yes" }, Date.now(), { resolvedBy: "Alice" });
      expect(ledgerFor(db, "u_kid").some((r) => r.kind === "forecast_resolved")).toBe(true);
      resolveForecast(db, file("Sib"), { outcome: "yes" }, Date.now(), { resolvedBy: "Kid" });
      expect(ledgerFor(db, "u_sib")).toHaveLength(0);
    });

    it("a forecast's self-declared producers stay one party per lineage", () => {
      const id = db.saveForecastAnswer({
        entityName: "Alice",
        question: "q",
        kind: "probability",
        probability: 0.9,
        answerJson: JSON.stringify({ producers: ["Kid", "Sib"] }),
      });
      resolveForecast(db, id, { outcome: "yes" }, Date.now());
      expect(ledgerFor(db, "u_alice").some((r) => r.kind === "forecast_resolved")).toBe(true);
      expect(ledgerFor(db, "u_kid")).toHaveLength(0);
      expect(ledgerFor(db, "u_sib")).toHaveLength(0);
    });

    it("an experiment the owner replicated credits its agent; a sibling's samples do not", () => {
      entity(kid).properties.rank = 3;
      run(kid, "experiment create Owner arms a,b metric score goal higher");
      run(kid, "experiment start Owner");
      run(kid, "experiment record Owner a score 0.9");
      run(alice, "experiment record Owner b score 0.5");
      expect(run(kid, "experiment complete Owner")).not.toContain("No standing credited");
      expect(ledgerFor(db, "u_kid").some((r) => r.kind === "experiment_complete")).toBe(true);

      entity(sib).properties.rank = 3;
      run(sib, "experiment create Sibling arms a,b metric score goal higher");
      run(sib, "experiment start Sibling");
      run(sib, "experiment record Sibling a score 0.9");
      run(kid, "experiment record Sibling b score 0.5");
      expect(run(sib, "experiment complete Sibling")).toContain("No standing credited");
      expect(ledgerFor(db, "u_sib")).toHaveLength(0);
    });
  });

  describe("gates are unchanged", () => {
    it("one person's agents reach a gate's standing floor but never make it solo", async () => {
      const gate = SAFETY_GATES["code.exec"]!;
      // Sib reviews Kid's passing attempts until Kid stands at the floor.
      for (let i = 0; i < gate.minStanding; i++)
        creditVerifiedCode(db, {
          runId: `floor-${i}`,
          worker: { name: "Kid", entityId: kid.entity! },
          reviewer: "Sib",
        });
      expect(meetsStandingFloor(getStanding(db, kid.entity!), gate.minStanding)).toBe(true);
      const progress = () => getGateProgress(db, kid.entity!).find((g) => g.id === "code.exec")!;
      expect(progress().status).toBe("supervised");

      // The owner approves every held run: each runs, none demonstrates.
      grant(db, alice.entity!, "code.exec");
      expect(approvalDemonstrates(entity(alice), { name: "Kid" }, "code.exec")).toBe(false);
      for (let i = 0; i < gate.demoThreshold; i++) {
        const held = run(kid, "build-it");
        const token = tokenIn(held)!;
        expect(token).toBeDefined();
        const answer = run(alice, `challenge approve ${token}`);
        expect(answer).toContain("does not build code.exec");
        await until(() => ran.length === i + 1);
      }
      expect(db.getCompetence(kid.entity!, "code.exec")?.demonstrations ?? 0).toBe(0);
      expect(progress().status).toBe("supervised");
      expect(checkUnattendedGate(db, kid.entity!, "code.exec").ok).toBe(false);

      // A sibling agent can never answer the hold at all.
      const held = run(kid, "build-it");
      const token = tokenIn(held)!;
      expect(run(sib, `challenge approve ${token}`)).not.toContain("approved challenge");
      expect(db.getCompetence(kid.entity!, "code.exec")?.demonstrations ?? 0).toBe(0);

      // A person outside the lineage still demonstrates, exactly as before.
      expect(approvalDemonstrates(entity(root), { name: "Kid" }, "code.exec")).toBe(true);
      expect(run(root, `challenge approve ${token}`)).toContain("counts toward code.exec");
      await until(() => (db.getCompetence(kid.entity!, "code.exec")?.demonstrations ?? 0) === 1);
    });
  });

  describe("readouts", () => {
    it("owner-approved credit shows the same number in standing, standing top, task standing, orient", () => {
      run(alice, "task create Work | y standing:6");
      run(kid, "task claim 1");
      run(kid, "task submit 1 done");
      run(alice, "task approve 1 Kid");
      const expected = standingOf(db, "Kid").toFixed(1);
      expect(expected).toBe("6.0");
      expect(run(kid, "standing")).toContain(expected);
      expect(run(alice, "standing top")).toContain(`Kid — ${expected}`);
      expect(run(alice, "task standing")).toContain(`Kid: ${expected} standing`);
      expect(run(kid, "orient")).toContain(`Your Standing: ${expected}`);
    });
  });

  describe("the rule change is chronicled once", () => {
    it("writes one civic-rule event and never repeats it", () => {
      const first = chronicleCivicRuleChanges(db);
      expect(first).toEqual(["civic-rule:contributors-earn-standing"]);
      expect(chronicleCivicRuleChanges(db)).toEqual([]);
      const entries = db.queryChronicle({ kind: "event", source: CIVIC_RULE_SOURCE });
      expect(entries).toHaveLength(1);
      expect(entries[0]!.refs).toContain("civic-rule:contributors-earn-standing");
      expect(entries[0]!.title).toContain("contributors earn standing");
    });
  });
});
