// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  arenaCalibrationHistory,
  calibrateFiledForecast,
  calibrationKey,
  calibrationModeFromEnv,
  methodOf,
} from "../src/arena/calibration";
import type { RoundForecast } from "../src/arena/forecast";
import {
  atLeastLinearPool,
  type FormationStep,
  linearPoolSd,
  recordedReplies,
} from "../src/arena/formations";
import type { ArenaRound } from "../src/arena/types";
import type { ResolvedRecord } from "../src/forecast/history";
import { fitCalibration } from "../src/forecast/recalibration";
import type { ArenaSubmissionRow } from "../src/persistence/db-arena";

const round = (id: string, tracker = "civiqs"): ArenaRound => ({
  round_id: id,
  tracker,
  question: "q",
  target_type: "continuous_normal",
  lock_at: "2027-01-06T14:00:00Z",
  release_at: "2027-01-08T14:00:00Z",
});

const DELPHI_NOTE = "route civiqs → formation:delphi:a,b,c+research@search:tavily; marina delphi";

/**
 * `n` resolved weekly records for one key whose real misses are `ratio` times
 * the filed sd (alternating sign), so the CRPS-optimal scale is clearly ≠ 1.
 */
function records(n: number, ratio: number, key: string, start = Date.parse("2026-06-05")) {
  const out: ResolvedRecord[] = [];
  for (let i = 0; i < n; i++) {
    const sd = 0.2;
    out.push({
      id: `r${i}`,
      answerType: "number",
      group: key,
      resolvedAt: new Date(start + i * 7 * 86_400_000).toISOString(),
      raw: { value: 30, sd },
      outcome: { value: 30 + (i % 2 ? 1 : -1) * ratio * sd },
    });
  }
  return out;
}

describe("methodOf", () => {
  it("names the routed method at pattern level", () => {
    expect(methodOf(DELPHI_NOTE)).toBe("formation:delphi+research");
    expect(methodOf("route civiqs → formation:delphi:a,b+research@closed-book; x")).toBe(
      "formation:delphi",
    );
    expect(methodOf("route civiqs → nowcast; marina-baseline v1")).toBe("nowcast");
    expect(methodOf("route aaii → model:openrouter/x; y")).toBe("model");
    expect(methodOf("marina-baseline v1: persistence mean; Civiqs daily nowcast 2026-09-29")).toBe(
      "nowcast",
    );
    expect(methodOf("marina-baseline v1: persistence mean")).toBe("baseline");
    expect(methodOf(undefined)).toBe("baseline");
  });
});

describe("arenaCalibrationHistory", () => {
  const row = (
    id: number,
    roundId: string,
    topline: { mean: number; sd: number },
    extra: Partial<ArenaSubmissionRow> = {},
    detail: unknown = {},
  ): ArenaSubmissionRow =>
    ({
      id,
      entrant: "e",
      round_id: roundId,
      request_id: `q${id}`,
      url: "u",
      meta: "{}",
      body: JSON.stringify({ round_id: roundId, topline, notes: DELPHI_NOTE }),
      detail: JSON.stringify(detail),
      status: "accepted",
      http_status: 200,
      response: null,
      created_at: id,
      updated_at: id,
      ...extra,
    }) as ArenaSubmissionRow;

  it("keeps the newest accepted filing of each resolved round, its pre-calibration sd", () => {
    const rows = [
      row(1, "civiqs-a", { mean: 1, sd: 9 }),
      row(
        2,
        "civiqs-a",
        { mean: 2, sd: 0.5 },
        {},
        {
          round: { tracker: "civiqs" },
          forecast: { note: DELPHI_NOTE, calibration: { fromSd: 0.3 } },
        },
      ),
      row(3, "civiqs-a", { mean: 3, sd: 0.5 }, { status: "rejected" }),
      row(4, "yougov-b", { mean: 40, sd: 1.5 }),
      row(5, "civiqs-open", { mean: 5, sd: 1 }),
      row(6, "civiqs-void", { mean: 5, sd: 1 }),
    ];
    const out = arenaCalibrationHistory(
      rows,
      {
        "civiqs-a": { value: 2.5, resolved_at: "2026-10-01T00:00:00Z" },
        "yougov-b": { value: 41, resolved_at: "2026-10-02T00:00:00Z" },
        "civiqs-void": { value: 1, resolved_at: "2026-10-02T00:00:00Z", voided: { why: "x" } },
      },
      { "yougov-b": "economist_yougov" },
    );
    expect(out).toHaveLength(2);
    const a = out.find((r) => r.id === "civiqs-a")!;
    expect(a.raw).toEqual({ value: 2, sd: 0.3 });
    expect(a.group).toBe(calibrationKey("civiqs", "formation:delphi+research"));
    // Empty detail: the tracker comes from the season, the method from the body's notes.
    expect(out.find((r) => r.id === "yougov-b")!.group).toBe(
      "arena:economist_yougov|formation:delphi+research",
    );
  });
});

