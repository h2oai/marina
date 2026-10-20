// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  resetChallengesForTests,
  summarizeChallengeHolds,
  UNANSWERED_DIGEST_KEY,
} from "../src/engine/challenges";
import { Engine } from "../src/engine/engine";
import { resetGateContextForTests } from "../src/engine/gate-context";
import {
  notifyOperator,
  type OpsNotice,
  parseOpsNotify,
  setOpsNotifySenderForTests,
  splitArgs,
} from "../src/engine/ops-notify";
import { MarinaDB } from "../src/persistence/database";
import type { ChallengeHoldRow } from "../src/persistence/db-decisions";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi } from "./helpers";

const ENV_KEYS = ["MARINA_CHALLENGE_TTL_MS", "MARINA_OPS_NOTIFY"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

describe("MARINA_OPS_NOTIFY parsing", () => {
  it("is off unless a URL or cmd: program is given", () => {
    expect(parseOpsNotify(undefined)).toEqual({ kind: "off" });
    expect(parseOpsNotify("off")).toEqual({ kind: "off" });
    expect(parseOpsNotify("nonsense")).toEqual({ kind: "off" });
    expect(parseOpsNotify("https://ntfy.example/marina")).toEqual({
      kind: "webhook",
      url: "https://ntfy.example/marina",
    });
    expect(parseOpsNotify('cmd:notify-send -a "Marina ops"')).toEqual({
      kind: "command",
      argv: ["notify-send", "-a", "Marina ops"],
    });
    expect(splitArgs(`a 'b c' "d"`)).toEqual(["a", "b c", "d"]);
  });

  it("sends nothing when off and reports a failed delivery without throwing", async () => {
    const sent: OpsNotice[] = [];
    setOpsNotifySenderForTests(async (_t, n) => {
      sent.push(n);
    });
    try {
      expect(await notifyOperator({ event: "x", title: "t", detail: "d" }, {})).toBe(false);
      expect(sent).toEqual([]);
      setOpsNotifySenderForTests(async () => {
        throw new Error("unreachable");
      });
      expect(
        await notifyOperator(
          { event: "x", title: "t", detail: "d" },
          { MARINA_OPS_NOTIFY: "https://example.invalid/hook" },
        ),
      ).toBe(false);
    } finally {
      setOpsNotifySenderForTests(undefined);
    }
  });
});

describe("summarizeChallengeHolds", () => {
  const row = (over: Partial<ChallengeHoldRow>): ChallengeHoldRow => ({
    token: `ch_${Math.random().toString(16).slice(2, 14)}`,
    kind: "tool",
    requester_id: "e_1",
    requester_name: "Host",
    creator_name: null,
    gate_id: null,
    min_rank: null,
    command: null,
    tool_name: "marina_command",
    coding_target: null,
    summary: "masked",
    reason: "held",
    status: "expired",
    requester_notice: null,
    created_at: 1_000,
    expires_at: 2_000,
    settled_at: 2_000,
    ...over,
  });

  it("counts unanswered holds by class and requester inside the window, content-free", () => {
    const now = 10 * 86_400_000;
    const s = summarizeChallengeHolds(
      [
        row({ created_at: now - 1_000 }),
        row({ created_at: now - 2_000, tool_name: "marina_pool", requester_name: "Critic" }),
        row({ created_at: now - 3_000, status: "once", creator_name: "Alice" }),
        row({ created_at: now - 4_000, status: "pending", kind: "gate", gate_id: "agent.spawn" }),
        row({ created_at: 1 }), // outside the 7-day window
      ],
      now,
    );
    expect(s).toMatchObject({ total: 4, unanswered: 2, approved: 1, open: 1, operatorOnly: 3 });
    expect(s.byClass[0]).toEqual({ class: "tool:marina_command", total: 2, unanswered: 1 });
    expect(s.byClass.map((c) => c.class)).toContain("agent.spawn");
    expect(s.byRequester.find((r) => r.name === "Critic")).toEqual({
      name: "Critic",
      total: 1,
      unanswered: 1,
    });
    expect(JSON.stringify(s)).not.toContain("masked");
  });
});

describe("unanswered holds reach the operator", () => {
  const DB = `test_challenge_unanswered_${process.pid}.db`;
  let db: MarinaDB;
  let engine: Engine;
  let builder: MockConnection;
  let root: MockConnection;
  let notices: OpsNotice[];

  beforeEach(() => {
    resetChallengesForTests();
    resetGateContextForTests();
    notices = [];
    setOpsNotifySenderForTests(async (_target, notice) => {
      notices.push(notice);
    });
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
    for (const [i, name] of ["Builder", "Root"].entries()) {
      const c = new MockConnection(`c${i}`);
      engine.addConnection(c);
      engine.spawnEntity(`c${i}`, name);
      c.clear();
      conns.push(c);
    }
    [builder, root] = conns as [MockConnection, MockConnection];
    engine.entities.get(root.entity as EntityId)!.properties.rank = 9;
  });
  afterEach(() => {
    setOpsNotifySenderForTests(undefined);
    resetChallengesForTests();
    resetGateContextForTests();
    restoreEnv();
    engine.stop();
    db.close();
    cleanupDb(DB);
  });

  it("pushes a notice when a hold opens and keeps an open digest once holds expire", async () => {
    process.env.MARINA_OPS_NOTIFY = "https://ops.example/hook";
    process.env.MARINA_CHALLENGE_TTL_MS = "1";
    await engine.processCommand(builder.entity!, "zap now");
    const opened = notices.find((n) => n.event === "challenge.opened");
    expect(opened).toMatchObject({ class: "rank:5", token: expect.stringMatching(/^ch_/) });
    expect(opened?.title).toContain("Builder");
    // Content-free: the held input never leaves the world.
    expect(JSON.stringify(opened)).not.toContain("zap now");

    await Bun.sleep(5);
    await engine.processCommand(root.entity!, "challenge");
    const digest = db
      .listOperationalAlerts("open")
      .find((a) => a.alert_key === UNANSWERED_DIGEST_KEY);
    expect(digest).toMatchObject({ severity: "warning", category: "challenge-digest" });
    expect(digest?.title).toContain("1 of 1 held action(s) expired unanswered");
    expect(digest?.detail).toContain("rank:5 1");
    expect(notices.some((n) => n.event === "challenge.unanswered")).toBe(true);

    root.clear();
    await engine.processCommand(root.entity!, "challenge summary");
    const out = stripAnsi(root.allTextJoined());
    expect(out).toContain("1 held · 0 approved · 0 denied · 1 expired unanswered · 0 open");
    expect(out).toContain("rank:5");
  });

  it("sends nothing when MARINA_OPS_NOTIFY is unset, but the digest still opens", async () => {
    delete process.env.MARINA_OPS_NOTIFY;
    process.env.MARINA_CHALLENGE_TTL_MS = "1";
    await engine.processCommand(builder.entity!, "zap now");
    await Bun.sleep(5);
    await engine.processCommand(root.entity!, "challenge");
    expect(notices).toEqual([]);
    expect(
      db.listOperationalAlerts("open").some((a) => a.alert_key === UNANSWERED_DIGEST_KEY),
    ).toBe(true);
  });
});
