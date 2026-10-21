// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Challenges are answered by people (2026-10-14): agents — whatever their
 * stored rank, internal or external — never answer another participant's
 * hold. Holds survive a restart, expire on a timer with the requester told,
 * wait in a durable inbox for offline approvers, are scored by the judge
 * (tool holds too), and the decision gate's hold text says what to do.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { classifyCommandRisk, classifyToolRisk, isGatedRisk } from "../src/agent/tool-policy";
import { explainGateHold } from "../src/decisions/policy";
import {
  listRaisedBy,
  raiseForTool,
  resetChallengesForTests,
  sweepChallenges,
} from "../src/engine/challenges";
import { Engine } from "../src/engine/engine";
import { resetGateContextForTests } from "../src/engine/gate-context";
import { handleParticipantMessage } from "../src/net/participant-messages";
import { MarinaDB } from "../src/persistence/database";
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
const text = (c: MockConnection) => stripAnsi(c.allText().join("\n"));

interface World {
  db: MarinaDB;
  engine: Engine;
  ran: string[];
  join(name: string, opts?: { rank?: number; protocol?: "mcp"; agent?: boolean }): MockConnection;
}

function world(path: string): World {
  const db = new MarinaDB(path);
  const engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  const ran: string[] = [];
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
  let n = 0;
  const join: World["join"] = (name, opts = {}) => {
    const c = new MockConnection(`${name}-${n++}`);
    if (opts.protocol) (c as unknown as { protocol: string }).protocol = opts.protocol;
    if (opts.agent) (c as unknown as { agent: boolean }).agent = true;
    engine.addConnection(c);
    engine.spawnEntity(c.id, name);
    if (opts.rank !== undefined)
      engine.entities.get(c.entity as EntityId)!.properties.rank = opts.rank;
    c.clear();
    return c;
  };
  return { db, engine, ran, join };
}

