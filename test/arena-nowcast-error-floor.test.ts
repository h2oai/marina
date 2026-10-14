// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { ArenaData } from "../src/arena/data";
import { forecastRound, type RoundForecast } from "../src/arena/forecast";
import { atLeastNarrowestProposal } from "../src/arena/formations";
import { nowcastErrorFloor, nowcastForecaster } from "../src/arena/research/civiqs-nowcast";
import { applyErrorFloor } from "../src/arena/submit";
import type { ArenaLock, ArenaRound } from "../src/arena/types";

const DIR = "civiqs/describe_feeling_us";

/** An angry-share snapshot whose last daily reading is `value` on `endDate`. */
const snap = (endDate: string, value: number, fetchedAt: string) => ({
  choices: ["Angry", "Hopeful"],
  end_date: endDate,
  fetched_at: fetchedAt,
  points: [
    ["2026-08-01", 29, 16],
    [endDate, value, 16],
  ],
});

function dataWith(files: Record<string, unknown>) {
  return new ArenaData("https://example.test", async (url) => {
    const path = url.replace("https://example.test/", "");
    return path in files ? Response.json(files[path]) : new Response("", { status: 404 });
  });
}

// Weekly (Friday) history: …, 09-18 29.5, 09-25 29.6, 10-02 29.5.
const history = [
  ...Array.from({ length: 20 }, (_, i) => ({
    date: new Date(Date.parse("2026-04-24") + i * 7 * 86_400_000).toISOString().slice(0, 10),
    value: 29.5,
  })),
  { date: "2026-09-18", value: 29.5 },
  { date: "2026-09-25", value: 29.6 },
  { date: "2026-10-02", value: 29.5 },
];

// Each week's Wednesday-lock nowcast read a level the next model run revised away.
const archive = {
  [`${DIR}/2026-09-16.json`]: snap("2026-09-15", 30.2, "2026-09-16T06:00:00Z"),
  [`${DIR}/2026-09-23.json`]: snap("2026-09-22", 29.8, "2026-09-23T06:00:00Z"),
  [`${DIR}/2026-09-30.json`]: snap("2026-09-29", 29.6, "2026-09-30T06:00:00Z"),
  // Dated a lock day but fetched AFTER that lock: never that week's nowcast.
  [`${DIR}/2026-10-01.json`]: snap("2026-09-30", 35, "2026-10-01T06:00:00Z"),
  [`${DIR}/2026-10-07.json`]: snap("2026-10-06", 29.8, "2026-10-07T06:00:00Z"),
};

const round: ArenaRound = {
  round_id: "civiqs-2026-w41-angry-share",
  tracker: "civiqs",
  series: "civiqs_angry_share",
  question: "Angry share?",
  target_type: "continuous_normal",
  lock_at: "2026-10-07T14:00:00Z",
  release_at: "2026-10-09T14:00:00Z",
};
const lock: ArenaLock = { round_id: round.round_id, answer_history: history };

describe("measured nowcast error floor", () => {
  it("measures each Friday against that week's lock-time nowcast, shrunk toward sd0", async () => {
    const floor = await nowcastErrorFloor(
      dataWith(archive),
      "civiqs_angry_share",
      history,
      round.lock_at,
      0.15,
    );
    expect(floor?.errors).toEqual([
      { date: "2026-09-18", error: -0.7 },
      { date: "2026-09-25", error: -0.2 },
      { date: "2026-10-02", error: -0.1 },
    ]);
    expect(floor?.n).toBe(3);
    const ms = (0.49 + 0.04 + 0.01) / 3;
    expect(floor?.rms).toBeCloseTo(Math.sqrt(ms), 3);
    expect(floor?.sd).toBeCloseTo(Math.sqrt((3 * ms + 2 * 0.15 ** 2) / 5), 3);
  });

  it("gives no floor on fewer than three measured weeks", async () => {
    const { [`${DIR}/2026-09-16.json`]: _, ...fewer } = archive;
    expect(
      await nowcastErrorFloor(dataWith(fewer), "civiqs_angry_share", history, round.lock_at, 0.15),
    ).toBeUndefined();
  });

  it("is attached to the daily origin and raises a narrower filed sd", async () => {
    const forecaster = nowcastForecaster(dataWith(archive), forecastRound, {
      horizon: { mode: "off", phi: 1 },
    });
    const f = await forecaster(round, lock);
    const floor = f.origins?.civiqs_angry_share?.errorFloor;
    expect(f.topline?.mean).toBe(29.8);
    expect(floor?.n).toBe(3);
    // A formation that settled narrower than the measured error is widened, mean untouched.
    const narrow: RoundForecast = { ...f, topline: { mean: 29.8, sd: 0.174 } };
    const filed = applyErrorFloor(round, narrow);
    expect(filed.topline).toEqual({ mean: 29.8, sd: floor!.sd });
    expect(filed.note).toContain(`sd floored to measured nowcast error ${floor!.sd} (n=3)`);
    expect(filed.errorFloorApplied?.fromSd).toBe(0.174);
    // Never narrows.
    const wide: RoundForecast = { ...f, topline: { mean: 29.8, sd: 2 } };
    expect(applyErrorFloor(round, wide)).toBe(wide);
  });

  it("holds for a weekly origin when the tracker has not re-run since the anchor", async () => {
    // No snapshot newer than the last Friday: the round starts from the weekly anchor.
    const { [`${DIR}/2026-10-07.json`]: _, ...stale } = archive;
    const forecaster = nowcastForecaster(dataWith(stale), forecastRound, {
      horizon: { mode: "off", phi: 1 },
    });
    const origin = (await forecaster(round, lock)).origins?.civiqs_angry_share;
    expect(origin?.selected).toBe("weekly");
    expect(origin?.errorFloor?.n).toBe(3);
  });

  it("leaves forecasts without a measured floor unchanged", () => {
    const f: RoundForecast = { topline: { mean: 1, sd: 0.1 }, rules: {}, note: "x" };
    expect(applyErrorFloor(round, f)).toBe(f);
  });
});

describe("formation sd", () => {
  it("is never narrower than the narrowest member proposal", () => {
    const proposals = {
      a: { mean: 29.8, sd: 0.18 },
      b: { mean: 29.8, sd: 0.2 },
      c: { mean: 29.8, sd: 0.3 },
    };
    expect(atLeastNarrowestProposal({ mean: 29.8, sd: 0.174 }, proposals)).toEqual({
      mean: 29.8,
      sd: 0.18,
    });
    expect(atLeastNarrowestProposal({ mean: 29.8, sd: 0.25 }, proposals).sd).toBe(0.25);
    expect(atLeastNarrowestProposal({ mean: 29.8, sd: 0.1 }, undefined).sd).toBe(0.1);
  });
});
