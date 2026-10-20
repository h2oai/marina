// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetChallengesForTests } from "../src/engine/challenges";
import { Engine } from "../src/engine/engine";
import { applyGateReset, auditGateGrants, planGateReset } from "../src/engine/gate-audit";
import { grant, grantGatesForRank, recordDemonstration } from "../src/engine/safety-gates";
import { setTrustProfile } from "../src/engine/trust-profile";
import { MarinaDB } from "../src/persistence/database";
import { isGrantedCompetence } from "../src/persistence/db-competence";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";
import { scopeProcessState } from "./process-state";

const DB = `test_gate_audit_${process.pid}.db`;
let db: MarinaDB;

beforeEach(() => {
  cleanupDb(DB);
  db = new MarinaDB(DB);
});
afterEach(() => {
  resetChallengesForTests();
  db.close();
  cleanupDb(DB);
});

describe("new databases start gates at an honest baseline", () => {
  const login = (name: string, setup: (c: MockConnection) => void) => {
    const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    const conn = new MockConnection(`c-${name}`);
    setup(conn);
    engine.addConnection(conn);
    const result = engine.login(conn.id, name);
    const id = (result as { entityId: string }).entityId;
    const rank = engine.entities.get(id as EntityId)?.properties.rank ?? 0;
    engine.stop();
    return { rank, granted: db.listGrantedCompetence().length };
  };

  it("under LOCAL a loopback person is sovereign; MCP, declared-agent and agent-account logins are not", () => {
    using _state = scopeProcessState();
    setTrustProfile("local");
    db.saveAgentConfig({ name: "Critic", model: "x", spawnedBy: "Operator" });

    const mcp = login("claudecheck", (c) => {
      (c as { protocol: string }).protocol = "mcp";
    });
    expect(mcp).toEqual({ rank: 0, granted: 0 });
    const declared = login("archivist", (c) => {
      (c as { agent?: boolean }).agent = true;
    });
    expect(declared).toEqual({ rank: 0, granted: 0 });
    // An agent account over a plain loopback socket (how residents used to log in).
    const resident = login("Critic", () => {});
    expect(resident).toEqual({ rank: 0, granted: 0 });
    expect(db.getUserByName("Critic")?.rank ?? 0).toBe(0);

    const person = login("Operator", () => {});
    expect(person.rank).toBe(9);
    expect(person.granted).toBeGreaterThan(0);
  });
});

describe("gate audit / gate reset", () => {
  beforeEach(() => {
    db.createUser({ id: "u_op", name: "Operator", rank: 9 });
    db.createUser({ id: "u_host", name: "Host", rank: 9 });
    db.createUser({ id: "u_ref", name: "Reflector", rank: 9 });
    db.saveAgentConfig({ name: "Host", model: "x", spawnedBy: "Operator" });
    db.ensurePrincipal({ type: "agent", displayName: "Reflector" });
    for (const id of ["u_op", "u_host", "u_ref"]) grantGatesForRank(db, id, 9);
    // A gate Host EARNED by demonstrations is not an operator grant.
    db.revokeCompetence("u_host", "code.exec");
    for (let i = 0; i < 10; i++) recordDemonstration(db, "u_host", "code.exec");
  });

  it("audit lists sentinel rows by holder and flags agent accounts", () => {
    const audit = auditGateGrants(db);
    const host = audit.holders.find((h) => h.name === "Host");
    expect(host?.kind).toBe("agent");
    expect(host?.gates).not.toContain("code.exec");
    expect(audit.holders.find((h) => h.name === "Reflector")?.kind).toBe("agent");
    expect(audit.holders.find((h) => h.name === "Operator")?.kind).toBe("person");
    expect(audit.holders[0]?.kind).toBe("agent");
    expect(audit.agentRows).toBe((host?.gates.length ?? 0) + 13);
  });

  it("reset plans per target and gate, applies only sentinel rows, and chronicles each holder", () => {
    expect(planGateReset(db, "agents", "nope").error).toContain("Unknown gate");
    expect(planGateReset(db, "Nobody").error).toContain("No account");
    const one = planGateReset(db, "Host", "shell.exec");
    expect(one.rows).toEqual([{ accountId: "u_host", name: "Host", gate: "shell.exec" }]);

    const plan = planGateReset(db, "agents");
    expect(new Set(plan.rows.map((r) => r.name))).toEqual(new Set(["Host", "Reflector"]));
    // Nothing changed by planning.
    expect(auditGateGrants(db).agentRows).toBe(plan.rows.length);

    const done = applyGateReset(db, plan, "Operator");
    expect(done).toHaveLength(plan.rows.length);
    expect(auditGateGrants(db).agentRows).toBe(0);
    // The operator keeps its grants; Host keeps the gate it demonstrated.
    expect(isGrantedCompetence(db.getCompetence("u_op", "key.manage"))).toBe(true);
    expect(db.getCompetence("u_host", "code.exec")?.demonstrations).toBe(10);
    const events = db.queryChronicle({ limit: 20 }).filter((e) => e.source === "gate");
    expect(events.map((e) => e.title).join("\n")).toContain("Operator reset");
    expect(events).toHaveLength(2);
    // Undo is a plain grant.
    grant(db, "u_host", "shell.exec");
    expect(isGrantedCompetence(db.getCompetence("u_host", "shell.exec"))).toBe(true);
  });

  it("the command dry-runs by default and applying takes an operator", async () => {
    const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    const conns: MockConnection[] = [];
    for (const [i, name] of ["Bob", "Root"].entries()) {
      const c = new MockConnection(`g${i}`);
      engine.addConnection(c);
      engine.spawnEntity(`g${i}`, name);
      c.clear();
      conns.push(c);
    }
    const [bob, root] = conns as [MockConnection, MockConnection];
    engine.entities.get(root.entity as EntityId)!.properties.rank = 9;
    const run = async (c: MockConnection, raw: string) => {
      c.clear();
      await engine.processCommand(c.entity!, raw);
      return stripAnsi(c.allTextJoined());
    };
    try {
      expect(await run(bob, "gate audit")).toContain("held by agent accounts");
      const dry = await run(bob, "gate reset agents");
      expect(dry).toContain("dry run");
      expect(auditGateGrants(db).agentRows).toBeGreaterThan(0);
      expect(await run(bob, "gate reset agents all apply")).toContain("takes an operator");
      expect(auditGateGrants(db).agentRows).toBeGreaterThan(0);
      expect(await run(root, "gate reset agents all apply")).toContain("Reset");
      expect(auditGateGrants(db).agentRows).toBe(0);
    } finally {
      engine.stop();
    }
  });
});