describe("fitCalibration key and shrink", () => {
  it("pools only the key's records and shrinks the scale toward 1", () => {
    const key = "arena:civiqs|formation:delphi";
    const history = [...records(20, 3, key), ...records(20, 0.1, "arena:other|x")];
    const base = {
      spec: { type: "number" as const },
      history,
      forecastOf: (r: ResolvedRecord) => r.raw,
      margin: 0.05,
      minRecords: 8,
      score: "brier" as const,
      key,
    };
    const loose = fitCalibration(base)!;
    const shrunk = fitCalibration({ ...base, sdShrink: 20 })!;
    expect(loose.group).toBe(key);
    expect(loose.adopted).toBe(true);
    const s = (f: typeof loose) => (f.params.kind === "sd-scale" ? f.params.s : Number.NaN);
    expect(s(loose)).toBeGreaterThan(2);
    expect(s(shrunk)).toBeGreaterThan(1);
    expect(s(shrunk)).toBeLessThan(s(loose));
  });
});

describe("calibrateFiledForecast", () => {
  const f: RoundForecast = { topline: { mean: 29.8, sd: 0.2 }, note: DELPHI_NOTE } as RoundForecast;
  const key = calibrationKey("civiqs", "formation:delphi+research");
  const now = Date.parse("2027-01-05T00:00:00Z");

  it("is identity with too little history", () => {
    const out = calibrateFiledForecast(round("civiqs-x"), f, records(5, 3, key), { now });
    expect(out.topline).toEqual(f.topline);
    expect(out.calibration?.adopted).toBe(false);
    expect(out.calibration?.reason).toContain("insufficient history");
  });

  it("widens an overconfident (family, method) on a held-out gain, mean untouched", () => {
    const out = calibrateFiledForecast(round("civiqs-x"), f, records(20, 3, key), { now });
    expect(out.calibration?.applied).toBe(true);
    expect(out.topline!.mean).toBe(29.8);
    expect(out.topline!.sd).toBeGreaterThan(0.2);
    expect(out.note).toContain(`calibrated on ${key}`);
  });

  it("ignores other keys, the round itself and outcomes not yet known", () => {
    const other = calibrateFiledForecast(round("civiqs-x", "aaii"), f, records(20, 3, key), {
      now,
    });
    expect(other.topline).toEqual(f.topline);
    // Every record resolves after `now`: none is visible.
    const future = calibrateFiledForecast(
      round("civiqs-x"),
      f,
      records(20, 3, key, Date.parse("2027-02-01")),
      { now },
    );
    expect(future.calibration?.applied).toBe(false);
    const self = records(20, 3, key).map((r) => ({ ...r, id: "civiqs-x" }));
    expect(calibrateFiledForecast(round("civiqs-x"), f, self, { now }).calibration?.applied).toBe(
      false,
    );
  });

  it("observe records without applying; off is a no-op", () => {
    const h = records(20, 3, key);
    const obs = calibrateFiledForecast(round("civiqs-x"), f, h, { now, mode: "observe" });
    expect(obs.calibration?.adopted).toBe(true);
    expect(obs.calibration?.applied).toBe(false);
    expect(obs.topline).toEqual(f.topline);
    expect(calibrateFiledForecast(round("civiqs-x"), f, h, { now, mode: "off" })).toBe(f);
    expect(calibrationModeFromEnv({})).toBe("on");
    expect(calibrationModeFromEnv({ MARINA_ARENA_CALIBRATION: "observe" })).toBe("observe");
    expect(calibrationModeFromEnv({ MARINA_ARENA_CALIBRATION: "OFF" })).toBe("off");
  });
});

describe("formation linear pool", () => {
  const step = (stage: string, reply: Record<string, unknown>, status = "ok"): FormationStep => ({
    stage,
    member: "m",
    status,
    reply,
  });

  it("is √(mean sd² + variance of the means)", () => {
    expect(linearPoolSd([{ mean: 0, sd: 0.3 }])).toBeCloseTo(0.3, 9);
    expect(
      linearPoolSd([
        { mean: -1, sd: 0.4 },
        { mean: 1, sd: 0.4 },
        { mean: 9, sd: 0 }, // not a distribution: ignored
      ]),
    ).toBeCloseTo(Math.sqrt(0.16 + 1), 9);
    expect(linearPoolSd([])).toBeUndefined();
  });

  it("pools every member stage (pre-convergence too), never advocates or dropped replies", () => {
    const steps = [
      step("round1", { mean: 29.6, sd: 0.2 }),
      step("round1", { mean: 30.0, sd: 0.2 }),
      step("round2", { mean: 29.8, sd: 0.2 }),
      step("round2", { mean: 29.8, sd: 0.2 }),
      step("advocate-up", { mean: 35, sd: 0.1 }),
      step("delphi/advocate-stay-or-down", { mean: 20, sd: 0.1 }),
      step("propose", { mean: 50, sd: 1 }, "dropped: move 20 beyond 4 start sd"),
      step("skeptic", { trust: 0.3, sd_scale: 1 }),
    ];
    expect(recordedReplies(steps)).toHaveLength(4);
    const out = atLeastLinearPool({ mean: 29.8, sd: 0.174 }, steps);
    expect(out.mean).toBe(29.8);
    // The converged round 2 alone pools to 0.2; round 1's disagreement widens it.
    expect(out.sd).toBeGreaterThan(0.2);
    // Only ever widens.
    expect(atLeastLinearPool({ mean: 29.8, sd: 2 }, steps).sd).toBe(2);
  });
});
