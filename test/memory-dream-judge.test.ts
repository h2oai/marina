// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Learn from last night, the utility-curve guard and the held-out measure
 * (`src/memory/dream/{judge,guard,measure}.ts`, `benchmarks/memory/dream.ts`):
 * an applied dream's ops are judge opinions settled by the owner's acts; a
 * dreamer that earned restatements applies them at once under
 * MARINA_DREAM_JUDGE=on; two consecutive drops in task success trip the guard
 * and hold the agent at observe; the measure splits applied dreams into
 * discovery and holdout; the offline replay rebuilds probes with no model.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { replayDreams } from "../benchmarks/memory/dream";
import { EARNED_JUDGE_MIN_N, judgeEarned, judgeStandings } from "../src/decisions/judges";
import { Engine } from "../src/engine/engine";
import {
  assessDreams,
  clearGuard,
  DREAM_SETTLE_MS,
  dreamEffect,
  dreamJudgeName,
  GUARD_K,
  guardState,
  runDream,
  settleQuietDreams,
} from "../src/memory/dream";
import { MarinaDB } from "../src/persistence/database";
import { type EntityId, roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom, tempDbPath } from "./helpers";
import { scopeProcessState } from "./process-state";

const TEST_DB = tempDbPath("test_memory_dream_judge.db");
const HOUR = 60 * 60 * 1000;

const NOTES = [
  "The amber deployment listens on port 8443 behind the staging proxy",
  "The amber deployment listens on port 8443 behind the staging gateway",
  "The quartz build takes eleven minutes on the shared runner",
  "Cobalt tests need the fixture database reset before each run",
  "Cobalt tests need the fixture database reset before every run",
  "Lantern maintenance is scheduled for the first Monday of each month",
  "The staging proxy rejects requests without a tenant header",
  "Verified fact: the production port is 443 and must never change",
  "A note that was served many times and never used by anyone",
  "Indigo alerts page the on-call engineer after three failures",
  "The quartz runner caches dependencies between builds",
  "Amber health checks poll every thirty seconds",
];

const stub = (reply: string) => async () => reply;

