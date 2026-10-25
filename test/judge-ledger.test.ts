// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One judge service: every surface writes the one ledger, the backfill copies
 * older rows idempotently, `judgeEarned` is `earnedJudge` over the ledger,
 * `MARINA_JUDGE` sets every surface under the legacy overrides, and
 * `judge stats` reads it all — with no model provider too.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { judgeEarned as attentionEarned, attentionJudgeMode } from "../src/agent/attention-judge";
import { earnedJudge } from "../src/decisions/earned-judge";
import {
  judgeEarned,
  judgeModeFor,
  judgeStandings,
  moreNeededAtRate,
} from "../src/decisions/judges";
import { decisionVerifyMode, decisionVerifyNeedsEarned } from "../src/decisions/verify";
import { judgeMode as challengeJudgeMode } from "../src/engine/challenges";
import { judgeCommand, judgeStatsLines } from "../src/engine/commands/judge";
import { judgeAgreement } from "../src/outcomes/agreement";
import { noteArbiterOverrule } from "../src/outcomes/deliver";
import { judgeWaitingWork } from "../src/outcomes/judge-quality";
import { judgeResolutionMode } from "../src/outcomes/judge-resolution";
import { recordTaskVerdict, recordVerifierOpinion } from "../src/outcomes/live";
import { recordResolved, settleDelivery } from "../src/outcomes/record";
import { MarinaDB } from "../src/persistence/database";
import { stripAnsi } from "./helpers";
import { noProviderEnv } from "./hermetic-env";
import { scopeProcessState } from "./process-state";

const raw = (db: MarinaDB) => (db as unknown as { db: Database }).db;

let db: MarinaDB;
beforeEach(() => {
  db = new MarinaDB(":memory:");
});
afterEach(async () => {
  await settleDelivery(db);
  db.close();
});

const verifier = (
  taskId: number,
  opinion: "pass" | "fail" | "none",
  at: number,
  evaluator = "x:jev",
) =>
  recordVerifierOpinion(
    db,
    {
      taskId,
      claimantName: "Ada",
      evaluator,
      calibrated: evaluator !== "chat-classifier:m",
      mode: "observe",
      opinion,
      signals: {},
    },
    at,
  );

describe("every surface writes the one ledger", () => {
  it("verify: the verifier's table, the ledger and the outcome path; settled by the creator's verdict", () => {
    verifier(1, "fail", 10);
    verifier(1, "pass", 20); // the resubmission's opinion replaces the first
    recordTaskVerdict(db, { taskId: 1, claimant: "Ada", approved: true, at: 30 });
    verifier(2, "pass", 10);
    recordTaskVerdict(db, { taskId: 2, claimant: "Ada", approved: false, at: 30 });
    verifier(3, "none", 10);
    verifier(4, "fail", 10); // no verdict yet
    verifier(1, "fail", 20, "local:openjev");
    recordTaskVerdict(db, { taskId: 1, claimant: "Ada", approved: true, at: 31 });
    verifier(1, "pass", 20, "chat-classifier:m");

    expect(db.listJudgeObservations()).toHaveLength(7);
    const [jev] = judgeStandings(db, { surface: "verify", judge: "x:jev" });
    expect(jev).toMatchObject({
      compared: 2,
      agreed: 1,
      falsePass: 1,
      falseFail: 0,
      noOpinion: 1,
      awaiting: 1,
      calibrated: true,
    });
    const [local] = judgeStandings(db, { surface: "verify", judge: "local:openjev" });
    expect(local).toMatchObject({ compared: 1, falseFail: 1 });
    const [chat] = judgeStandings(db, { surface: "verify", judge: "chat-classifier:m" });
    expect(chat?.calibrated).toBe(false);
    // The same opinions on the outcome path (`outcome agreement`).
    expect(judgeStandings(db, { surface: "outcome", judge: "x:jev" })[0]?.opinions).toBe(4);
  });

  it("attention: a judged request outcome, settled by its mechanical result", () => {
    recordResolved(db, {
      subject: "judged:attention:wake:Ada:tell:1",
      kind: "request",
      source: "attention-judge:attention-wake",
      domain: "attention",
      succeeded: true,
      basis: "judged",
      judge: "attention-wake:m",
      resolvedAt: 10,
    });
    recordResolved(db, {
      subject: "attention:wake:Ada:tell:1",
      kind: "request",
      source: "attention-judge:attention-wake",
      domain: "attention",
      succeeded: true,
      basis: "mechanical",
      resolvedAt: 20,
    });
    const [row] = db.listJudgeLedger({ surface: "attention:attention-wake" });
    expect(row).toMatchObject({
      judge: "attention-wake:m",
      opinion: "pass",
      truth: "pass",
      agreed: 1,
    });
    expect(attentionEarned(db, "attention-wake:m")).toBe(false);
    expect(judgeAgreement(db, { judge: "attention-wake:m" })[0]).toMatchObject({
      compared: 1,
      agreed: 1,
    });
  });

  it("outcome: a judged forecast resolution settles at once when the market already resolved it, by value", () => {
    recordResolved(db, {
      subject: "forecast:7",
      kind: "forecast",
      source: "forecast:choice",
      domain: "forecast",
      succeeded: true,
      truth: { options: ["b"] },
      basis: "mechanical",
      resolvedAt: 5,
    });
    recordResolved(db, {
      subject: "judged:forecast:7",
      kind: "forecast",
      source: "forecast:choice",
      domain: "forecast",
      succeeded: true,
      truth: { options: ["a"] },
      basis: "judged",
      judge: "j:m",
      resolvedAt: 10,
    });
    const [row] = db.listJudgeLedger({ surface: "outcome" });
    expect(row).toMatchObject({ truth: "pass", agreed: 0 }); // same success flag, different option
    expect(judgeAgreement(db)[0]).toMatchObject({ judge: "j:m", compared: 1, agreed: 0 });
  });

  it("arbiter: an overrule scored by the truth", () => {
    const answer = {
      answer: { type: "choice" as const, options: [{ id: "a" }, { id: "b" }] },
      arbiter: {
        applied: false,
        result: {
          status: "adjudicated",
          evaluator: "arbiter:m",
          disagreement: { majority: "a" },
          bar: { verdict: "overrule", answer: "b" },
        },
      },
    } as never;
    noteArbiterOverrule(db, "forecast:1", answer, { options: ["b"] }, 100);
    noteArbiterOverrule(db, "forecast:2", answer, { options: ["a"] }, 100);
    const [s] = judgeStandings(db, { surface: "arbiter" });
    expect(s).toMatchObject({
      judge: "arbiter:m",
      compared: 2,
      agreed: 1,
      rule: "arbiter-precision",
    });
    expect(s?.earned).toBe(false); // 2 < MARINA_ARBITER_EARN_MIN_RESOLVED
  });
});

