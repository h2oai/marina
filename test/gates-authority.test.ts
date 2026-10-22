// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Safety gates are the single authority — contracts under test:
 * - A gated command's minRank never blocks a gate holder, in any posture.
 * - `world` / `marina-descend` sit behind `world.lineage`, `build` code paths
 *   behind `world.code`; migration 140 carries existing capability across.
 * - Inline rank floors go through `rankFloorRefusal`: refused + challenge
 *   under shared/guarded, passed under `open` and LOCAL, passed on an approved
 *   re-run — but never above the rank the approval covered.
 * - Implicit LOCAL lifts everything for the loopback person; an agent's host
 *   shell / arbitrary host commands are held for a person. `sovereign` lifts all.
 * - `gate grant|revoke|list` never escalates.
 * - The lineage growth limits are operator env knobs with the old defaults.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LOCAL_AGENT_HELD_GATES, OPEN_POSTURE_CORE } from "../src/engine/autonomy";
import { resetChallengesForTests } from "../src/engine/challenges";
import { Engine } from "../src/engine/engine";
import {
  armGatePass,
  isRankWaivedForRun,
  resetGateContextForTests,
} from "../src/engine/gate-context";
import { rankFloorRefusal } from "../src/engine/rank-floor";
import {
  checkGateForExecution,
  checkUnattendedGate,
  grant,
  SAFETY_GATES,
} from "../src/engine/safety-gates";
import { resetTrustProfileForTests, setTrustProfile } from "../src/engine/trust-profile";
import { MarinaDB } from "../src/persistence/database";
import { MIGRATIONS } from "../src/persistence/schema";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi, until } from "./helpers";

const savedPosture = process.env.MARINA_AUTONOMY;
const tokenIn = (text: string) => text.match(/\b(ch_[0-9a-f]{12})\b/)?.[1];

