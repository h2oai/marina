// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Approvals are the proof (2026-10-14): the gate ladder newcomers can climb.
 *
 * - A person's `once` approval of a held run of an EARNABLE gate is one
 *   demonstration; `demoThreshold` of them make the gate solo.
 * - The requester's own lineage (an owner, at any depth) approves the run but
 *   never builds the gate — the same one-party rule `gate grant` applies.
 * - Operator-grant gates (the open-posture core) are never built by approvals
 *   and never lifted by `open`; `code.exec.unrestricted` says so honestly.
 * - One rank-floor rule: the router's `minRank` behaves exactly like
 *   `rankFloorRefusal` under shared/guarded, local and `open`.
 * - Read-only forms (`world list`, `position list`, `admin decisions`) are
 *   open at rank 0 while their write forms stay gated.
 * - `witness attest` (the earned posture's pending runs) follows the same rule.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HeadlessGateApprover } from "../src/coding/exec-approver";
import { resetChallengesForTests } from "../src/engine/challenges";
import { Engine } from "../src/engine/engine";
import { resetGateContextForTests } from "../src/engine/gate-context";
import { rankFloorRefusal } from "../src/engine/rank-floor";
import {
  checkGateForExecution,
  grant,
  meetsStandingFloor,
  recordGateExecution,
  SAFETY_GATES,
} from "../src/engine/safety-gates";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi, until } from "./helpers";
import { scopeProcessState } from "./process-state";

const tokenIn = (text: string) => text.match(/\b(ch_[0-9a-f]{12})\b/)?.[1];
const text = (c: MockConnection) => stripAnsi(c.allText().join("\n"));

interface World {
  db: MarinaDB;
  engine: Engine;
  ran: string[];
  join(name: string, opts?: { rank?: number }): MockConnection;
}

function world(path: string): World {
  const db = new MarinaDB(path);
  const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  const ran: string[] = [];
  // An imperatively gated command, like `agent spawn`.
  engine.commands.registerBuiltin({
    name: "breed",
    category: "Test",
    help: "imperatively gated test command",
    minRank: 0,
    handler: (ctx, input) => {
      const gate = checkGateForExecution(db, input.entity, "agent.spawn");
      if (!gate.ok) {
        ctx.send(input.entity, gate.reason ?? "refused");
        return;
      }
      recordGateExecution(db, input.entity, "agent.spawn", gate, "command:breed");
      ran.push("breed");
      ctx.send(input.entity, "bred");
    },
  });
  // A core-gated command.
  engine.commands.registerBuiltin({
    name: "wipe",
    category: "Test",
    help: "core-gated test command",
    minRank: 0,
    gate: "shell.exec",
    handler: (ctx, input) => {
      ran.push("wipe");
      ctx.send(input.entity, "wiped");
    },
  });
  // An ungated command with a router rank floor.
  engine.commands.registerBuiltin({
    name: "probe4",
    category: "Test",
    help: "rank-4 ungated test command",
    minRank: 4,
    handler: (ctx, input) => {
      ran.push("probe4");
      ctx.send(input.entity, "probed");
    },
  });
  let n = 0;
  const join: World["join"] = (name, opts = {}) => {
    const c = new MockConnection(`${name}-${n++}`);
    engine.addConnection(c);
    engine.spawnEntity(c.id, name);
    if (opts.rank !== undefined)
      engine.entities.get(c.entity as EntityId)!.properties.rank = opts.rank;
    c.clear();
    return c;
  };
  return { db, engine, ran, join };
}