describe("the backfill", () => {
  it("copies challenge_outcomes, judge_observations and judged outcomes idempotently, leaving them unchanged", () => {
    const sqlite = raw(db);
    const challenge = (
      token: string,
      answer: "once" | "deny" | "expired",
      opinion: "allow" | "hold",
      role = "admin",
    ) =>
      db.recordChallengeOutcome({
        token,
        kind: "gate",
        class: "agent.spawn",
        requesterName: "Jay",
        summary: "s",
        reason: "r",
        answer,
        answeredBy: role === "judge" ? "judge" : "Root",
        answeredRole: role as "admin",
        judgeOpinion: opinion,
        createdAt: 1,
      });
    challenge("ch_1", "once", "allow");
    challenge("ch_2", "deny", "allow");
    challenge("ch_3", "deny", "hold");
    challenge("ch_4", "expired", "allow"); // no truth: skipped
    challenge("ch_5", "once", "allow", "judge"); // the judge's own approval: skipped
    const task = db.createTask({ title: "t", creatorId: "e_c", creatorName: "Cy" });
    db.createTaskClaim(task, "e_a", "Ada");
    db.updateTaskClaimStatus(task, "e_a", "approved");
    db.recordJudgeObservation({
      taskId: task,
      claimantName: "Ada",
      evaluator: "x:jev",
      calibrated: true,
      mode: "observe",
      opinion: "fail",
      signals: {},
    });
    db.recordJudgeObservation({
      taskId: task,
      claimantName: "Ada",
      evaluator: "x:jev",
      calibrated: true,
      mode: "observe",
      opinion: "pass",
      signals: {},
    });
    db.recordOutcomeRow(
      {
        subject: "judged:task:9:Ada:10",
        kind: "task",
        source: "task:verdict",
        domain: "tools",
        succeeded: true,
        basis: "judged",
        judge: "j:m",
        resolvedAt: 10,
        now: 10,
      },
      [],
    );
    db.recordOutcomeRow(
      {
        subject: "task:9:Ada:20",
        kind: "task",
        source: "task:verdict",
        domain: "tools",
        succeeded: false,
        basis: "mechanical",
        resolvedAt: 20,
        now: 20,
      },
      [],
    );
    // A database from before the ledger: nothing in it yet.
    sqlite.run("DELETE FROM judge_ledger");
    const counts = () =>
      ["challenge_outcomes", "judge_observations", "outcomes", "judge_ledger"].map(
        (t) => (sqlite.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n,
      );
    const snapshot = () =>
      sqlite.query("SELECT * FROM judge_ledger ORDER BY surface, subject").all();
    db.backfillJudgeLedger();
    const once = { counts: counts(), rows: snapshot() };
    db.backfillJudgeLedger();
    expect(counts()).toEqual(once.counts);
    expect(snapshot()).toEqual(once.rows);
    expect(once.counts.slice(0, 3)).toEqual([5, 2, 2]);

    const challenges = judgeStandings(db, { surface: "challenge" });
    expect(challenges).toEqual([
      expect.objectContaining({
        question: "agent.spawn",
        judge: "unknown",
        opinions: 3,
        compared: 2,
        agreed: 1,
      }),
    ]);
    expect(judgeStandings(db, { surface: "verify" })[0]).toMatchObject({
      opinions: 1,
      compared: 1,
      agreed: 1,
    });
    expect(judgeStandings(db, { surface: "outcome" })[0]).toMatchObject({
      judge: "j:m",
      compared: 1,
      falsePass: 1,
    });
  });
});

describe("judgeEarned is earnedJudge over the ledger", () => {
  it("agrees on a grid of fixtures, and earns only from opinions with a truth", () => {
    for (const [agreed, compared] of [
      [0, 0],
      [24, 24],
      [25, 25],
      [25, 30],
      [29, 30],
      [40, 42],
      [60, 70],
    ] as const) {
      const fresh = new MarinaDB(":memory:");
      for (let i = 0; i < compared; i++)
        fresh.recordJudgeOpinion({
          surface: "verify",
          judge: "x:m",
          subject: `task:${i}:Ada`,
          opinion: "pass",
          truth: i < agreed ? "pass" : "fail",
          opinedAt: i,
        });
      // Opinions still waiting for a truth never count.
      for (let i = 0; i < 50; i++)
        fresh.recordJudgeOpinion({
          surface: "verify",
          judge: "x:m",
          subject: `w:${i}`,
          opinion: "pass",
          opinedAt: i,
        });
      expect(judgeEarned(fresh, "verify", "x:m")).toBe(earnedJudge(agreed, compared).earned);
      const [s] = judgeStandings(fresh, { surface: "verify" });
      if (s) expect(s.lower).toBe(earnedJudge(agreed, compared).lower);
      fresh.close();
    }
  });

  it("is counted per surface, judge and (challenges) class — never pooled", () => {
    for (let i = 0; i < 30; i++) {
      db.recordJudgeOpinion({
        surface: "challenge",
        question: "agent.spawn",
        judge: "x:m",
        subject: `c:${i}`,
        opinion: "pass",
        truth: "pass",
        opinedAt: i,
      });
    }
    expect(judgeEarned(db, "challenge", "x:m", { question: "agent.spawn" })).toBe(true);
    expect(judgeEarned(db, "challenge", "x:m", { question: "role.edit" })).toBe(false);
    expect(judgeEarned(db, "challenge", "y:m", { question: "agent.spawn" })).toBe(false);
    expect(judgeEarned(db, "verify", "x:m")).toBe(false);
  });

  it("estimates how many more agreeing observations are needed", () => {
    expect(moreNeededAtRate(25, 25)).toBe(0);
    expect(moreNeededAtRate(0, 0)).toBe(25);
    expect(moreNeededAtRate(10, 10)).toBe(15);
    expect(moreNeededAtRate(5, 10)).toBeUndefined(); // 50 % never reaches the bar
    const n = moreNeededAtRate(19, 20)!;
    expect(earnedJudge(19 + 0.95 * n, 20 + n).earned).toBe(true);
    expect(earnedJudge(19 + 0.95 * (n - 1), 20 + n - 1).earned).toBe(false);
  });
});

describe("one flag: MARINA_JUDGE under the legacy overrides", () => {
  const LEGACY = [
    "MARINA_JUDGE",
    "MARINA_CHALLENGE_JUDGE",
    "MARINA_DECISION_VERIFY",
    "MARINA_ATTENTION_JUDGE",
    "MARINA_OUTCOME_JUDGE",
    "MARINA_AUTONOMY",
  ];
  const clean = Object.fromEntries(LEGACY.map((k) => [k, undefined]));

  it("no flags: every surface keeps today's default", () => {
    using _ = scopeProcessState({ env: clean });
    expect([
      challengeJudgeMode(),
      decisionVerifyMode(),
      attentionJudgeMode(),
      judgeResolutionMode(),
    ]).toEqual(["observe", "observe", "observe", "off"]);
    expect(decisionVerifyNeedsEarned()).toBe(false);
    for (const s of ["challenge", "verify", "attention", "outcome"] as const)
      expect(judgeModeFor(s).from).toBe("default");
  });

  it("MARINA_JUDGE sets every surface", () => {
    for (const mode of ["off", "observe", "on"] as const) {
      using _ = scopeProcessState({ env: { ...clean, MARINA_JUDGE: mode } });
      expect(challengeJudgeMode()).toBe(mode);
      expect(attentionJudgeMode()).toBe(mode);
      expect(judgeResolutionMode()).toBe(mode);
      expect(decisionVerifyMode()).toBe(mode);
    }
    {
      // Verify keeps its posture rule: `on` acts only under `guarded`.
      using _ = scopeProcessState({
        env: { ...clean, MARINA_JUDGE: "on", MARINA_AUTONOMY: "earned" },
      });
      expect(decisionVerifyMode()).toBe("observe");
    }
    using _ = scopeProcessState({
      env: { ...clean, MARINA_JUDGE: "on", MARINA_AUTONOMY: "guarded" },
    });
    expect(decisionVerifyMode()).toBe("on");
    expect(decisionVerifyNeedsEarned()).toBe(true); // the one flag lets only an earned verifier bounce
  });

  it("a set legacy variable wins for its surface, parsed exactly as before", () => {
    using _ = scopeProcessState({
      env: {
        ...clean,
        MARINA_JUDGE: "on",
        MARINA_CHALLENGE_JUDGE: "off",
        MARINA_ATTENTION_JUDGE: "junk", // junk meant observe before, and still does
        MARINA_OUTCOME_JUDGE: "junk", // junk meant off before, and still does
        MARINA_DECISION_VERIFY: "on",
        MARINA_AUTONOMY: "guarded",
      },
    });
    expect(challengeJudgeMode()).toBe("off");
    expect(attentionJudgeMode()).toBe("observe");
    expect(judgeResolutionMode()).toBe("off");
    expect(decisionVerifyMode()).toBe("on");
    expect(decisionVerifyNeedsEarned()).toBe(false); // the legacy `on` keeps its old meaning
    expect(judgeModeFor("challenge")).toEqual({
      mode: "off",
      from: "legacy",
      variable: "MARINA_CHALLENGE_JUDGE",
    });
  });

  it("junk in MARINA_JUDGE is ignored", () => {
    using _ = scopeProcessState({ env: { ...clean, MARINA_JUDGE: "maybe" } });
    expect(judgeModeFor("outcome")).toEqual({ mode: "off", from: "default" });
    expect(challengeJudgeMode()).toBe("observe");
  });
});

describe("judge stats", () => {
  it("shows every surface and judge with n, agreement, lower bound, earned and what it needs", () => {
    for (let i = 0; i < 25; i++)
      db.recordJudgeOpinion({
        surface: "verify",
        judge: "x:jev",
        subject: `t:${i}`,
        opinion: "pass",
        truth: "pass",
        opinedAt: i,
      });
    for (let i = 0; i < 10; i++)
      db.recordJudgeOpinion({
        surface: "challenge",
        question: "agent.spawn",
        judge: "x:jev",
        subject: `c:${i}`,
        opinion: "pass",
        truth: "pass",
        opinedAt: i,
      });
    const all = stripAnsi(judgeStatsLines(db, { backend: "x:jev" }).join("\n"));
    expect(all).toContain("backend: x:jev");
    expect(all).toMatch(/verify x:jev\s+n 25 · agreed 100% · lower \d+% · earned/);
    expect(all).toMatch(
      /challenge\/agent\.spawn x:jev\s+n 10 · agreed 100% · lower \d+% · not earned · needs ~15 more/,
    );
    const one = stripAnsi(
      judgeStatsLines(db, { surface: "challenge", backend: "x:jev" }).join("\n"),
    );
    expect(one).not.toContain("verify x:jev");
  });

  it("with no model provider: no judge calls, nothing throws, and the readout says so", async () => {
    using _ = scopeProcessState({ env: { ...noProviderEnv(), MARINA_JUDGE: "on" } });
    const text = stripAnsi(judgeStatsLines(db, {}).join("\n"));
    expect(text).toContain("no judge backend");
    expect(text).toContain("No judge opinions recorded yet.");
    const report = await judgeWaitingWork(db);
    expect(report).toMatchObject({ judged: 0, stoppedBy: "no decision backend" });
    const sent: string[] = [];
    const cmd = judgeCommand({ store: () => db, backend: () => undefined });
    await cmd.handler(
      { send: (_id: string, m: string) => sent.push(m) } as never,
      {
        entity: "e_1",
        args: "stats",
      } as never,
    );
    expect(stripAnsi(sent.join("\n"))).toContain("no judge backend");
  });
});
