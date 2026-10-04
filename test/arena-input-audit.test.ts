// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { ArenaData } from "../src/arena/data";
import { auditedTrendsHistory, auditForecastInputs } from "../src/arena/input-audit";
import { buildResearchBrief } from "../src/arena/research/briefs";
import type { ArenaRound } from "../src/arena/types";

const round: ArenaRound = {
  round_id: "trends-test",
  tracker: "google_trends",
  question: "shares",
  target_type: "profile_energy",
  cells: ["trends_share_a", "trends_share_b"],
  lock_at: "2026-09-10T14:00:00Z",
  release_at: "2026-09-18T14:00:00Z",
};
const snapshot = () => ({
  fetched_at: "2026-09-10T12:00:00Z",
  queries: ["A", "B"],
  points: [["2026-09-01", "2026-09-07", [25, 75], false]] as Array<
    [string, string, number[], boolean]
  >,
});

test("YouGov research asks for the exact population and category without expanding the search budget", () => {
  const target = {
    ...round,
    tracker: "economist_yougov",
    series: "yougov_rv_strong_approval",
    question:
      "Economist/YouGov: percent of US registered voters who strongly approve of Donald Trump's job performance",
    target_type: "continuous_normal" as const,
  };
  const brief = buildResearchBrief(target, {
    round_id: target.round_id,
    answer_history: [{ date: "2026-09-01", value: 20 }],
  });
  expect(brief.queries).toHaveLength(3);
  expect(brief.queries?.[0]).toBe(target.question);
  expect(brief.request).toContain("total approval and strong approval are different responses");
  expect(brief.request).toContain("yougov_rv_strong_approval");
});

test("Trends accepts one complete basket and rejects a changed denominator or malformed vintage", () => {
  expect(auditedTrendsHistory(round, snapshot(), false)?.trends_share_a?.[0]?.value).toBe(25);
  for (const mutate of [
    (s: ReturnType<typeof snapshot>) => {
      s.queries.push("C");
      s.points[0]![2].push(50);
    },
    (s: ReturnType<typeof snapshot>) => {
      s.queries[1] = "A";
    },
    (s: ReturnType<typeof snapshot>) => {
      s.points[0]![2].pop();
    },
    (s: ReturnType<typeof snapshot>) => {
      s.points[0]![2][0] = -1;
    },
    (s: ReturnType<typeof snapshot>) => {
      s.points[0]![2][0] = Number.NaN;
    },
    (s: ReturnType<typeof snapshot>) => {
      s.points.push(s.points[0]!);
    },
    (s: ReturnType<typeof snapshot>) => {
      s.fetched_at = "2026-09-10T15:00:00Z";
    },
    (s: ReturnType<typeof snapshot>) => {
      s.fetched_at = "";
    },
  ]) {
    const s = snapshot();
    mutate(s);
    expect(auditedTrendsHistory(round, s, false)).toBeUndefined();
  }
});

test("partial periods are opt-in and an empty complete-period history cannot mask older data", () => {
  const s = snapshot();
  s.points = [["2026-09-08", "2026-09-14", [50, 50], true]];
  expect(auditedTrendsHistory(round, s, false)).toBeUndefined();
  expect(auditedTrendsHistory(round, s, true)?.trends_share_b?.[0]?.value).toBe(50);
});

test("audit rejects cross-series YouGov inputs and mismatched profile dates/shares", () => {
  const yougov = {
    ...round,
    tracker: "economist_yougov",
    series: "yougov_approval",
    target_type: "continuous_normal" as const,
  };
  const lock = {
    round_id: round.round_id,
    series: "another_poll",
    answer_history: [{ date: "2026-09-01", value: 42 }],
  };
  expect(auditForecastInputs(yougov, lock).issues).toContain("lock series disagrees with target");
  expect(auditForecastInputs(yougov, { ...lock, series: yougov.series }).ok).toBe(true);
  const profile = {
    round_id: round.round_id,
    answer_history_by_cell: auditedTrendsHistory(round, snapshot(), false)!,
  };
  expect(auditForecastInputs(round, profile).ok).toBe(true);
  profile.answer_history_by_cell.trends_share_b![0]!.date = "2026-09-02";
  expect(auditForecastInputs(round, profile).ok).toBe(false);
  profile.answer_history_by_cell.trends_share_b![0]!.value = 50;
  expect(auditForecastInputs(round, profile).issues).toContain(
    "basket shares do not form one complete 100-percent composition",
  );
});

test("frozen views preserve missing reads and isolate candidate mutations", async () => {
  let calls = 0;
  let exists = false;
  const data = new ArenaData("https://example.test", async () => {
    calls++;
    return exists
      ? Response.json({ round_id: "sample-round", history: [{ date: "2026-09-01", value: 2 }] })
      : new Response("", { status: 404 });
  });
  const frozen = data.frozen();
  await expect(frozen.lock("sample-round")).rejects.toThrow("404");
  exists = true;
  await expect(frozen.lock("sample-round")).rejects.toThrow("404");
  expect(calls).toBe(1);
  const fresh = data.frozen();
  const [a, b] = await Promise.all([fresh.lock("sample-round"), fresh.lock("sample-round")]);
  a.history![0]!.value = 999;
  expect(b.history![0]!.value).toBe(2);
  expect((await fresh.lock("sample-round")).history![0]!.value).toBe(2);
  expect(calls).toBe(2);
});
