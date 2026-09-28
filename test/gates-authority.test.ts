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
 * - `gate grant|revoke|list` never escalates.
 * - The lineage growth limits are operator env knobs with the old defaults.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { OPEN_POSTURE_CORE } from "../src/engine/autonomy";
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
import { FORWARD_MIGRATIONS } from "../src/persistence/schema";
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
    await send(bob, "world list");
    expect(text(bob)).toContain("Not yet");
    expect(text(bob)).not.toContain("rank 5");

    grant(db, id(bob), "world.lineage");
    bob.clear();
    await send(bob, "world list");
    expect(text(bob)).toContain("No child worlds yet");
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
    expect(refusals).toContain("core gate");
    expect(checkUnattendedGate(db, id(builder), "agent.spawn").ok).toBe(false);
    expect(checkUnattendedGate(db, id(bob), "shell.exec").ok).toBe(false);

    // A holder passes on what it holds.
    alice.clear();
    await send(alice, "gate grant Bob agent.spawn");
    expect(text(alice)).toContain("Granted agent.spawn to Bob");
    expect(checkUnattendedGate(db, id(bob), "agent.spawn").ok).toBe(true);

    // Revoke is sovereign-only; a sovereign grants the core.
    await send(alice, "gate revoke Bob agent.spawn");
    expect(text(alice)).toContain("sovereign");
    expect(checkUnattendedGate(db, id(bob), "agent.spawn").ok).toBe(true);
    await send(root, "gate grant Bob shell.exec");
    expect(checkUnattendedGate(db, id(bob), "shell.exec").ok).toBe(true);
    await send(root, "gate revoke Bob agent.spawn");
    expect(checkUnattendedGate(db, id(bob), "agent.spawn").ok).toBe(false);

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
    expect(text(alice)).toContain("core gate");
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
    const sql = FORWARD_MIGRATIONS.find((m) => m.version === 140)?.sql ?? "";
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
