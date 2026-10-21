// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { AnswerSpec } from "../src/forecast/answer-types";
import type { ForecastLookup, Reading } from "../src/forecast/lookup-types";
import {
  optionRanges,
  quantModeFromEnv,
  quantStage,
  quantWeightFromEnv,
  seriesBaseline,
} from "../src/forecast/quant";
import { typedOptionsFromEnv } from "../src/forecast/service";
import {
  forecastTyped,
  type ModelPart,
  type TypedForecastAnswer,
  type TypedForecastOptions,
} from "../src/forecast/typed";
import { normalCdf } from "../src/quant/normal";
import type { Retriever } from "../src/research/retrieve";

const opts = (...labels: string[]) => labels.map((label, i) => ({ id: "ABCDEFG"[i]!, label }));

/** Monthly readings rising ~0.1 a month with small wiggles, ending 2026-08-01 at about 4.0. */
function unrateReading(): Reading {
  const history = Array.from({ length: 30 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 2 + i, 1)).toISOString().slice(0, 10),
    value: Number((1.1 + 0.1 * i + (i % 3 === 0 ? 0.05 : -0.03)).toFixed(2)),
  }));
  const last = history.at(-1)!;
  return {
    source: "FRED",
    series: "UNRATE",
    value: last.value,
    date: last.date,
    asOf: "2026-09-05T00:00:00Z",
    history,
  };
}

describe("optionRanges", () => {
  it("reads percentage ranges and joins rounding gaps at the midpoint", () => {
    const r = optionRanges(opts("Below 2.5%", "2.5% to 2.9%", "3.0% to 3.4%", "3.5% or higher"))!;
    expect(r.gapsClosed).toBe(true);
    expect(r.buckets.map((b) => [b.lo, b.hi])).toEqual([
      [undefined, 2.5],
      [2.5, 2.95],
      [2.95, 3.45],
      [3.45, undefined],
    ]);
  });

  it("reads thousands separators, between/and and counts", () => {
    const t = optionRanges(opts("Less than 100,000", "Between 100,000 and 200,000", "200,000+"))!;
    expect(t.buckets.map((b) => [b.lo, b.hi])).toEqual([
      [undefined, 100000],
      [100000, 200000],
      [200000, undefined],
    ]);
    const counts = optionRanges(opts("0", "1", "2", "3 or more"))!;
    expect(counts.buckets.map((b) => [b.lo, b.hi])).toEqual([
      [-0.5, 0.5],
      [0.5, 1.5],
      [1.5, 2.5],
      [2.5, undefined],
    ]);
    const ranges = optionRanges(opts("0", "1-2", "3-5", "More than 5"))!;
    expect(ranges.buckets.map((b) => [b.lo, b.hi])).toEqual([
      [-0.5, 0.5],
      [0.5, 2.5],
      [2.5, 5.5],
      [5.5, undefined],
    ]);
    expect(ranges.gapsClosed).toBe(false);
  });

  it("refuses options that are not one numeric partition", () => {
    expect(optionRanges(opts("Yes", "No"))).toBeUndefined();
    expect(optionRanges(opts("<5", "3-8"))).toBeUndefined(); // overlap
    expect(optionRanges(opts("<5", "<8"))).toBeUndefined();
    expect(optionRanges(opts("1.5", "2.5"))).toBeUndefined(); // non-integer exact values
    expect(optionRanges(opts("<5"))).toBeUndefined();
  });

  it("falls back to the option id when the label is not a range", () => {
    const r = optionRanges([
      { id: "<10", label: "Low" },
      { id: ">=10", label: "High" },
    ]);
    expect(r?.buckets).toHaveLength(2);
  });
});

describe("seriesBaseline", () => {
  it("fits the freshest reading's history and projects it to the target", () => {
    const b = seriesBaseline([unrateReading()], "2026-11-01T00:00:00Z")!;
    expect(b.series).toBe("UNRATE");
    expect(b.steps).toBe(3);
    expect(b.points).toBe(30);
    expect(b.mean).toBeGreaterThan(4);
    expect(b.p10).toBeLessThan(b.mean);
    expect(b.p90).toBeGreaterThan(b.mean);
  });

  it("needs a reading with history", () => {
    const r = unrateReading();
    expect(seriesBaseline([{ ...r, history: [] }], "2026-11-01")).toBeUndefined();
    expect(seriesBaseline([], "2026-11-01")).toBeUndefined();
  });
});

