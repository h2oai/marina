// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { historyPath } from "../src/forecast/history";
import { formationEnv, plainFromTyped } from "../src/forecast/surface";
import type { TypedForecastAnswer } from "../src/forecast/typed";
import { EVAL_REF_PREFIX, evalExclusion, sourceNamesBoard } from "../src/learning/eval-context";
import type { Lesson } from "../src/learning/outcomes";
import { modelAccess } from "../src/model/access";

const typed = (over: Partial<TypedForecastAnswer>): TypedForecastAnswer =>
  ({
    question: "q",
    answer: { type: "number" },
    runs: [],
    research: [],
    cutoff: { at: "2026-10-11T00:00:00.000Z", basis: "now", pastCutoff: false },
    sources: [{ url: "https://example.org/1" }],
    costUsd: 0.2,
    latencyMs: 10,
    ...over,
  }) as TypedForecastAnswer;

describe("formation names on a surface", () => {
  it("verify checks each run and keeps the resolved formation", () => {
    const made = formationEnv("verify", { MARINA_FORECAST_FORMATION: "delphi" });
    expect(made).toEqual({
      env: { MARINA_FORECAST_FORMATION: "delphi", MARINA_FORECAST_VERIFY: "on" },
    });
  });

  it("a typed formation is passed through and an unknown one is an error", () => {
    expect(formationEnv("Delphi", {})).toEqual({ env: { MARINA_FORECAST_FORMATION: "delphi" } });
    expect(formationEnv(undefined, { A: "1" })).toEqual({ env: { A: "1" } });
    const bad = formationEnv("swarm", {});
    expect("error" in bad && bad.error).toContain("unknown formation");
  });
});

describe("a plain question answered by the typed pipeline", () => {
  it("a yes/no choice becomes a probability, with its runs as analysts", () => {
    const t = typed({
      answer: {
        type: "choice",
        options: [{ id: "yes" }, { id: "no" }],
        probabilities: true,
      },
      distribution: { yes: 0.6234, no: 0.3766 },
      runs: [
        {
          run: 1,
          model: "m1",
          distribution: { yes: 0.6, no: 0.4 },
          reason: "r",
          weight: 1,
          grounded: 0.8,
          status: "ok",
        },
      ],
    });
    const a = plainFromTyped("probability", t);
    expect(a).toMatchObject({
      kind: "probability",
      probability: 0.623,
      pipeline: "typed",
      analysts: [{ name: "m1", probability: 0.6, reason: "r", weight: 1, grounded: 0.8 }],
      costUsd: 0.2,
    });
    expect(a.typed).toBe(t);
  });

  it("a number keeps mean, sd and the 80 % interval", () => {
    const a = plainFromTyped("number", typed({ prediction: 10, uncertainty: { sd: 2 } }));
    expect(a).toMatchObject({ kind: "number", mean: 10, sd: 2, interval: [7.437, 12.563] });
  });
});

describe("resolved history is kept by default", () => {
  it("next to an on-disk world database, unless off or set", () => {
    expect(historyPath({ DB_PATH: "/w/marina.db" })).toBe(join("/w", "forecast", "history.jsonl"));
    expect(historyPath({ DB_PATH: ":memory:" })).toBeUndefined();
    expect(historyPath({})).toBeUndefined();
    expect(
      historyPath({ DB_PATH: "/w/marina.db", MARINA_FORECAST_HISTORY: "off" }),
    ).toBeUndefined();
    expect(historyPath({ MARINA_FORECAST_HISTORY: "/h.jsonl" })).toBe("/h.jsonl");
  });
});

describe("measurement outcomes teach without teaching their own board", () => {
  const lesson = (over: Partial<Lesson>): Lesson =>
    ({ domain: "tools", text: "t", kind: "success", ...over }) as Lesson;

  it("an eval:<board> ref excludes the lesson from that board's measurements only", () => {
    const excluded = evalExclusion({ benchmark: "tau2-airline", mode: "measure" })!;
    const own = lesson({ source: "request:reported", refs: [`${EVAL_REF_PREFIX}tau2-airline`] });
    const other = lesson({ source: "request:reported", refs: [`${EVAL_REF_PREFIX}ifbench`] });
    expect(excluded(own)).toBe(true);
    expect(excluded(other)).toBe(false);
    expect(evalExclusion({ benchmark: "tau2-airline", mode: "live" })).toBeUndefined();
  });

  it("a producer kind is not a board; a board producer is", () => {
    expect(sourceNamesBoard("forecast:probability")).toBe(false);
    expect(sourceNamesBoard("request:reported")).toBe(false);
    expect(sourceNamesBoard("prophet:probability")).toBe(true);
  });
});

describe("one-shot completions reach a Marina endpoint", () => {
  it("marina/* uses a key the endpoint accepts", () => {
    expect(modelAccess("marina/default", { MODEL_API_KEYS: "k1:ada,k2" }).apiKey).toBe("k1");
    expect(() => modelAccess("marina/default", {})).toThrow("MODEL_API_KEYS");
  });
});
