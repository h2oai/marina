// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { Retriever } from "../src/arena/research/retrieve";
import type { LookupFetch } from "../src/forecast/lookup-http";
import { bestMatches, tokens } from "../src/forecast/lookup-match";
import {
  blsLookup,
  fredLookup,
  impliedProbabilities,
  kalshiLookup,
  type LookupContext,
  lookupsFromSpec,
  numericAnchor,
  oddsLookup,
  polymarketLookup,
} from "../src/forecast/lookups";
import { forecastTyped, type ModelPart } from "../src/forecast/typed";
import type { KalshiCandle, KalshiEvent } from "../src/net/kalshi-client";
import type { PolymarketEvent, PolymarketPricePoint } from "../src/net/polymarket-client";

const NOW = new Date("2026-10-05T00:00:00Z");
const PAST = new Date("2026-09-01T12:00:00Z");
const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** A fake fetcher: routes by URL substring; records every URL. */
function fakeHttp(routes: Array<[string, unknown]>, seen: string[] = []): LookupFetch {
  const find = (url: string) => routes.find(([k]) => url.includes(k))?.[1];
  return {
    async json<T>(url: string) {
      seen.push(url);
      const v = find(url);
      if (v === undefined) return { ok: false, error: "fake HTTP 404" };
      return { ok: true, value: v as T };
    },
    async text(url: string) {
      seen.push(url);
      const v = find(url);
      return typeof v === "string" ? { ok: true, value: v } : { ok: false, error: "fake HTTP 404" };
    },
  };
}

describe("matching", () => {
  it("keeps only matches close to the best one", () => {
    const q = tokens("Will the Fed cut rates at its next meeting? Fed rate cut");
    expect(
      bestMatches(
        ["Next Fed rate hike?", "Next Fed rate cut?", "World Series winner"],
        q,
        (s) => s,
      ),
    ).toEqual(["Next Fed rate cut?"]);
    expect(bestMatches(["World Series winner"], q, (s) => s)).toEqual([]);
  });
});

describe("lookup registry", () => {
  it("expands markets and all; ignores unknown names", () => {
    expect(lookupsFromSpec("markets").map((l) => l.name)).toEqual(["polymarket", "kalshi"]);
    expect(lookupsFromSpec("all").map((l) => l.name)).toEqual([
      "polymarket",
      "kalshi",
      "odds",
      "fred",
      "bls",
    ]);
    expect(lookupsFromSpec("fred, nope").map((l) => l.name)).toEqual(["fred"]);
  });
});

describe("polymarket price at the cutoff", () => {
  const event: PolymarketEvent = {
    id: "1",
    title: "Fed rate cut in September",
    slug: "fed-cut",
    markets: [
      {
        id: "m1",
        question: "Will the Fed cut rates in September?",
        outcomePrices: '["0.99","0.01"]', // today's (resolved) price — must never be shown
        clobTokenIds: '["tok-yes","tok-no"]',
        volume: 1,
        active: false,
        closed: true,
      },
      {
        id: "m2",
        question: "Will the Fed cut by 50bp?",
        outcomePrices: '["0.02","0.98"]',
        clobTokenIds: '["tok-late"]',
        volume: 1,
        active: false,
        closed: true,
      },
    ],
  };
  const history = async (
    token: string,
  ): Promise<{ ok: true; paper: false; response: PolymarketPricePoint[] }> => {
    const points: Record<string, PolymarketPricePoint[]> = {
      // one price before the cutoff, one after
      "tok-yes": [
        { t: ts("2026-09-01T06:00:00Z"), p: 0.62 },
        { t: ts("2026-09-10T00:00:00Z"), p: 0.95 },
      ],
      // only after the cutoff: the market is unusable as of the cutoff
      "tok-late": [{ t: ts("2026-09-05T00:00:00Z"), p: 0.3 }],
    };
    return { ok: true, paper: false, response: points[token] ?? [] };
  };

  it("reads the last price at or before the cutoff, never today's price", async () => {
    const seenClosed: boolean[] = [];
    const lookup = polymarketLookup(
      async (_q, _n, _o, includeClosed) => {
        seenClosed.push(Boolean(includeClosed));
        return { ok: true, paper: false, response: [event] };
      },
      4,
      history,
    );
    const r = await lookup.lookup("Will the Fed cut rates in September?", PAST, NOW);
    expect(seenClosed).toEqual([true]);
    expect(r.mode).toBe("historical");
    expect(r.asOf).toBe(PAST.toISOString());
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain("Yes 62%");
    expect(r.lines[0]).toContain("price at 2026-09-01T06:00Z");
    expect(r.lines.join(" ")).not.toContain("99%");
    expect(r.lines.join(" ")).not.toContain("95%");
  });

  it("drops an event that does not match the question", async () => {
    const lookup = polymarketLookup(
      async () => ({ ok: true, paper: false, response: [event] }),
      4,
      history,
    );
    const r = await lookup.lookup("Who will win the World Series?", PAST, NOW);
    expect(r.lines).toEqual([]);
    expect(r.skipped).toBe("no market matched the question");
  });
});

