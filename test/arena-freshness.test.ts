// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { ArenaData } from "../src/arena/data";
import { forecastRound } from "../src/arena/forecast";
import { buildDossier } from "../src/arena/formations";
import { auditForecastFreshness, forecastCutoff } from "../src/arena/freshness";
import { buildResearchBrief } from "../src/arena/research/briefs";
import {
  civiqsNowcast,
  nowcastForecaster,
  trendsForecastLock,
} from "../src/arena/research/civiqs-nowcast";
import { forecasterFor } from "../src/arena/service";
import type { ArenaLock, ArenaRound } from "../src/arena/types";

const now = Date.parse("2026-10-07T18:00:00Z");
let clock: ReturnType<typeof spyOn>;
beforeEach(() => {
  clock = spyOn(Date, "now").mockReturnValue(now);
});
afterEach(() => clock.mockRestore());
const round: ArenaRound = {
  round_id: "civiqs-2026-w42-approval",
  tracker: "civiqs",
  series: "civiqs_net_approval",
  target_type: "continuous_normal",
  question: "Net approval?",
  lock_at: "2026-10-14T14:00:00Z",
  release_at: "2026-10-16T14:00:00Z",
};
const lock: ArenaLock = {
  round_id: round.round_id,
  answer_history: [
    { date: "2026-09-25", value: -26 },
    { date: "2026-10-02", value: -26.1 },
  ],
};
const base = forecastRound(round, lock);
function archive(date = "2026-10-06") {
  const requests: string[] = [];
  const data = new ArenaData("https://example.test", async (url) => {
    requests.push(url);
    return url.endsWith("/2026-10-07.json")
      ? Response.json({
          choices: ["Approve", "Disapprove"],
          fetched_at: "2026-10-07T08:00:00Z",
          points: [[date, 34, 60]],
        })
      : new Response("", { status: 404 });
  });
  return { data, requests };
}

test("early forecasts search from today; historical cutoffs stay historical", async () => {
  expect(forecastCutoff(round.lock_at)).toBe(new Date(now).toISOString());
  expect(forecastCutoff("2026-09-30T14:00:00Z")).toBe("2026-09-30T14:00:00.000Z");
  const { data, requests } = archive();
  expect((await civiqsNowcast(data, round))?.date).toBe("2026-10-06");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toEndWith("/2026-10-07.json");
});

test("a newly downloaded daily snapshot does not refresh an old observation", async () => {
  const { data } = archive("2026-10-01");
  await expect(
    nowcastForecaster(data, forecastRound, { strictFreshness: true })(round, lock),
  ).rejects.toThrow("2026-10-02 is 5 days old");
});

test("strict baseline previews refuse stale inputs while replays remain available", async () => {
  const strict = await forecasterFor("baseline", { strictFreshness: true });
  await expect(strict.forecaster(round, lock)).rejects.toThrow("stale forecast inputs");
  const replay = await forecasterFor("baseline");
  expect((await replay.forecaster(round, lock)).topline).toEqual(base.topline);
});

test("fresh archives may survive live failure, with that failure retained", async () => {
  const { data } = archive();
  const f = await nowcastForecaster(data, forecastRound, {
    strictFreshness: true,
    live: async () => {
      throw new Error("HTTP 503");
    },
  })(round, lock);
  expect(f.freshness?.ok).toBe(true);
  expect(f.origins?.civiqs_net_approval?.liveError).toBe("HTTP 503");
  expect(f.origins?.civiqs_net_approval?.reading.date).toBe("2026-10-06");
});

test("every profile cell must be current; monthly releases use their own cadence", () => {
  const profile: ArenaRound = { ...round, target_type: "profile_energy", cells: ["a", "b"] };
  const inputs: ArenaLock = {
    round_id: round.round_id,
    answer_history_by_cell: {
      a: [{ date: "2026-10-06", value: 1 }],
      b: [{ date: "2026-10-02", value: 2 }],
    },
  };
  const audit = auditForecastFreshness(profile, inputs, forecastRound(profile, inputs));
  expect(audit.ok).toBe(false);
  expect(audit.issues).toEqual([expect.stringContaining("b: observation")]);
  const monthly = { ...round, tracker: "ny_fed_sce" };
  const monthlyLock = {
    ...lock,
    answer_history: [
      { date: "2026-08-01", value: 3 },
      { date: "2026-09-01", value: 3.1 },
    ],
  };
  expect(auditForecastFreshness(monthly, monthlyLock, forecastRound(monthly, monthlyLock)).ok).toBe(
    true,
  );
});

test("research has a real information cutoff and retains failed engines and empty evidence", async () => {
  const brief = buildResearchBrief(round, lock);
  expect(brief.untilAt).toBe(new Date(now).toISOString());
  const dossier = await buildDossier(
    round,
    lock,
    base,
    async () => ({
      report: "No relevant dated sources found.",
      sources: [],
      costUsd: 0.01,
      searches: 1,
      retriever: "sonar",
      warnings: ["tavily HTTP 429"],
    }),
    async () => undefined,
  );
  expect(dossier.status).toBe("empty");
  expect(dossier.costUsd).toBe(0.01);
  expect(dossier.warnings).toContain("tavily HTTP 429");
  expect(dossier.warnings).toContain(
    "No verified research evidence; do not attribute forecast changes to research.",
  );
});

test("Trends refreshes the entire basket and gives models the same newer vintage", async () => {
  const trendRound: ArenaRound = {
    ...round,
    tracker: "google_trends",
    target_type: "profile_energy",
    cells: ["trends_share_a", "trends_share_b"],
  };
  const trendLock: ArenaLock = {
    round_id: round.round_id,
    answer_history_by_cell: {
      trends_share_a: [{ date: "2026-09-26", value: 50 }],
      trends_share_b: [{ date: "2026-09-26", value: 50 }],
    },
  };
  const data = new ArenaData("https://example.test", async (url) => {
    if (url.endsWith("trends/index.json"))
      return Response.json({ directories: ["basket.a+b.geo-US"] });
    if (url.endsWith("2026-10-07.json"))
      return Response.json({
        fetched_at: "2026-10-07T10:00:00Z",
        queries: ["a", "b"],
        points: [["2026-09-27", "2026-10-03", [60, 40], false]],
      });
    return new Response("", { status: 404 });
  });
  const inputs = await trendsForecastLock(data, trendRound, trendLock);
  expect(inputs.answer_history_by_cell?.trends_share_a?.at(-1)).toEqual({
    date: "2026-10-03",
    value: 60,
  });
  const forecast = await nowcastForecaster(data, forecastRound, { strictFreshness: true })(
    trendRound,
    trendLock,
  );
  expect(forecast.profile?.trends_share_a?.mean).toBe(60);
  expect(forecast.freshness?.readings.trends_share_a?.date).toBe("2026-10-03");
  expect(auditForecastFreshness(trendRound, trendLock, forecast).ok).toBe(true);
});
