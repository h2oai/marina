// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { blindPanelCases, liveGateCases } from "../src/decisions/challenge-labels";
import { judgeRecords, raiseForTool, resetChallengesForTests } from "../src/engine/challenges";
import { Engine } from "../src/engine/engine";
import { resetGateContextForTests } from "../src/engine/gate-context";
import { checkGateForExecution, grant, recordGateExecution } from "../src/engine/safety-gates";
import { MarinaDB } from "../src/persistence/database";
import { isGrantedCompetence } from "../src/persistence/db-competence";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi, until } from "./helpers";

const ENV_KEYS = [
  "MARINA_CHALLENGES",
  "MARINA_CHALLENGE_TTL_MS",
  "MARINA_CHALLENGE_JUDGE",
  "MARINA_DECISIONS",
  "MARINA_DECISION_BASE_URL",
  "MARINA_DECISION_MODEL",
  "MARINA_DECISION_GATE",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

const tokenIn = (text: string) => text.match(/\b(ch_[0-9a-f]{12})\b/)?.[1];

describe("challenges (engine)", () => {
  const DB = `test_challenges_${process.pid}.db`;
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection; // creator of Builder
  let builder: MockConnection; // the requester
  let root: MockConnection; // admin
  let bob: MockConnection; // stranger
  let ran: string[];

  const text = (c: MockConnection) => stripAnsi(c.allText().join("\n"));
  const send = (c: MockConnection, raw: string) => engine.processCommand(c.entity!, raw);

  beforeEach(() => {
    resetChallengesForTests();
    resetGateContextForTests();
    db = new MarinaDB(DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    ran = [];
    engine.commands.registerBuiltin({
      name: "zap",
      category: "Test",
      help: "rank-5 test command",
      minRank: 5,
      handler: (ctx, input) => {
        ran.push(`zap ${input.tokens.join(" ")}`.trim());
        ctx.send(input.entity, "zapped");
      },
    });
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
    const conns: MockConnection[] = [];
    for (const [i, name] of ["Alice", "Builder", "Root", "Bob"].entries()) {
      const c = new MockConnection(`c${i}`);
      engine.addConnection(c);
      engine.spawnEntity(`c${i}`, name);
      c.clear();
      conns.push(c);
    }
    [alice, builder, root, bob] = conns as [
      MockConnection,
      MockConnection,
      MockConnection,
      MockConnection,
    ];
    for (const c of conns) c.clear();
    engine.entities.get(root.entity as EntityId)!.properties.rank = 9;
    db.saveAgentConfig({ name: "Builder", model: "x", spawnedBy: "Alice" });
  });
  afterEach(() => {
    resetChallengesForTests();
    resetGateContextForTests();
    restoreEnv();
    db.close();
    cleanupDb(DB);
  });

  it("a rank refusal asks at once, never waits, and approval re-runs the command", async () => {
    const started = Date.now();
    await send(builder, "zap now");
    expect(Date.now() - started).toBeLessThan(1_000);
    const reply = text(builder);
    expect(reply).toContain('to use "zap"');
    expect(reply).toContain("runs automatically if approved");
    expect(reply).toContain("carry on with other work");
    const token = tokenIn(reply)!;
    expect(token).toBeDefined();
    expect(ran).toEqual([]);

    // Admins hear about it; the creator lacks rank 5, so is not asked.
    expect(text(root)).toContain(`challenge approve ${token}`);
    expect(text(alice)).not.toContain(token);

    // The creator can't approve what they couldn't do; a stranger can't at all.
    await send(alice, `challenge approve ${token}`);
    expect(stripAnsi(alice.lastText())).toContain("only for what they could do themselves");
    await send(bob, `challenge approve ${token}`);
    expect(stripAnsi(bob.lastText())).toContain("Only the requester's creator or an admin");

    await send(root, `challenge approve ${token}`);
    await until(() => ran.length === 1);
    expect(ran).toEqual(["zap now"]);
    expect(text(builder)).toContain(`Root approved challenge ${token}`);
    expect(text(builder)).toContain("zapped");

    // Single use: the token is gone, and the next attempt asks again.
    await send(root, `challenge approve ${token}`);
    expect(stripAnsi(root.lastText())).toContain("No open challenge");
    builder.clear();
    await send(builder, "zap again");
    expect(ran).toEqual(["zap now"]);
    expect(tokenIn(text(builder))).toBeDefined();
  });

  it("nobody answers their own ask, nor one raised by the agent that spawned them", async () => {
    engine.entities.get(builder.entity as EntityId)!.properties.rank = 9;
    engine.entities.get(root.entity as EntityId)!.properties.rank = 0;
    await send(root, "zap");
    const token = tokenIn(text(root))!;
    await send(root, `challenge approve ${token}`);
    expect(stripAnsi(root.lastText())).toContain("can't answer your own ask");

    // Builder (admin now) was spawned by Alice; Alice's own ask is off-limits to it.
    engine.entities.get(alice.entity as EntityId)!.properties.rank = 0;
    await send(alice, "zap");
    const aliceToken = tokenIn(text(alice))!;
    await send(builder, `challenge approve ${aliceToken}`);
    expect(stripAnsi(builder.lastText())).toContain("can't answer your own ask");
  });

  it("a gate refusal inside a handler is a challenge; a holder's approval is a witnessed demonstration", async () => {
    grant(db, alice.entity!, "agent.spawn");
    await send(builder, "breed");
    const reply = text(builder);
    const token = tokenIn(reply)!;
    expect(token).toBeDefined();
    // The creator holds the gate, so is asked (and admins too).
    expect(text(alice)).toContain(`challenge approve ${token}`);
    expect(text(root)).toContain(`challenge approve ${token}`);

    await send(alice, `challenge approve ${token}`);
    await until(() => ran.includes("breed"));
    const competence = db.getCompetence(builder.entity!, "agent.spawn");
    expect(competence?.demonstrations).toBe(1);

    // `always` grants the gate: later runs pass with no challenge.
    await send(builder, "breed");
    const second = tokenIn(stripAnsi(builder.lastText()))!;
    await send(alice, `challenge approve ${second} always`);
    await until(() => ran.filter((r) => r === "breed").length === 2);
    builder.clear();
    await send(builder, "breed");
    expect(ran.filter((r) => r === "breed").length).toBe(3);
    expect(text(builder)).not.toContain("challenge ch_");
  });

  it("`always` on a core gate needs an admin; otherwise it is approved once", async () => {
    engine.commands.registerBuiltin({
      name: "wipe",
      category: "Test",
      help: "core-gated test command",
      minRank: 0,
      gate: "admin.destructive",
      handler: (ctx, input) => {
        ran.push("wipe");
        ctx.send(input.entity, "wiped");
      },
    });
    grant(db, alice.entity!, "admin.destructive");
    await send(builder, "wipe");
    const token = tokenIn(text(builder))!;
    await send(alice, `challenge approve ${token} always`);
    expect(stripAnsi(alice.lastText())).toContain("needs an admin; approved once");
    await until(() => ran.includes("wipe"));
    // Not granted — at most a witnessed demonstration from the holder's approval.
    expect(isGrantedCompetence(db.getCompetence(builder.entity!, "admin.destructive"))).toBe(false);
  });

  it("deny and expiry reach the requester; `decision approve|deny` answer challenges too", async () => {
    await send(builder, "zap one");
    const first = tokenIn(text(builder))!;
    await send(root, `challenge deny ${first} not today`);
    expect(text(builder)).toContain(`Root declined challenge ${first}`);
    expect(text(builder)).toContain("not today");
    expect(ran).toEqual([]);

    await send(builder, "zap two");
    const second = tokenIn(stripAnsi(builder.lastText()))!;
    await send(root, `decision approve ${second}`);
    await until(() => ran.length === 1);

    process.env.MARINA_CHALLENGE_TTL_MS = "1";
    await send(builder, "zap three");
    const third = tokenIn(stripAnsi(builder.lastText()))!;
    await Bun.sleep(5);
    await send(root, "challenge");
    expect(text(builder)).toContain(`Challenge ${third} expired unanswered`);
  });

  it("MARINA_CHALLENGES=off restores plain refusals", async () => {
    process.env.MARINA_CHALLENGES = "off";
    await send(builder, "zap");
    expect(text(builder)).toContain('to use "zap"');
    expect(tokenIn(text(builder))).toBeUndefined();
    expect(text(root)).toBe("");
  });

  it("the same held command is asked once, not re-broadcast", async () => {
    await send(builder, "zap same");
    const token = tokenIn(text(builder))!;
    root.clear();
    await send(builder, "zap same");
    expect(stripAnsi(builder.lastText())).toContain(`Still waiting on`);
    expect(stripAnsi(builder.lastText())).toContain(token);
    expect(text(root)).toBe("");
  });

  it("a held tool call returns at once and re-runs on approval", async () => {
    let calls = 0;
    const held = raiseForTool({
      requesterId: "",
      requesterName: "Builder",
      toolName: "marina_command",
      summary: 'marina_command {"command":"build destroy old-room"}',
      reason: "Held by the decision gate.",
      rerun: async () => {
        calls++;
        return "destroyed";
      },
    });
    expect(held.token).toMatch(/^ch_/);
    expect(held.message).toContain("runs automatically if approved");
    expect(text(alice)).toContain(`challenge approve ${held.token}`);
    await send(alice, `challenge approve ${held.token}`);
    await until(() => text(builder).includes("destroyed"));
    expect(calls).toBe(1);
  });
});

describe("challenges: no silent walls", () => {
  const DB = `test_challenges_cap_${process.pid}.db`;
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let builder: MockConnection;
  let root: MockConnection;

  const text = (c: MockConnection) => stripAnsi(c.allText().join("\n"));
  const hold = (summary: string, requesterName = "Builder") =>
    raiseForTool({
      requesterId: "",
      requesterName,
      toolName: "marina_command",
      summary,
      reason: "Held for approval by the decision gate (unauthorized 0.95).",
      rerun: async () => `ran ${summary}`,
    });

  beforeEach(() => {
    resetChallengesForTests();
    resetGateContextForTests();
    db = new MarinaDB(DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    engine.commands.registerBuiltin({
      name: "zap",
      category: "Test",
      help: "rank-5 test command",
      minRank: 5,
      handler: (ctx, input) => ctx.send(input.entity, "zapped"),
    });
    const conns: MockConnection[] = [];
    for (const [i, name] of ["Alice", "Builder", "Root"].entries()) {
      const c = new MockConnection(`k${i}`);
      engine.addConnection(c);
      engine.spawnEntity(`k${i}`, name);
      conns.push(c);
    }
    [alice, builder, root] = conns as [MockConnection, MockConnection, MockConnection];
    for (const c of conns) c.clear();
    engine.entities.get(root.entity as EntityId)!.properties.rank = 9;
    db.saveAgentConfig({ name: "Builder", model: "x", spawnedBy: "Alice" });
  });
  afterEach(() => {
    resetChallengesForTests();
    resetGateContextForTests();
    restoreEnv();
    db.close();
    cleanupDb(DB);
  });

  it("at the cap, the newest hold replaces the oldest of its class and says so", async () => {
    const first = hold("marina_command call 1");
    for (let i = 2; i <= 5; i++) expect(hold(`marina_command call ${i}`).token).toBeDefined();
    alice.clear();
    const sixth = hold("marina_command call 6");
    expect(sixth.token).toMatch(/^ch_/);
    expect(sixth.message).toContain("runs automatically if approved");
    expect(sixth.message).toContain(`replaces your oldest held call (challenge ${first.token}`);
    expect(sixth.message).toContain("did not run");
    // Approvers hear that the old one is gone and about the new one.
    expect(text(alice)).toContain(
      `Challenge ${first.token} (Builder) was replaced by ${sixth.token}`,
    );
    expect(text(alice)).toContain(`challenge approve ${sixth.token}`);
    // The replaced challenge can no longer be approved; the new one still runs.
    await engine.processCommand(alice.entity!, `challenge approve ${first.token}`);
    expect(text(builder)).not.toContain("ran marina_command call 1");
    await engine.processCommand(alice.entity!, `challenge approve ${sixth.token}`);
    await until(() => text(builder).includes("ran marina_command call 6"));
    // Its outcome is recorded as expired (unanswered), never as a person's verdict.
    const outcome = db
      .listChallengeOutcomes({ limit: 50 })
      .find((row) => row.token === first.token);
    expect(outcome?.answer).toBe("expired");
  });

  it("when every open challenge is of another class, the refusal names them", async () => {
    const tokens: string[] = [];
    for (const arg of ["a", "b", "c", "d", "e"]) {
      builder.clear();
      await engine.processCommand(builder.entity!, `zap ${arg}`);
      tokens.push(tokenIn(text(builder))!);
    }
    expect(tokens.every(Boolean)).toBe(true);
    const refused = hold("marina_command pool out add T1");
    expect(refused.token).toBeUndefined();
    expect(refused.message).toContain("It did not run");
    expect(refused.message).toContain("already have 5 open challenges of other kinds");
    for (const token of tokens) expect(refused.message).toContain(token);
    expect(refused.message).toContain("Take another route");
  });

  it("with no approver connected, the agent is told who can answer and to carry on", () => {
    engine.entities.get(root.entity as EntityId)!.properties.rank = 0;
    const loner = new MockConnection("k9");
    engine.addConnection(loner);
    engine.spawnEntity("k9", "Loner");
    db.saveAgentConfig({ name: "Loner", model: "x", spawnedBy: "Operator" });
    const held = hold("marina_pool add crew:answerer T1", "Loner");
    expect(held.token).toMatch(/^ch_/);
    expect(held.message).toContain("Held for approval by Operator or an admin");
    expect(held.message).toContain("no eligible approver is connected right now");
    expect(held.message).toMatch(/stays open \d+ min and runs automatically if approved/);
    expect(held.message).toContain("expires without running");
    expect(held.message).toContain("Continue with other work");
    // The same call again coalesces onto the open challenge instead of opening another.
    const again = hold("marina_pool add crew:answerer T1", "Loner");
    expect(again.token).toBe(held.token);
    expect(again.message).toContain("Still waiting on an approver");
  });
});

describe("challenge judge + pi adapter", () => {
  let backend: ReturnType<typeof Bun.serve>;
  let risk = 0.8;
  beforeAll(() => {
    backend = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          answers: {
            destructive: { type: "noul", noul: risk },
            irreversible: { type: "noul", noul: risk / 2 },
            outsideScope: { type: "noul", noul: 0.05 },
            unauthorized: { type: "noul", noul: 0.05 },
          },
        }),
    });
  });
  afterAll(() => backend.stop(true));
  afterEach(() => {
    resetChallengesForTests();
    resetGateContextForTests();
    restoreEnv();
  });

  function useBackend() {
    process.env.MARINA_DECISIONS = "decisions-api";
    process.env.MARINA_DECISION_MODEL = "stub-jev";
    process.env.MARINA_DECISION_BASE_URL = `http://localhost:${backend.port}`;
  }

  it("the adapter's gate `ask` blocks now with a token instead of waiting", async () => {
    useBackend();
    process.env.MARINA_DECISION_GATE = "on";
    risk = 0.8;
    const DB = `test_challenges_adapter_${process.pid}.db`;
    const db = new MarinaDB(DB);
    const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    const alice = new MockConnection("a");
    const builderConn = new MockConnection("b");
    engine.addConnection(alice);
    engine.addConnection(builderConn);
    engine.spawnEntity("a", "Alice");
    engine.spawnEntity("b", "Builder");
    db.saveAgentConfig({ name: "Builder", model: "x", spawnedBy: "Alice" });
    try {
      const { LeanAgentAdapter } = await import("../src/agent/lean-agent-adapter");
      const adapter = new LeanAgentAdapter(
        { name: "Builder", spawnedBy: "Alice" } as never,
        "ws://127.0.0.1:3300",
        null,
      );
      const agent = (
        adapter as unknown as { agent: { beforeToolCall: (ctx: unknown) => Promise<unknown> } }
      ).agent;
      let executed = 0;
      const args = { command: "build destroy old-room" };
      const tool = {
        name: "marina_command",
        description: "run a command",
        execute: async () => {
          executed++;
          return { content: [{ type: "text", text: "room destroyed" }] };
        },
      };
      const started = Date.now();
      const result = (await agent.beforeToolCall({
        toolCall: { id: "t", name: "marina_command", arguments: args },
        args,
        context: { tools: [tool] },
      })) as { block: boolean; reason: string };
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result.block).toBe(true);
      expect(result.reason).toContain("runs automatically if approved");
      const token = tokenIn(stripAnsi(alice.allText().join("\n")))!;
      expect(token).toBeDefined();
      await engine.processCommand(alice.entity!, `challenge approve ${token}`);
      await until(() => stripAnsi(builderConn.allText().join("\n")).includes("room destroyed"));
      expect(executed).toBe(1);
    } finally {
      db.close();
      cleanupDb(DB);
    }
  });

  it("the judge observes first and auto-approves only a class it has earned, never a core gate", async () => {
    useBackend();
    risk = 0.02;
    const DB = `test_challenges_judge_${process.pid}.db`;
    const db = new MarinaDB(DB);
    const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    const ran: string[] = [];
    for (const [name, gate] of [
      ["soft", "agent.spawn"],
      ["other", "role.edit"],
      ["hard", "shell.exec"],
    ] as const) {
      engine.commands.registerBuiltin({
        name,
        category: "Test",
        help: "gated test command",
        minRank: 0,
        gate,
        handler: (ctx, input) => {
          ran.push(name);
          ctx.send(input.entity, `${name} ran`);
        },
      });
    }
    const conn = new MockConnection("j");
    const admin = new MockConnection("r");
    engine.addConnection(conn);
    engine.addConnection(admin);
    engine.spawnEntity("j", "Jay");
    engine.spawnEntity("r", "Root");
    engine.entities.get(admin.entity as EntityId)!.properties.rank = 9;
    try {
      // observe: the opinion is recorded with the person's answer; nothing auto-runs.
      process.env.MARINA_CHALLENGE_JUDGE = "observe";
      await engine.processCommand(conn.entity!, "soft");
      const token = tokenIn(stripAnsi(conn.allText().join("\n")))!;
      await Bun.sleep(100);
      expect(ran).toEqual([]);
      await engine.processCommand(admin.entity!, `challenge approve ${token}`);
      await until(() => ran.includes("soft"));
      const [row] = db.listChallengeOutcomes();
      expect(row).toMatchObject({
        class: "agent.spawn",
        answer: "once",
        answered_role: "admin",
        judge_opinion: "allow",
      });

      // Earn agent.spawn: 25 people-approved cases the judge called allow.
      for (let i = 0; i < 25; i++) {
        db.recordChallengeOutcome({
          token: `ch_seed${i}`,
          kind: "gate",
          class: "agent.spawn",
          requesterName: "Jay",
          summary: "soft",
          reason: "seed",
          answer: "once",
          answeredBy: "Root",
          answeredRole: "admin",
          judgeOpinion: "allow",
          createdAt: Date.now(),
        });
      }
      process.env.MARINA_CHALLENGE_JUDGE = "on";
      conn.clear();
      await engine.processCommand(conn.entity!, "soft");
      await until(() => ran.filter((r) => r === "soft").length === 2);
      expect(stripAnsi(conn.allText().join("\n"))).toContain("the judge approved");

      // An unearned class and a core gate wait for people.
      await engine.processCommand(conn.entity!, "other");
      await engine.processCommand(conn.entity!, "hard");
      await Bun.sleep(100);
      expect(ran).toEqual(["soft", "soft"]);
    } finally {
      db.close();
      cleanupDb(DB);
    }
  });
});

