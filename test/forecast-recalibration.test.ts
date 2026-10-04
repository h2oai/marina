// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { adjustForecast, DEFAULT_ADJUST, fixedSlope } from "../src/forecast/adjust";
import type { AnswerSpec } from "../src/forecast/answer-types";
import { logOddsDistributions, logOddsMarginals } from "../src/forecast/distribution";
import { forecastFormed } from "../src/forecast/formations";
import {
  memoryHistory,
  priorBucket,
  type ResolvedRecord,
  resolvedRecord,
} from "../src/forecast/history";
import { fitShrinkWeight } from "../src/forecast/prior";
import { applyCalibration, fitCalibration, fitPlatt } from "../src/forecast/recalibration";
import { chooseFormation, pairedGain } from "../src/forecast/routing";
import type { ModelPart, TypedForecastAnswer } from "../src/forecast/typed";

const yn: AnswerSpec = {
  type: "choice",
  options: [
    { id: "Yes", label: "Yes" },
    { id: "No", label: "No" },
  ],
  probabilities: true,
};
const CUTOFF = "2026-09-01T00:00:00.000Z";

/** An overconfident forecaster: says 0.95/0.05 but is right only 70 % of the time. */
function overconfident(n: number, startDay = 1): ResolvedRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const saysYes = i % 2 === 0;
    const right = (i * 7) % 10 < 7;
    const y = right ? saysYes : !saysYes;
    const p = saysYes ? 0.95 : 0.05;
    return resolvedRecord({
      id: `c${i}`,
      spec: yn,
      resolvedAt: new Date(Date.UTC(2026, 7, startDay + Math.floor(i / 5))).toISOString(),
      numbers: { distribution: { Yes: p, No: 1 - p } },
      truth: { options: [y ? "Yes" : "No"] },
    });
  });
}

describe("recalibration", () => {
  it("fits a tempering Platt map for an overconfident forecaster and adopts it held-out", () => {
    const fit = fitCalibration({
      spec: yn,
      history: overconfident(100),
      forecastOf: (r) => r.raw,
      margin: 0.05,
      minRecords: 50,
      score: "brier",
    })!;
    expect(fit.adopted).toBe(true);
    expect(fit.params.kind).toBe("platt");
    if (fit.params.kind === "platt") expect(fit.params.a).toBeLessThan(1);
    const out = applyCalibration(fit.group, fit.params, { distribution: { Yes: 0.95, No: 0.05 } });
    expect(out.distribution!.Yes).toBeLessThan(0.9);
    expect(out.distribution!.Yes).toBeGreaterThan(0.5); // monotone: the argmax stays
  });

  it("keeps identity without a held-out win or with too little history", () => {
    const calibrated = Array.from({ length: 100 }, (_, i) => {
      const p = 0.5;
      return resolvedRecord({
        id: `k${i}`,
        spec: yn,
        resolvedAt: new Date(Date.UTC(2026, 7, 1 + Math.floor(i / 5))).toISOString(),
        numbers: { distribution: { Yes: p, No: 1 - p } },
        truth: { options: [i % 2 ? "Yes" : "No"] },
      });
    });
    const fit = fitCalibration({
      spec: yn,
      history: calibrated,
      forecastOf: (r) => r.raw,
      margin: 0.05,
      minRecords: 50,
      score: "brier",
    })!;
    expect(fit.adopted).toBe(false);
    expect(fit.params.kind).toBe("identity");
    const few = fitCalibration({
      spec: yn,
      history: overconfident(20),
      forecastOf: (r) => r.raw,
      margin: 0.05,
      minRecords: 50,
      score: "brier",
    })!;
    expect(few.adopted).toBe(false);
  });

  it("Platt is bounded and near identity on calibrated data", () => {
    const pts = Array.from({ length: 400 }, (_, i) => {
      const p = 0.1 + (0.8 * ((i * 13) % 100)) / 100;
      return { z: Math.log(p / (1 - p)), y: ((i * 31) % 100) / 100 < p ? 1 : 0 };
    });
    const f = fitPlatt(pts)!;
    expect(f.a).toBeGreaterThan(0.6);
    expect(f.a).toBeLessThan(1.6);
    expect(fitPlatt([])).toBeUndefined();
  });

  it("never fits on history resolved after the cutoff", async () => {
    // Only FUTURE records are overconfident; visible ones are too few to fit.
    const future = overconfident(200).map((r) => ({
      ...r,
      resolvedAt: "2026-09-15T00:00:00.000Z",
    }));
    const a: TypedForecastAnswer = {
      question: "q",
      answer: yn,
      runs: [],
      research: [],
      sources: [],
      costUsd: 0,
      latencyMs: 0,
      cutoff: { at: CUTOFF, basis: "asOf", pastCutoff: true },
      distribution: { Yes: 0.95, No: 0.05 },
      prediction: "Yes",
      formatted: "Yes",
    };
    await adjustForecast(
      a,
      { question: "q", answer: yn },
      {
        ...DEFAULT_ADJUST,
        calibration: "on",
        history: memoryHistory(future),
      },
    );
    expect(a.adjustment?.history.visible).toBe(0);
    expect(a.adjustment?.calibration?.applied).toBe(false);
    expect(a.distribution!.Yes).toBeCloseTo(0.95, 3);
  });
});

