// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  bucketProbabilities,
  formatBucket,
  type Predictive,
  parseBuckets,
  predictiveCdf,
  thresholdBuckets,
} from "../src/quant/buckets";
import { normalCdf } from "../src/quant/normal";

const normal = (mean: number, sd: number): Predictive => ({ kind: "normal", mean, sd });
const quantiles = (...pairs: Array<[number, number]>): Predictive => ({
  kind: "quantiles",
  quantiles: pairs.map(([level, value]) => ({ level, value })),
});
const ps = (pred: Predictive, buckets: Parameters<typeof bucketProbabilities>[1]) =>
  bucketProbabilities(pred, buckets).buckets.map((b) => b.p);

describe("bucketProbabilities — normal", () => {
  it("open-ended thresholds partition the line and sum to 1", () => {
    const r = bucketProbabilities(normal(3.4, 0.3), thresholdBuckets([3, 3.5, 4]));
    expect(r.buckets).toHaveLength(4);
    expect(r.coverage).toBeCloseTo(1, 12);
    expect(r.buckets[0]!.p).toBeCloseTo(normalCdf(3, 3.4, 0.3), 12);
    expect(r.buckets[1]!.p).toBeCloseTo(normalCdf(3.5, 3.4, 0.3) - normalCdf(3, 3.4, 0.3), 12);
    expect(r.best).toBe(1);
    expect(r.buckets[r.best]!.label).toBe("[3, 3.5)");
    expect(r.warnings).toEqual([]);
  });

  it("symmetric buckets around the mean tie; the first is picked and the tie reported", () => {
    const r = bucketProbabilities(normal(10, 2), parseBuckets("<10, >=10"));
    expect(r.buckets[0]!.p).toBeCloseTo(0.5, 7);
    expect(r.ties).toEqual([0, 1]);
    expect(r.best).toBe(0);
    expect(r.warnings.join(" ")).toContain("tie");
  });

  it("degenerate sd 0: all mass on the mean, inclusion decides the boundary", () => {
    expect(ps(normal(10, 0), thresholdBuckets([5, 10, 15]))).toEqual([0, 0, 1, 0]);
    expect(ps(normal(10, 0), thresholdBuckets([5, 10, 15], "upper"))).toEqual([0, 1, 0, 0]);
    expect(ps(normal(10, 0), [{ lo: 10, hi: 10, hiClosed: true }])).toEqual([1]);
    expect(ps(normal(10, 0), [{ lo: 10, hi: 10, loClosed: false }])).toEqual([0]);
    expect(bucketProbabilities(normal(10, 0), [{ lo: 0 }]).warnings[0]).toContain("sd is 0");
  });

  it("gaps and overlaps show in coverage and share", () => {
    const r = bucketProbabilities(normal(0, 1), [
      { lo: -1, hi: 1 },
      { lo: 0, hi: 2 },
    ]);
    expect(r.coverage).toBeGreaterThan(1);
    expect(r.buckets.reduce((s, b) => s + b.share, 0)).toBeCloseTo(1, 12);
    expect(r.warnings.join(" ")).toContain("cover");
    const gap = bucketProbabilities(normal(0, 1), [{ hi: -1 }, { lo: 1 }]);
    expect(gap.coverage).toBeCloseTo(2 * normalCdf(-1), 7);
  });

  it("an infinite end is the same as an open end", () => {
    const a = ps(normal(0, 1), [
      { lo: Number.NEGATIVE_INFINITY, hi: 0 },
      { lo: 0, hi: Infinity },
    ]);
    expect(a[0]).toBeCloseTo(0.5, 7);
    expect(a[1]).toBeCloseTo(0.5, 7);
  });

  it("probabilities never leave [0, 1], even far in the tails", () => {
    for (const p of ps(normal(0, 1), thresholdBuckets([-40, -10, 0, 10, 40]))) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("refuses invalid input", () => {
    expect(() => bucketProbabilities(normal(0, 1), [])).toThrow("no buckets");
    expect(() => bucketProbabilities(normal(Number.NaN, 1), [{ lo: 0 }])).toThrow(RangeError);
    expect(() => bucketProbabilities(normal(0, -1), [{ lo: 0 }])).toThrow(RangeError);
    expect(() => bucketProbabilities(normal(0, Infinity), [{ lo: 0 }])).toThrow(RangeError);
    expect(() => bucketProbabilities(normal(0, 1), [{ lo: 2, hi: 1 }])).toThrow("inverted");
    expect(() => bucketProbabilities(normal(0, 1), [{ lo: Number.NaN }])).toThrow("NaN");
  });
});

describe("bucketProbabilities — quantiles", () => {
  it("linear between quantiles, exponential tails that keep the given tail mass", () => {
    const q = quantiles([0.1, 38], [0.5, 42], [0.9, 47]);
    const [a, b, c] = ps(q, parseBuckets("<40, 40-45, >=45"));
    expect(a).toBeCloseTo(0.1 + 0.4 * (2 / 4), 12); // 0.3
    expect(b).toBeCloseTo(0.4 * (2 / 4) + 0.4 * (3 / 5), 12); // 0.44
    expect(c).toBeCloseTo(0.4 * (2 / 5) + 0.1, 12); // 0.26
    expect(ps(q, [{ hi: 38 }])[0]).toBeCloseTo(0.1, 12);
    expect(ps(q, [{ lo: 47 }])[0]).toBeCloseTo(0.1, 12);
    // Tails decay but stay positive.
    const far = ps(q, [{ hi: 30 }, { lo: 60 }]);
    expect(far[0]).toBeGreaterThan(0);
    expect(far[0]).toBeLessThan(0.1);
    expect(far[1]).toBeGreaterThan(0);
    expect(far[1]).toBeLessThan(0.1);
  });

  it("levels 0 and 1 bound the support", () => {
    const q = quantiles([0, 10], [1, 20]);
    expect(ps(q, [{ hi: 10 }, { lo: 10, hi: 15 }, { lo: 15, hi: 20 }, { lo: 20 }])).toEqual([
      0, 0.5, 0.5, 0,
    ]);
  });

  it("tied quantile values are an atom; inclusion decides who gets it", () => {
    const q = quantiles([0.1, 5], [0.5, 5], [0.9, 10]);
    const cdf = predictiveCdf(q);
    expect(cdf.below(5)).toBeCloseTo(0.1, 12);
    expect(cdf.atMost(5)).toBeCloseTo(0.5, 12);
    expect(ps(q, [{ hi: 5 }])[0]).toBeCloseTo(0.1, 12);
    expect(ps(q, [{ hi: 5, hiClosed: true }])[0]).toBeCloseTo(0.5, 12);
    // An interior atom.
    const mid = quantiles([0.1, 0], [0.3, 5], [0.6, 5], [0.9, 10]);
    expect(ps(mid, [{ lo: 5, hi: 5, hiClosed: true }])[0]).toBeCloseTo(0.3, 12);
    expect(
      ps(mid, [
        { lo: 0, hi: 5 },
        { lo: 5, hi: 10 },
      ]),
    ).toEqual([expect.closeTo(0.2, 12), expect.closeTo(0.6, 12)]);
  });

  it("all quantiles equal is a point mass", () => {
    const r = bucketProbabilities(quantiles([0.1, 3], [0.9, 3]), thresholdBuckets([3]));
    expect(r.buckets.map((b) => b.p)).toEqual([0, 1]);
    expect(r.warnings.join(" ")).toContain("same value");
  });

  it("crossed quantiles are sorted with a warning", () => {
    const r = bucketProbabilities(quantiles([0.1, 50], [0.5, 40], [0.9, 60]), [{ hi: 50 }]);
    expect(r.buckets[0]!.p).toBeCloseTo(0.5, 12);
    expect(r.warnings.join(" ")).toContain("crossed");
  });

  it("order of the given quantiles does not matter", () => {
    const a = ps(quantiles([0.9, 47], [0.1, 38], [0.5, 42]), thresholdBuckets([40, 45]));
    const b = ps(quantiles([0.1, 38], [0.5, 42], [0.9, 47]), thresholdBuckets([40, 45]));
    expect(a).toEqual(b);
  });

  it("refuses unusable quantiles", () => {
    expect(() => predictiveCdf(quantiles())).toThrow(RangeError);
    expect(() => predictiveCdf(quantiles([0.5, 3]))).toThrow("at least two");
    expect(() => predictiveCdf(quantiles([1.5, 3], [0.5, 2]))).toThrow("level");
    expect(() => predictiveCdf(quantiles([0.1, Number.NaN], [0.5, 2]))).toThrow("finite");
    expect(() => predictiveCdf(quantiles([0.5, 1], [0.5, 2]))).toThrow("two values");
  });
});

describe("thresholdBuckets and formatBucket", () => {
  it("dedups and sorts thresholds; open ends at both sides", () => {
    const b = thresholdBuckets([20, 10, 20]);
    expect(b.map(formatBucket)).toEqual(["< 10", "[10, 20)", "≥ 20"]);
    expect(thresholdBuckets([10, 20], "upper").map(formatBucket)).toEqual([
      "≤ 10",
      "(10, 20]",
      "> 20",
    ]);
    expect(() => thresholdBuckets([])).toThrow(RangeError);
    expect(() => thresholdBuckets([Number.NaN])).toThrow(RangeError);
    expect(formatBucket({})).toBe("any value");
    expect(formatBucket({ lo: 2.5, hi: 2.5, hiClosed: true })).toBe("= 2.5");
  });
});

describe("parseBuckets", () => {
  it("reads comparison, range, bracket, plus and point forms", () => {
    expect(parseBuckets("<10, <=10, >20, >=20, 10-20, 10..20, 10 to 20, 5+, 7, =8")).toEqual([
      { hi: 10, hiClosed: false, label: "<10" },
      { hi: 10, hiClosed: true, label: "<=10" },
      { lo: 20, loClosed: false, label: ">20" },
      { lo: 20, loClosed: true, label: ">=20" },
      { lo: 10, hi: 20, label: "10-20" },
      { lo: 10, hi: 20, label: "10..20" },
      { lo: 10, hi: 20, label: "10 to 20" },
      { lo: 5, loClosed: true, label: "5+" },
      { lo: 7, hi: 7, loClosed: true, hiClosed: true, label: "7" },
      { lo: 8, hi: 8, loClosed: true, hiClosed: true, label: "=8" },
    ]);
  });

  it("reads words, unicode comparisons, negatives, percents and dollars", () => {
    expect(parseBuckets("below 3%; 3%-4%; at least 4%")).toEqual([
      { hi: 3, hiClosed: false, label: "below 3%" },
      { lo: 3, hi: 4, label: "3%-4%" },
      { lo: 4, loClosed: true, label: "at least 4%" },
    ]);
    expect(parseBuckets("≤ -5 | -5--1 | > -1")).toEqual([
      { hi: -5, hiClosed: true, label: "≤ -5" },
      { lo: -5, hi: -1, label: "-5--1" },
      { lo: -1, loClosed: false, label: "> -1" },
    ]);
    expect(parseBuckets("under $1.5e3")[0]).toMatchObject({ hi: 1500 });
  });

  it("brackets set both ends, infinities become open ends, commas inside brackets are kept", () => {
    expect(parseBuckets("[1, 2], (2, 3), (-inf, 1), [3, inf)")).toEqual([
      { lo: 1, hi: 2, loClosed: true, hiClosed: true, label: "[1, 2]" },
      { lo: 2, hi: 3, loClosed: false, hiClosed: false, label: "(2, 3)" },
      { hi: 1, loClosed: false, hiClosed: false, label: "(-inf, 1)" },
      { lo: 3, loClosed: true, hiClosed: false, label: "[3, inf)" },
    ]);
  });

  it("keeps labels for multiple-choice options", () => {
    const b = parseBuckets("A: <40; B: 40-45; C: >=45");
    expect(b.map((x) => x.label)).toEqual(["A", "B", "C"]);
    const r = bucketProbabilities(normal(43, 1), b);
    expect(r.buckets[r.best]!.label).toBe("B");
  });

  it("names the item it cannot read", () => {
    expect(() => parseBuckets("")).toThrow("no buckets");
    expect(() => parseBuckets("<10, lots")).toThrow('"lots"');
    expect(() => parseBuckets("10-")).toThrow(RangeError);
  });
});
