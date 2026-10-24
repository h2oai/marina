import { describe, expect, test } from "bun:test";
import { parseForecasterSpec } from "../src/arena/config";
import {
  LEAD_SERIES,
  type LeadSeriesSpec,
  leadForecast,
  leadForecastFromInputs,
  monthCutoff,
  monthlyChange,
} from "../src/arena/lead-forecast";
import type { ArenaPoint, ArenaRound } from "../src/arena/types";

const DAY = 86_400_000;
const ym = (i: number) => new Date(Date.UTC(2021, i, 1)).toISOString().slice(0, 10);

/** A target that follows the indicator's monthly change exactly (β = 0.5). */
function fixture(months: number) {
  const indicator: ArenaPoint[] = [];
  const target: ArenaPoint[] = [];
  let level = 3;
  let ind = 3;
  for (let i = 0; i < months; i++) {
    const step = Math.sin(i * 1.7) * 0.6;
    ind += step;
    indicator.push({ date: ym(i), value: ind });
    if (i > 0) level += 0.5 * step;
    target.push({ date: ym(i), value: level });
  }
  return { indicator, target };
}

const SPEC: LeadSeriesSpec = {
  indicators: [{ id: "TEST", transform: "diff", lagDays: 10 }],
  cutoffDays: 3,
};

describe("monthly lead change", () => {
  test("averages within a month and respects the publication lag", () => {
    const pts: ArenaPoint[] = [
      { date: "2026-08-03", value: 3 },
      { date: "2026-08-17", value: 5 },
      { date: "2026-09-07", value: 6 },
      { date: "2026-09-28", value: 8 },
    ];
    const ind = { id: "W", transform: "diff" as const, lagDays: 1 };
    // Sep 28 is published Sep 29: visible by Oct 4, not by Sep 20.
    expect(monthlyChange(pts, ind, Date.parse("2026-10-04T00:00:00Z"), "2026-09")).toBe(3);
    expect(monthlyChange(pts, ind, Date.parse("2026-09-20T00:00:00Z"), "2026-09")).toBe(2);
    // maxMonth bounds the months considered.
    expect(monthlyChange(pts, ind, Date.parse("2026-10-04T00:00:00Z"), "2026-08")).toBeUndefined();
  });

  test("log and year-over-year transforms", () => {
    const pts: ArenaPoint[] = [];
    for (let i = 0; i < 14; i++) pts.push({ date: ym(i), value: 100 + i });
    const cutoff = Date.parse("2030-01-01");
    const log = monthlyChange(
      pts,
      { id: "X", transform: "logpct", lagDays: 0 },
      cutoff,
      ym(13).slice(0, 7),
    );
    expect(log!).toBeCloseTo(100 * Math.log(113 / 112), 9);
    const yoy = monthlyChange(
      pts,
      { id: "X", transform: "yoy-diff", lagDays: 0 },
      cutoff,
      ym(13).slice(0, 7),
    );
    expect(yoy!).toBeCloseTo(100 * (113 / 101 - 1) - 100 * (112 / 100 - 1), 9);
  });

  test("the month cutoff is the 1st of the next month plus the days", () => {
    expect(new Date(monthCutoff("2026-09", 3)).toISOString()).toBe("2026-10-04T00:00:00.000Z");
  });
});

describe("lead forecast from frozen inputs", () => {
  const { indicator, target } = fixture(40);
  const history = target.slice(0, 39);
  const lockAt = new Date(monthCutoff(target[38]!.date.slice(0, 7), 0) + 40 * DAY).toISOString();
  const start = { mean: history.at(-1)!.value, sd: 0.2 };

  test("moves the start by the earned lead and keeps the start's sd", () => {
    const f = leadForecastFromInputs(history, [indicator], SPEC, lockAt, start)!;
    expect(f.evidence.nowcast.applied).toBe(true);
    expect(f.topline.sd).toBe(0.2);
    // β is shrunk toward 0 (8 pseudo-cases), so the move lands short of the truth but toward it.
    const truth = target[39]!.value;
    expect(Math.abs(f.topline.mean - truth)).toBeLessThan(Math.abs(start.mean - truth) / 2);
    expect(f.evidence.targetMonth).toBe(target[39]!.date.slice(0, 7));
  });

  test("an observation published after the lock never changes the forecast", () => {
    const base = leadForecastFromInputs(history, [indicator], SPEC, lockAt, start)!;
    const later = [
      ...indicator,
      { date: new Date(Date.parse(lockAt) + DAY).toISOString().slice(0, 10), value: 999 },
    ];
    expect(leadForecastFromInputs(history, [later], SPEC, lockAt, start)).toEqual(base);
  });

  test("an indicator that stopped publishing ⇒ undefined", () => {
    expect(
      leadForecastFromInputs(history, [indicator.slice(0, 30)], SPEC, lockAt, start),
    ).toBeUndefined();
  });

  test("an unregistered series is not a lead round", async () => {
    const round = {
      round_id: "x-2026-w1",
      tracker: "economist_yougov",
      series: "yougov_rv_approval",
      question: "",
      target_type: "continuous_normal",
      lock_at: "2026-10-01T00:00:00Z",
      release_at: "2026-10-03T00:00:00Z",
    } satisfies ArenaRound;
    expect(await leadForecast(round, { round_id: round.round_id }, start, {})).toBeUndefined();
  });

  test("registered series and the forecaster spec", () => {
    expect(Object.keys(LEAD_SERIES).sort()).toEqual(["sce_inflation_1y", "sce_inflation_3y"]);
    expect(parseForecasterSpec("lead")).toBe("lead");
    expect(parseForecasterSpec("route:ny_fed_sce=lead;*=nowcast")).toBe(
      "route:ny_fed_sce=lead;*=nowcast",
    );
  });
});