describe("quantStage", () => {
  const rangeSpec: AnswerSpec = {
    type: "choice",
    options: opts("Below 3.5%", "3.5% to 3.9%", "4.0% to 4.4%", "4.5% or higher"),
    probabilities: true,
  };

  it("observe records buckets from the series and shows nothing", () => {
    const s = quantStage({
      mode: "observe",
      spec: rangeSpec,
      readings: [unrateReading()],
      cutoff: "2026-09-05T00:00:00Z",
      endTime: "2026-11-01T00:00:00Z",
    });
    expect(s.lines).toEqual([]);
    expect(s.evidence).toBeUndefined();
    expect(s.record.shown).toBe(false);
    const q = s.record.buckets!;
    expect(q.source).toBe("series");
    const total = Object.values(q.distribution).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 12);
    const { mean, sd } = q.predictive;
    expect(q.distribution.A).toBeCloseTo(normalCdf(3.5, mean, sd), 12);
  });

  it("on shows a baseline line, a ranges line and judge evidence", () => {
    const s = quantStage({
      mode: "on",
      spec: rangeSpec,
      readings: [unrateReading()],
      cutoff: "2026-09-05T00:00:00Z",
      endTime: "2026-11-01T00:00:00Z",
    });
    expect(s.lines).toHaveLength(2);
    expect(s.lines[0]).toContain("QUANT BASELINE");
    expect(s.lines[0]).toContain("FRED UNRATE");
    expect(s.lines[1]).toContain("QUANT RANGES");
    expect(s.lines[1]).toContain(`Most likely: ${s.record.buckets!.best}`);
    expect(s.evidence).toContain("QUANT RANGES");
    expect(s.record.shown).toBe(true);
  });

  it("falls back to a supplied numeric prior seen by the cutoff, and explains a miss", () => {
    const withPrior = quantStage({
      mode: "on",
      spec: rangeSpec,
      readings: [],
      priors: [
        { source: "statistical", value: 3.7, sd: 0.2, at: "2026-12-01T00:00:00Z" }, // too late
        { source: "community", value: 4.2, sd: 0.1, at: "2026-09-01T00:00:00Z" },
      ],
      cutoff: "2026-09-05T00:00:00Z",
    });
    expect(withPrior.record.buckets?.source).toBe("prior");
    expect(withPrior.record.buckets?.best).toBe("C");
    expect(withPrior.lines).toHaveLength(1);

    const nothing = quantStage({
      mode: "on",
      spec: { type: "choice", options: opts("Yes", "No") },
      readings: [],
      cutoff: "2026-09-05T00:00:00Z",
    });
    expect(nothing.lines).toEqual([]);
    expect(nothing.record.notes).toEqual([
      "no official series with history to fit",
      "the options are not numeric ranges",
    ]);
  });

  it("a number question gets only the baseline", () => {
    const s = quantStage({
      mode: "on",
      spec: { type: "number" },
      readings: [unrateReading()],
      cutoff: "2026-09-05T00:00:00Z",
    });
    expect(s.record.buckets).toBeUndefined();
    expect(s.lines).toHaveLength(1);
  });
});

describe("environment", () => {
  it("parses MARINA_FORECAST_QUANT and its weight; default off adds no option", () => {
    expect(quantModeFromEnv({})).toBe("off");
    expect(quantModeFromEnv({ MARINA_FORECAST_QUANT: " ON " })).toBe("on");
    expect(quantModeFromEnv({ MARINA_FORECAST_QUANT: "observe" })).toBe("observe");
    expect(quantModeFromEnv({ MARINA_FORECAST_QUANT: "yes" })).toBe("off");
    expect(quantWeightFromEnv({})).toBe(0.25);
    expect(quantWeightFromEnv({ MARINA_FORECAST_QUANT_WEIGHT: "0.6" })).toBe(0.6);
    expect(quantWeightFromEnv({ MARINA_FORECAST_QUANT_WEIGHT: "2" })).toBe(0.25);
    expect("quant" in typedOptionsFromEnv({})).toBe(false);
    expect("quant" in typedOptionsFromEnv({ MARINA_FORECAST_QUANT: "off" })).toBe(false);
    expect(typedOptionsFromEnv({ MARINA_FORECAST_QUANT: "on" })).toMatchObject({
      quant: "on",
      quantWeight: 0.25,
    });
  });
});

// ─── The typed pipeline ─────────────────────────────────────────────────────

const retriever: Retriever = async () => ({
  report: "- 2026-09-01 — unemployment edged up ([src](https://example.org/1))",
  sources: [{ url: "https://example.org/1" }],
  costUsd: 0,
  searches: 1,
  retriever: "fake",
});

const fredLookup: ForecastLookup = {
  name: "fred",
  lookup: async () => ({
    name: "fred",
    lines: ["- 2026-08-01 — FRED UNRATE 4.0 ([FRED](https://fred.stlouisfed.org/series/UNRATE))"],
    sources: [{ url: "https://fred.stlouisfed.org/series/UNRATE" }],
    readings: [unrateReading()],
  }),
};

interface Captured {
  prompts: string[];
  answer: TypedForecastAnswer;
}

