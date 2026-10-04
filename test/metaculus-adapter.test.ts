// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// The Metaculus adapter on synthetic questions: mapping, the CDF, the pass
// (posting, idempotency, dry run, caps), outcomes → the learning loop. No network.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ForecastPayload,
  fixtureClient,
  type MetaculusClient,
  type MetaculusPost,
  type MetaculusQuestion,
  metaculusClient,
} from "../benchmarks/metaculus/api";
import {
  ATTEMPT_BENCHMARK,
  BENCHMARK,
  forecastPass,
  OUTCOME_BENCHMARK,
  outcomeScore,
  resolvePass,
  spentToday,
} from "../benchmarks/metaculus/bot";
import { type CdfQuestion, continuousCdf, quantileOf } from "../benchmarks/metaculus/cdf";
import { commentFor, payloadFor, requestFor, specFor } from "../benchmarks/metaculus/map";
import { timerUnits } from "../benchmarks/metaculus/timer";
import type { TypedForecastAnswer } from "../src/forecast/typed";
import { memoryLessonSink, type Outcome } from "../src/learning/outcomes";
import {
  disableOutcomeLearning,
  enableOutcomeLearning,
  noteOutcome,
  settleOutcomes,
} from "../src/learning/service";
import { MarinaDB } from "../src/persistence/database";

const config = { label: "test", description: "test configuration" };
const binary: MetaculusQuestion = {
  id: 101,
  type: "binary",
  title: "Will the synthetic event happen by 2027?",
  status: "open",
  resolution_criteria: "Resolves Yes if the synthetic event happens.",
  fine_print: "Synthetic.",
  description: "A synthetic question for tests.",
  scheduled_close_time: "2026-12-01T00:00:00Z",
  scheduled_resolve_time: "2027-01-01T00:00:00Z",
};
const multiple: MetaculusQuestion = {
  id: 102,
  type: "multiple_choice",
  title: "Which synthetic option?",
  status: "open",
  options: ["Red", "Green", "Blue"],
};
const numeric: MetaculusQuestion = {
  id: 103,
  type: "numeric",
  title: "How many synthetic widgets?",
  status: "open",
  unit: "widgets",
  scaling: { range_min: 0, range_max: 100, zero_point: null },
  open_lower_bound: false,
  open_upper_bound: true,
};
const post = (id: number, q: MetaculusQuestion): MetaculusPost => ({ id, question: q });

function answerFor(
  q: MetaculusQuestion,
  extra: Partial<TypedForecastAnswer> = {},
): TypedForecastAnswer {
  const spec = specFor(q)!;
  return {
    question: q.title,
    answer: spec,
    runs: [{ run: 1, model: "fake", weight: 1, status: "ok", reason: "Synthetic reason." }],
    research: [],
    cutoff: { at: "2026-10-02T00:00:00.000Z", basis: "now", pastCutoff: false },
    sources: [{ url: "https://example.org/a" }],
    costUsd: 0.02,
    latencyMs: 1,
    ...(q.type === "binary"
      ? { prediction: "Yes", formatted: "Yes", distribution: { Yes: 0.7, No: 0.3 } }
      : q.type === "multiple_choice"
        ? { prediction: "B", formatted: "B", distribution: { A: 0.2, B: 0.5, C: 0.3 } }
        : { prediction: 40, formatted: "40", uncertainty: { sd: 8 } }),
    ...extra,
  } as TypedForecastAnswer;
}

const fakeForecast = async (req: { question: string }) => {
  const q = [binary, multiple, numeric].find((x) => x.title === req.question)!;
  return answerFor(q);
};

/** A client that records what it would post. */
function recordingClient(posts: MetaculusPost[]) {
  const sent: { forecasts: ForecastPayload[]; comments: Array<{ postId: number; text: string }> } =
    {
      forecasts: [],
      comments: [],
    };
  const base = fixtureClient(posts);
  const client: MetaculusClient = {
    ...base,
    forecast: async (p) => {
      sent.forecasts.push(p);
    },
    comment: async (postId, text) => {
      sent.comments.push({ postId, text });
    },
  };
  return { client, sent };
}