describe("kalshi", () => {
  const ev: KalshiEvent = {
    event_ticker: "KXFED-26SEP",
    series_ticker: "KXFED",
    title: "Fed decision in September 2026",
    markets: [
      {
        ticker: "KXFED-26SEP-CUT",
        title: "Cut",
        yes_bid: 60,
        yes_ask: 64,
        no_ask: 40,
        no_bid: 36,
        volume: 10,
        status: "active",
        close_time: "2026-09-17T18:00:00Z",
        category: "economics",
      },
    ],
  };

  it("prices a live market at the bid/ask midpoint", async () => {
    const lookup = kalshiLookup({
      events: async () => ({ ok: true, paper: false, response: { events: [ev] } }),
      candles: async () => ({ ok: false, error: "unused" }),
    });
    const r = await lookup.lookup("Fed decision September 2026 rate cut", NOW, NOW, {
      endTime: "2026-09-17T18:00:00Z",
    });
    expect(r.mode).toBe("live");
    expect(r.lines[0]).toContain("Yes 62%");
  });

  it("uses the last candle at or before a past cutoff, across settled events", async () => {
    const statuses: string[] = [];
    const candles: KalshiCandle[] = [
      { end_period_ts: ts("2026-09-01T11:00:00Z"), price: { close: 55 } },
      { end_period_ts: ts("2026-09-01T13:00:00Z"), price: { close: 97 } }, // after the cutoff
    ];
    const lookup = kalshiLookup({
      events: async (f = {}) => {
        statuses.push(f.status ?? "");
        return {
          ok: true,
          paper: false,
          response: { events: f.status === "settled" ? [ev] : [] },
        };
      },
      candles: async () => ({ ok: true, paper: false, response: { candlesticks: candles } }),
    });
    const r = await lookup.lookup("Fed decision September 2026 rate cut", PAST, NOW);
    expect(statuses).toEqual(["open", "closed", "settled"]);
    expect(r.mode).toBe("historical");
    expect(r.lines[0]).toContain("Yes 55%");
    expect(r.lines.join(" ")).not.toContain("97%");
  });
});

