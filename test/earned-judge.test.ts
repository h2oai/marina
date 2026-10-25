// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One earned-judge rule and one agreement tally, used by the outcome judges,
 * the challenge judge and `decision agreement`.
 */

import { describe, expect, it } from "bun:test";
import {
  EARNED_JUDGE_MIN_LOWER,
  EARNED_JUDGE_MIN_N,
  earnedJudge,
} from "../src/decisions/earned-judge";
import { judgeEarned, judgeStandings } from "../src/decisions/judges";
import { EARNED_MIN_N, EARNED_MIN_PRECISION, listJudgeRecords } from "../src/engine/challenges";
import { EARNED_MIN_COMPARED, EARNED_MIN_LOWER } from "../src/outcomes/agreement";
import { MarinaDB } from "../src/persistence/database";
import { wilsonInterval } from "../src/stats";

describe("earnedJudge", () => {
  it("is the one threshold every judge surface re-exports", () => {
    expect([EARNED_MIN_COMPARED, EARNED_MIN_N]).toEqual([EARNED_JUDGE_MIN_N, EARNED_JUDGE_MIN_N]);
    expect([EARNED_MIN_LOWER, EARNED_MIN_PRECISION]).toEqual([
      EARNED_JUDGE_MIN_LOWER,
      EARNED_JUDGE_MIN_LOWER,
    ]);
    expect(EARNED_JUDGE_MIN_N).toBe(25);
    expect(EARNED_JUDGE_MIN_LOWER).toBe(0.85);
  });

  it("needs both enough comparisons and a high enough Wilson lower bound", () => {
    expect(earnedJudge(0, 0)).toEqual({ lower: 0, earned: false });
    expect(earnedJudge(24, 24).earned).toBe(false); // too few, however perfect
    expect(earnedJudge(25, 25).earned).toBe(true);
    expect(earnedJudge(25, 30).earned).toBe(false);
    expect(earnedJudge(30, 30).lower).toBe(wilsonInterval(30, 30).low);
  });

  it("matches the outcome path's former rule exactly on a grid", () => {
    for (let n = 0; n <= 400; n++)
      for (let k = 0; k <= n; k++) {
        const lower = n ? wilsonInterval(k, n).low : 0;
        const got = earnedJudge(k, n);
        expect(got.lower).toBe(lower);
        expect(got.earned).toBe(n >= 25 && lower >= 0.85);
      }
  });

  it("decides like the challenge judge's former 1.96 rule for every n ≤ 2000", () => {
    // The challenge gate used z = 1.96 (vs 1.959964 here). The verdicts agree
    // for every k ≤ n ≤ 2000; the first difference is at n = 2381, where the
    // two lower bounds straddle 0.85 by < 3e-7.
    const legacy = (k: number, n: number) => {
      if (n === 0) return 0;
      const z = 1.96;
      const p = k / n;
      const denom = 1 + (z * z) / n;
      const centre = p + (z * z) / (2 * n);
      const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
      return Math.max(0, (centre - margin) / denom);
    };
    let differ = 0;
    for (let n = 25; n <= 2000; n++)
      for (let k = Math.floor(0.8 * n); k <= n; k++)
        if (earnedJudge(k, n).earned !== legacy(k, n) >= 0.85) differ++;
    expect(differ).toBe(0);
  });

  it("the ledger tallies agreement, false passes and false fails", () => {
    const db = new MarinaDB(":memory:");
    const rows: ["pass" | "fail", "pass" | "fail", boolean?][] = [
      ["pass", "pass"],
      ["pass", "fail"],
      ["fail", "pass"],
      ["fail", "fail"],
      ["pass", "pass", false], // a judged forecast with a different truth
    ];
    rows.forEach(([opinion, truth, agreed], i) => {
      db.recordJudgeOpinion({
        surface: "outcome",
        judge: "j",
        subject: `s:${i}`,
        opinion,
        truth,
        ...(agreed === undefined ? {} : { agreed }),
        opinedAt: i,
      });
    });
    expect(judgeStandings(db, { surface: "outcome" })[0]).toMatchObject({
      compared: 5,
      agreed: 2,
      falsePass: 1,
      falseFail: 1,
    });
    db.close();
  });
});

describe("every judge surface uses it", () => {
  const ledger = (
    surface: string,
    rows: { opinion: "pass" | "fail"; truth: "pass" | "fail" }[],
  ) => {
    const db = new MarinaDB(":memory:");
    rows.forEach((r, i) => {
      db.recordJudgeOpinion({
        surface,
        question: surface === "challenge" ? "agent.spawn" : "",
        judge: "chat-classifier:m",
        subject: `s:${i}`,
        opinion: r.opinion,
        truth: r.truth,
        opinedAt: i,
      });
    });
    return db;
  };

  it("the challenge judge's precision of allow", () => {
    const db = ledger(
      "challenge",
      Array.from({ length: 30 }, (_, i) => ({
        opinion: "pass" as const,
        truth: i < 29 ? ("pass" as const) : ("fail" as const),
      })),
    );
    const [rec] = listJudgeRecords(db);
    expect(rec).toMatchObject({
      allowSaid: 30,
      allowApproved: 29,
      earned: earnedJudge(29, 30).earned,
    });
    expect(rec!.precisionLower).toBe(earnedJudge(29, 30).lower);
    db.close();
  });

  it("`decision agreement` (the verify surface) reports the same lower bound and verdict", () => {
    const db = ledger(
      "verify",
      Array.from({ length: 30 }, (_, i) => ({
        opinion: "pass" as const,
        truth: i < 28 ? ("pass" as const) : ("fail" as const),
      })),
    );
    const [a] = judgeStandings(db, { surface: "verify" });
    expect(a).toMatchObject({ compared: 30, agreed: 28, falsePass: 2, falseFail: 0 });
    expect(a).toMatchObject(earnedJudge(28, 30));
    expect(judgeEarned(db, "verify", "chat-classifier:m")).toBe(earnedJudge(28, 30).earned);
    db.close();
  });
});
