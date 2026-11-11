// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `forecast market:live` picks a real, undecided Kalshi market closing soon and
// forecasts it filed against that market, so the answer is scored when it
// settles (the hourly outcome-autoresolve job reads linked markets). Nothing
// runs until someone types it or schedules it.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { forecastCommand, forecastLiveMarket, saveAnswer } from "../src/engine/commands/forecast";
import { parseModifiers } from "../src/engine/parse-input";
import {
  fetchLiveKalshiPick,
  kalshiQuestion,
  pickLiveKalshiMarket,
} from "../src/forecast/live-market";
import type { ForecastAnswer } from "../src/forecast/question";
import type { KalshiMarket } from "../src/net/clients/kalshi-client";
import { __setDnsResolverForTest } from "../src/net/url-guard";
import { MarinaDB } from "../src/persistence/database";
import type { CommandInput, EntityId, RoomContext } from "../src/types";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function km(over: Partial<KalshiMarket> & { ticker: string }): KalshiMarket {
  return {
    title: over.ticker,
    yes_ask: Number.NaN,
    yes_bid: Number.NaN,
    no_ask: Number.NaN,
    no_bid: Number.NaN,
    volume: 0,
    status: "active",
    close_time: iso(NOW + 10 * H),
    category: "",
    yes_ask_dollars: "0.50",
    ...over,
  };
}

describe("pickLiveKalshiMarket", () => {
  it("takes the most traded undecided market in the window", () => {
    const pick = pickLiveKalshiMarket(
      [
        km({ ticker: "LATE", close_time: iso(NOW + 100 * H), volume_24h_fp: "9999" }),
        km({ ticker: "DECIDED", yes_ask_dollars: "0.99", volume_24h_fp: "5000" }),
        km({ ticker: "LONGSHOT", yes_ask_dollars: "0.02", volume_24h_fp: "4000" }),
        km({ ticker: "COMBO", mve_collection_ticker: "KXMVE-1", volume_24h_fp: "3000" }),
        km({ ticker: "BUSY", yes_ask_dollars: "0.40", volume_24h_fp: "900" }),
        km({ ticker: "QUIET", volume_24h_fp: "5" }),
      ],
      NOW,
      NOW + 48 * H,
    );
    expect(pick?.ticker).toBe("BUSY");
  });

  it("skips what the forecaster answered, and that market's sibling outcomes", () => {
    const markets = [
      km({ ticker: "GAME-A", event_ticker: "GAME", volume_24h_fp: "900" }),
      km({ ticker: "GAME-B", event_ticker: "GAME", volume_24h_fp: "800" }),
      km({ ticker: "OTHER", event_ticker: "OTHER", volume_24h_fp: "10" }),
    ];
    expect(pickLiveKalshiMarket(markets, NOW, NOW + 48 * H)?.ticker).toBe("GAME-A");
    expect(pickLiveKalshiMarket(markets, NOW, NOW + 48 * H, new Set(["GAME-A"]))?.ticker).toBe(
      "OTHER",
    );
    expect(
      pickLiveKalshiMarket(markets, NOW, NOW + 48 * H, new Set(["GAME-A", "OTHER"])),
    ).toBeUndefined();
  });
});

describe("kalshiQuestion", () => {
  it("asks in the venue's own resolution words", () => {
    const q = kalshiQuestion(
      km({
        ticker: "KXT-1",
        title: "Ivanov Denis wins",
        close_time: "2026-11-13T17:15:00Z",
        rules_primary: "If Ivanov Denis wins the match, then the market resolves to Yes.",
      }),
    );
    expect(q).toBe(
      "Ivanov Denis wins? Resolves YES per Kalshi: If Ivanov Denis wins the match, then the market resolves to Yes. Market closes 2026-11-13 17:15Z.",
    );
    expect(kalshiQuestion(km({ ticker: "KXT-2", title: "Rain?" }))).toContain(
      "Resolves per Kalshi market KXT-2.",
    );
  });
});