describe("sports odds", () => {
  const game = (commence: string) => ({
    id: "g1",
    sport_key: "basketball_nba",
    commence_time: commence,
    home_team: "Boston Celtics",
    away_team: "Los Angeles Lakers",
    bookmakers: [
      {
        key: "b1",
        markets: [
          {
            key: "h2h",
            outcomes: [
              { name: "Boston Celtics", price: 1.5 },
              { name: "Los Angeles Lakers", price: 2.8 },
            ],
          },
        ],
      },
    ],
  });

  it("removes the bookmaker margin", () => {
    const p = impliedProbabilities(game("2026-10-06T00:00:00Z"));
    expect(p?.books).toBe(1);
    const [top, second] = p!.probs;
    expect(top?.[0]).toBe("Boston Celtics");
    expect(top![1] + second![1]).toBeCloseTo(1, 6);
    expect(top![1]).toBeCloseTo(0.651, 3);
  });

  it("is skipped without a key, and never leaks the key", async () => {
    expect((await oddsLookup(undefined).lookup("x", NOW, NOW)).skipped).toBe(
      "ODDS_API_KEY not set",
    );
    const seen: string[] = [];
    const lookup = oddsLookup(
      "SECRETKEY",
      fakeHttp([["/sports/basketball_nba/odds", [game("2026-10-06T00:00:00Z")]]], seen),
    );
    const ctx: LookupContext = {
      hints: { sport: "basketball_nba", teams: ["Boston Celtics", "Los Angeles Lakers"] },
    };
    const r = await lookup.lookup("Will the Celtics beat the Lakers?", NOW, NOW, ctx);
    expect(seen[0]).toContain("apiKey=SECRETKEY");
    expect(r.lines[0]).toContain("Boston Celtics 65%");
    expect(JSON.stringify(r)).not.toContain("SECRETKEY");
  });

  it("shows only games that start after the cutoff", async () => {
    const lookup = oddsLookup(
      "K",
      fakeHttp([["/sports/basketball_nba/odds", [game("2026-10-04T00:00:00Z")]]]),
    );
    const r = await lookup.lookup("Will the Celtics beat the Lakers?", NOW, NOW, {
      hints: { sport: "basketball_nba" },
    });
    expect(r.lines).toEqual([]);
  });

  it("reads a historical snapshot only when it is at or before the cutoff", async () => {
    const ok = oddsLookup(
      "K",
      fakeHttp([
        [
          "/historical/sports/basketball_nba/odds",
          { timestamp: "2026-09-01T11:55:00Z", data: [game("2026-09-02T00:00:00Z")] },
        ],
      ]),
    );
    const r = await ok.lookup("Will the Celtics beat the Lakers?", PAST, NOW, {
      hints: { sport: "basketball_nba" },
    });
    expect(r.mode).toBe("historical");
    expect(r.asOf).toBe("2026-09-01T11:55:00.000Z");
    expect(r.lines).toHaveLength(1);
    const late = oddsLookup(
      "K",
      fakeHttp([
        [
          "/historical/sports/basketball_nba/odds",
          { timestamp: "2026-09-01T12:30:00Z", data: [game("2026-09-02T00:00:00Z")] },
        ],
      ]),
    );
    const l = await late.lookup("Will the Celtics beat the Lakers?", PAST, NOW, {
      hints: { sport: "basketball_nba" },
    });
    expect(l.skipped).toBe("no odds snapshot at or before the cutoff");
    expect((await ok.lookup("x", PAST, NOW)).skipped).toBe("historical odds need a sport key");
  });
});

describe("official series", () => {
  const obs = {
    observations: [
      { date: "2026-08-01", value: "4.3" },
      { date: "2026-07-01", value: "4.2" },
      { date: "2026-06-01", value: "4.1" },
      { date: "2026-09-01", value: "9.9" }, // dated after the cutoff day: must be dropped
    ],
  };

  it("reads FRED as published on the cutoff date (vintage) and drops later observations", async () => {
    const seen: string[] = [];
    const lookup = fredLookup(
      "FK",
      fakeHttp(
        [
          ["series/observations", obs],
          ["fred/series?", { seriess: [{ title: "Unemployment Rate", units_short: "%" }] }],
        ],
        seen,
      ),
    );
    const r = await lookup.lookup(
      "Unemployment rate in September?",
      new Date("2026-08-20T00:00:00Z"),
      NOW,
      {
        hints: { fred: ["UNRATE"] },
        answerType: "number",
      },
    );
    const url = seen.find((u) => u.includes("observations"))!;
    expect(url).toContain("realtime_start=2026-08-20");
    expect(url).toContain("realtime_end=2026-08-20");
    expect(url).toContain("observation_end=2026-08-20");
    expect(r.mode).toBe("historical");
    expect(r.readings?.[0]?.value).toBe(4.3);
    expect(r.readings?.[0]?.date).toBe("2026-08-01");
    expect(r.lines.join(" ")).not.toContain("9.9");
    expect(JSON.stringify(r)).not.toContain("FK");
  });

  it("without a key, FRED serves a live cutoff only", async () => {
    const past = await fredLookup(undefined).lookup("x", PAST, NOW, {
      hints: { fred: ["UNRATE"] },
    });
    expect(past.skipped).toContain("needs FRED_API_KEY");
    const live = fredLookup(
      undefined,
      fakeHttp([["fredgraph.csv", "observation_date,UNRATE\n2026-08-01,4.3\n2026-09-01,4.4\n"]]),
    );
    const r = await live.lookup("x", NOW, NOW, { hints: { fred: ["UNRATE"] } });
    expect(r.mode).toBe("live");
    expect(r.readings?.[0]?.value).toBe(4.4);
  });

  it("BLS is live-only and parses monthly periods", async () => {
    expect(
      (await blsLookup(undefined).lookup("x", PAST, NOW, { hints: { bls: ["CUUR0000SA0"] } }))
        .skipped,
    ).toContain("skipped for a past cutoff");
    const lookup = blsLookup(
      undefined,
      fakeHttp([
        [
          "api.bls.gov",
          {
            status: "REQUEST_SUCCEEDED",
            Results: {
              series: [
                {
                  seriesID: "CUUR0000SA0",
                  data: [
                    { year: "2026", period: "M08", value: "330.1" },
                    { year: "2026", period: "M07", value: "329.4" },
                    { year: "2025", period: "M13", value: "320.0" },
                  ],
                },
              ],
            },
          },
        ],
      ]),
    );
    const r = await lookup.lookup("CPI", NOW, NOW, { hints: { bls: ["CUUR0000SA0"] } });
    expect(r.readings?.[0]?.value).toBe(330.1);
    expect(r.readings?.[0]?.date).toBe("2026-08-01");
  });

  it("the anchor's spread grows with the horizon", () => {
    const history = Array.from({ length: 24 }, (_, i) => ({
      date: `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}-01`,
      // a drifting series with a little noise: changes grow with the horizon
      value: 4 + i * 0.1 + (((i * 7) % 3) - 1) * 0.02,
    }));
    const reading = {
      source: "FRED",
      series: "UNRATE",
      value: history.at(-1)!.value,
      date: history.at(-1)!.date,
      asOf: "2025-12-20",
      history,
    };
    const cutoff = new Date("2025-12-20T00:00:00Z");
    const near = numericAnchor([reading], cutoff, "2026-01-05T00:00:00Z")!;
    const far = numericAnchor([reading], cutoff, "2026-06-01T00:00:00Z")!;
    expect(near.steps).toBe(1);
    expect(far.steps).toBeGreaterThan(near.steps);
    expect(far.sd!).toBeGreaterThan(near.sd!);
  });
});

