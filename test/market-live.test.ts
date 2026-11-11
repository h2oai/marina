// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `market live` lists markets that resolve inside the window, most traded
// first: the venues are asked for the window (and Kalshi for no combos), and
// the selection keeps both rules even when a venue ignores a parameter.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { selectKalshiLive, selectPolymarketLive } from "../src/engine/commands/market";
import { getMarkets, type KalshiMarket, kalshiPrice } from "../src/net/clients/kalshi-client";
import { getEvents, type PolymarketEvent } from "../src/net/clients/polymarket-client";
import { __setDnsResolverForTest } from "../src/net/url-guard";

const NOW = Date.parse("2026-11-10T12:00:00Z");
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
    ...over,
  };
}

describe("selectKalshiLive", () => {
  it("keeps the window, drops combos, ranks by 24 h volume", () => {
    const picked = selectKalshiLive(
      [
        km({ ticker: "PAST", close_time: iso(NOW - H), volume_24h_fp: "999" }),
        km({ ticker: "LATE", close_time: iso(NOW + 100 * H), volume_24h_fp: "999" }),
        km({ ticker: "KXMVECROSSCATEGORY-X", volume_24h_fp: "999" }),
        km({ ticker: "COMBO", mve_collection_ticker: "KXMVE-1", volume_24h_fp: "999" }),
        km({ ticker: "QUIET", volume_24h_fp: "5" }),
        km({ ticker: "BUSY", volume_24h_fp: "500.00" }),
        km({ ticker: "NOVOL" }),
      ],
      NOW,
      NOW + 48 * H,
      10,
    );
    expect(picked.map((m) => m.ticker)).toEqual(["BUSY", "QUIET", "NOVOL"]);
  });

  it("honours the limit", () => {
    const many = Array.from({ length: 5 }, (_, i) => km({ ticker: `M${i}` }));
    expect(selectKalshiLive(many, NOW, NOW + 48 * H, 2)).toHaveLength(2);
  });
});

describe("selectPolymarketLive", () => {
  const market = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    question: id,
    outcomePrices: '["0.6","0.4"]',
    volume: 0,
    active: true,
    closed: false,
    ...over,
  });
  const ev = (id: string, over: Partial<PolymarketEvent> = {}): PolymarketEvent => ({
    id,
    title: id,
    slug: id,
    endDate: iso(NOW + 10 * H),
    markets: [market(`${id}-m`)],
    ...over,
  });

  it("keeps the window, drops closed markets and empty events, ranks by 24 h volume", () => {
    const picked = selectPolymarketLive(
      [
        ev("dead-2025", { endDate: "2025-12-31T00:00:00Z", volume24hr: 1e9 }),
        ev("far", { endDate: iso(NOW + 400 * H), volume24hr: 1e9 }),
        ev("no-end", { endDate: undefined, volume24hr: 1e9 }),
        ev("all-closed", { markets: [market("c", { closed: true })], volume24hr: 1e9 }),
        ev("small", { volume24hr: 10 }),
        ev("big", {
          volume24hr: 5000,
          markets: [
            market("low", { volume24hr: 1 }),
            market("shut", { closed: true, volume24hr: 1e6 }),
            market("high", { volume24hr: 900 }),
          ],
        }),
      ],
      NOW,
      NOW + 72 * H,
      10,
    );
    expect(picked.map((e) => e.id)).toEqual(["big", "small"]);
    expect(picked[0]!.markets.map((m) => m.id)).toEqual(["high", "low"]);
  });
});

describe("kalshiPrice", () => {
  it("prefers the dollar string, falls back to cents, else NaN", () => {
    expect(kalshiPrice("0.4800", null)).toBe(0.48);
    expect(kalshiPrice(undefined, 37)).toBe(0.37);
    expect(kalshiPrice(null, null)).toBeNaN();
  });
});

describe("venue query parameters", () => {
  const realFetch = globalThis.fetch;
  let urls: string[] = [];
  beforeEach(() => {
    urls = [];
    __setDnsResolverForTest(async () => ["93.184.216.34"]);
    globalThis.fetch = (async (input: string | URL) => {
      urls.push(String(input));
      const body = String(input).includes("kalshi") ? { markets: [] } : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    __setDnsResolverForTest(null);
  });

  it("Kalshi asks for the close window and no combos", async () => {
    await getMarkets(
      { status: "open", minCloseTs: 100, maxCloseTs: 200, excludeMultivariate: true },
      { base: "https://kalshi.example.com/v2" },
    );
    const q = new URL(urls[0]!).searchParams;
    expect(q.get("min_close_ts")).toBe("100");
    expect(q.get("max_close_ts")).toBe("200");
    expect(q.get("mve_filter")).toBe("exclude");
  });

  it("Polymarket asks for the end window, by 24 h volume", async () => {
    await getEvents(
      {
        active: true,
        closed: false,
        endDateMin: "2026-11-10T00:00:00.000Z",
        endDateMax: "2026-11-12T00:00:00.000Z",
        order: "volume24hr",
      },
      { gammaBase: "https://gamma.example.com" },
    );
    const q = new URL(urls[0]!).searchParams;
    expect(q.get("end_date_min")).toBe("2026-11-10T00:00:00.000Z");
    expect(q.get("end_date_max")).toBe("2026-11-12T00:00:00.000Z");
    expect(q.get("order")).toBe("volume24hr");
    expect(q.get("ascending")).toBe("false");
  });
});
