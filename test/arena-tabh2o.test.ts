// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { parseForecasterSpec } from "../src/arena/config";
import { ArenaData } from "../src/arena/data";
import { evaluateResolved, type Forecaster } from "../src/arena/evaluate";
import { forecastRound } from "../src/arena/forecast";
import { parseRoutes } from "../src/arena/routing";
import {
  buildTable,
  CI_Z,
  DEFAULT_TABH2O_OPTIONS,
  guardedBlend,
  lockSeries,
  parseTabH2OSpec,
  type TabPredict,
  tabh2oForecastRound,
  throttledTabPredict,
} from "../src/arena/tabh2o-forecaster";
import type { ArenaLock, ArenaPoint, ArenaRound } from "../src/arena/types";
import {
  endpointFor,
  fromWireResponse,
  type TabH2OPredictRequest,
  type TabH2OResult,
  toWireRequest,
} from "../src/net/tabh2o-client";

const weekly = (values: number[], start = "2026-01-02"): ArenaPoint[] =>
  values.map((value, i) => ({
    date: new Date(Date.parse(start) + i * 7 * 86_400_000).toISOString().slice(0, 10),
    value,
  }));
const nextWeek = (h: ArenaPoint[]) =>
  new Date(Date.parse(h.at(-1)!.date) + 7 * 86_400_000).toISOString();

const history = weekly(Array.from({ length: 30 }, (_, i) => 40 + (i % 3) + i * 0.1));
const round: ArenaRound = {
  round_id: "example-2026-w40",
  tracker: "example",
  question: "Bull-bear spread?",
  target_type: "continuous_normal",
  lock_at: "2026-07-28T14:00:00Z",
  release_at: nextWeek(history),
};
const lock: ArenaLock = { round_id: round.round_id, answer_history: history };

/** A mocked TabH2O: answers every test row with `delta` and a ±`half` interval. */
function mockPredict(
  delta: number,
  half: number | undefined,
  seen: TabH2OPredictRequest[] = [],
): TabPredict {
  return async (req) => {
    seen.push(req);
    return {
      result: {
        ok: true,
        response: {
          task: req.task,
          predictions: req.predict_on.map(() => ({
            prediction: delta,
            ...(half === undefined
              ? {}
              : { confidence_interval: [delta - half, delta + half] as [number, number] }),
          })),
          model_version: "mock",
          usage: { cells: 10, priceUsd: 0.001 },
        },
      },
      cached: false,
      ms: 5,
    };
  };
}

describe("tabh2o spec", () => {
  it("parses the experimental specs, alone and as route targets", () => {
    for (const s of ["tabh2o", "tabh2o@nowcast", "tabh2o:forecast", "tabh2o:forecast@nowcast"]) {
      expect(parseForecasterSpec(s)).toBe(s);
    }
    expect(parseTabH2OSpec("tabh2o")).toEqual({ mode: "regression", nowcast: false });
    expect(parseTabH2OSpec("tabh2o:forecast@nowcast")).toEqual({ mode: "forecast", nowcast: true });
    expect(parseTabH2OSpec("tabh2o@baseline")).toBeUndefined();
    expect(() => parseForecasterSpec("tabh2o@later")).toThrow();
    const spec = parseForecasterSpec("route:civiqs=tabh2o@nowcast;example=tabh2o;*=nowcast");
    const routes = parseRoutes(spec);
    expect(routes.byFamily.get("civiqs")).toBe("tabh2o@nowcast");
    expect(routes.byFamily.get("example")).toBe("tabh2o");
    expect(() => parseForecasterSpec("route:example=tabh2o:lstm")).toThrow();
  });
});