describe("the dream judge, guard and measure", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn: MockConnection;
  let ada: EntityId;
  let ids: number[];
  const now = Date.now();

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Ada");
    ada = conn.entity!;
    conn.clear();
    ids = NOTES.map((text) => db.createNote("Ada", text, undefined, { skipDedup: true }));
    // The fixture notes are old; each dream's material is a fresh note written just before it.
    db.memoryRepository().raw.run("UPDATE notes SET created_at = ? WHERE entity_name = 'Ada'", [
      now - 200 * HOUR,
    ]);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  const note = (i: number) => ids[i]!;
  let fresh = 0;
  /** One new note dated `at`, and every fixture note served at `at`: the material a dream at `at + 1` gathers. */
  const material = (at: number) => {
    const id = db.createNote(
      "Ada",
      `Fresh observation number ${++fresh} about the harbour`,
      undefined,
      { skipDedup: true },
    );
    db.memoryRepository().raw.run("UPDATE notes SET created_at = ? WHERE id = ?", [at, id]);
    db.recordMemoryServed(
      ids.map((itemId, rank) => ({
        entityName: "Ada",
        surface: "prompt" as const,
        arm: "lexical" as const,
        tier: "unverified",
        itemId: String(itemId),
        rank,
        queryHash: `q${fresh}`,
        servedAt: at,
      })),
    );
    return id;
  };
  let seq = 0;
  const outcome = (owner: string, succeeded: boolean, at: number) =>
    db.recordOutcomeRow(
      {
        subject: `task:${++seq}`,
        kind: "task",
        source: "task:verdict",
        domain: "task",
        owner,
        succeeded,
        basis: "mechanical",
        resolvedAt: at,
        now: at,
      },
      [],
    );
  const dreamOps = (withSupersede = true) =>
    JSON.stringify({
      ops: [
        { op: "merge", keep: note(0), into: [note(1)], reason: "same" },
        { op: "link", from: note(6), to: note(0), relation: "related_to", reason: "proxy" },
        ...(withSupersede
          ? [
              {
                op: "supersede",
                id: note(3),
                text: "Cobalt tests reset the fixture database before each run",
                refs: [note(4)],
                reason: "tighter",
              },
            ]
          : []),
      ],
    });

  it("an applied dream's ops are opinions, settled by adopt, dismiss, rollback and time", async () => {
    using _state = scopeProcessState({
      env: { MARINA_DREAMING: "on", MARINA_DREAM_JUDGE: undefined },
    });
    const at = now + 1000;
    material(at - 1);
    const first = await runDream(db, "Ada", "command", {
      complete: stub(dreamOps()),
      model: "test/dreamer",
      now: at,
    });
    expect(first.state).toBe("applied");
    const judge = dreamJudgeName("test/dreamer");
    const standings = () =>
      judgeStandings(db, { surface: "dream", judge }).sort((a, b) =>
        a.question.localeCompare(b.question),
      );
    // Three opinions (merge, link, supersede), none settled yet.
    expect(standings().map((s) => [s.question, s.opinions, s.compared])).toEqual([
      ["link", 1, 0],
      ["merge", 1, 0],
      ["supersede", 1, 0],
    ]);
    // Adopting the restatement settles it as agreement.
    await engine.processCommand(ada, `memory dream adopt ${first.id}`);
    expect(standings().find((s) => s.question === "supersede")).toMatchObject({
      compared: 1,
      agreed: 1,
    });
    // Seven quiet days settle the applied ops as agreement; a second dream's
    // dismissal and rollback settle as disagreement.
    expect(settleQuietDreams(db, at + HOUR)).toBe(0);
    expect(settleQuietDreams(db, at + DREAM_SETTLE_MS + HOUR)).toBe(2); // merge and link; the adoption settled itself
    expect(standings().map((s) => [s.question, s.compared, s.agreed])).toEqual([
      ["link", 1, 1],
      ["merge", 1, 1],
      ["supersede", 1, 1],
    ]);
    material(at + 2 * HOUR - 1);
    const second = await runDream(db, "Ada", "command", {
      complete: stub(
        JSON.stringify({
          ops: [
            { op: "link", from: note(9), to: note(10), relation: "related_to", reason: "x" },
            {
              op: "supersede",
              id: note(6),
              text: "The staging proxy rejects requests lacking a tenant header",
              refs: [],
              reason: "y",
            },
          ],
        }),
      ),
      model: "test/dreamer",
      now: at + 2 * HOUR,
    });
    expect(second.state).toBe("applied");
    await engine.processCommand(ada, `memory dream dismiss ${second.id}`);
    await engine.processCommand(ada, `memory dream rollback ${second.id}`);
    expect(standings().map((s) => [s.question, s.compared, s.agreed])).toEqual([
      ["link", 2, 1],
      ["merge", 1, 1],
      ["supersede", 2, 1],
    ]);
    // Observe-mode dreams record no opinion.
    {
      using _observe = scopeProcessState({ env: { MARINA_DREAMING: undefined } });
      material(at + 3 * HOUR - 1);
      const observed = await runDream(db, "Ada", "command", {
        complete: stub(dreamOps(false)),
        model: "test/dreamer",
        now: at + 3 * HOUR,
      });
      expect(observed.state).toBe("observed");
      expect(standings().reduce((n, s) => n + s.opinions, 0)).toBe(5);
    }
    conn.clear();
    await engine.processCommand(ada, "outcome judge stats dream");
    expect(conn.lastText()).toContain("dream/supersede");
  });

  it("an earned dreamer applies restatements at once under MARINA_DREAM_JUDGE=on, never otherwise", async () => {
    const judge = dreamJudgeName("test/dreamer");
    // Seed an earned record for supersede: 30 agreed comparisons.
    // Forty, so one later dismissal still leaves the lower bound above the bar.
    for (let i = 0; i < EARNED_JUDGE_MIN_N + 15; i++)
      db.recordJudgeOpinion({
        surface: "dream",
        question: "supersede",
        judge,
        subject: `dream:0:${i}`,
        opinion: "pass",
        truth: "pass",
        opinedAt: now - HOUR,
        truthAt: now,
      });
    expect(judgeEarned(db, "dream", judge, { question: "supersede" })).toBe(true);
    expect(judgeEarned(db, "dream", judge, { question: "merge" })).toBe(false);
    {
      using _observe = scopeProcessState({
        env: { MARINA_DREAMING: "on", MARINA_DREAM_JUDGE: undefined, MARINA_JUDGE: undefined },
      });
      material(now + 999);
      const filed = await runDream(db, "Ada", "command", {
        complete: stub(dreamOps()),
        model: "test/dreamer",
        now: now + 1000,
      });
      expect(filed.skipped ?? "none").toBe("none");
      expect(filed.proposals).toBe(1);
      expect(db.getNote(note(3))!.verification_status).toBe("unverified");
      await engine.processCommand(ada, `memory dream dismiss ${filed.id}`);
      await engine.processCommand(ada, `memory dream rollback ${filed.id}`);
    }
    {
      using _on = scopeProcessState({ env: { MARINA_DREAMING: "on", MARINA_DREAM_JUDGE: "on" } });
      material(now + 1999);
      const earned = await runDream(db, "Ada", "command", {
        complete: stub(dreamOps()),
        model: "test/dreamer",
        now: now + 2000,
      });
      expect(earned.state).toBe("applied");
      expect(earned.proposals).toBe(0);
      expect(earned.checks?.probesAfter).toEqual({ pass: 2, fail: 0 });
      const ops = JSON.parse(db.getDream(earned.id!)!.ops_json) as Array<Record<string, unknown>>;
      expect(ops[2]).toMatchObject({ op: "supersede", proposal: "earned" });
      expect((ops[2]!.applied as { kind: string }).kind).toBe("supersede");
      expect(db.getNote(note(3))!.verification_status).toBe("superseded");
      // An unearned model under the same switch still files.
      material(now + 2999);
      const other = await runDream(db, "Ada", "command", {
        complete: stub(
          JSON.stringify({
            ops: [
              {
                op: "supersede",
                id: note(6),
                text: "The staging proxy rejects requests lacking a tenant header",
                refs: [],
                reason: "y",
              },
            ],
          }),
        ),
        model: "test/other",
        now: now + 3000,
      });
      expect(other.proposals).toBe(1);
      // Rollback reverses the earned restatement like any other.
      await engine.processCommand(ada, `memory dream rollback ${earned.id}`);
      expect(db.getNote(note(3))!.verification_status).toBe("unverified");
    }
  });

  it("the guard: two consecutive drops hold the agent at observe; an operator clears it", async () => {
    using _state = scopeProcessState({ env: { MARINA_DREAMING: "on" } });
    // Ten successes before the first dream.
    for (let i = 0; i < GUARD_K; i++) outcome("Ada", true, now - (GUARD_K - i) * HOUR);
    material(now + 999);
    const d1 = await runDream(db, "Ada", "command", {
      complete: stub(dreamOps(false)),
      model: "test/dreamer",
      now: now + 1000,
    });
    expect(d1.skipped ?? "none").toBe("none");
    expect(d1.state).toBe("applied");
    // Too little work after it: nothing assessed yet.
    expect(assessDreams(db, now + 2000)).toEqual([]);
    // Ten outcomes after, mostly failures: a drop.
    for (let i = 0; i < GUARD_K; i++) outcome("Ada", i < 3, now + 2000 + i * 60_000);
    const [a1] = assessDreams(db, now + HOUR);
    expect(a1).toMatchObject({ dreamId: d1.id!, drop: true, before: { n: 10, rate: 1 } });
    expect(a1!.after.rate).toBeCloseTo(0.3);
    expect(guardState(db, "Ada")).toMatchObject({ consecutive: 1 });
    expect(guardState(db, "Ada").tripped).toBeUndefined();
    // A second dream and another drop: tripped.
    material(now + 2 * HOUR - 1);
    const d2 = await runDream(db, "Ada", "command", {
      complete: stub(
        JSON.stringify({
          ops: [{ op: "link", from: note(9), to: note(10), relation: "related_to", reason: "x" }],
        }),
      ),
      model: "test/dreamer",
      now: now + 2 * HOUR,
    });
    expect(d2.state).toBe("applied");
    for (let i = 0; i < GUARD_K; i++) outcome("Ada", false, now + 2 * HOUR + 1000 + i * 60_000);
    const assessed = assessDreams(db, now + 3 * HOUR);
    expect(assessed.map((a) => a.dreamId)).toEqual([d2.id!]);
    const state = guardState(db, "Ada");
    expect(state.consecutive).toBe(2);
    expect(state.tripped?.dreams).toEqual([d2.id!]);
    const alert = db.listOperationalAlerts().find((a) => a.alert_key === "memory-dream:guard:Ada");
    expect(alert?.status).toBe("open");
    expect(db.queryChronicle({ kind: "event" }).some((e) => e.title === "memory.dream.guard")).toBe(
      true,
    );
    // Held at observe: the next dream in `on` applies nothing.
    material(now + 4 * HOUR - 1);
    const d3 = await runDream(db, "Ada", "command", {
      complete: stub(
        JSON.stringify({
          ops: [{ op: "link", from: note(2), to: note(5), relation: "related_to", reason: "z" }],
        }),
      ),
      model: "test/dreamer",
      now: now + 4 * HOUR,
    });
    expect(d3.state).toBe("observed");
    expect(d3.mode).toBe("on");
    expect(d3.checks?.accepted).toBe(1);
    expect(db.getNoteLinks(note(2))).toHaveLength(0);
    conn.clear();
    await engine.processCommand(ada, "memory dream guard");
    expect(conn.lastText()).toContain("tripped");
    conn.clear();
    await engine.processCommand(ada, "memory dream brief");
    expect(conn.lastText()).toContain("dreaming is paused");
    // Clearing takes an operator; Ada (rank 0 under the shared profile) is refused.
    conn.clear();
    await engine.processCommand(ada, "memory dream guard clear Ada");
    expect(guardState(db, "Ada").tripped).toBeDefined();
    expect(clearGuard(db, "Ada")).toBe(true);
    expect(guardState(db, "Ada")).toMatchObject({ consecutive: 0 });
    expect(
      db.listOperationalAlerts("resolved").find((a) => a.alert_key === "memory-dream:guard:Ada")
        ?.status,
    ).toBe("resolved");
    expect(clearGuard(db, "Ada")).toBe(false);
    material(now + 5 * HOUR - 1);
    const d4 = await runDream(db, "Ada", "command", {
      complete: stub(
        JSON.stringify({
          ops: [{ op: "link", from: note(2), to: note(10), relation: "related_to", reason: "q" }],
        }),
      ),
      model: "test/dreamer",
      now: now + 5 * HOUR,
    });
    expect(d4.state).toBe("applied");
  });

  it("the measure splits applied dreams into discovery and holdout; the replay rebuilds probes", async () => {
    using _state = scopeProcessState({ env: { MARINA_DREAMING: "on" } });
    // Six applied dreams, each with K outcomes on both sides, success rising after each.
    let t = now - 100 * HOUR;
    const dreamIds: number[] = [];
    for (let i = 0; i < GUARD_K; i++) outcome("Ada", i % 2 === 0, (t += 60_000));
    for (let d = 0; d < 6; d++) {
      material(t + 60_000 - 1);
      const dream = await runDream(db, "Ada", "command", {
        complete: stub(
          JSON.stringify({
            ops: [
              { op: "link", from: note(d), to: note(d + 1), relation: "related_to", reason: "r" },
            ],
          }),
        ),
        model: "test/dreamer",
        now: (t += 60_000),
      });
      expect(dream.state).toBe("applied");
      dreamIds.push(dream.id!);
      for (let i = 0; i < GUARD_K; i++) outcome("Ada", i < 9, (t += 60_000));
    }
    const effect = dreamEffect(db, { owner: "Ada" });
    expect(effect.applied).toBe(6);
    expect(effect.measured).toBe(6);
    expect(effect.discovery.dreams).toBe(3);
    expect(effect.holdout.dreams).toBe(3);
    expect(effect.holdout.after.rate).toBeCloseTo(0.9);
    expect(["insufficient", "no change", "wins"]).toContain(effect.verdict);
    expect(dreamEffect(db, { owner: "Bea" }).measured).toBe(0);
    conn.clear();
    await engine.processCommand(ada, "memory dream measure");
    expect(conn.lastText()).toContain("holdout");
    expect(conn.lastText()).toContain("6 of 6 applied dream(s) measurable");
    conn.clear();
    await engine.processCommand(ada, "memory dream measure all");
    expect(conn.lastText()).toMatch(/operator|rank/i);

    // The offline replay: no probes (links take nothing out), ops re-checked, region hashes match.
    const replays = replayDreams(db);
    expect(replays).toHaveLength(6);
    expect(replays.every((r) => r.ops.stillAccepted === 1 && r.ops.rechecked === 1)).toBe(true);
    // A dream with a merge has a probe; replay it after the duplicate changed.
    material(t + HOUR - 1);
    const merged = await runDream(db, "Ada", "command", {
      complete: stub(
        JSON.stringify({
          ops: [{ op: "merge", keep: note(0), into: [note(1)], reason: "same" }],
        }),
      ),
      model: "test/dreamer",
      now: t + HOUR,
    });
    expect(merged.state).toBe("applied");
    const [latest] = replayDreams(db);
    expect(latest!.id).toBe(merged.id!);
    expect(latest!.probes).toMatchObject({ total: 1, intact: 1, drifted: 0, gone: 0, passNow: 1 });
    expect(latest!.recorded.after).toEqual({ pass: 1, fail: 0 });
  });
});
