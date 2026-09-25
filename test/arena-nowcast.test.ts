// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { ArenaData } from "../src/arena/data";
import { forecastRound } from "../src/arena/forecast";
import {
  CIVIQS_SERIES,
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
});