describe("tabh2o client wire format", () => {
  const req: TabH2OPredictRequest = {
    task: "regression",
    training: [
      { a: 1, b: 2, y: 3 },
      { a: 2, b: 3, y: 5 },
    ],
    predict_on: [{ a: 3, b: 4 }],
    target_column: "y",
  };

  it("sends column names and row arrays, target last in train", () => {
    const wire = toWireRequest(req);
    expect(wire.train).toEqual({
      columns: ["a", "b", "y"],
      data: [
        [1, 2, 3],
        [2, 3, 5],
      ],
    });
    expect(wire.test).toEqual({ columns: ["a", "b"], data: [[3, 4]] });
    expect(wire.task).toBe("regression");
    expect(wire.target_column).toBe("y");
    expect(wire.time_column).toBeUndefined();
    expect(toWireRequest({ ...req, task: "forecast", time_column: "a" }).task).toBe("regression");
  });

  it("reads parallel prediction and interval arrays, and labels class probabilities", () => {
    const r = fromWireResponse(req, {
      predictions: [7.5],
      confidence_intervals: [[6, 9]],
      usage: { cells: 9, multiplier: 1, price_usd: "0.000135" },
      metadata: { model: "tabh2o_v1", time_ms: 80 },
    });
    expect(r.predictions[0]).toEqual({ prediction: 7.5, confidence_interval: [6, 9] });
    expect(r.model_version).toBe("tabh2o_v1");
    expect(r.runtime_ms).toBe(80);
    expect(r.usage).toEqual({ cells: 9, priceUsd: 0.000135 });
    const cls = fromWireResponse(
      {
        ...req,
        task: "classification",
        training: [
          { a: 1, y: "yes" },
          { a: 2, y: "no" },
        ],
      },
      { predictions: ["yes"], probabilities: [[0.2, 0.8]] },
    );
    expect(cls.predictions[0]!.probabilities).toEqual({ no: 0.2, yes: 0.8 });
  });

  it("sends a time-column request to /forecast", () => {
    const base = "https://tabh2o.h2oai.com/api/v1/predict";
    expect(endpointFor(base, req)).toBe(base);
    expect(endpointFor(base, { ...req, time_column: "date" })).toBe(
      "https://tabh2o.h2oai.com/api/v1/forecast",
    );
  });
});

describe("tabh2o training table", () => {
  it("builds lag/diff rows with the change h steps ahead as target, and one test row", () => {
    const t = buildTable([{ key: "s", points: history, steps: 1 }], "regression")!;
    const { training, predict_on } = t.request;
    expect(predict_on).toHaveLength(1);
    const test = predict_on[0]!;
    expect(test.level).toBeCloseTo(history.at(-1)!.value, 3);
    expect(test.t).toBe(0);
    expect(test.h).toBe(1);
    expect(test.cell).toBeUndefined();
    // Every row's target is a change between two points of the frozen history.
    for (const row of training) {
      expect(Number(row.t)).toBeLessThan(0);
      expect(Number(row.t) + Number(row.h)).toBeLessThanOrEqual(0);
    }
    const values = history.map((p) => p.value);
    const r0 = training.find((r) => r.t === 3 - 29 && r.h === 1)!;
    expect(r0.y).toBeCloseTo(values[4]! - values[3]!, 3);
    expect(r0.d1).toBeCloseTo(values[3]! - values[2]!, 3);
    expect(t.series[0]!.origin).toBe(values.at(-1)!);
  });

  it("keeps too-short histories out, and makes one request for a profile's cells", () => {
    expect(buildTable([{ key: "s", points: history.slice(0, 5), steps: 1 }], "regression")).toBe(
      undefined,
    );
    const two = buildTable(
      [
        { key: "a", points: history, steps: 1 },
        { key: "b", points: history.map((p) => ({ ...p, value: p.value * 2 })), steps: 1 },
      ],
      "regression",
    )!;
    expect(two.request.predict_on.map((r) => r.cell)).toEqual([0, 1]);
  });

  it("forecast mode sends the series with a time column and the next period dates", () => {
    const t = buildTable([{ key: "s", points: history, steps: 2 }], "forecast")!;
    expect(t.request.time_column).toBe("date");
    expect(t.request.training).toHaveLength(history.length);
    expect(t.request.predict_on.map((r) => r.date)).toEqual([
      nextWeek(history).slice(0, 10),
      new Date(Date.parse(nextWeek(history)) + 7 * 86_400_000).toISOString().slice(0, 10),
    ]);
  });
});

