// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Statistical priors: series history as of a cutoff (no lookahead), the
// self-selecting comparison prior, nested reference-class rates, the
// `statistical` supplied prior and the prior-only answer, plus the
// ForecastBench mapping onto them. No network.

import { describe, expect, it } from "bun:test";
import type { FbQuestion, FbQuestionSet } from "../benchmarks/forecastbench/dataset";
import { dateOptionId, fallbackForecasts, requestFor } from "../benchmarks/forecastbench/map";
import {
  datasetPriors,
  priorLine,
  publishedOutcomes,
  referenceClasses,
  seriesRefFor,
} from "../benchmarks/forecastbench/priors";
import {
  candidateConfigs,
  PRIOR_ONLY_CONFIG,
  parseConfigs,
} from "../benchmarks/forecasting/configs";
import { knowledgeBoundOf } from "../benchmarks/forecasting/knowledge";
import type { LookupFetch } from "../src/forecast/lookup-http";
import { choosePrior } from "../src/forecast/prior";
import { priorAnswer } from "../src/forecast/prior-answer";
import { classRate, classTotals, type PublishedOutcome } from "../src/forecast/reference-class";
import {
  lastVisibleDay,
  retryRateLimited,
  type SeriesPoint,
  seriesHistory,
} from "../src/forecast/series-history";
import { chooseMethod, comparisonPrior, replayMethods } from "../src/forecast/series-prior";
import { parsePriors } from "../src/net/forecast-api";

const DAY = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A daily series from `start` for `n` days. */
function daily(start: string, n: number, f: (i: number, date: string) => number): SeriesPoint[] {
  const t0 = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => {
    const date = day(t0 + i * DAY);
    return { date, value: f(i, date) };
  });
}

/** A deterministic pseudo-random stream (no Math.random in tests). */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function fakeHttp(body: unknown): LookupFetch & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async json<T>(url: string) {
      urls.push(url);
      return { ok: true as const, value: body as T };
    },
    async text(url: string) {
      urls.push(url);
      return { ok: true as const, value: String(body) };
    },
  };
}

