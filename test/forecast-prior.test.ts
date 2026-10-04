// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adjustActive,
  adjustForecast,
  adjustSettingsFromEnv,
  DEFAULT_ADJUST,
  implicitForecast,
} from "../src/forecast/adjust";
import type { AnswerSpec } from "../src/forecast/answer-types";
import { logit } from "../src/forecast/fitting";
import { forecastFormed, formationFromEnv } from "../src/forecast/formations";
import {
  jsonlHistory,
  labelKeys,
  memoryHistory,
  type ResolvedRecord,
  resolvedRecord,
  visibleRecords,
} from "../src/forecast/history";
import { baseRate, choosePrior, fitShrinkWeight, shrink, yesNo } from "../src/forecast/prior";
import { routeSettingsFromEnv } from "../src/forecast/routing";
import { typedOptionsFromEnv } from "../src/forecast/service";
import { forecastTyped, type ModelPart, type TypedForecastAnswer } from "../src/forecast/typed";

const yn: AnswerSpec = {
  type: "choice",
  options: [
    { id: "Yes", label: "Yes" },
    { id: "No", label: "No" },
  ],
  probabilities: true,
};
const CUTOFF = "2026-09-01T00:00:00.000Z";

/** A resolved yes/no record: the forecaster said `p` for Yes, the market said `m`, it resolved `y`. */
function binaryRecord(i: number, p: number, m: number, y: boolean, day = 1): ResolvedRecord {
  return resolvedRecord({
    id: `q${i}`,
    spec: yn,
    resolvedAt: new Date(Date.UTC(2026, 7, day, 0, i % 60)).toISOString(),
    numbers: { distribution: { Yes: p, No: 1 - p } },
    prior: { source: "market", distribution: { Yes: m, No: 1 - m } },
    truth: { options: [y ? "Yes" : "No"] },
  });
}

function answerFor(spec: AnswerSpec, d?: Record<string, number>): TypedForecastAnswer {
  return {
    question: "q",
    answer: spec,
    runs: [],
    research: [],
    sources: [],
    costUsd: 0,
    latencyMs: 0,
    cutoff: { at: CUTOFF, basis: "asOf", pastCutoff: true },
    ...(d
      ? {
          distribution: d,
          prediction: (d.Yes ?? 0) >= 0.5 ? "Yes" : "No",
          formatted: (d.Yes ?? 0) >= 0.5 ? "Yes" : "No",
        }
      : {}),
  };
}