describe("gates are the authority", () => {
  const DB = `test_gates_authority_${process.pid}.db`;
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection; // creator of Builder
  let builder: MockConnection; // rank 0
  let root: MockConnection; // sovereign
  let bob: MockConnection; // stranger
  let ran: string[];

  const text = (c: MockConnection) => stripAnsi(c.allText().join("\n"));
  const send = (c: MockConnection, raw: string) => engine.processCommand(c.entity!, raw);
  const id = (c: MockConnection) => c.entity as EntityId;

  beforeEach(() => {
    delete process.env.MARINA_AUTONOMY; // guarded
    resetChallengesForTests();
    resetGateContextForTests();
    db = new MarinaDB(DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    ran = [];
    engine.commands.registerBuiltin({
      name: "tinker",
      category: "Test",
      help: "command with an inline rank-4 subcommand floor",
      minRank: 0,
      handler: (ctx, input) => {
        const entity = engine.entities.get(input.entity)!;
        const floor = rankFloorRefusal(entity, 4, "tinker needs rank 4.");
        if (floor) {
          ctx.send(input.entity, floor);
          return;
        }
        ran.push("tinker");
        ctx.send(input.entity, "tinkered");
      },
    });
    const conns: MockConnection[] = [];
    for (const [i, name] of ["Alice", "Builder", "Root", "Bob"].entries()) {
      const c = new MockConnection(`c${i}`);
      engine.addConnection(c);
      engine.spawnEntity(`c${i}`, name);
      conns.push(c);
    }
    [alice, builder, root, bob] = conns as [
      MockConnection,
      MockConnection,
      MockConnection,
      MockConnection,
    ];
    for (const c of conns) c.clear();
    engine.entities.get(id(root))!.properties.rank = 9;
    db.saveAgentConfig({ name: "Builder", model: "x", spawnedBy: "Alice" });
  });

  afterEach(() => {
    if (savedPosture === undefined) delete process.env.MARINA_AUTONOMY;
    else process.env.MARINA_AUTONOMY = savedPosture;
    resetChallengesForTests();
    resetGateContextForTests();
    resetTrustProfileForTests();
    engine.stop();
    db.close();
    cleanupDb(DB);
  });

  it("world.lineage: a rank-0 holder runs `world` under guarded; a non-holder is refused by the gate", async () => {
    // Listing is a read-only form: open at rank 0 without the gate.
    await send(bob, "world list");
    expect(text(bob)).toContain("No child worlds yet");
    bob.clear();
    await send(bob, "world stop nowhere");
    expect(text(bob)).toContain("Not yet");
    expect(text(bob)).not.toContain("rank 5");

    grant(db, id(bob), "world.lineage");
    bob.clear();
    await send(bob, "world stop nowhere");
    expect(text(bob)).toContain('No child world "nowhere"');
    expect(SAFETY_GATES["world.lineage"]?.minStanding).toBe(
      SAFETY_GATES["agent.spawn"]?.minStanding,
    );
  });

  it("world.code: build code paths are the gate, not rank 5", async () => {
    engine.entities.get(id(bob))!.properties.rank = 4; // build's own floor
    await send(bob, "build room test/lab A lab");
    bob.clear();
    await send(bob, "build destroy test/lab");
    expect(text(bob)).toContain("Cannot destroy rooms");
    expect(text(bob)).not.toContain("Destroyed room");

    grant(db, id(bob), "world.code");
    bob.clear();
    await send(bob, "build destroy test/lab");
    expect(text(bob)).not.toContain("Cannot destroy rooms");
    expect(text(bob)).toContain("Destroyed room");
  });

  it("inline rank floor: refuses with a challenge, and an approved re-run passes", async () => {
    await send(builder, "tinker");
    const reply = text(builder);
    expect(reply).toContain("tinker needs rank 4.");
    const token = tokenIn(reply);
    expect(token).toBeDefined();
    expect(ran).toEqual([]);

    await send(root, `challenge approve ${token}`);
    await until(() => ran.length === 1);
    expect(ran).toEqual(["tinker"]);
  });

  it("inline rank floor: open posture and the LOCAL profile pass it", async () => {
    process.env.MARINA_AUTONOMY = "open";
    await send(builder, "tinker");
    expect(ran).toEqual(["tinker"]);

    delete process.env.MARINA_AUTONOMY;
    setTrustProfile("local");
    await send(builder, "tinker");
    expect(ran).toEqual(["tinker", "tinker"]);
  });

  it("implicit local lifts every gate and floor for a person but live trading, and all but host commands for an agent", async () => {
    // MARINA_PROFILE=local, autonomy unset: the loopback PERSON is ungated
    // except for real-money orders (`trading.live`, holdsUnderLocalProfile);
    // an AGENT's host shell and arbitrary host commands (LOCAL_AGENT_HELD_GATES)
    // are held for a person — `sovereign` (next test) is the one switch that
    // lifts those too.
    delete process.env.MARINA_AUTONOMY;
    setTrustProfile("local");
    const rookie = engine.entities.get(id(builder))!; // an agent, rank 0, no standing
    const person = engine.entities.get(id(bob))!; // a person, rank 0, no standing
    for (const gateId of Object.keys(SAFETY_GATES)) {
      const held = SAFETY_GATES[gateId]!.holdsUnderLocalProfile === true;
      expect(checkGateForExecution(db, String(person.id), gateId).ok, gateId).toBe(!held);
      expect(checkGateForExecution(db, String(rookie.id), gateId).ok, gateId).toBe(
        !held && !LOCAL_AGENT_HELD_GATES.has(gateId),
      );
    }
    expect(SAFETY_GATES["trading.live"]!.holdsUnderLocalProfile).toBe(true);
    for (const core of OPEN_POSTURE_CORE) {
      if (core === "trading.live") continue;
      expect(checkGateForExecution(db, String(person.id), core).ok, core).toBe(true);
    }
    for (const floor of [1, 2, 3, 4]) {
      expect(rankFloorRefusal(rookie, floor)).toBeUndefined();
      expect(rankFloorRefusal(person, floor)).toBeUndefined();
    }
    // A floor guarding a path INTO the core (rank set, shell allowlist) holds the agent only.
    expect(rankFloorRefusal(person, 9, undefined, { core: true })).toBeUndefined();
    expect(rankFloorRefusal(rookie, 9, undefined, { core: true })).toContain("rank 9");
    await send(builder, "tinker");
    expect(ran).toEqual(["tinker"]);
    expect(text(builder)).not.toContain("challenge ch_");
    // `guarded` turns every check back on.
    process.env.MARINA_AUTONOMY = "guarded";
    expect(checkGateForExecution(db, String(person.id), "shell.exec").ok).toBe(false);
  });

  it("implicit local: an agent's host shell is held at once and runs when a person approves it", async () => {
    delete process.env.MARINA_AUTONOMY;
    setTrustProfile("local");
    engine.commands.registerBuiltin({
      name: "hostcmd",
      category: "Test",
      help: "stands in for a host-shell command",
      minRank: 5,
      gate: "shell.exec",
      handler: (ctx, input) => {
        ran.push(`hostcmd:${input.entity}`);
        ctx.send(input.entity, "host ran");
      },
    });
    // The person runs it with no prompt.
    await send(bob, "hostcmd");
    expect(ran).toEqual([`hostcmd:${id(bob)}`]);
    expect(text(bob)).not.toContain("challenge ch_");

    // The agent's run is held: the reply comes back now with a token.
    const started = Date.now();
    await send(builder, "hostcmd");
    expect(Date.now() - started).toBeLessThan(2_000);
    const reply = text(builder);
    expect(reply).toContain("on this local Marina an agent may");
    const token = tokenIn(reply);
    expect(token).toBeDefined();
    expect(ran).toHaveLength(1);

    // An agent never answers a hold — not even its own.
    builder.clear();
    await send(builder, `challenge approve ${token}`);
    expect(ran).toHaveLength(1);

    // The loopback operator approves once: the held input re-runs.
    await send(root, `challenge approve ${token} once`);
    await until(() => ran.length === 2);
    expect(ran[1]).toBe(`hostcmd:${id(builder)}`);
    // Once builds nothing: the next run is held again.
    expect(checkUnattendedGate(db, id(builder), "shell.exec").ok).toBe(false);
  });

  it("implicit local: an agent promoting itself to sovereign is held and writes no shell grant", async () => {
    delete process.env.MARINA_AUTONOMY;
    setTrustProfile("local");
    await send(builder, "rank Builder 9");
    const reply = text(builder);
    expect(reply).toContain("Only sovereigns (rank 9) can set ranks.");
    expect(tokenIn(reply)).toBeDefined();
    expect(engine.entities.get(id(builder))!.properties.rank ?? 0).toBe(0);
    expect(db.getCompetence(id(builder), "shell.exec")).toBeFalsy();
    expect(checkUnattendedGate(db, id(builder), "shell.exec").ok).toBe(false);
  });

  it("the named switch: MARINA_AUTONOMY=sovereign lifts EVERY gate and floor in a shared profile", async () => {
    // The explicit form of the all-gates-off switch: no local profile needed.
    setTrustProfile("shared");
    process.env.MARINA_AUTONOMY = "sovereign";
    const rookie = engine.entities.get(id(builder))!; // an agent, rank 0, no standing
    for (const gateId of Object.keys(SAFETY_GATES)) {
      expect(checkGateForExecution(db, String(rookie.id), gateId).ok, gateId).toBe(true);
    }
    for (const core of OPEN_POSTURE_CORE) {
      expect(checkGateForExecution(db, String(rookie.id), core).ok, core).toBe(true);
    }
    for (const floor of [1, 2, 3, 4]) expect(rankFloorRefusal(rookie, floor)).toBeUndefined();
    expect(rankFloorRefusal(rookie, 9, undefined, { core: true })).toBeUndefined();
    await send(builder, "tinker");
    expect(ran).toEqual(["tinker"]);
    expect(text(builder)).not.toContain("challenge ch_");
    // `open` is not the switch: the core stays gated.
    process.env.MARINA_AUTONOMY = "open";
    expect(checkGateForExecution(db, String(rookie.id), "shell.exec").ok).toBe(false);
  });

  it("an approved rank waiver never covers a floor above the rank it vouched for", () => {
    const entity = engine.entities.get(id(builder))!;
    armGatePass(String(entity.id), {
      gateIds: [],
      rankWaived: true,
      waivedRank: 4,
      approverName: "Root",
      token: "ch_000000000000",
    });
    expect(isRankWaivedForRun(String(entity.id), 4)).toBe(true);
    expect(isRankWaivedForRun(String(entity.id), 7)).toBe(false);
    expect(rankFloorRefusal(entity, 4)).toBeUndefined();
    expect(rankFloorRefusal(entity, 7)).toContain("rank 7");
  });

  it("gate grant never escalates", async () => {
    // Not a holder.
    await send(bob, "gate grant Alice agent.spawn");
    expect(text(bob)).toContain("only gates you hold solo");

    grant(db, id(alice), "agent.spawn");
    grant(db, id(alice), "shell.exec");
    // Self-grant, own child, core gate: all refused.
    await send(alice, "gate grant Alice agent.spawn");
    await send(alice, "gate grant Builder agent.spawn");
    await send(alice, "gate grant Bob shell.exec");
    const refusals = text(alice);
    expect(refusals).toContain("Nobody grants a gate to themselves");
    expect(refusals).toContain("an agent you spawned");
    expect(refusals).toContain("operator-grant gate");
    expect(checkUnattendedGate(db, id(builder), "agent.spawn").ok).toBe(false);
    expect(checkUnattendedGate(db, id(bob), "shell.exec").ok).toBe(false);

    // A holder passes on what it holds.
    alice.clear();
    await send(alice, "gate grant Bob agent.spawn");
    expect(text(alice)).toContain("Granted agent.spawn to Bob");
    expect(checkUnattendedGate(db, id(bob), "agent.spawn").ok).toBe(true);

    // Revoke is sovereign-only; a sovereign grants the core.
    await send(alice, "gate revoke Bob agent.spawn");
    expect(text(alice)).toContain("operator (a person at rank 9)");
    expect(checkUnattendedGate(db, id(bob), "agent.spawn").ok).toBe(true);
    await send(root, "gate grant Bob shell.exec");
    expect(checkUnattendedGate(db, id(bob), "shell.exec").ok).toBe(true);
    await send(root, "gate revoke Bob agent.spawn");
    expect(checkUnattendedGate(db, id(bob), "agent.spawn").ok).toBe(false);

    // A rank-9 AGENT is not an operator: it grants nothing, core or not.
    builder.clear();
    (engine.entities.get(id(builder) as EntityId)!.properties as { rank?: number }).rank = 9;
    grant(db, id(builder), "agent.spawn");
    await send(builder, "gate grant Bob world.code");
    await send(builder, "gate grant Bob agent.spawn");
    expect(text(builder)).toContain("Agents don't grant gates");
    expect(checkUnattendedGate(db, id(bob), "world.code").ok).toBe(false);

    await send(bob, "gate list");
    expect(text(bob)).toContain("world.lineage");
    expect(text(bob)).toContain("world.code");

    // Every grant and revoke is an immutable chronicle event.
    const audit = db
      .queryChronicle({ kind: "event" })
      .filter((e) => e.source === "gate")
      .map((e) => e.title);
    expect(audit).toContain("Alice granted agent.spawn to Bob");
    expect(audit).toContain("Root granted shell.exec to Bob");
    expect(audit).toContain("Root revoked agent.spawn from Bob");
    expect(audit.some((t) => t.includes("Builder"))).toBe(false); // refusals leave no entry
  });

  it("world.code is core: open posture does not pass it, and only a sovereign grants it", async () => {
    expect(OPEN_POSTURE_CORE.has("world.code")).toBe(true);
    const saved = process.env.MARINA_AUTONOMY;
    process.env.MARINA_AUTONOMY = "open";
    try {
      expect(checkGateForExecution(db, id(bob), "world.lineage").ok).toBe(true);
      expect(checkGateForExecution(db, id(bob), "world.code").ok).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.MARINA_AUTONOMY;
      else process.env.MARINA_AUTONOMY = saved;
    }
    grant(db, id(alice), "world.code");
    await send(alice, "gate grant Bob world.code");
    expect(text(alice)).toContain("operator-grant gate");
  });
});

describe("migration 140 carries capability across", () => {
  const DB = `test_gates_mig140_${process.pid}.db`;
  afterEach(() => cleanupDb(DB));

  it("copies unsupervised admin.destructive to world.lineage and grants world.code at rank 5+", () => {
    new MarinaDB(DB).close();
    const raw = new Database(DB);
    const now = Date.now();
    raw.run("INSERT INTO users (id, name, created_at, last_login, rank) VALUES (?, ?, ?, ?, ?)", [
      "u_arch",
      "Arch",
      now,
      now,
      5,
    ]);
    raw.run("INSERT INTO users (id, name, created_at, last_login, rank) VALUES (?, ?, ?, ?, ?)", [
      "u_new",
      "Newbie",
      now,
      now,
      2,
    ]);
    raw.run(
      "INSERT INTO entity_competence (entity_id, gate, demonstrations, supervised_only) VALUES (?, 'admin.destructive', 999, 0), (?, 'admin.destructive', 0, 1)",
      ["u_admin", "u_learner"],
    );
    const sql = MIGRATIONS.find((m) => m.version === 140)?.sql ?? "";
    raw.exec(sql);
    const rows = raw
      .query(
        "SELECT entity_id, gate, demonstrations, supervised_only FROM entity_competence ORDER BY entity_id, gate",
      )
      .all() as {
      entity_id: string;
      gate: string;
      demonstrations: number;
      supervised_only: number;
    }[];
    const has = (e: string, g: string) => rows.find((r) => r.entity_id === e && r.gate === g);
    expect(has("u_admin", "world.lineage")).toMatchObject({
      demonstrations: 999,
      supervised_only: 0,
    });
    expect(has("u_learner", "world.lineage")).toBeUndefined();
    expect(has("u_arch", "world.code")).toMatchObject({ demonstrations: 999, supervised_only: 0 });
    expect(has("u_new", "world.code")).toBeUndefined();
    raw.close();
  });
});

describe("lineage growth limits are operator env knobs", () => {
  const read = (env: Record<string, string>) => {
    const proc = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        'import * as c from "./src/engine/constants"; console.log(JSON.stringify([c.MAX_SPAWN_DEPTH, c.STANDING_PER_SPAWNED_CHILD, c.MAX_REPLICAS_PER_RUN, c.MAX_RELAY_HOPS]))',
      ],
      { cwd: `${import.meta.dir}/..`, env: { ...process.env, ...env } },
    );
    return JSON.parse(proc.stdout.toString().trim().split("\n").at(-1) ?? "[]") as number[];
  };

  it("defaults match the old hard caps and env overrides them", () => {
    const cleared = {
      MARINA_MAX_SPAWN_DEPTH: "",
      MARINA_STANDING_PER_SPAWNED_CHILD: "",
      MARINA_MAX_REPLICAS_PER_RUN: "",
      MARINA_MAX_RELAY_HOPS: "",
    };
    expect(read(cleared)).toEqual([3, 25, 5, 3]);
    expect(
      read({
        MARINA_MAX_SPAWN_DEPTH: "5",
        MARINA_STANDING_PER_SPAWNED_CHILD: "10",
        MARINA_MAX_REPLICAS_PER_RUN: "8",
        MARINA_MAX_RELAY_HOPS: "0", // invalid ⇒ default
      }),
    ).toEqual([5, 10, 8, 3]);
  });
});
