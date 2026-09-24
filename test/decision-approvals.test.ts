// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  type ApprovalRequest,
  listApprovals,
  requestApproval,
  resetApprovalsForTests,
  setApprovalNotifier,
  settleApproval,
} from "../src/decisions/approvals";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi, until } from "./helpers";

const base = {
  agentName: "Builder",
  ownerName: "Alice",
  toolName: "marina_command",
  summary: 'marina_command {"command":"build destroy old-room"}',
  reason: "Held for approval by the decision gate (destructive 0.80).",
  signals: { destructive: 0.8 },
};

describe("approval queue", () => {
  let delivered: ApprovalRequest[];
  beforeEach(() => {
    resetApprovalsForTests();
    delivered = [];
    setApprovalNotifier((r) => {
      delivered.push(r);
      return true;
    });
  });
  afterEach(() => resetApprovalsForTests());

  it("only the owner settles, never the agent itself or a stranger", async () => {
    const waiting = requestApproval(base, 5_000);
    const token = delivered[0]!.token;
    expect(listApprovals("alice").map((r) => r.token)).toEqual([token]);
    expect(listApprovals("Bob")).toEqual([]);
    expect(settleApproval(token, "Bob", "approved")).toEqual({ ok: false, error: "not_owner" });
    expect(settleApproval(token, "Builder", "approved")).toEqual({ ok: false, error: "self" });
    expect(settleApproval(token, "Alice", "approved").ok).toBe(true);
    expect(await waiting).toMatchObject({ outcome: "approved", by: "Alice" });
    expect(settleApproval(token, "Alice", "approved")).toEqual({ ok: false, error: "not_found" });
  });

  it("fails closed: deny, timeout, unreachable owner, or no approvable owner", async () => {
    const denied = requestApproval(base, 5_000);
    settleApproval(delivered[0]!.token, "Alice", "denied", "not today");
    expect(await denied).toMatchObject({ outcome: "denied", note: "not today" });

    expect((await requestApproval(base, 30)).outcome).toBe("timeout");
    expect((await requestApproval({ ...base, ownerName: "system" }, 5_000)).outcome).toBe(
      "timeout",
    );
    expect((await requestApproval({ ...base, ownerName: "" }, 5_000)).outcome).toBe("timeout");

    setApprovalNotifier(() => false);
    expect((await requestApproval(base, 5_000)).outcome).toBe("timeout");
    setApprovalNotifier(undefined);
    expect((await requestApproval(base, 5_000)).outcome).toBe("timeout");
  });
});

describe("decision command (engine)", () => {
  const DB = `test_decision_approvals_${process.pid}.db`;
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let bob: MockConnection;

  beforeEach(() => {
    resetApprovalsForTests();
    db = new MarinaDB(DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("c1");
    bob = new MockConnection("c2");
    engine.addConnection(alice);
    engine.addConnection(bob);
    engine.spawnEntity("c1", "Alice");
    engine.spawnEntity("c2", "Bob");
    alice.clear();
    bob.clear();
  });
  afterEach(() => {
    resetApprovalsForTests();
    db.close();
    cleanupDb(DB);
  });

  it("notifies the owner, who approves with `decision approve <token>`", async () => {
    const waiting = requestApproval(base, 5_000);
    await until(() => alice.allText().some((t) => t.includes("decision approve")));
    const notice = stripAnsi(alice.allText().join("\n"));
    expect(notice).toContain("Builder wants to run marina_command");
    const token = notice.match(/decision approve (ap_[0-9a-f]+)/)![1]!;

    engine.processCommand(alice.entity!, "decision list");
    expect(stripAnsi(alice.lastText())).toContain(token);
    engine.processCommand(bob.entity!, `decision approve ${token}`);
    expect(stripAnsi(bob.lastText())).toContain("Only the principal that spawned");

    engine.processCommand(alice.entity!, `decision approve ${token}`);
    expect(await waiting).toMatchObject({ outcome: "approved", by: "Alice" });
    expect(stripAnsi(alice.lastText())).toContain("Approved Builder's marina_command call");
  });

  it("an offline owner fails the hold closed at once", async () => {
    const started = Date.now();
    expect((await requestApproval({ ...base, ownerName: "Nobody" }, 5_000)).outcome).toBe(
      "timeout",
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("pi adapter gate hold", () => {
  let backend: ReturnType<typeof Bun.serve>;
  const keys = [
    "MARINA_DECISIONS",
    "MARINA_DECISION_BASE_URL",
    "MARINA_DECISION_MODEL",
    "MARINA_DECISION_GATE",
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

  beforeAll(() => {
    backend = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          answers: {
            destructive: { type: "noul", noul: 0.8 },
            irreversible: { type: "noul", noul: 0.3 },
            outsideScope: { type: "noul", noul: 0.1 },
            unauthorized: { type: "noul", noul: 0.1 },
          },
        }),
    });
  });
  afterAll(() => backend.stop(true));
  afterEach(() => {
    resetApprovalsForTests();
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function hook() {
    process.env.MARINA_DECISIONS = "decisions-api";
    process.env.MARINA_DECISION_MODEL = "stub-jev";
    process.env.MARINA_DECISION_BASE_URL = `http://localhost:${backend.port}`;
    process.env.MARINA_DECISION_GATE = "on";
    const { LeanAgentAdapter } = await import("../src/agent/lean-agent-adapter");
    const adapter = new LeanAgentAdapter(
      { name: "Builder", spawnedBy: "Alice" } as never,
      "ws://127.0.0.1:3300",
      null,
    );
    const agent = (
      adapter as unknown as { agent: { beforeToolCall: (ctx: unknown) => Promise<unknown> } }
    ).agent;
    const args = { command: "build destroy old-room" };
    return () =>
      agent.beforeToolCall({
        toolCall: { id: "t", name: "marina_command", arguments: args },
        args,
        context: {},
      });
  }

  it("runs the held call once the owner approves, and blocks it on deny", async () => {
    setApprovalNotifier((r) => {
      queueMicrotask(() => settleApproval(r.token, "Alice", "approved"));
      return true;
    });
    const call = await hook();
    expect(await call()).toBeUndefined();

    setApprovalNotifier((r) => {
      queueMicrotask(() => settleApproval(r.token, "Alice", "denied", "keep it"));
      return true;
    });
    const denied = (await call()) as { block: boolean; reason: string };
    expect(denied.block).toBe(true);
    expect(denied.reason).toContain("denied it: keep it");
  });
});
