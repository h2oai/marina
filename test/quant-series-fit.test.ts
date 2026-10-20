// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { erf, normalCdf, normalQuantile } from "../src/quant/normal";
import {
  DEFAULT_LEVELS,
  ewma,
  FIT_METHODS,
  fitSeries,
  linearFit,
  medianSpacingDays,
  predictWith,
  rms,
  robustSpread,
  rollingOriginErrors,
  stepChanges,
  stepsAhead,
} from "../src/quant/series-fit";

const monthly = (values: number[]) =>
  values.map((value, i) => ({
    date: new Date(Date.UTC(2025, i, 1)).toISOString().slice(0, 10),
    value,
  }));

describe("normal primitives", () => {
  it("erf is odd and close to the reference values", () => {
    expect(erf(0)).toBeCloseTo(0, 7);
    expect(erf(1)).toBeCloseTo(0.8427007929, 6);
    expect(erf(-1)).toBe(-erf(1));
  });

  it("normalCdf handles sd 0 as a point mass, infinities and bad sd", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(5, 5, 0)).toBe(1);
    expect(normalCdf(4.999, 5, 0)).toBe(0);
    expect(normalCdf(Number.POSITIVE_INFINITY, 0, 1)).toBe(1);
    expect(normalCdf(Number.NEGATIVE_INFINITY, 0, 1)).toBe(0);
    expect(() => normalCdf(0, 0, -1)).toThrow(RangeError);
    expect(() => normalCdf(0, 0, Number.NaN)).toThrow(RangeError);
  });

  it("normalCdf is near double precision and exactly symmetric", () => {
    const reference: Array<[number, number]> = [
      [0, 0.5],
      [1, 0.8413447460685429],
      [3, 0.9986501019683699],
      [-5, 2.866515718791939e-7],
      [-8, 6.22096057427178e-16],
    ];
    for (const [z, p] of reference) {
      expect(Math.abs(normalCdf(z) - p)).toBeLessThan(1e-15);
      expect(Math.abs(normalCdf(z) / p - 1)).toBeLessThan(1e-7);
    }
    expect(normalCdf(-40)).toBe(0);
    expect(normalCdf(40)).toBe(1);
    for (const z of [0.1, 0.7, 1.3, 2.9, 6.5, 9]) {
      expect(normalCdf(z) + normalCdf(-z)).toBeCloseTo(1, 15);
    }
    expect(Number.isNaN(normalCdf(Number.NaN))).toBe(true);
  });

  it("normalQuantile inverts normalCdf", () => {
    for (const p of [0.01, 0.1, 0.5, 0.9, 0.99]) {
      expect(normalCdf(normalQuantile(10, 3, p), 10, 3)).toBeCloseTo(p, 6);
    }
  });
});

