// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standing is visible where an agent works: a notice the moment a credit
 * lands, a one-line summary (live standing, last live credits, retired
 * credit labelled as history) in `standing summary` / `orient` / `brief` and
 * the resident's continuation prompt, and one line naming the live ways to
 * earn, derived from the live kinds.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LeanAgentAdapter } from "../src/agent/lean-agent-adapter";
import {
  liveStandingKinds,
  RETIRED_STANDING_KINDS,
  record,
  recordVerified,
  TASK_STANDING_MAX,
} from "../src/agent/standing";
import {
  creditRef,
  earningKinds,
  rankStep,
  standingEarnLine,
  standingSummaryLine,
} from "../src/agent/standing-summary";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, stripAnsi, until } from "./helpers";
import { scopeProcessState } from "./process-state";

const TEST_DB = `test_standing_visible_${process.pid}.db`;

describe("the earn line and its parts", () => {
  it("names every live earning kind and no retired or debit kind", () => {
    const line = standingEarnLine();
    expect(line.startsWith("earn standing: ")).toBe(true);
    expect(line).not.toContain("\n");
    const kinds = earningKinds();
    for (const kind of kinds) expect(liveStandingKinds()).toContain(kind);
    for (const kind of RETIRED_STANDING_KINDS) expect(kinds).not.toContain(kind);
    expect(kinds).not.toContain("assistance_superseded");
    expect(kinds).not.toContain("crew_member_stalled");
    expect(kinds).toEqual(
      expect.arrayContaining(["task_complete", "code_verified", "forecast_resolved"]),
    );
    expect(line.split(" · ")).toHaveLength(kinds.length);
    expect(line).toContain(`≤${TASK_STANDING_MAX}`);
    expect(line).not.toMatch(/chronicl|pool note/i);
  });

  it("formats refs and the rank step", () => {
    expect(creditRef("task_complete", "12")).toBe("task:#12");
    expect(creditRef("code_verified", "code:r1")).toBe("code:r1");
    expect(rankStep(3.4)).toBe("rank 0 by standing; rank 1 at 5");
    expect(rankStep(120)).toBe("rank 4 by standing; top derived rank");
  });
});

describe("standing visible to the earner", () => {
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let kid: MockConnection;

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

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = join("Alice");
    kid = join("Kid");
  });

  afterEach(async () => {
    await engine.shutdown();
    db.close();
    cleanupDb(TEST_DB);
  });

  it("tells the claimant once when an approved task credits it", async () => {
    run(alice, "task create Map | the grid standing:3");
    run(kid, "task claim 1");
    run(kid, "task submit 1 mapped");
    kid.clear();
    expect(run(alice, "task approve 1 Kid")).toContain("Kid earned 3 standing");
    await until(() => stripAnsi(kid.allTextJoined()).includes("standing +3.00"));
    const told = stripAnsi(kid.allTextJoined());
    expect(told).toContain("Your submission for task #1 was approved!");
    expect(told).not.toContain("earned 3 standing");
    expect(told).toContain(
      "standing +3.00 task_complete task:#1 → 3.00 (rank 0 by standing; rank 1 at 5)",
    );
    const notice = kid.messages.find((p) => p.tag === "standing");
    expect(notice?.data).toMatchObject({ kind: "task_complete", ref: "1", amount: 3 });
  });

  it("tells nothing for a repeated credit or a rolled-back write", async () => {
    const credit = () =>
      recordVerified(db, {
        kind: "code_verified",
        ref: "code:r1",
        worker: { name: "Kid" },
        verifier: "Alice",
      });
    expect(credit().credited).toBe(true);
    await until(() => kid.messages.some((p) => p.tag === "standing"));
    kid.clear();
    credit();
    expect(() =>
      db.transaction(() => {
        recordVerified(db, {
          kind: "experiment_complete",
          ref: "experiment:9",
          worker: { name: "Kid" },
          verifier: "Alice",
        });
        throw new Error("roll back");
      }),
    ).toThrow("roll back");
    await Promise.resolve();
    await Bun.sleep(5);
    expect(kid.messages.filter((p) => p.tag === "standing")).toEqual([]);
  });

  it("summarises live standing, live credits only, and retired credit as history", () => {
    using _s = scopeProcessState({ env: { MARINA_STANDING_RETIRED: undefined } });
    db.appendStandingEvent({
      entityId: "u_kid",
      entityName: "Kid",
      kind: "chronicled",
      ref: "chronicle:1",
      amount: 20,
    });
    record(db, "u_kid", "Kid", "code_verified", "code:r2", 1);
    const line = standingSummaryLine(db, "Kid");
    expect(line).toMatch(
      /^standing 1\.00 live \(rank 0 by standing; rank 1 at 5\) · last: \+1\.00 code_verified code:r2 0m · retired 20\.0 \(history, not counted\)$/,
    );
    expect(line).not.toContain("chronicled");

    const summary = run(kid, "standing summary").split("\n");
    expect(summary[0]).toBe(line);
    expect(summary[1]).toBe(standingEarnLine());
  });

  it("shows the summary in orient and brief, and the earn line when there is no work", () => {
    expect(run(kid, "orient")).toContain("Your Standing: 0.00 live");
    expect(run(kid, "orient")).toContain("earn standing: ");
    const brief = run(kid, "brief");
    expect(brief).toContain(
      "Standing: 0.00 live (rank 0 by standing; rank 1 at 5) · last: none yet",
    );
    expect(brief).toContain("earn standing: ");
    run(kid, "memory set goal map the grid");
    expect(run(kid, "brief")).not.toContain("earn standing: ");
  });
});

/** A resident whose world answers `standing summary` with fixed lines. */
function residentWithStanding(focus: string | null) {
  const adapter = new LeanAgentAdapter({ name: "Earner" }, "ws://127.0.0.1:3300", null);
  const sent: string[] = [];
  const i = adapter as unknown as {
    buildContinuationPrompt(): Promise<string>;
    obligationsComplete(system: string, user: string): Promise<string>;
    platformMemory: { client: { command(cmd: string): Promise<unknown[]> } };
    focus: { description: string; startedAt: number } | null;
  };
  i.obligationsComplete = async () => '{"add":[],"cancel":[]}';
  i.platformMemory.client.command = async (raw: string) => {
    sent.push(raw);
    if (raw === "standing summary")
      return [
        {
          kind: "message",
          data: {
            text: "standing 1.00 live (rank 0 by standing; rank 1 at 5) · last: +1.00 code_verified code:r2 2h\nearn standing: a · b",
          },
        },
      ];
    return [];
  };
  i.focus = focus ? { description: focus, startedAt: Date.now() } : null;
  return { sent, i };
}

describe("the resident's continuation prompt", () => {
  it("shows one [Standing] line at cycle 15, with the earn line only when unfocused", async () => {
    for (const focus of [null, "Map the grid"]) {
      const r = residentWithStanding(focus);
      const prompts: string[] = [];
      for (let c = 1; c <= 15; c++) prompts.push(await r.i.buildContinuationPrompt());
      expect(r.sent.filter((c) => c === "standing summary")).toHaveLength(1);
      for (const p of prompts.slice(0, 14)) expect(p).not.toContain("[Standing]");
      const line = prompts[14]!.split("\n").find((l) => l.startsWith("[Standing]"));
      expect(line).toContain("standing 1.00 live (rank 0 by standing; rank 1 at 5)");
      if (focus) expect(line).not.toContain("earn standing:");
      else expect(line).toContain("· earn standing: a · b");
    }
  });
});