describe("approvals are the proof", () => {
  const DB = `test_gates_approvals_${process.pid}.db`;
  let w: World;
  let state: DisposableStack | undefined;
  const send = (c: MockConnection, raw: string) => w.engine.processCommand(c.entity!, raw);
  const count = (what: string) => w.ran.filter((r) => r === what).length;

  beforeEach(() => {
    using pending = scopeProcessState({
      trustProfile: null,
      env: { MARINA_AUTONOMY: undefined, MARINA_CHALLENGES: undefined },
    });
    state = pending.move();
    resetChallengesForTests();
    resetGateContextForTests();
    w = world(DB);
  });
  afterEach(() => {
    resetChallengesForTests();
    resetGateContextForTests();
    w.engine.stop();
    w.db.close();
    cleanupDb(DB);
    using _state = state;
    state = undefined;
  });

  it("approved runs build an earnable gate; after the threshold it runs solo, no hold", async () => {
    const newcomer = w.join("Newcomer"); // a person, zero standing
    const root = w.join("Root", { rank: 9 }); // an operator
    const threshold = SAFETY_GATES["agent.spawn"]!.demoThreshold;
    for (let i = 1; i <= threshold; i++) {
      newcomer.clear();
      await send(newcomer, "breed");
      const token = tokenIn(text(newcomer))!;
      expect(token).toBeDefined();
      await send(root, `challenge approve ${token}`);
      await until(() => count("breed") === i);
      expect(w.db.getCompetence(newcomer.entity!, "agent.spawn")?.demonstrations).toBe(i);
    }
    expect(w.db.getCompetence(newcomer.entity!, "agent.spawn")?.supervised_only).toBe(0);
    // The newcomer has no standing, but held runs count regardless; solo use
    // re-checks standing, so give it the floor's worth of verified work.
    const taskId = w.db.createTask({ title: "t", creatorId: root.entity!, creatorName: "Root" });
    w.db.recordStandingEarned(newcomer.entity!, "Newcomer", taskId, 12); // above the floor: standing decays continuously
    newcomer.clear();
    await send(newcomer, "breed");
    expect(count("breed")).toBe(threshold + 1);
    expect(text(newcomer)).not.toContain("challenge ch_");
  });

  it("an owner approving its own agent's hold runs it but never builds the gate (any depth)", async () => {
    const owner = w.join("Owner");
    const middle = w.join("Middle");
    const child = w.join("Child");
    w.db.saveAgentConfig({ name: "Middle", model: "x", spawnedBy: "Owner" });
    w.db.saveAgentConfig({ name: "Child", model: "x", spawnedBy: "Middle" });
    grant(w.db, owner.entity!, "agent.spawn"); // the owner holds the authority

    await send(child, "breed");
    const token = tokenIn(text(child))!;
    expect(text(owner)).toContain(`challenge approve ${token}`);
    await send(owner, `challenge approve ${token}`);
    expect(stripAnsi(owner.lastText())).toContain("does not build agent.spawn");
    await until(() => count("breed") === 1);
    expect(w.db.getCompetence(child.entity!, "agent.spawn")?.demonstrations ?? 0).toBe(0);
    // Agents never answer: the middle agent is refused outright.
    await send(child, "breed");
    const second = tokenIn(stripAnsi(child.lastText()))!;
    await send(middle, `challenge approve ${second}`);
    expect(count("breed")).toBe(1);
  });

  it("core gates: operator approval runs once and builds nothing; `open` never lifts them", async () => {
    using _open = scopeProcessState({ env: { MARINA_AUTONOMY: "open" } });
    const newcomer = w.join("Newcomer");
    const root = w.join("Root", { rank: 9 });
    await send(newcomer, "wipe");
    expect(text(newcomer)).toContain("Operator grant");
    expect(text(newcomer)).not.toContain("needs standing");
    const token = tokenIn(text(newcomer))!;
    await send(root, `challenge approve ${token}`);
    expect(stripAnsi(root.lastText())).toContain("operator-grant only");
    await until(() => count("wipe") === 1);
    expect(w.db.getCompetence(newcomer.entity!, "shell.exec")).toBeUndefined();
    // Still held next time — approvals never accumulate into a core gate.
    newcomer.clear();
    await send(newcomer, "wipe");
    expect(count("wipe")).toBe(1);
    expect(tokenIn(text(newcomer))).toBeDefined();
  });

  it("one rank-floor rule: the router's minRank matches rankFloorRefusal in every posture", async () => {
    const rookie = w.join("Rookie"); // rank 0
    const entity = () => w.engine.entities.get(rookie.entity as EntityId)!;
    const cases: Array<{ profile: "shared" | "local"; autonomy?: string; passes: boolean }> = [
      { profile: "shared", passes: false },
      { profile: "shared", autonomy: "guarded", passes: false },
      { profile: "shared", autonomy: "earned", passes: false },
      { profile: "shared", autonomy: "open", passes: true },
      { profile: "local", passes: true },
      { profile: "local", autonomy: "guarded", passes: false },
    ];
    let runs = 0;
    for (const c of cases) {
      using _s = scopeProcessState({
        trustProfile: c.profile,
        env: { MARINA_AUTONOMY: c.autonomy },
      });
      expect(rankFloorRefusal(entity(), 4) === undefined).toBe(c.passes);
      rookie.clear();
      await send(rookie, "probe4");
      if (c.passes) runs++;
      expect(count("probe4")).toBe(runs);
      if (!c.passes) {
        expect(text(rookie)).toContain('to use "probe4"');
        expect(tokenIn(text(rookie))).toBeDefined(); // the refusal raised a challenge
      }
      // A floor guarding a path into the core is never lifted by `open`.
      if (c.autonomy === "open")
        expect(rankFloorRefusal(entity(), 4, "no", { core: true })).toBe("no");
    }
  });

  it("an approved rank challenge passes the router floor for that run only", async () => {
    const rookie = w.join("Rookie");
    const root = w.join("Root", { rank: 9 });
    await send(rookie, "probe4");
    const token = tokenIn(text(rookie))!;
    await send(root, `challenge approve ${token}`);
    await until(() => count("probe4") === 1);
    rookie.clear();
    await send(rookie, "probe4");
    expect(count("probe4")).toBe(1);
  });

  it("read-only forms are open at rank 0; their write forms stay gated", async () => {
    const rookie = w.join("Rookie");
    await send(rookie, "world list");
    expect(text(rookie)).toContain("No child worlds yet");
    rookie.clear();
    await send(rookie, "world create kid");
    expect(text(rookie)).not.toContain("Created child world");

    rookie.clear();
    await send(rookie, "position list");
    expect(text(rookie)).toContain("No open positions");
    rookie.clear();
    await send(rookie, "position open kalshi X yes 1");
    expect(text(rookie)).toContain("rank 2");

    rookie.clear();
    await send(rookie, "admin decisions");
    expect(text(rookie)).toContain("Decision settings");
    rookie.clear();
    await send(rookie, "admin decisions history");
    expect(text(rookie)).not.toContain("Operator grant");
    rookie.clear();
    await send(rookie, "admin models");
    expect(text(rookie)).toContain("Model tiers");
    expect(text(rookie)).toContain("judge");
    expect(text(rookie)).not.toContain("Operator grant");
    rookie.clear();
    await send(rookie, "admin decisions set gate on");
    expect(text(rookie)).toContain("Operator grant");
    rookie.clear();
    await send(rookie, "admin stats");
    expect(text(rookie)).toContain("Operator grant");
  });

  it("witness attest: an operator outside the lineage counts a pending run; the owner cannot", async () => {
    using _earned = scopeProcessState({ env: { MARINA_AUTONOMY: "earned" } });
    const owner = w.join("Owner", { rank: 9 }); // an operator who is also the owner
    const root = w.join("Root", { rank: 9 });
    const agent = w.join("Agent");
    w.db.saveAgentConfig({ name: "Agent", model: "x", spawnedBy: "Owner" });
    const taskId = w.db.createTask({ title: "t", creatorId: root.entity!, creatorName: "Root" });
    w.db.recordStandingEarned(agent.entity!, "Agent", taskId, 12); // above the floor: standing decays continuously

    await send(agent, "breed"); // runs optimistically under earned
    expect(count("breed")).toBe(1);
    const [row] = w.db.listOpenWitnessRows({ kind: "pending", entityId: agent.entity! });
    expect(row).toBeDefined();

    await send(owner, `witness attest ${row!.id}`);
    expect(stripAnsi(owner.lastText())).toContain("your own lineage");
    expect(w.db.getCompetence(agent.entity!, "agent.spawn")?.demonstrations ?? 0).toBe(0);

    await send(root, `witness attest ${row!.id}`);
    expect(w.db.getCompetence(agent.entity!, "agent.spawn")?.demonstrations).toBe(1);
    expect(w.db.getWitnessRow(row!.id)?.status).toBe("attested");
  });
});