const retriever = async () => ({
  report: "- 2026-08-20 — a fact ([src](https://example.org/1))",
  sources: [{ url: "https://example.org/1" }],
  costUsd: 0,
  searches: 1,
  retriever: "fake",
});
const part = (name: string, reply: (system: string, user: string) => string): ModelPart => ({
  name,
  complete: async (s, u) => reply(s, u),
});
const planner = part("planner", (system) =>
  system.startsWith("You plan research")
    ? '{"restatement":"Q","queries":["q"]}'
    : system.startsWith("You review")
      ? '{"done":true}'
      : "{}",
);

describe("skeptic crew", () => {
  const member = (name: string, p: number) =>
    part(name, () =>
      JSON.stringify({
        answer: p >= 0.5 ? "Yes" : "No",
        probabilities: { Yes: p, No: 1 - p },
        reason: name,
      }),
    );
  const skeptic = (trust: number) =>
    part("skeptic", () => JSON.stringify({ trust, critique: "c" }));
  const run = (trust: number, priors?: Parameters<typeof forecastFormed>[0]["priors"]) =>
    forecastFormed(
      { question: "Will it?", answer: yn, asOf: CUTOFF, ...(priors ? { priors } : {}) },
      {
        retriever,
        analysts: [member("stat", 0.9), member("analyst", 0.8)],
        planner,
        critic: skeptic(trust),
        now: () => new Date("2026-10-01T00:00:00Z"),
        options: { researchRounds: 1 },
      },
      "skeptic",
    );

  it("only shrinks toward the prior: trust 0 is the prior, trust 1 the proposals", async () => {
    const market = [
      { source: "market" as const, distribution: { Yes: 0.3 }, at: "2026-08-30T00:00:00Z" },
    ];
    const zero = await run(0, market);
    expect(zero.distribution!.Yes).toBeCloseTo(0.3, 2);
    const full = await run(1, market);
    const half = await run(0.5, market);
    expect(full.distribution!.Yes).toBeGreaterThan(half.distribution!.Yes!);
    expect(half.distribution!.Yes).toBeGreaterThan(0.3);
    // Never more extreme than the proposals' mean.
    expect(full.distribution!.Yes).toBeLessThanOrEqual(0.9);
    expect(full.formation.crew?.start.source).toBe("market");
    expect(full.formation.crew?.roles.skeptic).toBe("skeptic");
  });

  it("without an informative prior files the proposals' log-odds mean, unshrunk", async () => {
    const a = await run(-3);
    // Geometric mean of 0.9 and 0.8 (renormalised), not pulled toward 0.5.
    const g = Math.sqrt(0.9 * 0.8);
    expect(a.distribution!.Yes).toBeCloseTo(g / (g + Math.sqrt(0.1 * 0.2)), 2);
    expect(a.formation.crew?.trust).toBe(0);
    expect(a.formation.crew?.note).toContain("no informative prior");
  });

  it("degrades to one model", async () => {
    const a = await forecastFormed(
      { question: "Will it?", answer: yn, asOf: CUTOFF },
      {
        retriever,
        analysts: [
          part("solo", (system) =>
            system.startsWith("You are the skeptic")
              ? '{"trust":1}'
              : system.startsWith("You plan")
                ? '{"queries":["q"]}'
                : system.startsWith("You review")
                  ? '{"done":true}'
                  : '{"answer":"Yes","probabilities":{"Yes":0.7,"No":0.3}}',
          ),
        ],
        now: () => new Date("2026-10-01T00:00:00Z"),
        options: { researchRounds: 1 },
      },
      "skeptic",
    );
    expect(a.formation.crew?.roles).toEqual({
      statistician: "solo",
      analyst: "solo",
      skeptic: "solo",
    });
    expect(a.distribution!.Yes).toBeCloseTo(0.7, 2);
  });
});