describe("fetchLiveKalshiPick", () => {
  const realFetch = globalThis.fetch;
  let urls: string[] = [];
  beforeEach(() => {
    urls = [];
    __setDnsResolverForTest(async () => ["93.184.216.34"]);
    globalThis.fetch = (async (input: string | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ markets: [km({ ticker: "ONLY" })] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    __setDnsResolverForTest(null);
  });

  it("asks the venue for open markets closing in the window, no combos", async () => {
    const r = await fetchLiveKalshiPick(48 * H, new Set(), {
      now: NOW,
      client: { base: "https://kalshi.example.com/v2" },
    });
    expect(r).toMatchObject({ ok: true, market: { ticker: "ONLY" } });
    const q = new URL(urls[0]!).searchParams;
    expect(q.get("status")).toBe("open");
    expect(q.get("min_close_ts")).toBe(String(NOW / 1000));
    expect(q.get("max_close_ts")).toBe(String((NOW + 48 * H) / 1000));
    expect(q.get("mve_filter")).toBe("exclude");
  });
});

describe("forecast market:live", () => {
  let db: MarinaDB;
  let sent: string[];
  const ctx = () =>
    ({ send: (_: string, text: string) => sent.push(text) }) as unknown as RoomContext;
  const spec = {
    market: { type: "string" },
    window: { type: "string" },
    resolves: { type: "string" },
    formation: { type: "string" },
  } as const;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
    sent = [];
  });
  afterEach(() => db.close());

  it("files the picked market's question against that market, keeping other modifiers", async () => {
    const answered = {
      question: "q",
      kind: "probability",
      probability: 0.5,
    } as unknown as ForecastAnswer;
    saveAnswer(db, "Ada", answered, "kalshi/OLD");
    let excluded: ReadonlySet<string> | undefined;
    let window = 0;
    const reran: string[] = [];
    await forecastLiveMarket(
      ctx(),
      "e_ada" as EntityId,
      "Ada",
      parseModifiers("market:live window:24h formation:verify".split(" "), spec),
      { db },
      (args) => {
        reran.push(args);
      },
      async (w, ex) => {
        window = w;
        excluded = ex;
        return {
          ok: true,
          market: km({ ticker: "KXNEW-1", title: "Team A wins", rules_primary: "If A wins, Yes." }),
        };
      },
    );
    expect(window).toBe(24 * H);
    expect([...(excluded ?? [])]).toEqual(["OLD"]);
    expect(sent[0]).toContain("Picked kalshi/KXNEW-1 (yes 50¢)");
    expect(reran).toHaveLength(1);
    expect(reran[0]).toStartWith("resolves:kalshi/KXNEW-1 formation:verify -- Team A wins? ");
  });

  it("says so when no market qualifies, and runs nothing", async () => {
    const reran: string[] = [];
    await forecastLiveMarket(
      ctx(),
      "e_ada" as EntityId,
      "Ada",
      parseModifiers(["market:live"], spec),
      { db },
      (a) => {
        reran.push(a);
      },
      async () => ({ ok: true }),
    );
    expect(sent.at(-1)).toContain("No open Kalshi market closing within 48h");
    expect(reran).toEqual([]);
  });

  it("refuses a question, another market word, resolves: or a bad window before any request", () => {
    const cmd = forecastCommand({ db, getEntity: () => ({ name: "Ada" }) });
    const run = (args: string) =>
      cmd.handler(ctx(), { entity: "e_ada", args } as unknown as CommandInput);
    run("market:live Will it rain?");
    expect(sent.at(-1)).toContain("picks its own question");
    run("market:soon");
    expect(sent.at(-1)).toContain('market: takes live (forecast market:live), not "soon"');
    run("market:live resolves:kalshi/X");
    expect(sent.at(-1)).toContain("leave out resolves:");
    run("market:live window:90d");
    expect(sent.at(-1)).toContain("window: takes a duration from 1h to 30d");
  });

  it("only as the first word: a question that mentions market: is a question", async () => {
    const { forecastModifierSpec } = await import("../src/engine/commands/forecast");
    expect(Object.keys(forecastModifierSpec({}))).not.toContain("market");
  });
});
