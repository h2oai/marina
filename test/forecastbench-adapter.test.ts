// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The ForecastBench adapter on a synthetic round: mapping, resume, the set
// file, coverage, outcomes → the learning loop. No network.

import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backtestItems, scoreQuestion } from "../benchmarks/forecastbench/backtest";
import {
  type FbQuestion,
  type FbQuestionSet,
  fetchQuestionSet,
} from "../benchmarks/forecastbench/dataset";
import {
  dateOptionId,
  fallbackForecasts,
  forecastsFrom,
  requestFor,
  specFor,
} from "../benchmarks/forecastbench/map";
import {
  assemble,
  OUTCOME_BENCHMARK,
  readJournal,
  resolveRound,
  runRound,
} from "../benchmarks/forecastbench/run";
import {
  coverage,
  DEFAULT_SET_IDENTITY,
  setBody,
  setFileName,
  validateForecasts,
} from "../benchmarks/forecastbench/submission";
import type { AnswerSpec } from "../src/forecast/answer-types";
import type { TypedForecastAnswer, TypedForecastRequest } from "../src/forecast/typed";
import type { Outcome } from "../src/learning/outcomes";
import { MarinaDB } from "../src/persistence/database";

const due = "2026-10-11";
const dates = ["2026-10-18", "2026-11-10", "2027-01-09"];
const market: FbQuestion = {
  id: "m1",
  source: "polymarket",
  question: "Will the synthetic market resolve Yes?",
  background: "Synthetic.",
  market_info_close_datetime: "2027-01-01T00:00:00+00:00",
  freeze_datetime: "2026-10-07T00:00:00+00:00",
  freeze_datetime_value: "0.25",
  freeze_datetime_value_explanation: "The market price.",
  resolution_dates: "N/A",
};
const dataset: FbQuestion = {
  id: "SYN",
  source: "yfinance",
  question:
    "Will SYN's close on {resolution_date} be higher than its close on {forecast_due_date}?",
  freeze_datetime_value: "10.5",
  resolution_dates: dates,
};
const set: FbQuestionSet = {
  forecast_due_date: due,
  question_set: `${due}-llm.json`,
  questions: [market, dataset, { ...market, id: "m2" }],
};

function answer(req: TypedForecastRequest, cost = 0.01): TypedForecastAnswer {
  const spec = req.answer as AnswerSpec & { options: Array<{ id: string }> };
  const distribution =
    spec.type === "choice"
      ? { Yes: 0.3, No: 0.7 }
      : Object.fromEntries(spec.options.map((o, i) => [o.id, 0.55 + i * 0.01]));
  return {
    question: req.question,
    answer: req.answer,
    distribution,
    runs: [{ run: 1, model: "fake", weight: 1, status: "ok", reason: "Synthetic reason." }],
    research: [],
    cutoff: { at: `${due}T01:00:00.000Z`, basis: "now", pastCutoff: false },
    sources: [],
    costUsd: cost,
    latencyMs: 1,
  };
}

describe("forecastbench: mapping", () => {
  it("asks a market question for P(yes) with the freeze price as context", () => {
    const req = requestFor(market, due);
    expect(req.answer).toMatchObject({ type: "choice", probabilities: true });
    expect(req.context).toContain("0.25 — The market price.");
    expect(req.endTime).toBe("2027-01-01T00:00:00+00:00");
  });

  it("asks a dataset question for every resolution date at once", () => {
    const req = requestFor(dataset, due);
    expect(req.question).toContain(`close on ${due}`);
    expect(req.question).not.toContain("{");
    const spec = specFor(dataset, due);
    expect(spec).toMatchObject({ type: "multi", minPicks: 0, probabilities: true });
    expect((spec as { options: Array<{ id: string; label?: string }> }).options[0]).toEqual({
      id: dateOptionId("2026-10-18"),
      label: "2026-10-18 (7 days after 2026-10-11)",
    });
  });

  it("turns an answer into one forecast per date, reasoning once", () => {
    const f = forecastsFrom(dataset, answer(requestFor(dataset, due)), "why")!;
    expect(f.map((x) => x.resolution_date)).toEqual(dates);
    expect(f.map((x) => x.reasoning)).toEqual(["why", null, null]);
    expect(forecastsFrom(market, answer(requestFor(market, due)), null)).toEqual([
      { id: "m1", source: "polymarket", forecast: 0.3, resolution_date: null, reasoning: null },
    ]);
    expect(forecastsFrom(market, { distribution: undefined }, null)).toBeUndefined();
    expect(fallbackForecasts(market)[0]!.forecast).toBe(0.25);
    expect(fallbackForecasts(dataset).map((x) => x.forecast)).toEqual([0.5, 0.5, 0.5]);
  });
});