describe("series history", () => {
  const cutoff = new Date("2026-08-16T00:00:00Z");
  const now = () => new Date("2026-10-01T00:00:00Z");

  it("sees nothing on or after the cutoff's day", () => {
    expect(lastVisibleDay(cutoff)).toBe("2026-08-15");
  });

  it("drops DBnomics points after the cutoff and reads monthly periods", async () => {
    const http = fakeHttp({
      series: {
        docs: [
          {
            period: ["2026-08-14", "2026-08-15", "2026-08-16", "2026-08-17", "2026-07"],
            value: [20, 21, 99, 99, 18],
          },
        ],
      },
    });
    const h = await seriesHistory({ source: "dbnomics", id: "meteofrance/T/x.1.D" }, cutoff, {
      http,
      now,
    });
    if ("error" in h) throw new Error(h.error);
    expect(h.points.map((p) => p.value)).toEqual([18, 20, 21]);
    expect(h.points.at(-1)!.date).toBe("2026-08-15");
  });

  it("adjusts stock closes only for splits before the cutoff", async () => {
    const t = (d: string) => Date.parse(`${d}T14:30:00Z`) / 1000;
    const http = fakeHttp({
      chart: {
        result: [
          {
            timestamp: [t("2026-08-10"), t("2026-08-12"), t("2026-08-14")],
            indicators: { quote: [{ close: [200, 100, 101] }] },
            events: {
              splits: {
                a: { date: t("2026-08-11"), numerator: 2, denominator: 1 },
                // A split after the cutoff is never applied (it was not known then).
                b: { date: t("2026-09-01"), numerator: 10, denominator: 1 },
              },
            },
          },
        ],
      },
    });
    const h = await seriesHistory({ source: "yahoo", id: "SYN" }, cutoff, { http, now });
    if ("error" in h) throw new Error(h.error);
    expect(h.points.map((p) => p.value)).toEqual([100, 100, 101]);
    // The request itself never asks for prices after the cutoff.
    const period2 = Number(new URL(http.urls[0]!).searchParams.get("period2"));
    expect(period2 * 1000).toBeLessThan(cutoff.getTime());
  });

  it("reads FRED as of the day before the cutoff, and refuses a keyless past cutoff", async () => {
    const http = fakeHttp({ observations: [{ date: "2026-08-01", value: "5" }] });
    const h = await seriesHistory({ source: "fred", id: "UNRATE" }, cutoff, {
      http,
      now,
      fredApiKey: "k",
    });
    expect("error" in h).toBe(false);
    const q = new URL(http.urls[0]!).searchParams;
    expect(q.get("realtime_start")).toBe("2026-08-15");
    expect(q.get("realtime_end")).toBe("2026-08-15");
    const keyless = await seriesHistory({ source: "fred", id: "UNRATE" }, cutoff, { http, now });
    expect("error" in keyless && keyless.error).toContain("FRED_API_KEY");
  });

  it("retries a rate-limited request, and nothing else", async () => {
    let calls = 0;
    const waits: number[] = [];
    const flaky: LookupFetch = {
      async json<T>() {
        calls++;
        return calls < 3
          ? { ok: false as const, error: "fred HTTP 429" }
          : { ok: true as const, value: { observations: [] } as T };
      },
      async text() {
        return { ok: false as const, error: "fred HTTP 500" };
      },
    };
    const http = retryRateLimited(flaky, [1, 2, 3], async (ms) => {
      waits.push(ms);
    });
    expect((await http.json("u")).ok).toBe(true);
    expect(waits).toEqual([1, 2]);
    expect((await http.text("u")).ok).toBe(false);
    expect(waits).toEqual([1, 2]);
  });

  it("rejects malformed ids without a request", async () => {
    const http = fakeHttp({});
    const h = await seriesHistory({ source: "dbnomics", id: "../../etc" }, cutoff, { http, now });
    expect("error" in h).toBe(true);
    expect(http.urls).toHaveLength(0);
  });
});

describe("comparison prior", () => {
  it("finds seasonality in a seasonal series", () => {
    const rnd = lcg(7);
    const pts = daily("2012-01-01", 14 * 365, (_, d) => {
      const doy =
        (Date.parse(`${d}T00:00:00Z`) - Date.parse(`${d.slice(0, 4)}-01-01T00:00:00Z`)) / DAY;
      return 12 + 9 * Math.sin(((doy - 110) / 365) * 2 * Math.PI) + (rnd() - 0.5) * 4;
    });
    // Mid-August into autumn: the seasonal cycle says colder.
    const cut = pts.findIndex((p) => p.date === "2025-08-16");
    const p = comparisonPrior(pts.slice(0, cut), {
      baseline: "2025-08-16",
      targets: ["2025-09-15", "2025-11-14"],
    });
    expect(p?.method.startsWith("seasonal")).toBe(true);
    expect(p!.probabilities["2025-11-14"]!).toBeLessThan(0.2);
  });

  it("says 0.5 for a random walk", () => {
    const rnd = lcg(11);
    let v = 100;
    const pts = daily("2018-01-01", 7 * 365, () => {
      v += rnd() - 0.5;
      return v;
    });
    const p = comparisonPrior(pts, {
      baseline: "2025-01-01",
      targets: ["2025-01-08", "2025-01-31"],
    });
    expect(p?.method).toBe("half");
    expect(Object.values(p!.probabilities)).toEqual([0.5, 0.5]);
  });

  it("replays only outcomes inside the history it was given", () => {
    const pts = daily("2020-01-01", 3 * 365, (i) => i);
    const replay = replayMethods(pts, [7, 30]);
    expect(replay.length).toBeGreaterThan(0);
    // A steady climb: drift says rise, and beats a coin flip by far.
    expect(chooseMethod(replay)).not.toBe("half");
  });

  it("needs enough replayed outcomes before leaving 0.5", () => {
    expect(
      chooseMethod([
        { method: "drift", brier: 0.01, n: 5 },
        { method: "half", brier: 0.25, n: 5 },
      ]),
    ).toBe("half");
  });
});

