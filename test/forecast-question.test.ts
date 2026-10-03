// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { modelSourceEnvKeys } from "../src/agent/available-models";
import type { Retriever } from "../src/arena/research/retrieve";
import type { DecisionProvider } from "../src/decisions/types";
import { forecastQuestion, inferKind } from "../src/forecast/question";
import { handleForecast } from "../src/net/forecast-api";
import { scopeProcessState } from "./process-state";

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

  it("gives an unjudged answer no weight on a judge outage and records the error", async () => {
    // The judge fails on the first analyst only; the second is judged normally.
    let calls = 0;
    const flaky: DecisionProvider = {
      kind: "fake",
      model: "fake-jev",
      ask: async (request) => {
        calls++;
        if (JSON.stringify(request.state).includes("0.9")) throw new Error("judge 503");
        return judge(1).ask(request);
      },
    };
    const a = await forecastQuestion(
      { question: "Will X?" },
      {
        retriever,
        analysts: [
          { name: "loud", complete: analyst('{"probability": 0.9, "reason": "r"}') },
          { name: "judged", complete: analyst('{"probability": 0.2, "reason": "r"}') },
        ],
        judge: flaky,
      },
    );
    expect(calls).toBe(2);
    const loud = a.analysts.find((x) => x.name === "loud")!;
    expect(loud.weight).toBe(0);
    expect(loud.judgeError).toContain("judge 503");
    // The outage is not a pass: the answer is the judged analyst's alone.
    expect(a.probability).toBeCloseTo(0.2, 3);
    expect(a.judge).toMatchObject({ provider: "fake", calls: 2, errors: 1 });
    expect(a.judge?.error).toContain("judge 503");

    const down: DecisionProvider = {
      kind: "fake",
      model: "fake-jev",
      ask: async () => {
        throw new Error("judge down");
      },
    };
    const none = await forecastQuestion(
      { question: "Will X?" },
      {
        retriever,
        analysts: [{ name: "a", complete: analyst('{"probability": 0.9}') }],
        judge: down,
      },
    );
    expect(none.probability).toBeUndefined();
    expect(none.caveat).toContain("judge failed");
    expect(none.judge?.errors).toBe(1);
  });
});

describe("POST /v1/forecast", () => {
  /** No model at all — the one case /v1/forecast refuses (a single model is enough). */
  const noModels = () =>
    scopeProcessState({
      env: {
        ...Object.fromEntries(modelSourceEnvKeys().map((k) => [k, undefined])),
        MARINA_FORECAST_ANALYSTS: undefined,
      },
    });
  const post = (body: unknown) =>
    handleForecast(
      new Request("http://x/v1/forecast", { method: "POST", body: JSON.stringify(body) }),
    );

  it("validates the request and refuses cleanly only when no model is available", async () => {
    using _ = noModels();
    expect((await post({})).status).toBe(400);
    expect((await post({ question: "q", kind: "maybe" })).status).toBe(400);
    const res = await post({ question: "Will X happen?" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "forecast_unavailable",
    );
  });

  it("validates typed answer specs and options before spending anything", async () => {
    using _ = noModels();
    expect((await post({ question: "q", answer: { type: "guess" } })).status).toBe(400);
    expect((await post({ question: "q", answer: { type: "choice", options: ["A"] } })).status).toBe(
      400,
    );
    expect(
      (await post({ question: "q", answer: { type: "text" }, endTime: "not a date" })).status,
    ).toBe(400);
    expect((await post({ question: "q", answer: { type: "text" }, runs: 50 })).status).toBe(400);
    expect((await post({ question: "q", answer: { type: "text" }, critique: "yes" })).status).toBe(
      400,
    );
    const res = await post({ question: "q", answer: { type: "choice", options: ["A", "B"] } });
    expect(res.status).toBe(503);
  });
});
