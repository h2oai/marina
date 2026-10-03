// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { type AnswerSpec, parseAnswerSpec } from "../src/forecast/answer-types";
import {
  argmax,
  averageDistributions,
  blendDistributions,
  combinedSd,
  normalise,
  PROBABILITY_FLOOR,
  parseDistribution,
  pickDistribution,
} from "../src/forecast/distribution";
import { forecastTyped, type ModelPart } from "../src/forecast/typed";

const yesNo = [
  { id: "Yes", label: "Yes" },
  { id: "No", label: "No" },
];
const three = [{ id: "A", label: "Red" }, { id: "B", label: "Green" }, { id: "C" }];
const sum = (d: Record<string, number>) => Object.values(d).reduce((s, p) => s + p, 0);

describe("distribution helpers", () => {
  it("parses ids, labels, percents and arrays, then normalises", () => {
    expect(parseDistribution(three, { A: 0.5, Green: 0.3, C: 0.2 })).toEqual({
      A: 0.5,
      B: 0.3,
      C: 0.2,
    });
    const pct = parseDistribution(yesNo, { Yes: "70%", No: "30%" })!;
    expect(pct.Yes).toBeCloseTo(0.7, 4);
    const arr = parseDistribution(three, [
      { id: "A", probability: 2 },
      { option: "B", p: 2 },
    ])!;
    expect(arr.A).toBeCloseTo(arr.B!, 4);
    expect(arr.C).toBe(PROBABILITY_FLOOR);
    expect(sum(arr)).toBeCloseTo(1, 3);
    expect(parseDistribution(three, { Z: 1 })).toBeUndefined();
    expect(parseDistribution(three, "A")).toBeUndefined();
  });

  it("never returns 0 or 1", () => {
    const d = normalise({ Yes: 1, No: 0 })!;
    expect(d.No).toBe(PROBABILITY_FLOOR);
    expect(d.Yes).toBeCloseTo(1 - PROBABILITY_FLOOR, 4);
    expect(normalise({ Yes: 0, No: 0 })).toBeUndefined();
  });

  it("derives a distribution from a pick, averages, blends and picks the top", () => {
    expect(pickDistribution(yesNo, "No", 0.8)).toEqual({ Yes: 0.2, No: 0.8 });
    const avg = averageDistributions([
      { distribution: { Yes: 0.8, No: 0.2 }, weight: 1 },
      { distribution: { Yes: 0.4, No: 0.6 }, weight: 1 },
      { distribution: { Yes: 0.01, No: 0.99 }, weight: 0 },
    ])!;
    expect(avg.Yes).toBeCloseTo(0.6, 4);
    expect(averageDistributions([])).toBeUndefined();
    const blended = blendDistributions({ Yes: 0.8, No: 0.2 }, { Yes: 0.2, No: 0.8 }, 0.5);
    expect(blended.Yes).toBeCloseTo(0.5, 4);
    expect(argmax(three, { A: 0.2, B: 0.5, C: 0.3 })).toBe("B");
  });

  it("adds the runs' own sd to their spread in quadrature", () => {
    expect(combinedSd([{ sd: 3, weight: 1 }], 4)).toBe(5);
    expect(combinedSd([{ weight: 1 }], 0)).toBeUndefined();
    expect(
      combinedSd([
        { sd: 2, weight: 1 },
        { sd: 9, weight: 0 },
      ]),
    ).toBe(2);
  });

  it("keeps the probabilities flag on a parsed choice spec", () => {
    expect(
      parseAnswerSpec({ type: "choice", options: ["Yes", "No"], probabilities: true }),
    ).toEqual({
      spec: { type: "choice", options: [{ id: "Yes" }, { id: "No" }], probabilities: true },
    });
  });
});

const part = (name: string, reply: (system: string) => string): ModelPart => ({
  name,
  complete: async (s) => reply(s),
});
const retriever = async () => ({
  report: "- 2026-09-20 — a fact ([src](https://example.org/1))",
  sources: [{ url: "https://example.org/1" }],
  costUsd: 0,
  searches: 1,
  retriever: "fake",
});
const planner = (critic: string) =>
  part("planner", (system) => {
    if (system.startsWith("You plan research")) return '{"restatement":"Q","queries":["q"]}';
    if (system.startsWith("You review a research dossier")) return '{"done":true}';
    return critic;
  });
