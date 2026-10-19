// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The arena baselines now call the shared series-fit helpers (`src/quant/`).
 * These tests replay a wide family of generated series through the refactored
 * arena functions and through a frozen copy of the code as it stood before
 * (`test/fixtures/arena-baseline-legacy.ts`) and require BIT-IDENTICAL
 * results — `toStrictEqual` on every number, no tolerance.
 */

import { describe, expect, it } from "bun:test";
import {
  backtestSeries,
  forecastRound,
  forecastScalar,
  horizonSteps,
  PERSISTENCE_SD,
} from "../src/arena/forecast";
import { arenaEwma, pollBlendMean, pollLevelForecast, ruleErrorRms } from "../src/arena/poll-level";
import { crpsNormal, erf } from "../src/arena/score";
import { normalQuantile } from "../src/arena/score-shapes";
import type { ArenaPoint, ArenaRound } from "../src/arena/types";
import { fitSeries } from "../src/quant/series-fit";
import * as legacy from "./fixtures/arena-baseline-legacy";

const DAY = 86_400_000;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s + 0.5) / 2 ** 32;
  };
}

function gauss(u: () => number): number {
  return Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

type Shape = "walk" | "level" | "trend" | "spiky" | "constant" | "poll" | "gappy";
const SHAPES: Shape[] = ["walk", "level", "trend", "spiky", "constant", "poll", "gappy"];
const CADENCES = [1, 7, 30];
const LENGTHS = [0, 1, 2, 5, 9, 13, 14, 20, 27, 40, 75];

function makeSeries(shape: Shape, n: number, cadence: number, seed: number): ArenaPoint[] {
  const u = rng(seed);
  let x = 40 + 10 * u();
  const out: ArenaPoint[] = [];
  let t = Date.parse("2025-01-06");
  for (let i = 0; i < n; i++) {
    let v: number;
    switch (shape) {
      case "walk":
        x += gauss(u);
        v = x;
        break;
      case "level":
        v = 38 + 2 * gauss(u);
        break;
      case "trend":
        v = x + 0.3 * i + 0.5 * gauss(u);
        break;
      case "spiky":
        v = 100 + gauss(u) + (u() < 0.1 ? 60 * u() : 0);
        break;
      case "constant":
        v = 42;
        break;
      case "poll":
        v = Math.round(38 + 2 * gauss(u));
        break;
      case "gappy":
        x += gauss(u);
        v = u() < 0.15 ? Number.NaN : x;
        break;
    }
    out.push({ date: new Date(t).toISOString().slice(0, 10), value: v });
    // Irregular spacing on "gappy": occasional doubled gap.
    t += cadence * DAY * (shape === "gappy" && u() < 0.2 ? 2 : 1);
  }
  return out;
}

interface Case {
  name: string;
  points: ArenaPoint[];
  cadence: number;
}

function cases(): Case[] {
  const out: Case[] = [];
  let seed = 1;
  for (const shape of SHAPES) {
    for (const n of LENGTHS) {
      for (const cadence of CADENCES) {
        for (let rep = 0; rep < 2; rep++) {
          out.push({
            name: `${shape}/n${n}/c${cadence}/r${rep}`,
            points: makeSeries(shape, n, cadence, seed++),
            cadence,
          });
        }
      }
    }
  }
  return out;
}

const ALL = cases();

function releaseAt(c: Case, steps: number): string {
  const last = c.points.at(-1);
  const base = last ? Date.parse(last.date) : Date.parse("2025-06-01");
  return new Date(base + steps * c.cadence * DAY).toISOString();
}

function same<T>(run: () => T, old: () => T): void {
  let a: T | Error;
  let b: T | Error;
  try {
    a = run();
  } catch (e) {
    a = e as Error;
  }
  try {
    b = old();
  } catch (e) {
    b = e as Error;
  }
  if (a instanceof Error || b instanceof Error) {
    expect(a instanceof Error).toBe(b instanceof Error);
    expect((a as Error).message).toBe((b as Error).message);
    return;
  }
  expect(a).toStrictEqual(b);
}

describe("arena baselines are bit-identical after the move to src/quant", () => {
  it("covers a wide family of series", () => {
    expect(ALL.length).toBe(SHAPES.length * LENGTHS.length * CADENCES.length * 2);
  });

  it("forecastScalar (persistence mean, calibrated/robust spread choice)", () => {
    let compared = 0;
    let calibrated = 0;
    for (const c of ALL) {
      for (const steps of [1, 2, 3, 5]) {
        const at = releaseAt(c, steps);
        same(
          () => forecastScalar(c.points, at),
          () => legacy.forecastScalar(c.points, at),
        );
        compared++;
        if (c.points.some((p) => Number.isFinite(p.value))) {
          if (forecastScalar(c.points, at).rule !== "persistence") calibrated++;
        }
      }
    }
    expect(compared).toBe(ALL.length * 4);
    // The family exercises both outcomes of the spread choice.
    expect(calibrated).toBeGreaterThan(20);
  });

  it("horizonSteps, including unparseable and missing dates", () => {
    for (const c of ALL) {
      for (const steps of [1, 2, 4]) {
        const at = releaseAt(c, steps);
        same(
          () => horizonSteps(c.points, at),
          () => legacy.horizonSteps(c.points, at),
        );
      }
      same(
        () => horizonSteps(c.points, "not a date"),
        () => legacy.horizonSteps(c.points, "not a date"),
      );
    }
    const bad = [
      { date: "garbage", value: 1 },
      { date: "2025-01-01", value: 2 },
    ];
    same(
      () => horizonSteps(bad, "2025-02-01"),
      () => legacy.horizonSteps(bad, "2025-02-01"),
    );
  });

  it("backtestSeries", () => {
    let scored = 0;
    for (const c of ALL) {
      for (const steps of [1, 2, 3]) {
        same(
          () => backtestSeries(c.points, steps),
          () => legacy.backtestSeries(c.points, steps),
        );
        if (backtestSeries(c.points, steps)) scored++;
      }
    }
    expect(scored).toBeGreaterThan(50);
  });

  it("pollLevelForecast (blend mean, half own-RMS spread, floor 0.5)", () => {
    let fitted = 0;
    for (const c of ALL) {
      const values = c.points.map((p) => p.value);
      for (const steps of [1, 2, 3, 4, 7, Number.NaN]) {
        same(
          () => pollLevelForecast(values, steps),
          () => legacy.pollLevelForecast(values, steps),
        );
        if (pollLevelForecast(values, steps)) fitted++;
      }
    }
    expect(fitted).toBeGreaterThan(100);
  });

  it("ruleErrorRms, arenaEwma and pollBlendMean", () => {
    const persistence = (p: number[]) => p.at(-1)!;
    for (const c of ALL) {
      const values = c.points.map((p) => p.value).filter((v) => Number.isFinite(v));
      for (const steps of [1, 2, 5]) {
        same(
          () => ruleErrorRms(values, pollBlendMean, steps),
          () => legacy.ruleErrorRms(values, legacy.pollBlendMean, steps),
        );
        same(
          () => ruleErrorRms(values, persistence, steps),
          () => legacy.ruleErrorRms(values, persistence, steps),
        );
      }
      same(
        () => arenaEwma(values),
        () => legacy.arenaEwma(values),
      );
      same(
        () => arenaEwma(values, 0.15),
        () => legacy.arenaEwma(values, 0.15),
      );
      if (values.length > 0) {
        same(
          () => pollBlendMean(values),
          () => legacy.pollBlendMean(values),
        );
      }
    }
  });

  it("forecastRound's continuous topline (poll-level and baseline trackers)", () => {
    for (const c of ALL) {
      if (!c.points.some((p) => Number.isFinite(p.value))) continue;
      for (const tracker of ["economist_yougov", "some_other_tracker"]) {
        const round: ArenaRound = {
          round_id: "r",
          tracker,
          question: "next?",
          target_type: "continuous_normal",
          lock_at: releaseAt(c, 0),
          release_at: releaseAt(c, 1),
        };
        const got = forecastRound(round, { round_id: "r", history: c.points }, { pollLevel: "on" });
        const steps = legacy.horizonSteps(c.points, round.release_at);
        const poll =
          tracker === "economist_yougov"
            ? legacy.pollLevelForecast(
                c.points.map((p) => p.value),
                steps,
              )
            : undefined;
        if (poll) {
          expect(got.topline).toStrictEqual({
            mean: legacy.round3(poll.forecast.mean),
            sd: legacy.round3(poll.forecast.sd),
          });
          expect(got.pollLevel).toStrictEqual(poll.evidence);
        } else {
          const f = legacy.forecastScalar(c.points, round.release_at);
          expect(got.topline).toStrictEqual({ mean: f.mean, sd: f.sd });
        }
      }
    }
  });

  it("erf, crpsNormal and normalQuantile", () => {
    for (let x = -6; x <= 6; x += 0.0137) {
      expect(erf(x)).toBe(legacy.erf(x));
      expect(crpsNormal(1.3, 0.7, x)).toBe(legacy.crpsNormal(1.3, 0.7, x));
    }
    expect(crpsNormal(2, 0, 5)).toBe(legacy.crpsNormal(2, 0, 5));
    for (const level of [0, 1e-12, 0.001, 0.02, 0.02425, 0.1, 0.5, 0.9, 0.975, 0.99, 1]) {
      expect(normalQuantile(3, 2, level)).toBe(legacy.normalQuantile(3, 2, level));
    }
  });

  it("the general fit reproduces both arena rules from its parameters alone", () => {
    for (const c of ALL) {
      const values = c.points.map((p) => p.value).filter((v) => Number.isFinite(v));
      if (values.length === 0) continue;
      for (const steps of [1, 2, 3]) {
        // poll-level = method blend, α 0.4, warm-up 8, sd 0.5 × RMS floored at 0.5.
        const old = legacy.pollLevelForecast(values, steps);
        const fit = fitSeries(values, {
          steps,
          method: "blend",
          alpha: 0.4,
          warmUp: 8,
          sdScale: 0.5,
          minSd: 0.5,
        })!;
        if (old) {
          expect(fit.sdBasis).toBe("rolling-origin");
          expect(fit.mean).toBe(old.forecast.mean);
          expect(fit.sd).toBe(old.forecast.sd);
        } else {
          expect(fit.sdBasis).not.toBe("rolling-origin");
        }
        // The arena's "calibrated" spread = persistence's own rolling-origin RMS (warm-up 1).
        const spreads = legacy.candidateSpreads(values, steps);
        const pers = fitSeries(values, { steps, method: "persistence", warmUp: 1 })!;
        expect(pers.mean).toBe(values.at(-1)!);
        if (spreads.calibrated !== undefined) {
          expect(pers.sdBasis).toBe("rolling-origin");
          expect(Math.max(pers.sd, 0.05)).toBe(spreads.calibrated);
        }
      }
    }
    expect(PERSISTENCE_SD).toBe(legacy.PERSISTENCE_SD);
  });
});