describe("reference-class rates", () => {
  const o = (classes: string[], resolvedOn: string, outcome: number): PublishedOutcome => ({
    classes,
    resolvedOn,
    outcome,
  });

  it("counts only outcomes settled before the cutoff", () => {
    const outcomes = [
      o(["a", "a|t"], "2026-08-01", 1),
      o(["a", "a|t"], "2026-08-15", 1), // within the settle window of a 08-16 cutoff
      o(["a", "a|t"], "2026-09-01", 1), // after the cutoff
    ];
    const t = classTotals(outcomes, new Date("2026-08-16T00:00:00Z"));
    expect(t.get("a")).toEqual({ yes: 1, n: 1 });
  });

  it("pulls a thin narrow class only a little away from its parent", () => {
    const outcomes = [
      ...Array.from({ length: 100 }, (_, i) => o(["src", "src|t"], "2026-01-01", i < 10 ? 1 : 0)),
      o(["src", "src|u"], "2026-01-01", 1),
    ];
    const t = classTotals(outcomes, new Date("2026-08-16T00:00:00Z"));
    const thin = classRate(t, ["src", "src|u"])!;
    expect(thin.class).toBe("src|u");
    expect(thin.p).toBeLessThan(0.4);
    expect(classRate(t, ["none"])).toBeUndefined();
  });
});

describe("the statistical prior source", () => {
  const spec = {
    type: "multi" as const,
    options: [{ id: "d1" }, { id: "d2" }],
    minPicks: 0,
    probabilities: true as const,
  };

  it("is chosen like a supplied market price, and never from after the cutoff", () => {
    const at = "2026-08-15T23:59:59.999Z";
    const ok = choosePrior({
      spec,
      cutoff: "2026-08-16T00:00:00Z",
      supplied: [{ source: "statistical", distribution: { d1: 0.1, d2: 0.2 }, at }],
    });
    expect(ok.prior?.source).toBe("statistical");
    const late = choosePrior({
      spec,
      cutoff: "2026-08-15T00:00:00Z",
      supplied: [{ source: "statistical", distribution: { d1: 0.1, d2: 0.2 }, at }],
    });
    expect(late.prior?.source).toBe("type-default");
    expect(late.rejected?.[0]?.source).toBe("statistical");
  });

  it("is accepted over HTTP", () => {
    const r = parsePriors([
      { source: "statistical", at: "2026-08-15T00:00:00Z", distribution: { d1: 0.3 } },
    ]);
    expect("priors" in r && r.priors[0]!.source).toBe("statistical");
    expect("error" in parsePriors([{ source: "oracle", at: "2026-08-15T00:00:00Z" }])).toBe(true);
  });

  it("answers on its own with no model and no cost", () => {
    const a = priorAnswer({
      question: "q",
      answer: spec,
      asOf: "2026-08-16T00:00:00Z",
      priors: [
        { source: "statistical", distribution: { d1: 0.1, d2: 0.2 }, at: "2026-08-15T00:00:00Z" },
      ],
    });
    expect(a.distribution).toEqual({ d1: 0.1, d2: 0.2 });
    // An answer, not a fallback: a multi-select's prediction is its options at ≥ 0.5 (none here).
    expect(a.prediction).toEqual([]);
    expect(
      priorAnswer({ question: "q", answer: spec, asOf: "2026-08-16T00:00:00Z" }).prediction,
    ).toBeUndefined();
    expect(a.costUsd).toBe(0);
    expect(a.caveat).toContain("prior only");
  });

  it("is the baseline every candidate set includes", () => {
    expect(candidateConfigs([]).map((c) => c.label)).toContain(PRIOR_ONLY_CONFIG.label);
    expect(knowledgeBoundOf([])).toEqual({ after: "0000-01-01" });
    expect(parseConfigs([{ label: "p", analysts: [], priorOnly: true }])[0]!.priorOnly).toBe(true);
    expect(() => parseConfigs([{ label: "p", analysts: [] }])).toThrow();
  });
});

