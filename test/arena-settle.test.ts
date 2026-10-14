// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { arenaConfigFromEnv } from "../src/arena/config";
import { ArenaData } from "../src/arena/data";
import { profileEnergy, rboLoss } from "../src/arena/score-shapes";
import { arenaMethod, settleArenaFilings, shapeSubject } from "../src/arena/settle";
import type { ArenaRound } from "../src/arena/types";
import { settleDelivery } from "../src/outcomes/record";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

const ENTRANT = "marina-test";
const OWNER = `marina:arena/${ENTRANT}`;

const scalar: ArenaRound = {
  round_id: "civiqs-2026-w41-angry-share",
  tracker: "civiqs",
  series: "civiqs_angry_share",
  question: "Angry share?",
  target_type: "continuous_normal",
  lock_at: "2026-10-07T14:00:00Z",
  release_at: "2026-10-09T14:00:00Z",
};
const profile: ArenaRound = {
  round_id: "yougov-xtab-2026-w41",
  tracker: "yougov_xtab",
  question: "Crosstab approval?",
  target_type: "profile_energy",
  lock_at: "2026-10-04T14:00:00Z",
  release_at: "2026-10-06T14:00:00Z",
  cells: ["a", "b"],
};
const ranking: ArenaRound = {
  round_id: "wiki-top10-2026-10-11",
  tracker: "wikipedia",
  question: "Top 10?",
  target_type: "ranking_list",
  lock_at: "2026-10-02T14:00:00Z",
  release_at: "2026-10-13T14:00:00Z",
  ranking: { length: 3 },
};
const NOW = Date.parse("2026-10-14T00:00:00Z");

function dataWith(site: unknown[]): { data: ArenaData; siteFetches: () => number } {
  let fetches = 0;
  const files: Record<string, unknown> = {
    "questions/season0.json": { rounds: [scalar, profile, ranking] },
    [`locks/${scalar.round_id}.json`]: {
      round_id: scalar.round_id,
      answer_history: [{ date: "2026-10-02", value: 29.5 }],
    },
    "resolutions/resolved.json": {
      [scalar.round_id]: { value: 29.2, resolved_at: "2026-10-09T22:37:57Z" },
    },
    "site/data.json": { rounds: site },
  };
  const data = new ArenaData("https://example.test", async (url) => {
    const path = url.replace("https://example.test/", "");
    if (path === "site/data.json") fetches++;
    return path in files ? Response.json(files[path]) : new Response("", { status: 404 });
  });
  return { data, siteFetches: () => fetches };
}

const siteRounds = [
  {
    round_id: profile.round_id,
    status: "resolved",
    target_type: "profile_energy",
    resolution: { outcome: { a: 4, b: 24 } },
    scores: { persistence: { energy: 6 } },
  },
  {
    round_id: ranking.round_id,
    status: "resolved",
    target_type: "ranking_list",
    resolution: { outcome: ["x", "y", "z"] },
    scores: { persistence: { loss: 0.9 } },
  },
];