describe("metaculus: mapping", () => {
  it("maps each question type to a general answer spec", () => {
    expect(specFor(binary)).toMatchObject({ type: "choice", probabilities: true });
    const mc = specFor(multiple);
    expect(mc).toMatchObject({ type: "choice", probabilities: true });
    expect((mc as { options: Array<{ id: string; label?: string }> }).options[1]).toEqual({
      id: "B",
      label: "Green",
    });
    expect(specFor(numeric)).toEqual({ type: "number", unit: "widgets" });
    expect(specFor({ ...numeric, type: "discrete" })).toMatchObject({ integer: true });
    expect(specFor({ ...binary, type: "date" })).toBeUndefined();
    const req = requestFor(numeric)!;
    expect(req.context).toContain("cannot be lower than 0");
    expect(req.context).toContain("may be higher");
    expect(requestFor(binary)?.endTime).toBe("2027-01-01T00:00:00Z");
  });

  it("builds binary and multiple-choice payloads that the API accepts", () => {
    const b = payloadFor(binary, answerFor(binary));
    expect("payload" in b && b.payload.probability_yes).toBe(0.7);
    const extreme = payloadFor(binary, answerFor(binary, { distribution: { Yes: 1, No: 0 } }));
    expect("payload" in extreme && extreme.payload.probability_yes).toBe(0.999);
    const m = payloadFor(multiple, answerFor(multiple));
    if (!("payload" in m)) throw new Error("no payload");
    const per = m.payload.probability_yes_per_category!;
    expect(Object.keys(per)).toEqual(["Red", "Green", "Blue"]);
    expect(Object.values(per).reduce((s, p) => s + p, 0)).toBeCloseTo(1, 9);
    expect(payloadFor(binary, answerFor(binary, { distribution: undefined }))).toEqual({
      skip: "no probability",
    });
  });

  it("writes a reasoning comment with the forecast, reasons, sources and attribution", () => {
    const a = answerFor(binary);
    const p = payloadFor(binary, a);
    if (!("payload" in p)) throw new Error("no payload");
    const text = commentFor(binary, a, p.payload);
    expect(text).toContain("70% Yes");
    expect(text).toContain("Synthetic reason.");
    expect(text).toContain("https://example.org/a");
    expect(text).toContain("H2O.ai Marina");
  });
});

describe("metaculus: CDF", () => {
  const linear: CdfQuestion = {
    rangeMin: 0,
    rangeMax: 100,
    zeroPoint: null,
    openLower: false,
    openUpper: true,
    cdfSize: 201,
  };
  const check = (q: CdfQuestion, cdf: number[]) => {
    expect(cdf).toHaveLength(q.cdfSize);
    const cap = 0.2 * (200 / (q.cdfSize - 1));
    for (let i = 1; i < cdf.length; i++) {
      const step = cdf[i]! - cdf[i - 1]!;
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThanOrEqual(cap + 1e-9);
    }
    if (q.openLower) expect(cdf[0]!).toBeGreaterThanOrEqual(0.001 - 1e-9);
    else expect(cdf[0]!).toBeCloseTo(0, 9);
    if (q.openUpper) expect(cdf.at(-1)!).toBeLessThanOrEqual(0.999 + 1e-9);
    else expect(cdf.at(-1)!).toBeCloseTo(1, 9);
  };

  it("is standardized for every bound combination and centred on the value", () => {
    for (const [openLower, openUpper] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      const q = { ...linear, openLower, openUpper };
      const cdf = continuousCdf(q, 40, 8);
      check(q, cdf);
      expect(quantileOf(q, cdf, 0.5)).toBeCloseTo(40, 0);
    }
  });

  it("stays valid with a tiny sd, a value out of range, a log scale and a discrete size", () => {
    check(linear, continuousCdf(linear, 50, 0.0001));
    check(linear, continuousCdf(linear, 150, 5));
    const log: CdfQuestion = { ...linear, rangeMin: 1, rangeMax: 10_000, zeroPoint: 0 };
    const lc = continuousCdf(log, 100, 30);
    check(log, lc);
    expect(quantileOf(log, lc, 0.5)).toBeGreaterThan(70);
    expect(quantileOf(log, lc, 0.5)).toBeLessThan(140);
    const discrete: CdfQuestion = { ...linear, rangeMin: -0.5, rangeMax: 10.5, cdfSize: 12 };
    check(discrete, continuousCdf(discrete, 4, 1));
  });
});