describe("ForecastBench dataset priors", () => {
  const due = "2026-08-16";
  const dates = ["2026-08-23", "2026-09-15"];
  const q = (source: string, id: string, extra: Partial<FbQuestion> = {}): FbQuestion => ({
    id,
    source,
    question: "Will X be higher on {resolution_date} than on {forecast_due_date}?",
    resolution_dates: dates,
    ...extra,
  });

  it("names the series ForecastBench asks about", () => {
    expect(seriesRefFor(q("fred", "WTREGEN"))).toEqual({ source: "fred", id: "WTREGEN" });
    expect(seriesRefFor(q("yfinance", "PCG"))).toEqual({ source: "yahoo", id: "PCG" });
    expect(
      seriesRefFor(
        q("dbnomics", "meteofrance_TEMPERATURE_celsius.07117.D", {
          url: "https://db.nomics.world/meteofrance/TEMPERATURE/celsius.07117.D",
        }),
      ),
    ).toEqual({ source: "dbnomics", id: "meteofrance/TEMPERATURE/celsius.07117.D" });
    expect(seriesRefFor(q("acled", "abc"))).toBeUndefined();
  });

  it("classes ACLED questions by event type, threshold and size", () => {
    const c = referenceClasses(
      q("acled", "a1", {
        question:
          "Will there be more than ten times as many 'Riots' in Chile for the 30 days before {resolution_date} compared to one plus the 30-day average?",
        freeze_datetime_value: "3.5",
      }),
    );
    expect(c).toEqual(["acled", "acled|Riots|x10", "acled|Riots|x10|<10"]);
  });

  it("builds priors from series and from earlier rounds' outcomes, and shows them to the runs", async () => {
    const past: FbQuestionSet = {
      forecast_due_date: "2026-06-07",
      question_set: "2026-06-07-llm.json",
      questions: [q("acled", "old", { question: "Will there be more 'Riots' in Chile?" })],
    };
    const outcomes = publishedOutcomes([
      {
        set: past,
        resolutions: Array.from({ length: 1 }, () => ({
          id: "old",
          source: "acled",
          resolution_date: "2026-06-14",
          resolved_to: 0,
          resolved: true,
        })),
      },
    ]);
    const set: FbQuestionSet = {
      forecast_due_date: due,
      question_set: `${due}-llm.json`,
      questions: [
        q("acled", "new", { question: "Will there be more 'Riots' in Peru?" }),
        q("yfinance", "SYN"),
      ],
    };
    const seen: string[] = [];
    const { priors } = await datasetPriors(set, set.questions, {
      outcomes,
      history: async (ref, cutoff) => {
        seen.push(`${ref.source}:${ref.id}@${cutoff.toISOString()}`);
        let v = 10;
        const rnd = lcg(3);
        return {
          ref,
          points: daily("2019-01-01", 2_000, () => (v += rnd() - 0.5)).filter((p) => p.date < due),
          lastDay: "2026-08-15",
          vintage: true,
          url: "u",
        };
      },
    });
    expect(seen).toEqual([`yahoo:SYN@${due}T00:00:00.000Z`]);
    const acled = priors.get("acled|new")!;
    expect(acled.prior.source).toBe("statistical");
    expect(acled.byDate[dates[0]!]!).toBeLessThan(0.5);
    expect(Date.parse(acled.prior.at)).toBeLessThan(Date.parse(`${due}T00:00:00Z`));
    const stock = priors.get("yfinance|SYN")!;
    expect(Object.keys(stock.prior.distribution!)).toEqual(dates.map(dateOptionId));

    const req = requestFor(set.questions[0]!, due, {
      prior: acled.prior,
      line: priorLine(acled),
    });
    expect(req.priors).toEqual([acled.prior]);
    expect(req.context).toContain("Statistical prior");
    // A question that could not be forecast falls back to its prior, not 0.5.
    expect(fallbackForecasts(set.questions[0]!, acled.byDate).map((f) => f.forecast)).toEqual(
      dates.map((d) => acled.byDate[d]!),
    );
  });
});