describe("history visibility (the leakage rule)", () => {
  it("keeps only records resolved at or before the cutoff, never the question itself", () => {
    const rs = [
      binaryRecord(1, 0.6, 0.5, true, 10),
      binaryRecord(2, 0.6, 0.5, true, 31),
      { ...binaryRecord(3, 0.6, 0.5, true, 5), resolvedAt: "2026-09-01T00:00:01.000Z" },
      binaryRecord(4, 0.6, 0.5, true, 2),
    ];
    const v = visibleRecords(rs, CUTOFF, "q4");
    expect(v.map((r) => r.id)).toEqual(["q1", "q2"]);
    expect(v.every((r) => r.resolvedAt <= CUTOFF)).toBe(true);
  });

  it("a JSON-lines history round-trips and skips a torn line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forecast-history-"));
    try {
      const h = jsonlHistory(join(dir, "h.jsonl"));
      await h.add(binaryRecord(1, 0.7, 0.6, true));
      await h.add(binaryRecord(2, 0.3, 0.4, false));
      expect((await h.all()).map((r) => r.id)).toEqual(["q1", "q2"]);
      // No question text is ever stored: labels are hashes.
      expect(JSON.stringify(await h.all())).not.toContain('"Yes":"Yes"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("choosing a prior", () => {
  it("uses a supplied market price observed by the cutoff", () => {
    const c = choosePrior({
      spec: yn,
      cutoff: CUTOFF,
      supplied: [{ source: "market", distribution: { Yes: 0.7 }, at: "2026-08-30T00:00:00Z" }],
    });
    expect(c.prior?.source).toBe("market");
    expect(c.prior?.distribution?.Yes).toBeCloseTo(0.7, 3);
    expect(c.prior?.distribution?.No).toBeCloseTo(0.3, 3);
  });

  it("rejects a supplied prior observed after the cutoff (it would carry the future)", () => {
    const c = choosePrior({
      spec: yn,
      cutoff: CUTOFF,
      supplied: [{ source: "market", distribution: { Yes: 0.99 }, at: "2026-09-02T00:00:00Z" }],
    });
    expect(c.prior?.source).toBe("type-default");
    expect(c.rejected?.[0]?.reason).toContain("after the cutoff");
  });

  it("takes a lookup price only for a yes/no question with exactly one priced market", () => {
    const price = (p: number, at = "2026-08-31T12:00:00.000Z") => ({
      venue: "kalshi",
      market: "m",
      outcome: "Yes",
      p,
      at,
    });
    const one = choosePrior({
      spec: yn,
      cutoff: CUTOFF,
      lookups: [{ name: "kalshi", lines: [], sources: [], prices: [price(0.2)] }],
    });
    expect(one.prior?.source).toBe("market-lookup");
    expect(one.prior?.distribution?.Yes).toBeCloseTo(0.2, 3);
    const two = choosePrior({
      spec: yn,
      cutoff: CUTOFF,
      lookups: [{ name: "kalshi", lines: [], sources: [], prices: [price(0.2), price(0.4)] }],
    });
    expect(two.prior?.source).toBe("type-default");
    // A price stamped after the cutoff never counts.
    const late = choosePrior({
      spec: yn,
      cutoff: CUTOFF,
      lookups: [
        { name: "kalshi", lines: [], sources: [], prices: [price(0.2, "2026-09-03T00:00:00Z")] },
      ],
    });
    expect(late.prior?.source).toBe("type-default");
    expect(yesNo({ type: "choice", options: [{ id: "A" }, { id: "B" }] })).toBeUndefined();
  });

  it("falls back to the label base rate, then the type default", () => {
    const history = Array.from({ length: 20 }, (_, i) => binaryRecord(i, 0.5, 0.5, i < 5));
    const b = baseRate(yn, history);
    expect(b?.source).toBe("base-rate");
    // 5 of 20 resolved Yes, smoothed toward ½.
    expect(b!.distribution!.Yes).toBeLessThan(0.4);
    expect(b!.distribution!.Yes).toBeGreaterThan(0.2);
    expect(baseRate(yn, history.slice(0, 3))).toBeUndefined();
    const four: AnswerSpec = {
      type: "choice",
      options: ["a", "b", "c", "d"].map((id) => ({ id, label: `Label ${id}` })),
    };
    expect(choosePrior({ spec: four, cutoff: CUTOFF }).prior?.distribution?.a).toBeCloseTo(0.25, 3);
    expect(labelKeys(four.type === "choice" ? four.options : []).a).toHaveLength(12);
  });

  it("uses a multi-select class base rate from the asker's category", () => {
    const multi: AnswerSpec = {
      type: "multi",
      options: [{ id: "d1" }, { id: "d2" }],
      minPicks: 0,
      probabilities: true,
    };
    const history = Array.from({ length: 12 }, (_, i) =>
      resolvedRecord({
        id: `m${i}`,
        spec: multi,
        resolvedAt: "2026-08-10T00:00:00Z",
        numbers: { distribution: { d1: 0.5 } },
        truth: { options: i < 3 ? ["d1"] : [] },
        resolvedOptions: ["d1"],
        category: "series:x",
      }),
    );
    const c = choosePrior({ spec: multi, cutoff: CUTOFF, history, category: "series:x" });
    expect(c.prior?.source).toBe("base-rate");
    expect(c.prior?.detail).toContain("class series:x");
    expect(c.prior!.distribution!.d1).toBeLessThan(0.4);
  });
});

describe("shrinking toward the prior", () => {
  it("pools a binary forecast in log-odds", () => {
    const f = shrink(
      "choice",
      { distribution: { Yes: 0.9, No: 0.1 } },
      { distribution: { Yes: 0.5, No: 0.5 } },
      0.5,
    );
    const expected = 1 / (1 + Math.exp(-(0.5 * logit(0.9))));
    expect(f.distribution!.Yes).toBeCloseTo(expected, 3);
    const n = shrink("number", { value: 10, sd: 2 }, { value: 0, sd: 1 }, 0.25);
    expect(n.value).toBeCloseTo(7.5, 6);
    expect(n.sd).toBeCloseTo(1.75, 6);
  });

  it("fits the weight on older history and adopts it only on a held-out win", () => {
    // An overconfident forecaster next to a calibrated market: pooling toward the market helps.
    const rs: ResolvedRecord[] = [];
    for (let i = 0; i < 100; i++) {
      const m = 0.2 + (0.6 * ((i * 37) % 100)) / 100;
      const y = ((i * 53) % 100) / 100 < m;
      const p = y ? 0.97 : 0.6; // loud when wrong half the time
      rs.push(binaryRecord(i, i % 2 ? p : 1 - p, m, i % 2 ? y : !y, 1 + Math.floor(i / 4)));
    }
    const w = fitShrinkWeight({
      spec: yn,
      source: "market",
      history: visibleRecords(rs, CUTOFF),
      priorWeight: 0,
      margin: 0.05,
      minRecords: 50,
      score: "brier",
    });
    expect(w.adopted).toBe(true);
    expect(w.params).toBeGreaterThan(0.3);
    expect(w.through! <= CUTOFF).toBe(true);
    const few = fitShrinkWeight({
      spec: yn,
      source: "market",
      history: rs.slice(0, 10),
      priorWeight: 0.5,
      margin: 0.05,
      minRecords: 50,
      score: "brier",
    });
    expect(few.adopted).toBe(false);
    expect(few.params).toBe(0.5);
    expect(few.reason).toContain("insufficient history");
  });
});

describe("the adjustment stage", () => {
  it("records raw, prior and weight; uses only history visible at the cutoff", async () => {
    // Visible history: a forecaster that should listen to the market.
    const past = Array.from({ length: 60 }, (_, i) =>
      binaryRecord(i, i % 2 ? 0.95 : 0.05, i % 3 ? 0.5 : 0.5, i % 4 === 0, 1 + (i % 25)),
    );
    // Future records that would say the opposite — they must not count.
    const future = Array.from({ length: 200 }, (_, i) => ({
      ...binaryRecord(1000 + i, 0.95, 0.5, true),
      resolvedAt: "2026-09-20T00:00:00.000Z",
    }));
    const history = memoryHistory([...past, ...future]);
    const a = answerFor(yn, { Yes: 0.9, No: 0.1 });
    await adjustForecast(
      a,
      {
        question: "q",
        answer: yn,
        priors: [{ source: "market", distribution: { Yes: 0.5 }, at: "2026-08-31T00:00:00Z" }],
      },
      { ...DEFAULT_ADJUST, prior: "on", history },
    );
    expect(a.adjustment?.history.visible).toBe(60);
    expect(a.adjustment!.history.through! <= CUTOFF).toBe(true);
    expect(a.adjustment?.raw.distribution?.Yes).toBeCloseTo(0.9, 3);
    expect(a.adjustment?.prior?.source).toBe("market");
    expect((a.adjustment?.shrink?.through ?? "") <= CUTOFF).toBe(true);
    expect(a.distribution!.Yes).toBeLessThan(0.9);
  });

  it("is off by default and leaves a pick-only answer's pick unless its mode moves", async () => {
    const pickOnly: AnswerSpec = {
      type: "choice",
      options: [
        { id: "Yes", label: "Yes" },
        { id: "No", label: "No" },
      ],
    };
    const a: TypedForecastAnswer = {
      ...answerFor(pickOnly),
      prediction: "Yes",
      formatted: "Yes",
      runs: [
        {
          run: 1,
          model: "m",
          value: "Yes",
          formatted: "Yes",
          confidence: 0.55,
          weight: 1,
          status: "ok",
        },
        {
          run: 2,
          model: "m",
          value: "No",
          formatted: "No",
          confidence: 0.52,
          weight: 1,
          status: "ok",
        },
        {
          run: 3,
          model: "m",
          value: "Yes",
          formatted: "Yes",
          confidence: 0.55,
          weight: 1,
          status: "ok",
        },
      ],
    };
    expect(implicitForecast(pickOnly, a)?.implicit).toBe(true);
    // A supplied market at 10 % Yes with full weight moves the mode: the pick changes, recorded.
    await adjustForecast(
      a,
      {
        question: "q",
        answer: pickOnly,
        priors: [{ source: "market", distribution: { Yes: 0.1 }, at: "2026-08-31T00:00:00Z" }],
      },
      { ...DEFAULT_ADJUST, prior: "on", priorWeight: 0.9 },
    );
    expect(a.prediction).toBe("No");
    expect(a.adjustment?.replaced).toBe("Yes");
    expect(a.distribution).toBeUndefined();
  });
});

describe("defaults: unset settings change nothing", () => {
  it("an environment with no forecast settings turns no mechanism on", () => {
    const s = adjustSettingsFromEnv({});
    expect(adjustActive(s)).toBe(false);
    expect(s.history).toBeUndefined();
    expect(typedOptionsFromEnv({}).pool).toBeUndefined();
    expect(routeSettingsFromEnv({}).mode).toBe("off");
    expect(formationFromEnv({})).toBe("ensemble");
  });

  it("the ensemble formation with settings unset answers exactly as the typed forecaster", async () => {
    const part = (name: string): ModelPart => ({
      name,
      complete: async (system) =>
        system.startsWith("You plan research")
          ? '{"queries":["q"]}'
          : system.startsWith("You review")
            ? '{"done":true}'
            : '{"answer":"Yes","probabilities":{"Yes":0.8,"No":0.2},"reason":"r"}',
    });
    const deps = {
      retriever: async () => ({
        report: "- 2026-08-20 — a fact ([src](https://example.org/1))",
        sources: [{ url: "https://example.org/1" }],
        costUsd: 0,
        searches: 1,
        retriever: "fake",
      }),
      analysts: [part("a"), part("b")],
      now: () => new Date("2026-10-01T00:00:00Z"),
      options: { researchRounds: 1, critique: false },
      adjust: adjustSettingsFromEnv({}),
    };
    const req = { question: "Will it?", answer: yn, asOf: CUTOFF };
    const typed = await forecastTyped(req, deps);
    const formed = await forecastFormed(req, deps, "ensemble");
    expect(formed.adjustment).toBeUndefined();
    expect(formed.distribution).toEqual(typed.distribution);
    expect(formed.formatted).toBe(typed.formatted);
  });
});