describe("judge records and case exports", () => {
  const row = (over: Partial<Record<string, unknown>>) =>
    ({
      id: 1,
      token: "ch_a",
      kind: "gate",
      class: "agent.spawn",
      requester_name: "Jay",
      creator_name: null,
      tool_name: null,
      summary: "agent spawn scout",
      reason: "Needs the agent.spawn gate.",
      answer: "once",
      answered_by: "Root",
      answered_role: "admin",
      judge_opinion: "allow",
      judge_signals: null,
      created_at: 0,
      answered_at: 0,
      ...over,
    }) as never;

  it("earns a class only on enough approved allow calls, never a core gate", () => {
    const many = (cls: string, n: number, answer = "once") =>
      Array.from({ length: n }, () => row({ class: cls, answer }));
    const records = judgeRecords([
      ...many("agent.spawn", 30),
      ...many("role.edit", 5),
      ...many("world.lineage", 25),
      ...many("world.lineage", 5, "deny"),
      ...many("shell.exec", 40),
      row({ class: "agent.spawn", answered_role: "judge" }),
      row({ class: "agent.spawn", answer: "expired" }),
    ]);
    const by = Object.fromEntries(records.map((r) => [r.class, r]));
    expect(by["agent.spawn"]).toMatchObject({ allowSaid: 30, allowApproved: 30, earned: true });
    expect(by["role.edit"]?.earned).toBe(false); // too few
    expect(by["world.lineage"]?.earned).toBe(false); // people denied 1 in 6
    expect(by["shell.exec"]?.earned).toBe(false); // core
  });

  it("exports live labels (people only) and blind cases without answers", () => {
    const rows = [
      row({ token: "ch_1", answer: "deny" }),
      row({ token: "ch_2", answered_role: "judge" }),
      row({
        token: "ch_3",
        kind: "tool",
        tool_name: "marina_command",
        summary: 'marina_command {"command":"build destroy old"}',
      }),
    ];
    const live = liveGateCases(rows);
    expect(live.map((c) => [c.id, c.expect])).toEqual([
      ["challenge:ch_1", "hold"],
      ["challenge:ch_3", "allow"],
    ]);
    expect(live[0]).toMatchObject({ family: "challenge-live", command: "agent spawn scout" });
    const blind = blindPanelCases(rows);
    expect(blind).toHaveLength(2); // ch_2 repeats ch_1's action
    expect(blind[1]).toMatchObject({
      tool: "marina_command",
      arguments: { command: "build destroy old" },
    });
    expect(JSON.stringify(blind)).not.toContain("deny");
  });
});
