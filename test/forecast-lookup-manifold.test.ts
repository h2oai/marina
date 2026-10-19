// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { arenaResearchLookups } from "../src/arena/research/data-evidence";
import { dataSources } from "../src/forecast/data-query";
import type { ManifoldBet, ManifoldMarket } from "../src/forecast/lookup-crowd";
import type { LookupFetch } from "../src/forecast/lookup-http";
import {
  LOOKUP_NAMES,
  lookupsFromSpec,
  manifoldLookup,
  OPT_IN_LOOKUP_NAMES,
  priceAtCutoff,
} from "../src/forecast/lookups";
import { choosePrior } from "../src/forecast/prior";

const NOW = new Date("2026-10-05T00:00:00Z");
const PAST = new Date("2026-09-01T12:00:00Z");
const ms = (iso: string) => Date.parse(iso);

/** A fake fetcher: routes by URL substring; records every URL. No network. */
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
      return { ok: false, error: "unused" };
    },
  };
}

const fed: ManifoldMarket = {
  id: "fed1",
  question: "Will the Fed cut rates at the October 2026 FOMC meeting?",
  url: "https://manifold.markets/someone/will-the-fed-cut-rates-oct-2026",
  outcomeType: "BINARY",
  probability: 0.81,
  volume: 15234.7,
  createdTime: ms("2026-06-01T00:00:00Z"),
  closeTime: ms("2026-10-28T18:00:00Z"),
  isResolved: false,
};
const unrelated: ManifoldMarket = {
  id: "x",
  question: "Will the movie gross 1B?",
  outcomeType: "BINARY",
  probability: 0.3,
  createdTime: ms("2026-01-01T00:00:00Z"),
};
const QUERY = "Will the Fed cut rates at its October 2026 FOMC meeting?";

describe("registry: manifold is opt-in on both config surfaces", () => {
  it("never turns on under auto, all or markets; only when named", () => {
    expect(OPT_IN_LOOKUP_NAMES).toEqual(["manifold"]);
    expect(LOOKUP_NAMES as readonly string[]).not.toContain("manifold");
    const names = (spec: string | undefined, env = {}) =>
      lookupsFromSpec(spec, env).map((l) => l.name);
    expect(names(undefined)).not.toContain("manifold");
    expect(names("auto")).not.toContain("manifold");
    expect(names("all")).not.toContain("manifold");
    expect(names("markets")).toEqual(["polymarket", "kalshi"]);
    expect(names("manifold")).toEqual(["manifold"]);
    expect(names("markets,manifold")).toEqual(["polymarket", "kalshi", "manifold"]);
    // Not offered: unknown names are ignored, as before.
    expect(names("gjopen")).toEqual([]);
  });

  it("is accepted by the arena research spec too, and listed as opt-in by the data command", () => {
    expect(
      arenaResearchLookups({ MARINA_ARENA_RESEARCH_LOOKUPS: "fred,manifold" }).map((l) => l.name),
    ).toEqual(["fred", "manifold"]);
    expect(
      arenaResearchLookups({ MARINA_ARENA_RESEARCH_LOOKUPS: "all" }).map((l) => l.name),
    ).not.toContain("manifold");
    expect(dataSources({})).toContain("manifold   opt-in");
  });
});

describe("manifold: live", () => {
  it("searches, matches, and reports probability, volume and close date", async () => {
    const seen: string[] = [];
    const http = fakeHttp([["/search-markets", [unrelated, fed]]], seen);
    const r = await manifoldLookup(http).lookup(QUERY, NOW, NOW, {
      endTime: "2026-10-28T00:00:00Z",
    });
    expect(seen[0]).toContain("api.manifold.markets/v0/search-markets?term=Will+the+Fed");
    expect(r.mode).toBe("live");
    expect(r.lines).toEqual([
      `- 2026-10-05 — Manifold (play money) "${fed.question}": Yes 81% (volume M15,235, closes 2026-10-28) [Manifold](${fed.url})`,
    ]);
    expect(r.prices).toEqual([
      { venue: "manifold", market: fed.question, outcome: "Yes", p: 0.81, at: NOW.toISOString() },
    ]);
    expect(r.sources).toEqual([{ url: fed.url!, title: fed.question }]);
  });

  it("skips resolved and closed markets, and markets about another period", async () => {
    const resolved = { ...fed, isResolved: true };
    const r1 = await manifoldLookup(fakeHttp([["/search-markets", [resolved]]])).lookup(
      QUERY,
      NOW,
      NOW,
    );
    expect(r1.lines).toEqual([]);
    expect(r1.skipped).toBe("no open market matched");
    const r2 = await manifoldLookup(fakeHttp([["/search-markets", [fed]]])).lookup(
      QUERY,
      NOW,
      NOW,
      {
        endTime: "2027-06-01T00:00:00Z",
      },
    );
    expect(r2.skipped).toBe("no market matched the question");
  });

  it("shows a multiple-choice market's leading answers from the market itself", async () => {
    const mc: ManifoldMarket = {
      ...fed,
      id: "mc1",
      question: "How many Fed rate cuts in October 2026 FOMC meeting?",
      outcomeType: "MULTIPLE_CHOICE",
      probability: undefined,
    };
    const full = {
      ...mc,
      answers: [
        { text: "0", probability: 0.2 },
        { text: "1", probability: 0.7 },
        { text: "2", probability: 0.1 },
        { text: "3+", probability: 0.0 },
      ],
    };
    const seen: string[] = [];
    const http = fakeHttp(
      [
        ["/search-markets", [mc]],
        ["/market/mc1", full],
      ],
      seen,
    );
    const r = await manifoldLookup(http).lookup(QUERY, NOW, NOW);
    expect(seen[1]).toContain("/v0/market/mc1");
    expect(r.lines[0]).toContain(": 1 70%, 0 20%, 2 10% (volume");
    // No single yes price for a multiple-choice market.
    expect(r.prices).toBeUndefined();
  });

  it("reports an API failure as skipped, never throws", async () => {
    const r = await manifoldLookup(fakeHttp([])).lookup(QUERY, NOW, NOW);
    expect(r.skipped).toBe("fake HTTP 404");
    const bad = await manifoldLookup(fakeHttp([["/search-markets", { error: "x" }]])).lookup(
      QUERY,
      NOW,
      NOW,
    );
    expect(bad.skipped).toBe("Manifold returned no market list");
  });
});