describe("formation routing", () => {
  const rec = (id: number, formation: string, score: number): ResolvedRecord => ({
    ...resolvedRecord({
      id: `r${id}`,
      spec: yn,
      resolvedAt: "2026-08-10T00:00:00Z",
      numbers: { distribution: { Yes: 0.5, No: 0.5 } },
      truth: { options: ["Yes"] },
      formation,
      score,
    }),
  });
  const settings = {
    mode: "on" as const,
    candidates: ["ensemble" as const, "skeptic" as const],
    minN: 30,
  };

  it("routes to a challenger only with a paired win above the margin; else falls open", () => {
    const history: ResolvedRecord[] = [];
    for (let i = 0; i < 40; i++) {
      history.push(rec(i, "ensemble", 0.6 + (i % 5) * 0.01));
      history.push(rec(i, "skeptic", 0.7 + (i % 5) * 0.01));
    }
    const d = chooseFormation({ spec: yn, history, defaultFormation: "ensemble", settings });
    expect(d.chosen).toBe("skeptic");
    const weak = history.map((r) =>
      r.formation === "skeptic" ? { ...r, score: r.score! - 0.095 } : r,
    );
    expect(
      chooseFormation({ spec: yn, history: weak, defaultFormation: "ensemble", settings }).chosen,
    ).toBe("ensemble");
    const few = history.slice(0, 20);
    const f = chooseFormation({ spec: yn, history: few, defaultFormation: "ensemble", settings });
    expect(f.chosen).toBe("ensemble");
    expect(f.challengers[0]?.verdict).toBe("too few paired");
    const observe = chooseFormation({
      spec: yn,
      history,
      defaultFormation: "ensemble",
      settings: { ...settings, mode: "observe" },
    });
    expect(observe.picked).toBe("skeptic");
    expect(observe.chosen).toBe("ensemble");
  });

  it("pairs on common questions", () => {
    const g = pairedGain([
      { challenger: 1, incumbent: 0 },
      { challenger: 1, incumbent: 0 },
    ]);
    expect(g.gain).toBe(1);
    expect(g.ci[0]).toBe(1);
  });
});

