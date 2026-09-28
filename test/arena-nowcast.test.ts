// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { ArenaData } from "../src/arena/data";
import { forecastRound } from "../src/arena/forecast";
import {
  CIVIQS_SERIES,
  civiqsDailySeries,
  civiqsDir,
  civiqsNowcast,
  nowcastForecaster,
} from "../src/arena/research/civiqs-nowcast";
import type { ArenaLock, ArenaRound } from "../src/arena/types";

const approvalSnap = (endDate: string, approve: number, disapprove: number, fetchedAt: string) => ({
  choices: ["Approve", "Disapprove", "Neither approve nor disapprove"],
  end_date: endDate,
  fetched_at: fetchedAt,
  points: [
    ["2026-09-20", 36, 60, 4],
    [endDate, approve, disapprove, 4],
  ],
});

function dataWith(files: Record<string, unknown>) {
  return new ArenaData("https://example.test", async (url) => {
    const path = url.replace("https://example.test/", "");
    return path in files ? Response.json(files[path]) : new Response("", { status: 404 });
  });
}

const round: ArenaRound = {
  round_id: "civiqs-2026-w40-approval",
  tracker: "civiqs",
  series: "civiqs_net_approval",
  question: "Net approval?",
  target_type: "continuous_normal",
  lock_at: "2026-09-30T14:00:00Z",
  release_at: "2026-10-02T14:00:00Z",
};
const history = Array.from({ length: 30 }, (_, i) => ({
  date: new Date(Date.parse("2026-03-06") + i * 7 * 86_400_000).toISOString().slice(0, 10),
  value: -24 - (i % 2) * 0.3,
}));
const lock: ArenaLock = { round_id: round.round_id, answer_history: history };