describe("arena settling", () => {
  const DB = `test_arena_settle_${process.pid}.db`;
  let db: MarinaDB;
  const config = arenaConfigFromEnv({ MARINA_ARENA_ENTRANT: ENTRANT })!;
  beforeEach(() => {
    db = new MarinaDB(DB);
  });
  afterEach(async () => {
    await settleDelivery(db);
    db.close();
    cleanupDb(DB);
  });

  const file = (round: ArenaRound, body: Record<string, unknown>, notes: string) => {
    const id = db.insertArenaSubmission({
      entrant: ENTRANT,
      roundId: round.round_id,
      requestId: `r-${round.round_id}-${Math.random()}`,
      url: "https://x",
      meta: "{}",
      body: JSON.stringify({ round_id: round.round_id, entrant: ENTRANT, ...body, notes }),
    });
    db.updateArenaSubmission(id, { status: "accepted", httpStatus: 200 });
    return id;
  };

  it("names the method from the route in a filing's notes", () => {
    expect(
      arenaMethod(
        "route civiqs → formation:delphi:openrouter/a,b+research@search:tavily; marina delphi",
      ),
    ).toEqual({
      method: "formation:delphi:openrouter/a,b+research@search:tavily",
      methodKind: "formation:delphi",
    });
    expect(arenaMethod("route wikipedia → nowcast; marina-baseline v2")).toEqual({
      method: "nowcast",
      methodKind: "nowcast",
    });
    expect(arenaMethod("route midterm_special → research:openrouter/a").methodKind).toBe(
      "research",
    );
    expect(arenaMethod("marina-baseline v1: persistence mean").methodKind).toBe("baseline");
    expect(
      arenaMethod("marina-baseline v1: persistence mean; Civiqs daily nowcast 2026-09-29")
        .methodKind,
    ).toBe("nowcast");
    expect(arenaMethod(undefined).methodKind).toBe("unknown");
  });

  it("settles every shape once, scored as the arena scores it, with family and method", async () => {
    const { data } = dataWith(siteRounds);
    file(scalar, { topline: { mean: 29.6, sd: 0.5 } }, "route civiqs → nowcast; early");
    const newest = file(
      scalar,
      { topline: { mean: 29.8, sd: 0.174 } },
      "route civiqs → formation:delphi:openrouter/a+research@closed-book; delphi",
    );
    file(
      profile,
      {
        profile: {
          a: { mean: 3.5, sd: 1.5 },
          b: { mean: 27.3, sd: 1.7 },
        },
      },
      "route yougov_xtab → formation:delphi:openrouter/a; delphi",
    );
    file(ranking, { ranking: ["x", "q", "y"] }, "route wikipedia → nowcast; recency");

    const report = await settleArenaFilings(db, { config, data }, { now: NOW });
    expect(report).toMatchObject({ settled: 3, number: 1, profile: 1, ranking: 1, unscored: [] });

    // Number: the NEWEST accepted filing (the one the arena scores), resolved by CRPS.
    const answer = db.getForecastAnswerByExternalId(OWNER, `arena:${scalar.round_id}`)!;
    expect(answer).toMatchObject({ mean: 29.8, sd: 0.174, source: "arena", eval_mode: "live" });
    expect(JSON.parse(answer.answer_json)).toMatchObject({
      submissionId: newest,
      family: "civiqs",
      methodKind: "formation:delphi",
      persistence: { mean: 29.5, sd: 1.5 },
    });
    const number = db.getOutcomeBySubject(`forecast:${answer.id}`)!;
    expect(number.resolved_at).toBe(Date.parse("2026-10-09T22:37:57Z")); // published, not now
    expect(JSON.parse(number.refs_json!)).toEqual(
      expect.arrayContaining(["family:civiqs", "method:formation:delphi"]),
    );

    // Profile: the arena's energy score against its recorded persistence energy.
    const prof = db.getOutcomeBySubject(shapeSubject(ENTRANT, profile.round_id))!;
    const energy = profileEnergy(
      { a: { mean: 3.5, sd: 1.5 }, b: { mean: 27.3, sd: 1.7 } },
      { a: 4, b: 24 },
      ["a", "b"],
    );
    expect(prof).toMatchObject({
      kind: "forecast",
      source: "arena:profile",
      metric: "energy",
      basis: "mechanical",
      eval_mode: "live",
      succeeded: energy < 6 ? 1 : 0,
    });
    expect(prof.loss).toBeCloseTo(energy, 9);
    expect(JSON.parse(prof.refs_json!)).toEqual(
      expect.arrayContaining(["family:yougov_xtab", "method:formation:delphi"]),
    );

    // Ranking: rank-biased overlap loss at the round's depth.
    const rank = db.getOutcomeBySubject(shapeSubject(ENTRANT, ranking.round_id))!;
    const loss = rboLoss(["x", "q", "y"], ["x", "y", "z"], 0.9, 3);
    expect(rank.loss).toBeCloseTo(loss, 9);
    expect(rank.quality).toBeCloseTo(1 - loss, 9);
    expect(rank.metric).toBe("rbo-loss");

    // Idempotent: a second pass settles nothing and reads no site data.
    const again = dataWith(siteRounds);
    expect((await settleArenaFilings(db, { config, data: again.data }, { now: NOW })).settled).toBe(
      0,
    );
    expect(again.siteFetches()).toBe(0);
  });

  it("leaves a shape round open until the arena publishes it, and reports unscorable ones", async () => {
    file(ranking, { ranking: ["x", "q", "y"] }, "route wikipedia → nowcast");
    file(profile, { profile: { a: { mean: 3.5, sd: 1.5 } } }, "route yougov_xtab → nowcast");
    const open = dataWith([{ ...siteRounds[1], status: "open" }]);
    expect((await settleArenaFilings(db, { config, data: open.data }, { now: NOW })).settled).toBe(
      0,
    );
    const later = await settleArenaFilings(
      db,
      { config, data: dataWith(siteRounds).data },
      {
        now: NOW,
      },
    );
    expect(later.ranking).toBe(1);
    expect(later.unscored).toEqual([
      { roundId: profile.round_id, reason: "profile cells do not match the outcome" },
    ]);
  });
});