describe("cold start, pooling and tail guard", () => {
  const answer = (d: Record<string, number>): TypedForecastAnswer => ({
    question: "q",
    answer: yn,
    runs: [],
    research: [],
    sources: [],
    costUsd: 0,
    latencyMs: 0,
    cutoff: { at: CUTOFF, basis: "asOf", pastCutoff: true },
    distribution: d,
    prediction: "Yes",
    formatted: "Yes",
  });

  it("a fixed slope extremizes from the first forecast, with no history", async () => {
    const a = answer({ Yes: 0.7, No: 0.3 });
    await adjustForecast(
      a,
      { question: "q", answer: yn },
      {
        ...DEFAULT_ADJUST,
        calibration: "fixed",
        fixedSlope: Math.sqrt(3),
      },
    );
    const expected = 1 / (1 + Math.exp(-Math.sqrt(3) * Math.log(0.7 / 0.3)));
    expect(a.distribution!.Yes).toBeCloseTo(expected, 3);
    expect(a.adjustment?.calibration?.score).toBe("fixed");
    expect(fixedSlope("sqrt3")).toBeCloseTo(Math.sqrt(3), 6);
    expect(fixedSlope("9")).toBeUndefined();
  });

  it("the tail guard clamps final probabilities", async () => {
    const a = answer({ Yes: 0.999, No: 0.001 });
    await adjustForecast(a, { question: "q", answer: yn }, { ...DEFAULT_ADJUST, clamp: 0.02 });
    expect(a.distribution!.Yes).toBeLessThanOrEqual(0.98);
    expect(a.distribution!.No).toBeGreaterThanOrEqual(0.02);
  });

  it("never shrinks toward the uniform type default", async () => {
    const a = answer({ Yes: 0.9, No: 0.1 });
    await adjustForecast(
      a,
      { question: "q", answer: yn },
      {
        ...DEFAULT_ADJUST,
        prior: "on",
        priorWeight: 1,
      },
    );
    expect(a.adjustment?.prior?.source).toBe("type-default");
    expect(a.adjustment?.shrink).toBeUndefined();
    expect(a.distribution!.Yes).toBeCloseTo(0.9, 3);
  });

  it("log-odds pooling keeps agreeing confident runs confident", () => {
    const items = [
      { distribution: { Yes: 0.9, No: 0.1 }, weight: 1 },
      { distribution: { Yes: 0.6, No: 0.4 }, weight: 1 },
    ];
    const g = logOddsDistributions(items)!;
    const g9 = Math.sqrt(0.9 * 0.6);
    expect(g.Yes).toBeCloseTo(g9 / (g9 + Math.sqrt(0.1 * 0.4)), 3);
    const m = logOddsMarginals(items)!;
    expect(m.Yes).toBeCloseTo(1 / (1 + Math.exp(-(Math.log(9) + Math.log(1.5)) / 2)), 3);
  });

  it("fits the prior weight per time-to-close bucket when the bucket has the records", () => {
    const rec = (i: number, horizonDays: number, follow: boolean): ResolvedRecord =>
      resolvedRecord({
        id: `h${i}`,
        spec: yn,
        resolvedAt: new Date(Date.UTC(2026, 7, 1 + (i % 28))).toISOString(),
        numbers: { distribution: { Yes: 0.5, No: 0.5 } },
        prior: { source: "market", distribution: { Yes: 0.9, No: 0.1 }, horizonDays },
        truth: { options: [follow ? "Yes" : i % 2 ? "Yes" : "No"] },
      });
    // Near the close the market is right; far from it, a coin.
    const history = [
      ...Array.from({ length: 60 }, (_, i) => rec(i, 3, true)),
      ...Array.from({ length: 60 }, (_, i) => rec(100 + i, 90, false)),
    ];
    const near = fitShrinkWeight({
      spec: yn,
      source: "market",
      history,
      priorWeight: 0,
      margin: 0.05,
      minRecords: 50,
      score: "brier",
      context: { horizonDays: 2 },
    });
    expect(near.bucket).toBe("≤ 7 d");
    expect(near.params).toBeGreaterThan(0.7);
    expect(priorBucket({ horizonDays: 40, liquidity: 50_000 })).toBe("> 30 d, liquidity ≥ $10k");
  });
});