const now = () => new Date("2026-10-05T00:00:00Z");

describe("forecastTyped: probabilistic answers", () => {
  const spec: AnswerSpec = { type: "choice", options: yesNo, probabilities: true };

  it("asks every run for probabilities and averages them", async () => {
    let system = "";
    const a = await forecastTyped(
      { question: "Will it?", answer: spec },
      {
        retriever,
        analysts: [
          part("m1", (s) => {
            system = s;
            return '{"answer":"Yes","confidence":0.7,"probabilities":{"Yes":0.7,"No":0.3}}';
          }),
          // No probabilities: derived from the pick and its confidence.
          part("m2", () => '{"answer":"No","confidence":0.6}'),
        ],
        planner: planner('{"verdict":"keep","confidence":0.5}'),
        now,
        options: { runs: 2, researchRounds: 1 },
      },
    );
    expect(system).toContain('"probabilities"');
    expect(a.runs[1]?.distribution).toEqual({ Yes: 0.4, No: 0.6 });
    expect(a.distribution?.Yes).toBeCloseTo(0.55, 4);
    expect(a.prediction).toBe("Yes");
    expect(a.confidence).toBeCloseTo(0.55, 4);
  });

  it("moves the probabilities halfway toward an applied critique", async () => {
    const a = await forecastTyped(
      { question: "Will it?", answer: spec },
      {
        retriever,
        analysts: [part("m", () => '{"answer":"Yes","probabilities":{"Yes":0.6,"No":0.4}}')],
        planner: planner(
          '{"verdict":"revise","answer":"No","confidence":0.9,"probabilities":{"Yes":0.1,"No":0.9}}',
        ),
        now,
        options: { runs: 1, researchRounds: 1 },
      },
    );
    expect(a.critique?.applied).toBe(true);
    expect(a.distribution?.No).toBeCloseTo(0.65, 4);
    expect(a.prediction).toBe("No");
  });

  it("leaves a plain choice without a distribution", async () => {
    const a = await forecastTyped(
      { question: "Will it?", answer: { type: "choice", options: yesNo } },
      {
        retriever,
        analysts: [part("m", () => '{"answer":"Yes","probabilities":{"Yes":0.6,"No":0.4}}')],
        planner: planner('{"verdict":"keep"}'),
        now,
        options: { runs: 1, researchRounds: 1, critique: false },
      },
    );
    expect(a.distribution).toBeUndefined();
  });

  it("gives a multi-select each option's own probability", async () => {
    const dates = [{ id: "d7" }, { id: "d30" }, { id: "d90" }];
    const a = await forecastTyped(
      {
        question: "Higher on each date?",
        answer: { type: "multi", options: dates, minPicks: 0, probabilities: true },
      },
      {
        retriever,
        analysts: [
          part(
            "m1",
            () => '{"answer":["d30","d90"],"probabilities":{"d7":0.4,"d30":0.6,"d90":0.7}}',
          ),
          // Gave only one: the rest come from its picks.
          part("m2", () => '{"answer":["d90"],"confidence":0.8,"probabilities":{"d7":0.3}}'),
        ],
        planner: planner('{"verdict":"keep"}'),
        now,
        options: { runs: 2, researchRounds: 1, critique: false },
      },
    );
    expect(a.runs[1]?.distribution).toEqual({ d7: 0.3, d30: 0.2, d90: 0.8 });
    expect(a.distribution?.d7).toBeCloseTo(0.35, 4);
    expect(a.distribution?.d30).toBeCloseTo(0.4, 4);
    expect(a.distribution?.d90).toBeCloseTo(0.75, 4);
    // The picked set stays the runs' combined answer.
    expect(a.prediction).toContain("d90");
  });

  it("reports a number's uncertainty from the runs' sd and spread", async () => {
    const a = await forecastTyped(
      { question: "How many?", answer: { type: "number" } },
      {
        retriever,
        analysts: [
          part("m1", () => '{"answer":10,"sd":3}'),
          part("m2", () => '{"answer":10,"sd":3}'),
        ],
        planner: planner('{"verdict":"keep"}'),
        now,
        options: { runs: 2, researchRounds: 1, critique: false },
      },
    );
    expect(a.prediction).toBe(10);
    expect(a.uncertainty?.sd).toBe(3);
  });
});