describe("forecastbench: a round", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("forecasts every question, resumes after a failure, and assembles a valid set", async () => {
    dir = mkdtempSync(join(tmpdir(), "fb-"));
    const journal = join(dir, "set-1.jsonl");
    let calls = 0;
    const flaky = async (req: TypedForecastRequest) => {
      calls++;
      if (calls === 2) throw new Error("upstream 500");
      return answer(req);
    };
    const first = await runRound({ set, forecast: flaky, journal, concurrency: 1 });
    expect(first).toMatchObject({ attempted: 3, ok: 2, failed: 1 });
    // A torn line from an interrupted write is ignored.
    appendFileSync(journal, '{"key":"polymarket|m1","ok":');
    const second = await runRound({ set, forecast: async (r) => answer(r), journal });
    expect(second).toMatchObject({ attempted: 1, ok: 1, skippedDone: 2 });
    expect([...readJournal(journal).values()].every((j) => j.ok)).toBe(true);

    const a = assemble(set, journal);
    expect(a).toMatchObject({ fallback: 0, answered: 3 });
    expect(a.forecasts).toHaveLength(5);
    expect(validateForecasts(set.questions, a.forecasts)).toEqual([]);
    expect(coverage(set, a.forecasts)).toMatchObject({
      market: { expected: 2, given: 2 },
      dataset: { expected: 3, given: 3 },
      ok: true,
    });
  });

  it("stops starting questions at the budget and fills the rest with counted fallbacks", async () => {
    dir = mkdtempSync(join(tmpdir(), "fb-"));
    const journal = join(dir, "set-1.jsonl");
    const r = await runRound({
      set,
      forecast: async (req) => answer(req, 1),
      journal,
      concurrency: 1,
      budgetUsd: 1,
    });
    expect(r.attempted).toBe(1);
    expect(r.stoppedBy).toContain("budget");
    const a = assemble(set, journal);
    expect(a.fallback).toBe(2);
    expect(coverage(set, a.forecasts).ok).toBe(true);
  });

  it("names and shapes the file as ForecastBench requires", () => {
    expect(setFileName(due, DEFAULT_SET_IDENTITY, 1)).toBe(`${due}.H2O-ai.1.json`);
    expect(() => setFileName(due, DEFAULT_SET_IDENTITY, 4)).toThrow();
    const body = JSON.parse(setBody(set, DEFAULT_SET_IDENTITY, []));
    expect(body).toEqual({
      organization: "H2O.ai",
      model: "Marina",
      model_organization: "H2O.ai",
      question_set: `${due}-llm.json`,
      forecasts: [],
    });
    expect(
      validateForecasts(set.questions, [
        {
          id: "SYN",
          source: "yfinance",
          forecast: 0.5,
          resolution_date: "2030-01-01",
          reasoning: null,
        },
        { id: "m1", source: "polymarket", forecast: 1.5, resolution_date: null, reasoning: null },
      ]),
    ).toHaveLength(2);
    expect(coverage(set, []).ok).toBe(false);
  });

  it("reads a published question set through the fetcher", async () => {
    const seen: string[] = [];
    const s = await fetchQuestionSet(due, async (url) => {
      seen.push(url);
      return new Response(JSON.stringify(set));
    });
    expect(s.questions).toHaveLength(3);
    expect(seen[0]).toEndWith(`/question_sets/${due}-llm.json`);
  });

  it("follows latest-llm.json when it is served as a symlink pointer", async () => {
    const seen: string[] = [];
    const s = await fetchQuestionSet("latest", async (url) => {
      seen.push(url);
      return new Response(
        url.endsWith("latest-llm.json") ? `${due}-llm.json\n` : JSON.stringify(set),
      );
    });
    expect(s.questions).toHaveLength(3);
    expect(seen.map((u) => u.split("/").at(-1))).toEqual(["latest-llm.json", `${due}-llm.json`]);
    // A served JSON body is still read directly.
    const direct = await fetchQuestionSet("latest", async () => new Response(JSON.stringify(set)));
    expect(direct.questions).toHaveLength(3);
  });
});

