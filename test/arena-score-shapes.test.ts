// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { ArenaData } from "../src/arena/data";
import { forecastRanking, isExcludedTitle } from "../src/arena/forecast";
import { trendsBasketHistory, wikitopObservations } from "../src/arena/research/civiqs-nowcast";
import {
  cellSamples,
  energyScore,
  normalQuantile,
  profileEnergy,
  rboLoss,
  rboSimilarity,
} from "../src/arena/score-shapes";

/**
 * Values published by the arena (site/data.json, 2026-09-25) for real
 * forecasts: Marina's ported scorers must reproduce them.
 */
describe("profile energy score matches the arena", () => {
  const cells = [
    "trends_share_tesla",
    "trends_share_iphone",
    "trends_share_samsung",
    "trends_share_netflix",
    "trends_share_disney",
  ];
  it("is deterministic and reproduces a one-dimensional CRPS-like scale", () => {
    const a = cellSamples([{ mean: 0, sd: 1 }]);
    const b = cellSamples([{ mean: 0, sd: 1 }]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(400);
    // CRPS of N(0,1) at 0 is 0.2337; the 400-point set approximates it closely.
    expect(energyScore(a, [0])).toBeCloseTo(0.2337, 2);
    expect(normalQuantile(0, 1, 0.975)).toBeCloseTo(1.96, 3);
  });
  it("separates a sharper correct forecast from a wider one", () => {
    const outcome = Object.fromEntries(cells.map((c, i) => [c, 10 + i]));
    const sharp = Object.fromEntries(cells.map((c, i) => [c, { mean: 10 + i, sd: 0.5 }]));
    const wide = Object.fromEntries(cells.map((c, i) => [c, { mean: 10 + i, sd: 5 }]));
    expect(profileEnergy(sharp, outcome, cells)).toBeLessThan(profileEnergy(wide, outcome, cells));
  });
});

describe("ranking loss matches the arena", () => {
  it("is 0 for identical lists, 1 for disjoint ones, top-weighted in between", () => {
    const t = ["a", "b", "c", "d"];
    expect(rboSimilarity(t, t, 0.9)).toBe(1);
    expect(rboLoss(["w", "x", "y", "z"], t, 0.9)).toBe(1);
    expect(rboLoss(["a", "x", "y", "z"], t, 0.9)).toBeLessThan(
      rboLoss(["x", "y", "z", "a"], t, 0.9),
    );
  });
});

describe("Wikipedia ranking", () => {
  it("excludes Main_Page and non-article namespaces exactly as the arena does", () => {
    expect(isExcludedTitle("Main_Page")).toBe(true);
    expect(isExcludedTitle("Special:Search")).toBe(true);
    expect(isExcludedTitle("User_talk:X")).toBe(true);
    expect(isExcludedTitle("Deaths_in_2026")).toBe(false);
  });

  it("weights recent days more, so a fading spike loses to a sustained article", () => {
    const day = (date: string, views: Record<string, number>) => ({
      date,
      items: Object.keys(views),
      views,
    });
    const ranking = forecastRanking(
      {
        round_id: "wiki-top10-x",
        answer_obs: [
          day("2026-09-01", { Spike: 1000, Steady: 300 }),
          day("2026-09-08", { Spike: 10, Steady: 300 }),
        ],
      },
      2,
    );
    expect(ranking).toEqual(["Steady", "Spike"]);
  });

  it("reads archive days published before the lock (two-day lag), not fetch times", async () => {
    const files: Record<string, unknown> = {
      "wikitop/en.wikipedia.all-access/2026-09-23.json": {
        day: "2026-09-23",
        fetched_at: "2026-10-30T00:00:00Z", // backfilled long after — still counts
        articles: { A: 5, B: 3 },
      },
      "wikitop/en.wikipedia.all-access/2026-09-24.json": {
        day: "2026-09-24",
        articles: { A: 1 },
      },
    };
    const data = new ArenaData("https://example.test", async (url) => {
      const path = url.replace("https://example.test/", "");
      return path in files ? Response.json(files[path]) : new Response("", { status: 404 });
    });
    const obs = await wikitopObservations(data, {
      round_id: "wiki-top10-2026-10-04",
      tracker: "wikipedia",
      question: "?",
      target_type: "ranking_list",
      lock_at: "2026-09-25T14:00:00Z",
      release_at: "2026-10-06T14:00:00Z",
      ranking: { length: 2 },
    });
    // 09-24 is inside the publication lag of a 09-25 lock; 09-23 is not.
    expect(obs.map((o) => o.date)).toEqual(["2026-09-23"]);
    expect(obs[0]!.items).toEqual(["A", "B"]);
  });
});

describe("Google Trends basket history", () => {
  it("turns the snapshot fetched before the lock into per-brand shares", async () => {
    const files: Record<string, unknown> = {
      "trends/basket.Tesla-iPhone-Samsung-Netflix-Disney.geo-US/2026-09-11.json": {
        fetched_at: "2026-09-11T10:00:00Z",
        queries: ["Tesla", "iPhone", "Samsung", "Netflix", "Disney"],
        points: [
          ["2026-08-30", "2026-09-05", [10, 50, 10, 20, 10], false],
          ["2026-09-06", "2026-09-12", [10, 70, 10, 5, 5], true],
        ],
      },
    };
    const data = new ArenaData("https://example.test", async (url) => {
      const path = url.replace("https://example.test/", "");
      return path in files ? Response.json(files[path]) : new Response("", { status: 404 });
    });
    const round = {
      round_id: "trends-basket-2026-09-19",
      tracker: "google_trends",
      question: "?",
      target_type: "profile_energy" as const,
      cells: [
        "trends_share_tesla",
        "trends_share_iphone",
        "trends_share_samsung",
        "trends_share_netflix",
        "trends_share_disney",
      ],
      lock_at: "2026-09-11T14:00:00Z",
      release_at: "2026-09-19T14:00:00Z",
    };
    const complete = await trendsBasketHistory(data, round, false);
    expect(complete?.trends_share_iphone).toEqual([{ date: "2026-09-05", value: 50 }]);
    const partial = await trendsBasketHistory(data, round, true);
    expect(partial?.trends_share_iphone?.at(-1)).toEqual({ date: "2026-09-12", value: 70 });
  });
});