describe("code.exec.unrestricted is operator-grant only", () => {
  const DB = `test_gates_unrestricted_${process.pid}.db`;
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(DB);
  });
  afterEach(() => {
    db.close();
    cleanupDb(DB);
  });

  it("the headless approver's refusal says it is operator-grant, and a grant passes", async () => {
    const taskId = db.createTask({ title: "t", creatorId: "e_x", creatorName: "X" });
    db.recordStandingEarned("e_bot", "Bot", taskId, 12); // above the floor: standing decays continuously
    const approver = new HeadlessGateApprover({
      db,
      entityName: "Bot",
      allowList: ["e_bot"],
      authRequired: false,
      actingConnectionTrusted: () => true,
      audit: () => {},
    });
    const req = { argv: ["pytest"], cwd: "/w", entityId: "e_bot" };
    const refused = await approver.requestApproval(req);
    expect(refused.approved).toBe(false);
    expect(refused.reason).toContain("operator-grant only");
    grant(db, "e_bot", "code.exec.unrestricted");
    expect((await approver.requestApproval(req)).approved).toBe(true);
  });
});

describe("standing floors are read as shown", () => {
  it("whole tasks meet their floor despite continuous decay", () => {
    expect(meetsStandingFloor(2.9999, 3)).toBe(true);
    expect(meetsStandingFloor(2.96, 3)).toBe(true);
    expect(meetsStandingFloor(2.94, 3)).toBe(false);
    expect(meetsStandingFloor(0, 0)).toBe(true);
  });
});