describe("Civiqs nowcast", () => {
  it("names archive directories exactly as the arena does", () => {
    expect(civiqsDir(CIVIQS_SERIES.civiqs_net_approval!)).toBe("approve_president_trump_2025");
    expect(civiqsDir(CIVIQS_SERIES.civiqs_net_approval_age_65_up!)).toBe(
      "approve_president_trump_2025.age-65_",
    );
    expect(civiqsDir(CIVIQS_SERIES.civiqs_net_approval_race_hispanic!)).toBe(
      "approve_president_trump_2025.race-Hispanic_Latino",
    );
    expect(civiqsDir(CIVIQS_SERIES.civiqs_net_approval_race_black!)).toBe(
      "approve_president_trump_2025.race-Black_or_African-American",
    );
  });

  it("reads the freshest daily net from the latest snapshot fetched before the lock", async () => {
    const data = dataWith({
      "civiqs/approve_president_trump_2025/2026-09-29.json": approvalSnap(
        "2026-09-28",
        37,
        61,
        "2026-09-29T10:00:00Z",
      ),
      // Dated the lock day but fetched AFTER the lock: must be ignored.
      "civiqs/approve_president_trump_2025/2026-09-30.json": approvalSnap(
        "2026-09-29",
        40,
        55,
        "2026-09-30T16:00:00Z",
      ),
    });
    const n = await civiqsNowcast(data, round);
    expect(n).toMatchObject({
      date: "2026-09-28",
      value: -24,
      snapshot: expect.stringContaining("2026-09-29"),
    });
  });

  it("computes declared nets and single-choice shares", async () => {
    const econ: ArenaRound = { ...round, series: "civiqs_net_econ_now" };
    const angry: ArenaRound = { ...round, series: "civiqs_angry_share" };
    const data = dataWith({
      "civiqs/economy_us_now/2026-09-29.json": {
        choices: ["Very good", "Fairly good", "Fairly bad", "Very bad", "Unsure"],
        fetched_at: "2026-09-29T01:00:00Z",
        points: [["2026-09-28", 5, 20, 30, 40, 5]],
      },
      "civiqs/describe_feeling_us/2026-09-29.json": {
        choices: ["Angry", "Hopeful"],
        fetched_at: "2026-09-29T01:00:00Z",
        points: [["2026-09-28", 29.4, 20]],
      },
    });
    expect((await civiqsNowcast(data, econ))?.value).toBe(-45);
    expect((await civiqsNowcast(data, angry))?.value).toBe(29.4);
    expect(await civiqsNowcast(data, { ...round, series: "not_civiqs" })).toBeUndefined();
  });

  it("moves the baseline's mean only when the daily reading is newer than the history", async () => {
    const data = dataWith({
      "civiqs/approve_president_trump_2025/2026-09-29.json": approvalSnap(
        "2026-09-28",
        37,
        62,
        "2026-09-29T10:00:00Z",
      ),
    });
    const forecast = nowcastForecaster(data, forecastRound);
    const f = await forecast(round, lock);
    expect(f.topline!.mean).toBe(-25);
    expect(f.topline!.sd).toBe(forecastRound(round, lock).topline!.sd);
    const stale = await forecast(round, {
      ...lock,
      answer_history: [...history, { date: "2026-09-29", value: -26 }],
    });
    expect(stale.topline!.mean).toBe(-26);
    const other = await forecast(
      { ...round, tracker: "economist_yougov", series: "yougov_rv_approval" },
      lock,
    );
    expect(other.topline).toEqual(forecastRound(round, lock).topline);
  });

  it("returns the recent daily series from the archive only, for a lock that has passed", async () => {
    const past: ArenaRound = { ...round, lock_at: "2026-09-27T14:00:00Z" };
    const data = dataWith({
      "civiqs/approve_president_trump_2025/2026-09-26.json": approvalSnap(
        "2026-09-25",
        37,
        61,
        "2026-09-26T10:00:00Z",
      ),
      // Fetched after the lock: a backtest must not see it.
      "civiqs/approve_president_trump_2025/2026-09-27.json": approvalSnap(
        "2026-09-26",
        40,
        55,
        "2026-09-27T16:00:00Z",
      ),
    });
    let liveCalls = 0;
    const live = async () => {
      liveCalls++;
      return {
        choices: ["Approve", "Disapprove"],
        url: "https://civiqs.test",
        points: [["2026-09-30", 50, 40]] as Array<[string, ...number[]]>,
      };
    };
    const d = await civiqsDailySeries(data, past, { live });
    expect(liveCalls).toBe(0); // lock in the past ⇒ archive only
    expect(d).toEqual({
      series: "civiqs_net_approval",
      source: "civiqs/approve_president_trump_2025/2026-09-26.json",
      points: [
        { date: "2026-09-20", value: -24 },
        { date: "2026-09-25", value: -24 },
      ],
    });
    expect((await civiqsDailySeries(data, past, { days: 1 }))?.points).toEqual([
      { date: "2026-09-25", value: -24 },
    ]);
    expect(await civiqsDailySeries(data, { ...past, series: "yougov_x" })).toBeUndefined();
  });

  it("reads the live dashboard for an open round when it is at least as fresh", async () => {
    const open: ArenaRound = {
      ...round,
      lock_at: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const today = new Date().toISOString().slice(0, 10);
    const data = dataWith({});
    const d = await civiqsDailySeries(data, open, {
      live: async () => ({
        choices: ["Approve", "Disapprove"],
        url: "https://civiqs.test/x",
        points: [[today, 41, 55]] as Array<[string, ...number[]]>,
      }),
    });
    expect(d?.source).toBe("live:https://civiqs.test/x");
    expect(d?.points).toEqual([{ date: today, value: -14 }]);
  });

  it("the nowcast forecaster attaches the daily series only when asked", async () => {
    const past: ArenaRound = { ...round, lock_at: "2026-09-30T14:00:00Z" };
    const data = dataWith({
      "civiqs/approve_president_trump_2025/2026-09-29.json": approvalSnap(
        "2026-09-28",
        37,
        62,
        "2026-09-29T10:00:00Z",
      ),
    });
    const plain = await nowcastForecaster(data, forecastRound)(past, lock);
    expect("daily" in plain).toBe(false);
    const withDaily = (await nowcastForecaster(data, forecastRound, { daily: 21 })(past, lock)) as {
      daily?: { points: unknown[] };
      topline?: { mean: number };
    };
    expect(withDaily.topline!.mean).toBe(-25);
    expect(withDaily.daily?.points).toHaveLength(2);
  });
});