describe("challenges: people approve, agents never do", () => {
  const DB = `test_challenges_people_${process.pid}.db`;
  let w: World;
  const send = (c: MockConnection, raw: string) => w.engine.processCommand(c.entity!, raw);

  beforeEach(() => {
    resetChallengesForTests();
    resetGateContextForTests();
    w = world(DB);
  });
  afterEach(() => {
    resetChallengesForTests();
    resetGateContextForTests();
    restoreEnv();
    w.db.close();
    cleanupDb(DB);
  });

  it("a resident agent with stored rank 9 can't approve, and isn't asked; a person can", async () => {
    const builder = w.join("Builder");
    const resident = w.join("Resident", { rank: 9 });
    const root = w.join("Root", { rank: 9 });
    w.db.saveAgentConfig({ name: "Builder", model: "x", spawnedBy: "system" });
    w.db.saveAgentConfig({ name: "Resident", model: "x", spawnedBy: "system" });

    await send(builder, "zap now");
    const token = tokenIn(text(builder))!;
    expect(token).toBeDefined();
    expect(text(resident)).not.toContain(token);
    expect(text(root)).toContain(`challenge approve ${token}`);

    await send(resident, `challenge approve ${token}`);
    expect(stripAnsi(resident.lastText())).toContain("People answer held actions, agents don't");
    await send(resident, "challenge");
    expect(stripAnsi(resident.lastText())).toContain("No open challenges");
    expect(w.ran).toEqual([]);

    await send(root, `challenge approve ${token}`);
    await until(() => w.ran.length === 1);
    expect(w.ran).toEqual(["zap now"]);
  });

  it("an external agent — over MCP, or a declared SDK agent — can't approve even at rank 9", async () => {
    const builder = w.join("Builder");
    const viaMcp = w.join("Claudia", { rank: 9, protocol: "mcp" });
    const viaSdk = w.join("Botty", { rank: 9, agent: true });
    await send(builder, "zap one");
    const token = tokenIn(text(builder))!;
    for (const agent of [viaMcp, viaSdk]) {
      expect(text(agent)).not.toContain(token);
      await send(agent, `challenge approve ${token}`);
      expect(stripAnsi(agent.lastText())).toContain("agents don't");
    }
    expect(w.ran).toEqual([]);
  });

  it("an agent spawned by an agent is answered for by the person who started the chain", async () => {
    const alice = w.join("Alice");
    const scout = w.join("Scout", { rank: 9 });
    w.join("Builder");
    w.db.saveAgentConfig({ name: "Scout", model: "x", spawnedBy: "Alice" });
    w.db.saveAgentConfig({ name: "Builder", model: "x", spawnedBy: "Scout" });
    const held = raiseForTool({
      requesterId: "",
      requesterName: "Builder",
      toolName: "marina_command",
      summary: 'marina_command {"command":"build destroy old"}',
      reason: "held",
      rerun: async () => "destroyed",
    });
    expect(held.token).toMatch(/^ch_/);
    expect(text(alice)).toContain(`challenge approve ${held.token}`);
    expect(text(scout)).not.toContain(held.token!);
    await send(scout, `challenge approve ${held.token}`);
    expect(stripAnsi(scout.lastText())).toContain("agents don't");
    await send(alice, `challenge approve ${held.token}`);
    expect(stripAnsi(alice.lastText())).toContain("Approved Builder's");
  });

  it("a client that declares itself an agent on login is one for the connection's life", () => {
    const declared = new MockConnection("sdk-1");
    const plain = new MockConnection("web-1");
    w.engine.addConnection(declared);
    w.engine.addConnection(plain);
    const ws = (connId: string) => ({ data: { connId }, readyState: 1, send: () => undefined });
    handleParticipantMessage(w.engine, ws("sdk-1"), {
      type: "login",
      name: "Sdkbot",
      principal: "agent",
    });
    handleParticipantMessage(w.engine, ws("web-1"), { type: "login", name: "Webby" });
    expect(w.engine.getConnections().get("sdk-1")?.agent).toBe(true);
    expect(w.engine.getConnections().get("web-1")?.agent).toBeUndefined();
  });

  it("answers are never held by the decision gate; reads stay reads", () => {
    for (const raw of [
      "challenge approve ch_0123456789ab",
      "challenge deny ch_0123456789ab not now",
      "challenges approve ch_0123456789ab always",
      "decision approve ch_0123456789ab",
      "decision deny ch_0123456789ab",
    ]) {
      expect(classifyCommandRisk(raw)).toBe("communicate");
      expect(isGatedRisk(classifyToolRisk("marina_command", { command: raw }))).toBe(false);
    }
    for (const raw of ["challenge", "challenge list", "challenge stats", "decision list"]) {
      expect(classifyCommandRisk(raw)).toBe("read");
    }
  });

  it("a hold survives a restart and runs in the requester's slot on approval", async () => {
    let builder = w.join("Builder");
    w.join("Root", { rank: 9 });
    await send(builder, "zap durable");
    const token = tokenIn(text(builder))!;
    expect(w.db.listChallengeHolds({ pending: true }).map((r) => r.token)).toEqual([token]);
    // The durable inbox has the hold (content-free: no held input in it).
    const inbox = w.db
      .listOperationalAlerts("open")
      .find((a) => a.alert_key === `challenge:${token}`);
    expect(inbox?.category).toBe("challenge");
    expect(inbox?.title).not.toContain("zap durable");

    // Restart: the process forgets everything; the database remembers.
    resetChallengesForTests();
    w.db.close();
    w = world(DB);
    builder = w.join("Builder");
    const root = w.join("Root", { rank: 9 });
    sweepChallenges();
    expect(text(builder)).toContain(`Challenge ${token} survived a restart`);
    expect(text(root)).toContain(`challenge approve ${token}`);
    expect(listRaisedBy(builder.entity!).map((c) => c.token)).toEqual([token]);

    await send(root, `challenge approve ${token}`);
    await until(() => w.ran.length === 1);
    expect(w.ran).toEqual(["zap durable"]);
    expect(text(builder)).toContain("zapped");
    expect(w.db.listChallengeHolds({ pending: true })).toEqual([]);
    const resolved = w.db
      .listOperationalAlerts("resolved")
      .find((a) => a.alert_key === `challenge:${token}`);
    expect(resolved).toBeDefined();
  });

  it("a secret-shaped held input is never stored; after a restart the requester is asked to re-issue", async () => {
    let builder = w.join("Builder");
    const secret = "sk-test-fixture-not-a-real-key"; // matches the mask pattern; low entropy, not a real key
    await send(builder, `zap ${secret}`);
    const token = tokenIn(text(builder))!;
    const [row] = w.db.listChallengeHolds({ pending: true });
    expect(row?.command).toBeNull();
    expect(row?.summary).not.toContain(secret);

    resetChallengesForTests();
    w.db.close();
    w = world(DB);
    builder = w.join("Builder");
    sweepChallenges();
    expect(text(builder)).toContain(`Challenge ${token} did not survive a restart`);
    expect(w.db.listChallengeHolds({ pending: true })).toEqual([]);
  });

  it("expiry runs on the sweep (not on the next read) and the requester is told — later if offline", async () => {
    process.env.MARINA_CHALLENGE_TTL_MS = "60000";
    const builder = w.join("Builder");
    await send(builder, "zap late");
    const token = tokenIn(text(builder))!;
    // The requester goes away before the hold expires.
    w.engine.removeConnection(builder.id, "explicit");
    sweepChallenges(Date.now() + 120_000);
    const [row] = w.db.listChallengeHolds({ withNotice: true });
    expect(row?.status).toBe("expired");
    expect(row?.requester_notice).toContain(`Challenge ${token} expired unanswered`);
    expect(
      w.db.listOperationalAlerts("resolved").some((a) => a.alert_key === `challenge:${token}`),
    ).toBe(true);

    // Back online: the owed notice is delivered once.
    const again = w.join("Builder");
    sweepChallenges();
    expect(text(again)).toContain(`Challenge ${token} expired unanswered`);
    expect(w.db.listChallengeHolds({ withNotice: true })).toEqual([]);
  });

  it("an approver who connects after the hold was raised is told by the sweep", async () => {
    const builder = w.join("Builder");
    await send(builder, "zap waiting");
    const token = tokenIn(text(builder))!;
    expect(text(builder)).toContain("none connected (it waits in their inbox)");
    const root = w.join("Root", { rank: 9 });
    expect(text(root)).not.toContain(token);
    sweepChallenges();
    expect(text(root)).toContain(`challenge approve ${token}`);
    root.clear();
    sweepChallenges();
    expect(text(root)).toBe(""); // told once
  });
});