describe("series primitives", () => {
  it("ewma seeds at the first value and refuses an empty series", () => {
    expect(ewma([10])).toBe(10);
    expect(ewma([10, 20, 5])).toBeCloseTo(10.4, 12);
    expect(ewma([10, 20], 1)).toBe(20);
    expect(() => ewma([])).toThrow("empty history");
  });

  it("stepChanges equals persistence's rolling-origin errors", () => {
    const v = [1, 4, 2, 8, 5, 7, 3, 9, 6, 2];
    for (const steps of [1, 2, 3]) {
      for (const warmUp of [1, 3]) {
        expect(stepChanges(v, steps, { window: 5, warmUp })).toEqual(
          rollingOriginErrors(v, (p) => p.at(-1)!, steps, { window: 5, warmUp }),
        );
      }
    }
    expect(stepChanges([1, 2, 4], 1)).toEqual([1, 2]);
    expect(stepChanges([5], 1)).toEqual([]);
    expect(stepChanges([], 1)).toEqual([]);
  });

  it("rolling-origin predictions see only values before their origin", () => {
    const seen: number[] = [];
    rollingOriginErrors(
      [1, 2, 3, 4, 5, 6],
      (p) => {
        seen.push(p.length);
        return 0;
      },
      2,
      { warmUp: 2 },
    );
    // First origin t = warmUp + steps − 1 = 3, predicted from values[0..1].
    expect(seen).toEqual([2, 3, 4]);
  });

  it("rms and robustSpread", () => {
    expect(rms([3, 4])).toBeCloseTo(Math.sqrt(12.5), 12);
    expect(Number.isNaN(rms([]))).toBe(true);
    expect(robustSpread([1, -2, 3])).toBeCloseTo(1.4826 * 2, 12);
    // A single spike does not move the robust spread.
    expect(robustSpread([1, 1, 1, 1, 100])).toBeCloseTo(1.4826, 12);
  });

  it("linearFit recovers an exact line and is flat on one point", () => {
    expect(linearFit([1, 3, 5, 7])).toEqual({ last: 7, slope: 2 });
    expect(linearFit([4])).toEqual({ last: 4, slope: 0 });
    const flat = linearFit([2, 2, 2]);
    expect(flat.slope).toBe(0);
    expect(flat.last).toBe(2);
    expect(() => linearFit([])).toThrow();
  });

  it("predictWith: each method on a straight line", () => {
    const line = [10, 12, 14, 16, 18];
    expect(predictWith("persistence", line, 2)).toBe(18);
    expect(predictWith("trend", line, 2)).toBeCloseTo(22, 10);
    // Damped: 18 + 2 × (0.9 + 0.81) = 21.42
    expect(predictWith("damped", line, 2)).toBeCloseTo(21.42, 10);
    expect(predictWith("damped", line, 2, { damping: 1 })).toBeCloseTo(22, 10);
    expect(predictWith("blend", line, 1)).toBeCloseTo((18 + ewma(line)) / 2, 12);
    expect(predictWith("combo", line, 2)).toBeCloseTo((18 + ewma(line) + 21.42) / 3, 10);
    // trendWindow limits the line to the most recent values.
    expect(predictWith("trend", [0, 0, 0, 10, 20], 1, { trendWindow: 2 })).toBeCloseTo(30, 10);
  });

  it("medianSpacingDays and stepsAhead", () => {
    const pts = monthly([1, 2, 3, 4]);
    expect(medianSpacingDays(pts)).toBe(31);
    expect(medianSpacingDays([{ date: "2025-01-01" }])).toBe(7);
    expect(stepsAhead(pts, "2025-07-01")).toBe(3);
    expect(stepsAhead(pts, "2025-04-02")).toBe(1); // never below one
    expect(stepsAhead([], "2025-07-01")).toBe(1);
    expect(stepsAhead(pts, "2025-07-01", 1)).toBe(91);
    expect(Number.isNaN(stepsAhead(pts, "garbage"))).toBe(true);
  });
});