async function run(
  spec: AnswerSpec,
  analystReply: string,
  options: TypedForecastOptions,
): Promise<Captured> {
  const prompts: string[] = [];
  const part = (name: string, reply: (system: string) => string): ModelPart => ({
    name,
    complete: async (s, u) => {
      prompts.push(`${name}\n${s}\n${u}`);
      return reply(s);
    },
  });
  const planner = part("planner", (system) =>
    system.startsWith("You plan research")
      ? JSON.stringify({ restatement: "Unemployment in October?", queries: ["unemployment"] })
      : system.startsWith("You review a research dossier")
        ? JSON.stringify({ done: true })
        : JSON.stringify({ verdict: "keep", confidence: 0.5, reason: "fine" }),
  );
  const answer = await forecastTyped(
    {
      question: "US unemployment rate for October 2026?",
      answer: spec,
      endTime: "2026-11-01T00:00:00Z",
    },
    {
      retriever,
      analysts: [part("m1", () => analystReply)],
      planner,
      lookups: [fredLookup],
      now: () => new Date("2026-09-05T00:00:00Z"),
      options: { runs: 2, researchRounds: 1, followUp: false, ...options },
    },
  );
  return { prompts, answer };
}

/** The answer without wall-clock fields. */
const stable = (a: TypedForecastAnswer) => {
  const { latencyMs: _l, quant: _q, ...rest } = a;
  return JSON.stringify(rest);
};

const rangeChoice: AnswerSpec = {
  type: "choice",
  options: opts("Below 3.5%", "3.5% to 3.9%", "4.0% to 4.4%", "4.5% or higher"),
  probabilities: true,
};
const rangeReply = JSON.stringify({
  answer: "B",
  confidence: 0.5,
  probabilities: { A: 0.1, B: 0.5, C: 0.3, D: 0.1 },
  reason: "steady",
});

describe("forecastTyped with MARINA_FORECAST_QUANT", () => {
  it("off is byte-identical to no option at all: same prompts, same answer", async () => {
    const none = await run(rangeChoice, rangeReply, {});
    const off = await run(rangeChoice, rangeReply, { quant: "off" });
    expect(off.prompts).toEqual(none.prompts);
    expect(JSON.stringify({ ...off.answer, latencyMs: 0 })).toBe(
      JSON.stringify({ ...none.answer, latencyMs: 0 }),
    );
    expect(off.answer.quant).toBeUndefined();
    expect(none.prompts.join("\n")).not.toContain("QUANT");
  });

  it("observe records what quant would do and changes nothing a model sees or the answer", async () => {
    const off = await run(rangeChoice, rangeReply, {});
    const obs = await run(rangeChoice, rangeReply, { quant: "observe" });
    expect(obs.prompts).toEqual(off.prompts);
    expect(stable(obs.answer)).toBe(stable(off.answer));
    const q = obs.answer.quant!;
    expect(q.mode).toBe("observe");
    expect(q.shown).toBe(false);
    expect(q.baseline?.series).toBe("UNRATE");
    expect(q.buckets?.source).toBe("series");
    expect(q.blend?.applied).toBe(false);
    expect(q.blend?.before).toEqual(off.answer.distribution);
    expect(q.blend?.weight).toBe(0.25);
  });

  it("on shows the lines to the runs and blends the buckets into the distribution", async () => {
    const off = await run(rangeChoice, rangeReply, {});
    const on = await run(rangeChoice, rangeReply, { quant: "on", quantWeight: 0.5 });
    const runPrompt = on.prompts.find((p) => p.startsWith("m1"))!;
    expect(runPrompt).toContain("QUANT BASELINE");
    expect(runPrompt).toContain("QUANT RANGES");
    const q = on.answer.quant!;
    expect(q.shown).toBe(true);
    expect(q.blend?.applied).toBe(true);
    expect(q.blend?.weight).toBe(0.5);
    expect(on.answer.distribution).toEqual(q.blend!.after);
    for (const id of ["A", "B", "C", "D"]) {
      const expected = 0.5 * off.answer.distribution![id]! + 0.5 * q.buckets!.distribution[id]!;
      expect(on.answer.distribution![id]).toBeCloseTo(expected, 2);
    }
    expect(on.answer.prediction).toBe(
      Object.entries(on.answer.distribution!).sort((a, b) => b[1] - a[1])[0]![0],
    );
  });

  it("a number question: on shows the baseline as a reference class; observe only records it", async () => {
    const numberReply = JSON.stringify({ answer: 4.1, sd: 0.2, confidence: 0.5, reason: "r" });
    const off = await run({ type: "number" }, numberReply, {});
    const obs = await run({ type: "number" }, numberReply, { quant: "observe" });
    const on = await run({ type: "number" }, numberReply, { quant: "on" });
    expect(obs.prompts).toEqual(off.prompts);
    expect(stable(obs.answer)).toBe(stable(off.answer));
    expect(obs.answer.quant?.baseline?.steps).toBe(3);
    expect(on.prompts.find((p) => p.startsWith("m1"))).toContain("QUANT BASELINE");
    expect(on.answer.quant?.buckets).toBeUndefined();
    expect(on.answer.prediction).toBe(4.1);
  });

  it("a choice without probabilities is recorded but never blended", async () => {
    const plain: AnswerSpec = { type: "choice", options: rangeChoice.options };
    const on = await run(plain, '{"answer":"B","confidence":0.5}', { quant: "on" });
    expect(on.answer.quant?.buckets).toBeDefined();
    expect(on.answer.quant?.blend).toBeUndefined();
    expect(on.answer.distribution).toBeUndefined();
  });
});
