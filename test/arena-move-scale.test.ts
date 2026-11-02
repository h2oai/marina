// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * The move scale a formation judges its members against, and the order a
 * filing's sd is finished in — the two faults trends-basket-2026-10-31 and
 * civiqs angry-share w43 exposed:
 *
 *   - every member called a spike's reversion, every call was "beyond 4 start
 *     sd" (a post-spike nowcast sd of 0.9 for an 8-point move), persistence
 *     filed. The scale is now the series' own change scale when the start
 *     carries one (`seriesMoveScale`), and the start the SERVICE passes
 *     carries it (`withSeriesMoveScale`); a formation called without one is
 *     unchanged (the legacy pin, `test/arena-formations-legacy.test.ts`).
 *   - the measured-error floor ran before the spread calibration, which then
 *     narrowed below it. It now runs last (`finishForecast`).
 */
import { describe, expect, it } from "bun:test";
import type { ArenaData } from "../src/arena/data";
import { forecastRound, type RoundForecast } from "../src/arena/forecast";
import {
  type FormationMember,
  formationForecastRound,
  moveScaleLabel,
} from "../src/arena/formations";
import { withSeriesMoveScale } from "../src/arena/move-scale";
import { parseProfile } from "../src/arena/profile-shape";
import { buildForecastBody, finishForecast } from "../src/arena/submit";
import type { ArenaLock, ArenaPoint, ArenaRound } from "../src/arena/types";
import {
  agreement,
  MAX_FINAL_SD_MOVE,
  MAX_PROPOSAL_SD_MOVE,
  MOVE_SCALE_MIN_POINTS,
  moveScaleOf,
  seriesMoveScale,
  settle,
} from "../src/orchestration/formations/combine-numeric";

const weekly = (values: number[], start = "2026-01-02"): ArenaPoint[] =>
  values.map((value, i) => ({
    date: new Date(Date.parse(start) + i * 7 * 86_400_000).toISOString().slice(0, 10),
    value,
  }));

const round: ArenaRound = {
  round_id: "yougov-2026-w40-approval",
  tracker: "yougov",
  series: "yougov_net_approval",
  question: "Net approval?",
  target_type: "continuous_normal",
  lock_at: "2026-08-01T14:00:00Z",
  release_at: "2026-08-03T14:00:00Z",
};
const history = weekly(Array.from({ length: 30 }, (_, i) => 40 + (i % 3)));
const lock: ArenaLock = { round_id: round.round_id, answer_history: history };
const start = forecastRound(round, lock);
const base = start.topline!;

function crew(n: number, answer: (i: number) => unknown): FormationMember[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `m${i}`,
    complete: async () => JSON.stringify(answer(i)),
  }));
}
const at = (move: number, sd = base.sd) => ({ mean: base.mean + move, sd, reason: "r" });

describe("seriesMoveScale", () => {
  it("is the start sd with too little history, and never below it", () => {
    expect(seriesMoveScale(1.5, [])).toBe(1.5);
    expect(
      seriesMoveScale(
        1.5,
        Array.from({ length: MOVE_SCALE_MIN_POINTS - 1 }, () => 9),
      ),
    ).toBe(1.5);
    // Flat series: every one-step change is 0 → the sd stands.
    expect(
      seriesMoveScale(
        0.9,
        Array.from({ length: 12 }, () => 9.4),
      ),
    ).toBe(0.9);
  });

  it("reads a spike as the series' own change scale: an 8-point reversion is within bounds", () => {
    // Eleven stable readings, then Tesla doubles (trends-basket-2026-10-24 → 10-31).
    const values = [9.4, 9.3, 9.5, 9.4, 9.2, 9.6, 9.4, 9.3, 9.5, 9.4, 9.43, 18.37];
    const scale = seriesMoveScale(0.904, values);
    expect(scale).toBeGreaterThan(8);
    const spiked = { mean: 18.37, sd: 0.904, moveScale: scale };
    // The panel's call (back to ~10) was dropped at 4 start sd; it is well inside 4 move scales.
    expect(Math.abs(10.5 - spiked.mean)).toBeGreaterThan(MAX_PROPOSAL_SD_MOVE * spiked.sd);
    expect(Math.abs(10.5 - spiked.mean)).toBeLessThan(MAX_PROPOSAL_SD_MOVE * moveScaleOf(spiked));
  });

  it("moveScaleOf falls back to the sd for an unset, zero or invalid scale", () => {
    expect(moveScaleOf({ mean: 1, sd: 2 })).toBe(2);
    expect(moveScaleOf({ mean: 1, sd: 2, moveScale: 0 })).toBe(2);
    expect(moveScaleOf({ mean: 1, sd: 2, moveScale: Number.NaN })).toBe(2);
    expect(moveScaleOf({ mean: 1, sd: 2, moveScale: 5 })).toBe(5);
  });
});