describe("metaculus: the bot pass", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("posts the forecast and its comment once per question, recorded append-only", async () => {
    const db = new MarinaDB(":memory:");
    const { client, sent } = recordingClient([
      post(1, binary),
      post(2, multiple),
      post(3, numeric),
    ]);
    const opts = { client, db, forecast: fakeForecast, tournaments: ["t"], config };
    const r = await forecastPass(opts);
    expect(r).toMatchObject({ open: 3, forecast: 3, failed: [] });
    expect(sent.forecasts.map((f) => f.question)).toEqual([101, 102, 103]);
    expect(sent.forecasts[2]!.continuous_cdf).toHaveLength(201);
    expect(sent.comments.map((c) => c.postId)).toEqual([1, 2, 3]);
    const rows = db.listExternalSubmissions(BENCHMARK);
    expect(rows).toHaveLength(3);
    expect(rows.reduce((s, x) => s + (x.cost_usd ?? 0), 0)).toBeCloseTo(0.06, 9);
    // A second pass forecasts nothing new.
    const again = await forecastPass(opts);
    expect(again.forecast).toBe(0);
    expect(sent.forecasts).toHaveLength(3);
    db.close();
  });

  it("skips questions already forecast on Metaculus and stops at the daily cap", async () => {
    const db = new MarinaDB(":memory:");
    const done = { ...binary, my_forecasts: { latest: { forecast_values: [0.3, 0.7] } } };
    const { client, sent } = recordingClient([post(1, done), post(2, multiple), post(3, numeric)]);
    const r = await forecastPass({
      client,
      db,
      forecast: fakeForecast,
      tournaments: ["t"],
      config,
      dailyCapUsd: 0.02,
    });
    expect(r.skipped).toEqual([{ questionId: 101, reason: "already forecast on Metaculus" }]);
    expect(r.forecast).toBe(1);
    expect(r.stoppedBy).toContain("daily cap");
    expect(sent.forecasts).toHaveLength(1);
    db.close();
  });

  it("dry run writes payload and comment locally, posts and records nothing", async () => {
    dir = mkdtempSync(join(tmpdir(), "metaculus-dry-"));
    const db = new MarinaDB(":memory:");
    const r = await forecastPass({
      client: fixtureClient([post(1, binary)]),
      db,
      forecast: fakeForecast,
      tournaments: ["t"],
      config,
      dryRun: true,
      outDir: dir,
    });
    expect(r.forecast).toBe(1);
    const saved = JSON.parse(readFileSync(join(dir, "101.json"), "utf8"));
    expect(saved.payload.probability_yes).toBe(0.7);
    expect(saved.comment).toContain("H2O.ai Marina");
    expect(db.listExternalSubmissions(BENCHMARK)).toHaveLength(0);
    db.close();
  });

  it("records a failed forecast as failed, never as a submission", async () => {
    const db = new MarinaDB(":memory:");
    const { client, sent } = recordingClient([post(1, binary)]);
    const r = await forecastPass({
      client,
      db,
      forecast: async () => answerFor(binary, { distribution: undefined, caveat: "no run" }),
      tournaments: ["t"],
      config,
    });
    expect(r.failed[0]?.error).toContain("no probability");
    expect(sent.forecasts).toHaveLength(0);
    expect(db.listExternalSubmissions(BENCHMARK)).toHaveLength(0);
    db.close();
  });

  it("counts paid-but-unfiled forecasts against the cap and does not re-forecast them today", async () => {
    const db = new MarinaDB(":memory:");
    const { client } = recordingClient([post(1, binary), post(2, multiple)]);
    let calls = 0;
    const opts = {
      client,
      db,
      forecast: async (req: { question: string }) => {
        calls++;
        if (req.question === binary.title) {
          return answerFor(binary, { distribution: undefined, caveat: "no run", costUsd: 0.5 });
        }
        throw new Error("upstream 500 after research");
      },
      tournaments: ["t"],
      config,
      dailyCapUsd: 10,
    };
    const first = await forecastPass(opts);
    expect(first.failed).toHaveLength(2);
    expect(calls).toBe(2);
    // The unpostable answer's $0.50 is the bot's spend today, though nothing was filed.
    expect(spentToday(db, new Date())).toBeCloseTo(0.5, 9);
    expect(db.listExternalSubmissions(ATTEMPT_BENCHMARK)).toHaveLength(2);
    // The next pass the same day pays for neither again.
    const second = await forecastPass(opts);
    expect(calls).toBe(2);
    expect(second.skipped.map((s) => s.reason)).toEqual([
      "failed earlier today; retried tomorrow",
      "failed earlier today; retried tomorrow",
    ]);
    // A cap below what was already spent on failures stops the pass.
    const capped = await forecastPass({
      ...opts,
      client: recordingClient([post(3, numeric)]).client,
      dailyCapUsd: 0.4,
    });
    expect(capped.stoppedBy).toContain("daily cap");
    db.close();
  });
});