describe("forecastbench: outcomes teach", () => {
  it("scores resolved questions and hands outcomes to the learning loop worst-first, once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fb-"));
    try {
      const journal = join(dir, "set-1.jsonl");
      await runRound({ set, forecast: async (r) => answer(r), journal });
      const db = new MarinaDB(":memory:");
      const learned: Outcome[] = [];
      const resolutions = [
        {
          id: "m1",
          source: "polymarket",
          resolution_date: "2026-12-01",
          resolved_to: 1,
          resolved: true,
        },
        {
          id: "m2",
          source: "polymarket",
          resolution_date: "2026-12-01",
          resolved_to: 0,
          resolved: false,
        },
        {
          id: "SYN",
          source: "yfinance",
          resolution_date: dates[0]!,
          resolved_to: 0,
          resolved: true,
        },
      ];
      const learn = (o: Outcome) => learned.push(o);
      const opts = { set, journal, resolutions, db, learn, maxLessons: 1 };
      const r = await resolveRound(opts);
      expect(r.resolved).toBe(2);
      expect(r.learned).toBe(1);
      // m1: forecast 0.3, outcome 1 ⇒ Brier 0.49, the worst — its lesson comes first.
      expect(learned[0]).toMatchObject({ domain: "forecast", source: "forecastbench:market" });
      expect(learned[0]?.score).toBeCloseTo(0.51, 9);
      expect(r.meanBrier).toBeCloseTo((0.49 + 0.55 ** 2) / 2, 6);
      expect(db.listExternalSubmissions(OUTCOME_BENCHMARK)).toHaveLength(2);
      expect((await resolveRound(opts)).resolved).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("forecastbench: backtest items", () => {
  const resolutions = [
    {
      id: "m1",
      source: "polymarket",
      resolution_date: "2026-12-01",
      resolved_to: 1,
      resolved: true,
    },
    { id: "SYN", source: "yfinance", resolution_date: dates[0]!, resolved_to: 0, resolved: true },
    { id: "SYN", source: "yfinance", resolution_date: dates[1]!, resolved_to: 1, resolved: true },
    {
      id: "m2",
      source: "polymarket",
      resolution_date: "2026-12-01",
      resolved_to: 0,
      resolved: false,
    },
  ];

  it("asks each resolved question as of its round's due date", () => {
    const items = backtestItems(set, resolutions);
    expect(items.map((i) => i.id)).toEqual([
      `forecastbench:${due}/polymarket/m1`,
      `forecastbench:${due}/yfinance/SYN`,
    ]);
    expect(items[0]!.request.asOf).toBe(`${due}T00:00:00.000Z`);
    expect(backtestItems(set, resolutions, { sources: ["yfinance"] })).toHaveLength(1);
  });

  it("scores by mean 1 − Brier, with the set's fallback for an unusable answer", () => {
    const [m1, syn] = backtestItems(set, resolutions);
    expect(m1!.score(answer(m1!.request))).toBeCloseTo(1 - 0.7 ** 2, 9);
    // Dataset: 0.55 on the first date (outcome 0), 0.56 on the second (outcome 1).
    expect(syn!.score(answer(syn!.request))).toBeCloseTo(1 - (0.55 ** 2 + 0.44 ** 2) / 2, 9);
    // No answer: the market's freeze price (0.25) stands in.
    expect(scoreQuestion(market, [resolutions[0]!], undefined)).toBeCloseTo(1 - 0.75 ** 2, 9);
  });
});
