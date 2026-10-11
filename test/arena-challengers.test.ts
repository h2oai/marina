// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { recordChallengers, scoreChallengers } from "../src/arena/challenger-shadow";
import { ArenaData } from "../src/arena/data";
import { scoreShadow } from "../src/arena/evaluate";
import type { ArenaLock, ArenaRound } from "../src/arena/types";
import { MarinaDB } from "../src/persistence/database";

const round: ArenaRound = {
  round_id: "test-numeric",
  tracker: "test",
  series: "test",
  target_type: "continuous_normal",
  question: "Value?",
  lock_at: "2099-10-06T22:00:00Z",
  release_at: "2099-10-08T00:00:00Z",
};
const lock: ArenaLock = {
  round_id: round.round_id,
  history: Array.from({ length: 15 }, (_, i) => ({
    date: `2099-09-${String(i + 15).padStart(2, "0")}`,
    value: 40 + (i % 2),
  })),
};
const now = () => Date.parse("2099-10-06T12:00:00Z");
const data = new ArenaData("https://arena.test", async (url) => {
  if (url.endsWith("season0.json")) return Response.json({ rounds: [round] });
  if (url.includes("/locks/")) return Response.json(lock);
  if (url.endsWith("resolved.json"))
    return Response.json({ [round.round_id]: { value: 40, resolved_at: "2099-10-09T12:00:00Z" } });
  return new Response("missing", { status: 404 });
});

test("challengers retain paid failures and score the latest whole comparison", async () => {
  const db = new MarinaDB(":memory:");
  try {
    const first = await recordChallengers(db, data, round.round_id, {
      kind: "numeric",
      now,
      predict: async () => ({
        result: { ok: false, error: "provider unavailable" },
        cached: false,
        ms: 0,
      }),
    });
    expect(first.attempts.find((a) => a.candidate === "tabh2o-covariates")?.status).toBe("failed");
    const second = await recordChallengers(db, data, round.round_id, {
      kind: "numeric",
      now,
      predict: async () => ({ result: { ok: false, error: "spend cap" }, cached: false, ms: 0 }),
    });
    expect(db.listArenaSubmissions()).toHaveLength(0);
    const report = await scoreChallengers(
      data,
      db.listArenaShadow({ limit: 100 }),
      "2099-10-10T00:00:00Z",
    );
    expect(report.comparisons).toHaveLength(4);
    expect(report.comparisons.every((c) => c.batchId === second.batchId)).toBe(true);
    expect(report.comparisons.find((c) => c.candidate === "tabh2o-covariates")?.status).toBe(
      "failed",
    );
    expect(report.calibrationObservations).toHaveLength(1);
    expect(report.promotion).toBe("none");
  } finally {
    db.close();
  }
});

test("recorded Wikipedia rankings use native RBO scoring", async () => {
  const rankingRound: ArenaRound = {
    ...round,
    tracker: "wikipedia",
    target_type: "ranking_list",
    ranking: { length: 2 },
  };
  const rankingData = new ArenaData("https://arena.test", async (url) => {
    if (url.endsWith("season0.json")) return Response.json({ rounds: [rankingRound] });
    if (url.endsWith("resolved.json")) return Response.json({});
    if (url.endsWith("site/data.json"))
      return Response.json({
        rounds: [
          {
            round_id: round.round_id,
            target_type: "ranking_list",
            status: "resolved",
            resolution: { outcome: ["A", "B"] },
            scores: { persistence: { loss: 0.5 } },
          },
        ],
      });
    if (url.includes("/locks/"))
      return Response.json({
        round_id: round.round_id,
        answer_obs: [{ date: "2099-10-01", items: ["B", "A"] }],
      });
    return new Response("missing", { status: 404 });
  });
  const scores = await scoreShadow(rankingData, [
    {
      round_id: round.round_id,
      forecaster: "test",
      forecast: JSON.stringify({ ranking: ["A", "B"] }),
      cost_usd: 0,
      created_at: now(),
    },
  ]);
  expect(scores).toHaveLength(1);
  expect(scores[0]!.shape).toBe("ranking_list");
  expect(scores[0]!.skill).toBe(1);
});