describe("tabh2o round forecast", () => {
  const start = forecastRound(round, lock);
  const spec = { mode: "regression" as const, nowcast: false };

  it("adds the predicted change to the origin, sd from the interval, then shrinks toward the start", async () => {
    const f = await tabh2oForecastRound(round, lock, start, spec, {
      predict: mockPredict(1, 1.645),
    });
    const origin = history.at(-1)!.value;
    expect(f.fallback).toBeUndefined();
    expect(f.raw?.topline?.mean).toBeCloseTo(origin + 1, 3);
    expect(f.raw?.topline?.sd).toBeCloseTo(1.645 / CI_Z, 3);
    expect(f.topline!.mean).toBeCloseTo(
      start.topline!.mean + 0.5 * (origin + 1 - start.topline!.mean),
      3,
    );
    expect(f.tabh2o?.sdSource).toBe("ci");
    expect(f.costUsd).toBe(0.001);
  });

  it("uses the residual spread when no interval comes back", async () => {
    const f = await tabh2oForecastRound(round, lock, start, spec, {
      predict: mockPredict(0.2, undefined),
    });
    expect(f.tabh2o?.sdSource).toBe("residual");
    expect(f.raw?.topline?.sd).toBeGreaterThan(0);
  });

  it("falls back to the start with a recorded reason on an error, a throw or a blowup", async () => {
    const failing: TabPredict = async () => ({
      result: { ok: false, error: "TabH2O returned 503" },
      cached: false,
      ms: 1,
    });
    const a = await tabh2oForecastRound(round, lock, start, spec, { predict: failing });
    expect(a.topline).toEqual(start.topline!);
    expect(a.fallback).toContain("tabh2o unavailable");
    const b = await tabh2oForecastRound(round, lock, start, spec, {
      predict: async () => {
        throw new Error("boom");
      },
    });
    expect(b.fallback).toContain("boom");
    const c = await tabh2oForecastRound(round, lock, start, spec, {
      predict: mockPredict(500, 1),
    });
    expect(c.fallback).toContain("implausibly far");
    expect(c.topline).toEqual(start.topline!);
  });

  it("scales the blowup guard by the series' own move, not only the start's sd", () => {
    const base = { mean: 0, sd: 1.5 };
    const opts = DEFAULT_TABH2O_OPTIONS;
    expect(guardedBlend(base, { mean: 8, sd: 5 }, 0.5, opts)).toBeUndefined();
    expect(guardedBlend(base, { mean: 8, sd: 5 }, 10, opts)?.mean).toBe(4);
  });

  it("keeps the start for ranking rounds and too-short histories", async () => {
    const ranking: ArenaRound = { ...round, target_type: "ranking_list" };
    const r = await tabh2oForecastRound(ranking, lock, { ...start, ranking: ["A"] }, spec, {
      predict: mockPredict(0, 1),
    });
    expect(r.fallback).toContain("ranking");
    const short = { ...lock, answer_history: history.slice(0, 4) };
    const s = await tabh2oForecastRound(round, short, forecastRound(round, short), spec, {
      predict: mockPredict(0, 1),
    });
    expect(s.fallback).toContain("training rows");
  });

  it("moves each profile cell from one request", async () => {
    const cells = ["a", "b"];
    const profileRound: ArenaRound = {
      ...round,
      round_id: "civiqs-profile-2026-w40",
      target_type: "profile_energy",
      cells,
    };
    const profileLock: ArenaLock = {
      round_id: profileRound.round_id,
      answer_history_by_cell: { a: history, b: history.map((p) => ({ ...p, value: -p.value })) },
    };
    const seen: TabH2OPredictRequest[] = [];
    const f = await tabh2oForecastRound(
      profileRound,
      profileLock,
      forecastRound(profileRound, profileLock),
      spec,
      { predict: mockPredict(1, 2, seen) },
    );
    expect(seen).toHaveLength(1);
    expect(Object.keys(f.profile!)).toEqual(cells);
    expect(f.raw?.profile?.b?.mean).toBeCloseTo(-history.at(-1)!.value + 1, 3);
    expect(lockSeries(profileRound, profileLock)).toHaveLength(2);
  });
});