describe("forecastTyped with lookups", () => {
  const retriever: Retriever = async () => ({
    report: "- 2026-09-20 — nothing decisive ([src](https://example.org/1))",
    sources: [{ url: "https://example.org/1" }],
    costUsd: 0,
    searches: 1,
    retriever: "fake",
  });
  const part = (name: string, reply: (s: string, u: string) => string): ModelPart => ({
    name,
    complete: async (s, u) => reply(s, u),
  });

  it("passes the plan's data hints, anchors a number, and records what fired", async () => {
    let ctxSeen: LookupContext | undefined;
    const runPrompts: string[] = [];
    const a = await forecastTyped(
      {
        question: "What will the unemployment rate be for September?",
        answer: { type: "number" },
        endTime: "2026-10-03T12:00:00Z",
        asOf: "2026-09-20T00:00:00Z",
      },
      {
        retriever,
        now: () => NOW,
        planner: part("planner", (system) =>
          system.startsWith("You plan research")
            ? JSON.stringify({ queries: ["unemployment"], data: { fred: ["UNRATE"], sport: "" } })
            : JSON.stringify({ done: true }),
        ),
        analysts: [
          part("m1", (_s, u) => {
            runPrompts.push(u);
            return '{"answer": 4.3, "confidence": 0.6, "reason": "anchor"}';
          }),
        ],
        lookups: [
          {
            name: "fred",
            async lookup(_q, cutoff, _now, ctx) {
              ctxSeen = ctx;
              return {
                name: "fred",
                lines: [
                  "- 2026-08-01 — FRED UNRATE: 4.3 [FRED](https://fred.stlouisfed.org/series/UNRATE)",
                ],
                sources: [{ url: "https://fred.stlouisfed.org/series/UNRATE" }],
                mode: "historical",
                asOf: cutoff.toISOString(),
                readings: [
                  {
                    source: "FRED",
                    series: "UNRATE",
                    value: 4.3,
                    date: "2026-08-01",
                    asOf: "2026-09-20",
                    history: [
                      { date: "2026-05-01", value: 4.1 },
                      { date: "2026-06-01", value: 4.2 },
                      { date: "2026-07-01", value: 4.2 },
                      { date: "2026-08-01", value: 4.3 },
                    ],
                  },
                ],
              };
            },
          },
        ],
        options: { runs: 1, researchRounds: 1, critique: false },
      },
    );
    expect(ctxSeen?.hints).toEqual({ fred: ["UNRATE"] });
    expect(ctxSeen?.answerType).toBe("number");
    expect(ctxSeen?.endTime).toBe("2026-10-03T12:00:00Z");
    expect(a.lookups?.[0]?.asOf).toBe("2026-09-20T00:00:00.000Z");
    expect(a.anchor?.value).toBe(4.3);
    expect(a.anchor?.steps).toBeGreaterThanOrEqual(2);
    expect(runPrompts[0]).toContain("ANCHOR");
    expect(a.prediction).toBe(4.3);
  });
});
