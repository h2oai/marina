// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { AnswerSpec } from "../src/forecast/answer-types";
import { forecastFormed, formationFromEnv, panelSummary } from "../src/forecast/formations";
import type { ModelPart } from "../src/forecast/typed";

const yesNo: AnswerSpec = {
  type: "choice",
  options: [{ id: "Yes" }, { id: "No" }],
  probabilities: true,
};
const retriever = async () => ({
  report: "- 2026-09-20 — a fact ([src](https://example.org/1))",
  sources: [{ url: "https://example.org/1" }],
  costUsd: 0,
  searches: 1,
  retriever: "fake",
});
const part = (name: string, reply: (system: string, user: string) => string): ModelPart => ({
  name,
  complete: async (s, u) => reply(s, u),
});
const planner = part("planner", (system) => {
  if (system.startsWith("You plan research")) return '{"restatement":"Q","queries":["q"]}';
  if (system.startsWith("You review a research dossier")) return '{"done":true}';
  if (system.startsWith("You referee")) return '{"winner":"B","reason":"better grounded"}';
  return '{"verdict":"keep"}';
});
const now = () => new Date("2026-10-05T00:00:00Z");

/** An analyst that answers p in round one and q after seeing the panel. */
const analyst = (name: string, p: number, q: number) =>
  part(name, (system) => {
    const pp = system.includes("Delphi") ? q : p;
    return JSON.stringify({
      answer: pp >= 0.5 ? "Yes" : "No",
      probabilities: { Yes: pp, No: 1 - pp },
      reason: `${name} reason`,
    });
  });

describe("typed formations", () => {
  const deps = (analysts: ModelPart[]) => ({
    retriever,
    analysts,
    planner,
    critic: planner,
    now,
    options: { runs: analysts.length, researchRounds: 1 },
  });

  it("delphi: members revise after an anonymous summary; median of the revisions", async () => {
    const a = await forecastFormed(
      { question: "Will it?", answer: yesNo },
      deps([analyst("m1", 0.8, 0.7), analyst("m2", 0.2, 0.4), analyst("m3", 0.6, 0.6)]),
      "delphi",
    );
    expect(a.formation.pattern).toBe("delphi");
    expect(a.formation.revisions).toHaveLength(3);
    expect(a.distribution?.Yes).toBeCloseTo(0.6, 3);
    expect(a.prediction).toBe("Yes");
  });

  it("tournament: the referee's pick wins; the bracket is kept", async () => {
    const a = await forecastFormed(
      { question: "Will it?", answer: yesNo },
      deps([analyst("m1", 0.8, 0.8), analyst("m2", 0.3, 0.3)]),
      "tournament",
    );
    expect(a.formation.matches).toHaveLength(1);
    expect(a.formation.champion).toBe(a.formation.matches![0]!.b);
    expect(a.distribution?.Yes).toBeCloseTo(0.3, 3);
  });

  it("falls back to the runs' answer with fewer than two usable runs", async () => {
    const a = await forecastFormed(
      { question: "Will it?", answer: yesNo },
      deps([analyst("m1", 0.8, 0.8)]),
      "delphi",
    );
    expect(a.formation.fallback).toContain("fewer than two");
    expect(a.distribution?.Yes).toBeCloseTo(0.8, 3);
  });

  it("summarizes the panel without names and reads the operator's formation", () => {
    const s = panelSummary(yesNo, [
      {
        run: 1,
        model: "secret-model",
        weight: 1,
        status: "ok",
        formatted: "Yes",
        distribution: { Yes: 0.7, No: 0.3 },
        reason: "r1",
      },
      {
        run: 2,
        model: "other-model",
        weight: 1,
        status: "ok",
        formatted: "No",
        distribution: { Yes: 0.3, No: 0.7 },
        reason: "r2",
      },
    ]);
    expect(s).toContain("median 0.50");
    expect(s).not.toContain("secret-model");
    expect(formationFromEnv({ MARINA_FORECAST_FORMATION: "Delphi" })).toBe("delphi");
    expect(formationFromEnv({ MARINA_FORECAST_FORMATION: "bogus" })).toBe("ensemble");
  });
});