describe("the combiner reads the move scale", () => {
  it("settle caps the move at MAX_FINAL_SD_MOVE move scales; the sd blend still reads the sd", () => {
    const plain = { mean: 10, sd: 1 };
    const scaled = { mean: 10, sd: 1, moveScale: 4 };
    expect(settle(plain, 10, 1, 1).mean).toBe(10 + MAX_FINAL_SD_MOVE * 1);
    expect(settle(scaled, 10, 1, 1).mean).toBe(10 + MAX_FINAL_SD_MOVE * 4);
    expect(settle(scaled, 10, 0.2, 1).sd).toBe(settle(plain, 10, 0.2, 1).sd);
  });

  it("agreement measures the dispersion of the moves in move scales", () => {
    const plain = { mean: 10, sd: 1 };
    const scaled = { mean: 10, sd: 1, moveScale: 4 };
    const proposals = [
      { mean: 8, sd: 1 },
      { mean: 12, sd: 1 },
    ];
    expect(agreement(plain, proposals)).toBeLessThan(agreement(scaled, proposals));
  });
});

describe("a formation with a start that carries the move scale", () => {
  it("keeps a proposal beyond 4 start sds that is within 4 move scales, and moves past 2 start sds", async () => {
    const members = crew(3, () => at(6 * base.sd, base.sd));
    const unscaled = await formationForecastRound("ensemble", round, lock, members);
    expect(unscaled.proposals ?? {}).toEqual({});
    expect((unscaled.rounds ?? []).some((s) => s.status.includes("beyond 4 start sd"))).toBe(true);

    const scaled = await formationForecastRound("ensemble", round, lock, members, {
      ...start,
      moveScale: { topline: 3 * base.sd },
    });
    expect(Object.keys(scaled.proposals ?? {})).toHaveLength(3);
    expect(scaled.formationStart).toEqual({ ...base, moveScale: 3 * base.sd });
    // trust 0.5 (unanimous) × 6 sd = 3 sd, within MAX_FINAL_SD_MOVE × 3 sd = 6 sd.
    expect(scaled.topline!.mean - base.mean).toBeCloseTo(3 * base.sd, 2);
    expect(scaled.topline!.mean - base.mean).toBeGreaterThan(MAX_FINAL_SD_MOVE * base.sd);
  });

  it("names the bound it drops a blowup at", async () => {
    const members = crew(1, () => at(50 * base.sd));
    const f = await formationForecastRound("ensemble", round, lock, members, {
      ...start,
      moveScale: { topline: 3 * base.sd },
    });
    expect(f.rounds![0]!.status).toContain(`beyond 4 move scale (${3 * base.sd})`);
    expect(moveScaleLabel(base)).toBe("start sd");
    expect(moveScaleLabel({ ...base, moveScale: base.sd })).toBe("start sd");
  });

  it("a profile cell is validated against its own move scale", () => {
    const cells = ["a", "b"];
    const plain = { a: { mean: 18, sd: 0.9 }, b: { mean: 40, sd: 1.5 } };
    const dropped = parseProfile(
      { a: { mean: 10.5, sd: 2 }, b: { mean: 40, sd: 1.5 } },
      cells,
      plain,
      4,
    );
    expect(Object.keys(dropped.profile)).toEqual(["b"]);
    expect(dropped.issues[0]).toContain("beyond 4 start sd");
    const scaled = { a: { ...plain.a, moveScale: 9 }, b: plain.b };
    const kept = parseProfile(
      { a: { mean: 10.5, sd: 2 }, b: { mean: 40, sd: 1.5 } },
      cells,
      scaled,
      4,
    );
    expect(kept.issues).toEqual([]);
    expect(kept.profile.a).toEqual({ mean: 10.5, sd: 2 });
    const far = parseProfile({ a: { mean: -30, sd: 2 } }, ["a"], scaled, 4);
    expect(far.issues[0]).toContain("beyond 4 move scale (9)");
  });
});