describe("tabh2o backtest leakage", () => {
  it("never shows TabH2O a value from after the lock", async () => {
    const OUTCOME = 777.25;
    const r2: ArenaRound = { ...round, round_id: "example-2026-w41" };
    const files: Record<string, unknown> = {
      "questions/season0.json": { rounds: [round, r2] },
      [`locks/${round.round_id}.json`]: lock,
      [`locks/${r2.round_id}.json`]: { ...lock, round_id: r2.round_id },
      "resolutions/resolved.json": {
        [round.round_id]: { value: OUTCOME },
        [r2.round_id]: { value: OUTCOME },
      },
    };
    const data = new ArenaData("https://example.test", async (url) => {
      const path = url.replace("https://example.test/", "");
      return path in files ? Response.json(files[path]) : new Response("", { status: 404 });
    });
    const seen: TabH2OPredictRequest[] = [];
    const predict = mockPredict(0.5, 1, seen);
    const tab: Forecaster = async (rd, lk) =>
      tabh2oForecastRound(
        rd,
        lk,
        forecastRound(rd, lk),
        { mode: "regression", nowcast: false },
        {
          predict,
        },
      );
    const report = await evaluateResolved(data, { tab });
    expect(report.rounds).toHaveLength(2);
    expect(seen).toHaveLength(2);
    const allowed = new Set(history.map((p) => Math.round(p.value * 1000) / 1000));
    for (const req of seen) {
      for (const row of [...req.training, ...req.predict_on]) {
        expect(allowed.has(Number(row.level))).toBe(true);
        expect(Object.values(row)).not.toContain(OUTCOME);
      }
    }
  });
});

describe("throttled predictor", () => {
  const ok = (): TabH2OResult => ({
    ok: true,
    response: {
      task: "regression",
      predictions: [{ prediction: 1 }],
      usage: { cells: 1, priceUsd: 0 },
    },
  });
  const req: TabH2OPredictRequest = {
    task: "regression",
    training: [{ x: 1, y: 1 }],
    predict_on: [{ x: 2 }],
    target_column: "y",
  };

  it("answers an identical request once and paces distinct ones", async () => {
    let calls = 0;
    const waits: number[] = [];
    const p = throttledTabPredict(
      {},
      {
        call: async () => {
          calls++;
          return ok();
        },
        minGapMs: 1_000,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    const [a, b] = await Promise.all([p(req), p(req)]);
    expect(calls).toBe(1);
    expect([a.cached, b.cached].sort()).toEqual([false, true]);
    await p({ ...req, predict_on: [{ x: 3 }] });
    expect(calls).toBe(2);
    expect(waits.length).toBe(1);
  });

  it("retries a 429 once after Retry-After, and does not cache a failure", async () => {
    const answers: TabH2OResult[] = [
      { ok: false, error: "429", status: 429, retryAfterSec: 2 },
      ok(),
      { ok: false, error: "422", status: 422 },
    ];
    const slept: number[] = [];
    const p = throttledTabPredict(
      {},
      {
        call: async () => answers.shift()!,
        minGapMs: 0,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );
    expect((await p(req)).result.ok).toBe(true);
    expect(slept).toContain(2_000);
    const other = { ...req, predict_on: [{ x: 9 }] };
    expect((await p(other)).result.ok).toBe(false);
    answers.push(ok());
    expect((await p(other)).result.ok).toBe(true);
  });
});