describe("metaculus: outcomes teach", () => {
  it("scores binary, multiple-choice and numeric outcomes", () => {
    const base = { postId: 1, questionId: 1, type: "binary" as const, cutoff: "", runs: 1 };
    expect(outcomeScore({ ...base, probabilityYes: 0.7 }, "yes")).toBeCloseTo(0.91, 9);
    expect(outcomeScore({ ...base, probabilityYes: 0.7 }, "annulled")).toBeUndefined();
    expect(
      outcomeScore({ ...base, perCategory: { Red: 0.2, Green: 0.5, Blue: 0.3 } }, "Green"),
    ).toBeCloseTo(1 - (0.04 + 0.25 + 0.09) / 2, 9);
    expect(outcomeScore({ ...base, mean: 40, sd: 8 }, 40)).toBeCloseTo(1, 6);
    expect(outcomeScore({ ...base, mean: 40, sd: 8 }, 80)!).toBeLessThan(0.01);
  });

  it("hands each resolved question to the learning loop once, never its text", async () => {
    const db = new MarinaDB(":memory:");
    const { client } = recordingClient([post(1, binary)]);
    await forecastPass({ client, db, forecast: fakeForecast, tournaments: ["t"], config });
    const resolved = { ...binary, status: "resolved", resolution: "no" };
    const sink = memoryLessonSink();
    enableOutcomeLearning(db, { sink, writer: null, judge: null });
    try {
      const opts = {
        client: fixtureClient([post(1, resolved)]),
        db,
        learn: (o: Outcome) => noteOutcome(db, o),
      };
      const r = await resolvePass(opts);
      expect(r).toMatchObject({ resolved: 1, learned: 1 });
      await settleOutcomes(db);
      const [lesson] = sink.all();
      expect(lesson?.domain).toBe("forecast");
      expect(lesson?.score).toBeCloseTo(0.51, 9);
      expect(lesson?.text).not.toContain("synthetic event");
      expect(db.listExternalSubmissions(OUTCOME_BENCHMARK)).toHaveLength(1);
      expect((await resolvePass(opts)).resolved).toBe(0);
    } finally {
      disableOutcomeLearning(db);
      db.close();
    }
  });
});

describe("metaculus: client and timer", () => {
  it("sends the token only in the header and never echoes it in an error", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = metaculusClient({
      token: "secret-token-123",
      fetcher: async (url, init) => {
        calls.push({ url, ...(init ? { init } : {}) });
        if (url.includes("/posts/?")) {
          return new Response(JSON.stringify({ results: [post(1, binary)], next: null }));
        }
        if (url.endsWith("/comments/create/")) {
          return new Response("bad token secret-token-123", { status: 403 });
        }
        return new Response("");
      },
    });
    expect(await client.posts(33121)).toHaveLength(1);
    expect(calls[0]!.url).toContain("tournaments=33121");
    expect(calls[0]!.url).not.toContain("secret");
    const headers = (calls[0]!.init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Token secret-token-123");
    await client.forecast({
      question: 101,
      source: "api",
      probability_yes: 0.7,
      probability_yes_per_category: null,
      continuous_cdf: null,
    });
    expect(JSON.parse(String(calls[1]!.init?.body))[0]).toMatchObject({ question: 101 });
    const err = await client.comment(1, "x").catch((e: Error) => e.message);
    expect(err).toContain("[token]");
    expect(err).not.toContain("secret-token-123");
  });

  it("writes a 20-minute timer and a oneshot service that reads credentials from a file", () => {
    const u = timerUnits({
      repoDir: "/srv/marina",
      bun: "/usr/bin/bun",
      envFile: "/home/op/.config/marina-metaculus/env",
      tournaments: [33121, "minibench"],
      dailyCapUsd: 10,
    });
    expect(u.service).toContain("EnvironmentFile=/home/op/.config/marina-metaculus/env");
    expect(u.service).toContain("--tournament 33121 --tournament minibench");
    expect(u.service).not.toContain("METACULUS_TOKEN=");
    expect(u.timer).toContain("OnUnitActiveSec=20min");
  });
});