describe("withSeriesMoveScale", () => {
  it("scales a scalar start from the lock's history and records it even when it equals the sd", () => {
    const given = withSeriesMoveScale(round, lock, start);
    expect(given.moveScale?.topline).toBe(
      seriesMoveScale(
        base.sd,
        history.map((p) => p.value),
      ),
    );
    expect(given.topline).toBe(start.topline);
  });

  it("scales every cell of a profile start from its own history", () => {
    const profileRound: ArenaRound = {
      round_id: "trends-basket-2026-10-31",
      tracker: "google_trends",
      series: "trends_share_iphone",
      cells: ["trends_share_tesla", "trends_share_iphone"],
      question: "shares of the basket",
      target_type: "profile_energy",
      lock_at: "2026-10-23T14:00:00Z",
      release_at: "2026-10-31T14:00:00Z",
    };
    const tesla = [9.4, 9.3, 9.5, 9.4, 9.2, 9.6, 9.4, 9.3, 9.5, 9.4, 9.43, 18.37];
    const iphone = tesla.map((v) => 50 - v);
    const profileLock: ArenaLock = {
      round_id: profileRound.round_id,
      answer_history_by_cell: {
        trends_share_tesla: weekly(tesla),
        trends_share_iphone: weekly(iphone),
      },
    };
    const profileStart = {
      rules: {},
      note: "n",
      profile: {
        trends_share_tesla: { mean: 18.37, sd: 0.904 },
        trends_share_iphone: { mean: 31.6, sd: 1.5 },
      },
    };
    const given = withSeriesMoveScale(profileRound, profileLock, profileStart);
    expect(given.moveScale?.cells?.trends_share_tesla).toBeGreaterThan(8);
    expect(given.moveScale?.cells?.trends_share_iphone).toBeGreaterThan(8);
    expect(given.moveScale?.topline).toBeUndefined();
  });

  it("a profile formation keeps a spike's reversion when the start carries the scale", async () => {
    const cells = ["cell_spiked", "cell_flat"];
    const profileRound: ArenaRound = {
      round_id: "profile-2026-w44",
      tracker: "yougov_xtab",
      series: cells[0],
      cells,
      question: "Percent in each group?",
      unit: "percent",
      target_type: "profile_energy",
      lock_at: "2026-10-23T14:00:00Z",
      release_at: "2026-10-31T14:00:00Z",
    };
    const spiked = [9.4, 9.3, 9.5, 9.4, 9.2, 9.6, 9.4, 9.3, 9.5, 9.4, 9.43, 18.37];
    const profileLock: ArenaLock = {
      round_id: profileRound.round_id,
      answer_history_by_cell: {
        cell_spiked: weekly(spiked),
        cell_flat: weekly(spiked.map(() => 40)),
      },
    };
    const plain = forecastRound(profileRound, profileLock);
    const reversion = { cell_spiked: { mean: 10.5, sd: 2 }, cell_flat: { mean: 40, sd: 1.5 } };
    const members = crew(3, () => ({ profile: reversion, reason: "spikes decay" }));
    const unscaled = await formationForecastRound(
      "ensemble",
      profileRound,
      profileLock,
      members,
      plain,
    );
    expect(unscaled.profile!.cell_spiked!.mean).toBe(plain.profile!.cell_spiked!.mean);
    expect(unscaled.rounds!.some((s) => s.status.includes("cell_spiked move"))).toBe(true);

    const scaled = await formationForecastRound(
      "ensemble",
      profileRound,
      profileLock,
      members,
      withSeriesMoveScale(profileRound, profileLock, plain),
    );
    expect(scaled.rounds!.every((s) => s.status === "ok")).toBe(true);
    expect(scaled.profile!.cell_spiked!.mean).toBeLessThan(plain.profile!.cell_spiked!.mean - 2);
    expect(scaled.formationStartProfile!.cell_spiked!.moveScale).toBeGreaterThan(8);
  });

  it("leaves a start with nothing to scale alone", () => {
    const ranking = { rules: {}, note: "n", ranking: ["A", "B"] };
    expect(withSeriesMoveScale(round, lock, ranking)).toBe(ranking);
  });

  it("never files: the body carries mean and sd alone", async () => {
    const data = { lock: async () => lock } as unknown as ArenaData;
    const body = await buildForecastBody(data, "e", round, async () => ({
      ...start,
      topline: { ...base, moveScale: 7 },
      moveScale: { topline: 7 },
    }));
    expect(body.topline).toEqual({ mean: base.mean, sd: base.sd });
    expect(JSON.stringify(body)).not.toContain("moveScale");
  });
});

describe("finishForecast: the measured-error floor has the last word", () => {
  const raw = {
    ...start,
    topline: { mean: base.mean, sd: 0.5 },
    origins: {
      [round.series!]: {
        selected: "daily" as const,
        reading: { date: "2026-07-31", value: base.mean },
        targetDate: "2026-08-01",
        horizonDays: 1,
        mode: "off" as const,
        reason: "r",
        start: { mean: base.mean, sd: 0.5 },
        errorFloor: { sd: 0.4, n: 8, rms: 0.4, errors: [] },
      },
    },
  };
  const halve = (_r: ArenaRound, f: RoundForecast): RoundForecast => ({
    ...f,
    topline: { ...f.topline!, sd: f.topline!.sd / 2 },
    note: `${f.note}; sd ×0.5 spread-calibrated`,
  });

  it("a calibration that narrows below the floor files the floor", () => {
    const f = finishForecast(round, raw, { spread: halve });
    expect(f.topline!.sd).toBe(0.4);
    expect(f.errorFloorApplied?.fromSd).toBe(0.25);
    expect(f.note.indexOf("spread-calibrated")).toBeLessThan(f.note.indexOf("floored"));
  });

  it("a calibration that stays above the floor is filed as calibrated", () => {
    const widen = (_r: ArenaRound, f: RoundForecast): RoundForecast => ({
      ...f,
      topline: { ...f.topline!, sd: f.topline!.sd * 2 },
    });
    const f = finishForecast(round, raw, { spread: widen });
    expect(f.topline!.sd).toBe(1);
    expect(f.errorFloorApplied).toBeUndefined();
  });

  it("without a calibrator the floor alone applies", () => {
    expect(
      finishForecast(round, { ...raw, topline: { mean: base.mean, sd: 0.3 } }).topline!.sd,
    ).toBe(0.4);
  });
});