describe("decision-gate hold text", () => {
  it("names the question, the intent it was judged against, and the options", () => {
    const text = explainGateHold(
      { worst: 0.66, signals: { destructive: 0.1, irreversible: 0.2, outsideScope: 0.66 } },
      { goal: "Keep the research pool tidy", role: "librarian" },
    );
    expect(text).toContain("question: outsideScope 0.66");
    expect(text).toContain("reaches beyond your own work");
    expect(text).toContain('scope: goal "Keep the research pool tidy", role "librarian"');
    expect(text).toContain("options: wait — runs automatically if approved");
    expect(text).toContain("narrow — keep it to your own notes, tasks, rooms and artifacts");
    expect(text).toContain("ask your owner");
    // With no intent set, it says so rather than inventing one.
    expect(explainGateHold({ worst: 0.9, signals: { unauthorized: 0.9 } })).toContain(
      "scope: no goal, role, focus or task set",
    );
  });
});

describe("challenge judge scores tool holds", () => {
  let backend: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    backend = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          answers: {
            destructive: { type: "noul", noul: 0.02 },
            irreversible: { type: "noul", noul: 0.02 },
            outsideScope: { type: "noul", noul: 0.02 },
            unauthorized: { type: "noul", noul: 0.02 },
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

  it("observe: a decision-gate hold gets a shadow opinion recorded with the person's answer", async () => {
    process.env.MARINA_DECISIONS = "decisions-api";
    process.env.MARINA_DECISION_MODEL = "stub-jev";
    process.env.MARINA_DECISION_BASE_URL = `http://localhost:${backend.port}`;
    process.env.MARINA_CHALLENGE_JUDGE = "observe";
    const DB = `test_challenges_tool_judge_${process.pid}.db`;
    resetChallengesForTests();
    const w = world(DB);
    try {
      const alice = w.join("Alice");
      w.join("Builder");
      w.db.saveAgentConfig({ name: "Builder", model: "x", spawnedBy: "Alice" });
      let calls = 0;
      const held = raiseForTool({
        requesterId: "",
        requesterName: "Builder",
        toolName: "marina_pool",
        summary: 'marina_pool {"pool":"notes","action":"add"}',
        reason: "held",
        rerun: async () => {
          calls++;
          return "added";
        },
        command: "pool notes add a fact",
        judge: { args: { pool: "notes", action: "add", content: "a fact" } },
      });
      expect(held.token).toMatch(/^ch_/);
      // Shadow only: the judge's allow never runs anything under observe.
      await Bun.sleep(100);
      expect(calls).toBe(0);
      await w.engine.processCommand(alice.entity!, `challenge approve ${held.token}`);
      await until(() => calls === 1);
      const row = w.db.listChallengeOutcomes().find((r) => r.token === held.token);
      expect(row).toMatchObject({
        class: "tool:marina_pool",
        answer: "once",
        answered_role: "creator",
        judge_opinion: "allow",
      });
    } finally {
      w.db.close();
      cleanupDb(DB);
    }
  });
});
