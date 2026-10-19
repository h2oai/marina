// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { AnswerSpec } from "../src/forecast/answer-types";
import { logit, sigmoid } from "../src/forecast/fitting";
import type { MarketPrice } from "../src/forecast/lookups";
import { choosePrior, poolVenuePrices } from "../src/forecast/prior";

const yn: AnswerSpec = { type: "choice", options: [{ id: "Yes" }, { id: "No" }] };
const CUTOFF = "2026-09-01T00:00:00Z";
const FED = "Will the Fed cut rates in October?";
const price = (venue: string, p: number, extra: Partial<MarketPrice> = {}): MarketPrice => ({
  venue,
  market: FED,
  outcome: "Yes",
  p,
  at: "2026-08-31T12:00:00.000Z",
  ...extra,
});
const pick = (prices: MarketPrice[]) =>
  choosePrior({
    spec: yn,
    cutoff: CUTOFF,
    lookups: [{ name: "lookups", lines: [], sources: [], prices }],
  });

describe("market-lookup prior: single venue is unchanged (regression)", () => {
  // The exact outputs of the single-venue prior before cross-venue pooling.
  it("one price, several prices on one venue, a late price, no price", () => {
    expect(JSON.stringify(pick([price("kalshi", 0.2)]))).toBe(
      '{"prior":{"source":"market-lookup","distribution":{"Yes":0.2,"No":0.8},"at":"2026-08-31T12:00:00.000Z","detail":"kalshi price 0.2 at 2026-08-31T12:00:00.000Z"}}',
    );
    expect(JSON.stringify(pick([price("kalshi", 0.2), price("kalshi", 0.4)]))).toBe(
      '{"prior":{"source":"type-default","distribution":{"Yes":0.5,"No":0.5},"detail":"uniform"},"rejected":[{"source":"market-lookup","reason":"2 priced yes markets matched (a prior needs exactly one)"}]}',
    );
    expect(JSON.stringify(pick([price("polymarket", 0.2, { at: "2026-09-03T00:00:00Z" })]))).toBe(
      '{"prior":{"source":"type-default","distribution":{"Yes":0.5,"No":0.5},"detail":"uniform"},"rejected":[{"source":"market-lookup","reason":"0 priced yes markets matched (a prior needs exactly one)"}]}',
    );
    expect(
      JSON.stringify(
        pick([price("polymarket", 0.37), price("polymarket", 0.5), price("polymarket", 0.6)]),
      ),
    ).toBe(
      '{"prior":{"source":"type-default","distribution":{"Yes":0.5,"No":0.5},"detail":"uniform"},"rejected":[{"source":"market-lookup","reason":"3 priced yes markets matched (a prior needs exactly one)"}]}',
    );
    expect(JSON.stringify(pick([]))).toBe(
      '{"prior":{"source":"type-default","distribution":{"Yes":0.5,"No":0.5},"detail":"uniform"}}',
    );
  });
});

describe("market-lookup prior: several venues on one question are pooled", () => {
  it("pools one market per venue in log-odds, equal weights across volume units", () => {
    const c = pick([
      price("polymarket", 0.2),
      price("manifold", 0.3, {
        market: "Will the Fed cut rates at the October FOMC?",
        at: "2026-08-30T00:00:00.000Z",
        volume: 5000,
        volumeUnit: "mana",
      }),
    ]);
    const expected = sigmoid((logit(0.2) + logit(0.3)) / 2);
    expect(c.prior?.source).toBe("market-lookup");
    expect(c.prior?.distribution?.Yes).toBeCloseTo(expected, 6);
    expect(c.prior?.at).toBe("2026-08-31T12:00:00.000Z");
    expect(c.prior?.detail).toContain("pooled 2 venues, equal weights");
    expect(c.prior?.detail).toContain("polymarket 0.2 (w 0.5), manifold 0.3 (w 0.5)");
    expect(c.prior?.detail).not.toContain("disagree");
    expect(c.rejected).toBeUndefined();
  });

  it("weights by log(1 + volume) when every venue reports the same unit, and notes disagreement", () => {
    const r = poolVenuePrices([
      price("a", 0.1, { volume: 100, volumeUnit: "USD" }),
      price("b", 0.6, { volume: 10_000, volumeUnit: "USD" }),
    ]);
    if (!("pooled" in r)) throw new Error("expected a pool");
    const wa = Math.log1p(100);
    const wb = Math.log1p(10_000);
    const z = (wa * logit(0.1) + wb * logit(0.6)) / (wa + wb);
    expect(r.pooled.p).toBeCloseTo(sigmoid(z), 9);
    expect(r.pooled.detail).toContain("volume-weighted (USD)");
    expect(r.pooled.detail).toContain("spread 0.5 — venues disagree");
  });

  it("refuses venues whose markets do not name the same question", () => {
    const c = pick([
      price("kalshi", 0.2),
      price("manifold", 0.7, { market: "Oscar best picture" }),
    ]);
    expect(c.prior?.source).toBe("type-default");
    expect(c.rejected?.[0]?.reason).toContain("do not name the same question (kalshi, manifold)");
  });

  it("keeps several markets within one venue ambiguous, even beside another venue", () => {
    const c = pick([price("kalshi", 0.2), price("kalshi", 0.4), price("manifold", 0.3)]);
    expect(c.prior?.source).toBe("type-default");
    expect(c.rejected).toEqual([
      {
        source: "market-lookup",
        reason: "3 priced yes markets matched (a prior needs exactly one)",
      },
    ]);
  });
});