describe("fitSeries", () => {
  it("returns undefined for an empty or all-missing series", () => {
    expect(fitSeries([])).toBeUndefined();
    expect(fitSeries([Number.NaN, Number.POSITIVE_INFINITY])).toBeUndefined();
    expect(fitSeries([{ date: "2025-01-01", value: Number.NaN }])).toBeUndefined();
  });

  it("one point: the point itself, no spread", () => {
    const f = fitSeries([7])!;
    expect(f).toMatchObject({ method: "persistence", mean: 7, sd: 0, sdBasis: "none", n: 1 });
    expect(f.quantiles.every((q) => q.value === 7)).toBe(true);
    expect(fitSeries([7], { minSd: 0.5 })!.sd).toBe(0.5);
  });

  it("drops NaN values and reports them", () => {
    const f = fitSeries([1, Number.NaN, 2, Number.NaN, 3])!;
    expect(f.n).toBe(3);
    expect(f.dropped).toBe(2);
    expect(f.mean).toBe(3);
  });

  it("short series fall back to √steps × the one-step change RMS", () => {
    const f = fitSeries([10, 12, 11], { steps: 4 })!;
    expect(f.sdBasis).toBe("step-changes");
    expect(f.errorCount).toBe(2);
    expect(f.sd).toBeCloseTo(Math.sqrt(4) * rms([2, -1]), 12);
  });

  it("zero variance: sd 0, every method agrees, quantiles collapse", () => {
    const f = fitSeries(Array(30).fill(5))!;
    expect(f.mean).toBe(5);
    expect(f.sd).toBe(0);
    expect(f.sdBasis).toBe("rolling-origin");
    expect(f.method).toBe("persistence");
    expect(f.quantiles.map((q) => q.value)).toEqual(DEFAULT_LEVELS.map(() => 5));
  });

  it("auto picks a trend method on a trending series and persistence on a random walk", () => {
    const trending = Array.from({ length: 40 }, (_, i) => 100 + 2 * i + (i % 3) * 0.3);
    const t = fitSeries(trending, { steps: 3 })!;
    expect(["trend", "damped"]).toContain(t.method);
    expect(t.mean).toBeGreaterThan(trending.at(-1)!);
    expect(t.candidates?.map((c) => c.method)).toEqual([...FIT_METHODS]);

    // A walk whose steps alternate in size: nothing beats persistence by 5%.
    const walk: number[] = [50];
    for (let i = 1; i < 40; i++) walk.push(walk[i - 1]! + (i % 2 ? 1.3 : -1.1) * (i % 5 ? 1 : -1));
    const w = fitSeries(walk)!;
    const pers = w.candidates!.find((c) => c.method === "persistence")!;
    const best = Math.min(...w.candidates!.map((c) => c.rms ?? Number.POSITIVE_INFINITY));
    if (w.method === "persistence") expect(best).toBeGreaterThan(0.95 * pers.rms!);
    else expect(best).toBeLessThanOrEqual(0.95 * pers.rms!);
  });

  it("an explicit method is honoured and reports no candidates", () => {
    const f = fitSeries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], { method: "ewma" })!;
    expect(f.method).toBe("ewma");
    expect(f.candidates).toBeUndefined();
    expect(f.mean).toBeCloseTo(ewma([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 12);
  });

  it("sd = max(sdScale × own RMS, minSd); quantiles are normal around the mean", () => {
    const v = [3, 5, 4, 6, 5, 7, 6, 8, 7, 9, 8, 10, 9, 11];
    const base = fitSeries(v, { method: "persistence" })!;
    expect(base.sdBasis).toBe("rolling-origin");
    expect(base.sd).toBe(base.errorRms!);
    const half = fitSeries(v, { method: "persistence", sdScale: 0.5, minSd: 0 })!;
    expect(half.sd).toBe(0.5 * base.errorRms!);
    const floored = fitSeries(v, { method: "persistence", minSd: 100 })!;
    expect(floored.sd).toBe(100);
    const median = base.quantiles.find((q) => q.level === 0.5)!;
    expect(median.value).toBeCloseTo(base.mean, 9);
    const q90 = base.quantiles.find((q) => q.level === 0.9)!;
    expect(q90.value).toBeCloseTo(base.mean + 1.281552 * base.sd, 5);
  });

  it("dated input: sorted by date, target converted at the median spacing", () => {
    const pts = monthly([1, 2, 3, 4, 5, 6]).reverse();
    const f = fitSeries(pts, { target: "2025-09-01", method: "persistence" })!;
    expect(f.mean).toBe(6); // the latest date, not the last element
    expect(f.steps).toBe(3);
    expect(fitSeries(pts, { target: "2025-09-01", spacingDays: 7 })!.steps).toBe(13);
  });

  it("validates horizon, options and dates", () => {
    expect(() => fitSeries([1, 2], { steps: 0 })).toThrow(RangeError);
    expect(() => fitSeries([1, 2], { steps: 1.5 })).toThrow(RangeError);
    expect(() => fitSeries([1, 2], { steps: Number.NaN })).toThrow(RangeError);
    expect(() => fitSeries([1, 2], { target: "2025-01-01" })).toThrow("needs dated values");
    expect(() => fitSeries(monthly([1, 2]), { target: "soon" })).toThrow("invalid target date");
    expect(() => fitSeries(monthly([1, 2]), { target: "2026-01-01", steps: 2 })).toThrow(
      "not both",
    );
    expect(() => fitSeries([{ date: "nope", value: 1 }])).toThrow("invalid date");
    expect(() => fitSeries([1, 2], { alpha: 0 })).toThrow(RangeError);
    expect(() => fitSeries([1, 2], { damping: 1.5 })).toThrow(RangeError);
    expect(() => fitSeries([1, 2], { levels: [0, 0.5] })).toThrow(RangeError);
    expect(() => fitSeries([1, 2], { trendWindow: 1 })).toThrow(RangeError);
    expect(() => fitSeries([1, 2], { minSd: -1 })).toThrow(RangeError);
    expect(() => fitSeries([1, 2], { method: "magic" as never })).toThrow("unknown method");
  });

  it("is pure: the input is not mutated", () => {
    const pts = monthly([3, 1, 2]).reverse();
    const copy = structuredClone(pts);
    fitSeries(pts, { target: "2025-06-01" });
    expect(pts).toEqual(copy);
  });
});
