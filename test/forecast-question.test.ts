// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import type { Retriever } from "../src/arena/research/retrieve";
import type { DecisionProvider } from "../src/decisions/types";
import { forecastQuestion, inferKind } from "../src/forecast/question";
import { handleForecast } from "../src/net/forecast-api";

const retriever: Retriever = async () => ({
  report: "- Fed hiked on Sep 16 to 3.75% ([fed](https://federalreserve.example/p))",
  sources: [{ url: "https://federalreserve.example/p" }],
  costUsd: 0.03,
  searches: 3,
  retriever: "fake",
});
const analyst = (json: string) => async () => json;
const judge = (grounded: number): DecisionProvider => ({
  kind: "fake",
  model: "fake-jev",
  ask: async () => ({
    answers: {
      quality: { type: "score", score: 2, confidence: 0.9 },
      grounded: { type: "noul", noul: grounded },
    },
    model: "fake-jev",
    provider: "fake",
    latencyMs: 1,
  }),
});

describe("forecast any question", () => {
  it("infers yes/no questions as probabilities and others as numbers", () => {
    expect(inferKind("Will the Fed cut rates in October?")).toBe("probability");
    expect(inferKind("What will gasoline cost on Oct 15?")).toBe("number");
  });

  it("aggregates probabilities in log-odds, weighted by the judge", async () => {
    const a = await forecastQuestion(
      { question: "Will X happen?" },
      {
        retriever,
        analysts: [
          { name: "a", complete: analyst('{"probability": 0.2, "reason": "r"}') },
          { name: "b", complete: analyst('{"probability": 0.2, "reason": "r"}') },
        ],
        judge: judge(1),
        pageText: async () => "Fed hiked on Sep 16 to 3.75%",
      },
    );
    expect(a.kind).toBe("probability");
    expect(a.probability).toBeCloseTo(0.2, 3);
    expect(a.verification?.verified).toBe(1);
    expect(a.analysts.every((x) => x.grounded === 1)).toBe(true);
  });

  it("widens a number forecast by the analysts' disagreement", async () => {
    const a = await forecastQuestion(
      { question: "What will it be?", kind: "number" },
      {
        retriever,
        analysts: [
          { name: "a", complete: analyst('{"mean": 10, "sd": 1}') },
          { name: "b", complete: analyst('{"mean": 14, "sd": 1}') },
        ],
      },
    );
    expect(a.mean).toBe(12);
    expect(a.sd!).toBeGreaterThan(2); // sqrt(1 + 4)
    expect(a.interval![0]).toBeLessThan(12);
  });

  it("drops invalid replies, and says so when nothing usable is left", async () => {
    const a = await forecastQuestion(
      { question: "Will X?" },
      {
        retriever,
        analysts: [
          { name: "a", complete: analyst('{"probability": 7}') },
          {
            name: "b",
            complete: async () => {
              throw new Error("429");
            },
          },
        ],
      },
    );
    expect(a.probability).toBeUndefined();
    expect(a.caveat).toContain("no analyst");
    expect(a.analysts.map((x) => x.status)).toEqual(["invalid reply", "error: 429"]);
    const failed = await forecastQuestion(
      { question: "Will X?" },
      {
        retriever: async () => {
          throw new Error("503");
        },
        analysts: [],
      },
    );
    expect(failed.caveat).toContain("research failed");
  });

  it("flags answers the judge found weakly grounded", async () => {
    const a = await forecastQuestion(
      { question: "Will X?" },
      {
        retriever,
        analysts: [{ name: "a", complete: analyst('{"probability": 0.9}') }],
        judge: judge(0.1),
      },
    );
    expect(a.probability).toBeCloseTo(0.9, 2);
    expect(a.caveat).toContain("little verified evidence");
  });
});

describe("POST /v1/forecast", () => {
  const saved = process.env.OPENROUTER_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = saved;
  });
  const post = (body: unknown) =>
    handleForecast(
      new Request("http://x/v1/forecast", { method: "POST", body: JSON.stringify(body) }),
    );

  it("validates the request and refuses cleanly without the keys it needs", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ question: "q", kind: "maybe" })).status).toBe(400);
    delete process.env.OPENROUTER_API_KEY;
    const res = await post({ question: "Will X happen?" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "forecast_unavailable",
    );
  });
});