describe("manifold: a past cutoff reads the bet history, never the current value", () => {
  const bets: ManifoldBet[] = [
    // Newest first, as the API returns them; one after the cutoff must be ignored.
    { createdTime: ms("2026-09-03T00:00:00Z"), probAfter: 0.95, amount: 500 },
    { createdTime: ms("2026-09-01T12:00:00Z"), probAfter: 0.62, amount: 40 },
    { createdTime: ms("2026-08-30T10:00:00Z"), probAfter: 0.99, amount: 5, isRedemption: true },
    { createdTime: ms("2026-08-29T08:30:00Z"), probAfter: 0.58, amount: -60 },
    { createdTime: ms("2026-08-20T00:00:00Z"), probAfter: 0.4, answerId: "other" },
  ];

  it("takes the probability after the last trade at or before the cutoff", () => {
    expect(priceAtCutoff(bets, PAST.getTime())).toEqual({
      p: 0.62,
      at: ms("2026-09-01T12:00:00Z"),
      traded: 100,
      trades: 2,
    });
    expect(priceAtCutoff(bets, ms("2026-09-20T00:00:00Z"))).toEqual(
      expect.objectContaining({ p: 0.95 }),
    );
    // The last trade more than 30 days before the cutoff: stale, nothing.
    expect(priceAtCutoff(bets, ms("2026-12-01T00:00:00Z"))).toBeUndefined();
    expect(priceAtCutoff([], PAST.getTime())).toBeUndefined();
  });

  it("asks for bets before the cutoff and prints the historical price, not 81%", async () => {
    const seen: string[] = [];
    const http = fakeHttp(
      [
        ["/search-markets", [fed]],
        ["/bets?", bets],
      ],
      seen,
    );
    const r = await manifoldLookup(http).lookup(QUERY, PAST, NOW);
    expect(seen[1]).toContain("/v0/bets?contractId=fed1");
    expect(seen[1]).toContain(`beforeTime=${PAST.getTime() + 1}`);
    expect(r.mode).toBe("historical");
    expect(r.asOf).toBe(PAST.toISOString());
    expect(r.lines).toEqual([
      `- 2026-09-01 — Manifold (play money) "${fed.question}": Yes 62% (probability after the last trade, 2026-09-01T12:00Z; M100 traded up to the cutoff) [Manifold](${fed.url})`,
    ]);
    const line = r.lines.join("\n");
    expect(line).not.toContain("81%");
    expect(line).not.toContain("15,235");
    expect(line).not.toContain("closes");
    expect(r.prices).toEqual([
      {
        venue: "manifold",
        market: fed.question,
        outcome: "Yes",
        p: 0.62,
        at: "2026-09-01T12:00:00.000Z",
      },
    ]);
  });

  it("returns nothing rather than leak: no history, a later market, a settled one, multiple choice", async () => {
    const run = async (market: ManifoldMarket, history: unknown) =>
      manifoldLookup(
        fakeHttp([
          ["/search-markets", [market]],
          ...(history === undefined ? [] : ([["/bets?", history]] as Array<[string, unknown]>)),
        ]),
      ).lookup(QUERY, PAST, NOW);
    // The bet history cannot be read.
    const noHistory = await run(fed, undefined);
    expect(noHistory.lines).toEqual([]);
    expect(noHistory.prices).toBeUndefined();
    expect(noHistory.skipped).toBe("no trade at or before the cutoff");
    // Empty history.
    expect((await run(fed, [])).lines).toEqual([]);
    // Created after the cutoff.
    expect((await run({ ...fed, createdTime: ms("2026-09-02T00:00:00Z") }, bets)).skipped).toBe(
      "no market matched the question",
    );
    // Resolved before the cutoff: its price then was its resolution.
    expect(
      (await run({ ...fed, isResolved: true, resolutionTime: ms("2026-08-31T00:00:00Z") }, bets))
        .lines,
    ).toEqual([]);
    // Resolved AFTER the cutoff: still readable at the cutoff, resolution never shown.
    const later = await run(
      { ...fed, isResolved: true, resolutionTime: ms("2026-09-20T00:00:00Z") },
      bets,
    );
    expect(later.lines[0]).toContain("Yes 62%");
    // Multiple choice: no history-safe single price.
    expect((await run({ ...fed, outcomeType: "MULTIPLE_CHOICE" }, bets)).lines).toEqual([]);
  });

  it("feeds a yes/no forecast's market prior at the historical price", () => {
    const choice = {
      type: "choice" as const,
      options: [{ id: "Yes" }, { id: "No" }],
      probabilities: true,
    };
    const pick = choosePrior({
      spec: choice,
      cutoff: PAST.toISOString(),
      lookups: [
        {
          name: "manifold",
          lines: [],
          sources: [],
          prices: [
            {
              venue: "manifold",
              market: fed.question,
              outcome: "Yes",
              p: 0.62,
              at: "2026-09-01T12:00:00.000Z",
            },
          ],
        },
      ],
    });
    expect(pick.prior?.source).toBe("market-lookup");
    expect(pick.prior?.detail).toContain("manifold price 0.62");
  });
});
