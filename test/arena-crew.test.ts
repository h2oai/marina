// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { arenaConfigFromEnv, parseForecasterSpec } from "../src/arena/config";
import { CREW_ENTITY, crewForecastRound, learn, recallLessons } from "../src/arena/crew";
import { ArenaData } from "../src/arena/data";
import { evaluateResolved } from "../src/arena/evaluate";
import type { Complete } from "../src/arena/model-forecaster";
import { learnFromResolutions } from "../src/arena/service";
import type { ArenaLock, ArenaPoint, ArenaRound } from "../src/arena/types";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

const weekly = (values: number[], start = "2026-01-02"): ArenaPoint[] =>
  values.map((value, i) => ({
    date: new Date(Date.parse(start) + i * 7 * 86_400_000).toISOString().slice(0, 10),
    value,
  }));
const history = weekly(Array.from({ length: 30 }, (_, i) => 40 + (i % 3)));
const round: ArenaRound = {
  round_id: "civiqs-2026-w40-approval",
  tracker: "civiqs",
  series: "civiqs_net_approval",
  question: "Net approval?",
  target_type: "continuous_normal",
  lock_at: "2026-08-01T14:00:00Z",
  release_at: "2026-08-03T14:00:00Z",
};
const lock: ArenaLock = { round_id: round.round_id, answer_history: history };
const reply =
  (text: string): Complete =>
  async () =>
    text;

describe("forecasting crew", () => {
  it("moves the baseline by the proposals' mean move, scaled by the skeptic's trust", async () => {
    const last = history.at(-1)!.value;
    const f = await crewForecastRound(round, lock, {
      statistician: reply(`{"mean": ${last + 2}, "sd": 2, "reason": "trend"}`),
      analyst: reply(`{"mean": ${last + 4}, "sd": 2}`),
      skeptic: reply('{"trust": 0.5, "sd_scale": 1, "critique": "half"}'),
    });
    expect(f.topline!.mean).toBeCloseTo(last + 0.5 * 3, 3);
    expect(f.trust).toBe(0.5);
    expect(Object.keys(f.proposals!)).toEqual(["statistician", "analyst"]);
    expect(f.critique).toBe("half");
  });

  it("drops a broken or wild role, and files the baseline when nothing usable is left", async () => {
    const last = history.at(-1)!.value;
    const one = await crewForecastRound(round, lock, {
      statistician: async () => {
        throw new Error("down");
      },
      analyst: reply(`{"mean": ${last + 1000}, "sd": 1}`),
      skeptic: reply('{"trust": 1}'),
    });
    expect(one.fallback).toBe("no usable proposal");
    expect(one.topline!.mean).toBe(last);
    const trustZero = await crewForecastRound(round, lock, {
      statistician: reply(`{"mean": ${last + 2}, "sd": 2}`),
      analyst: reply("nonsense"),
      skeptic: reply('{"trust": 0}'),
    });
    expect(trustZero.topline!.mean).toBe(last);
  });

  it("answers only numeric rounds and files the baseline for profiles", async () => {
    const prof: ArenaRound = { ...round, target_type: "profile_energy", cells: ["a_b", "c_d"] };
    const f = await crewForecastRound(
      prof,
      { round_id: prof.round_id, answer_history_by_cell: { a_b: history, c_d: history } },
      { statistician: reply("{}"), analyst: reply("{}"), skeptic: reply("{}") },
    );
    expect(f.profile).toBeDefined();
    expect(f.fallback).toContain("numeric");
  });
});

describe("crew memory", () => {
  const DB = `test_arena_crew_${process.pid}.db`;
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(DB);
  });
  afterEach(() => {
    db.close();
    cleanupDb(DB);
  });

  it("writes a lesson per resolved round and the analyst recalls the series' newest", async () => {
    const last = history.at(-1)!.value;
    learn(db, round, lock, { mean: last + 2, sd: 1.5 }, last - 1);
    const lessons = recallLessons(db, "civiqs_net_approval");
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toContain("WRONG way");
    expect(lessons[0]).toContain("lost to persistence");
    expect(recallLessons(db, "other_series")).toHaveLength(0);
    expect(db.getNotesByType(CREW_ENTITY, "lesson", 10)).toHaveLength(1);

    let seen = "";
    await crewForecastRound(
      round,
      lock,
      {
        statistician: reply("{}"),
        analyst: async (_s, user) => {
          seen = user;
          return "{}";
        },
        skeptic: reply("{}"),
      },
      db,
    );
    expect(seen).toContain("WRONG way");
  });

  it("evaluation reveals an outcome to learners only after it was published", async () => {
    const r1: ArenaRound = { ...round, round_id: "civiqs-2026-w31-approval" };
    // Locks BEFORE r1 is published: must not know r1's outcome.
    const r2: ArenaRound = {
      ...round,
      round_id: "civiqs-2026-w32-approval",
      lock_at: "2026-08-02T14:00:00Z",
      release_at: "2026-08-05T14:00:00Z",
    };
    // Locks after r1's release: may learn from it.
    const r3: ArenaRound = {
      ...round,
      round_id: "civiqs-2026-w33-approval",
      lock_at: "2026-08-10T14:00:00Z",
      release_at: "2026-08-12T14:00:00Z",
    };
    const files: Record<string, unknown> = {
      "questions/season0.json": { rounds: [r1, r2, r3] },
      "resolutions/resolved.json": Object.fromEntries(
        [r1, r2, r3].map((r) => [r.round_id, { value: 41 }]),
      ),
    };
    for (const r of [r1, r2, r3])
      files[`locks/${r.round_id}.json`] = { ...lock, round_id: r.round_id };
    const data = new ArenaData("https://example.test", async (url) => {
      const path = url.replace("https://example.test/", "");
      return path in files ? Response.json(files[path]) : new Response("", { status: 404 });
    });
    const knownAt: Record<string, number> = {};
    const learned: string[] = [];
    await evaluateResolved(
      data,
      {
        probe: async (r, l) => {
          knownAt[r.round_id] = learned.length;
          return {
            topline: { mean: l.answer_history!.at(-1)!.value, sd: 1.5 },
            rules: {},
            note: "",
          };
        },
      },
      { learners: { probe: (r) => learned.push(r.round_id) } },
    );
    expect(knownAt[r1.round_id]).toBe(0);
    expect(knownAt[r2.round_id]).toBe(0); // r1 not yet published when r2 locked
    expect(knownAt[r3.round_id]).toBe(2); // r1 and r2 both published before r3's lock
  });

  it("learns live from accepted filings once the arena resolves them, exactly once", async () => {
    const files: Record<string, unknown> = {
      "questions/season0.json": { rounds: [round] },
      [`locks/${round.round_id}.json`]: lock,
      "resolutions/resolved.json": { [round.round_id]: { value: 45 } },
    };
    const data = new ArenaData("https://example.test", async (url) => {
      const path = url.replace("https://example.test/", "");
      return path in files ? Response.json(files[path]) : new Response("", { status: 404 });
    });
    const config = arenaConfigFromEnv({ MARINA_ARENA_ENTRANT: "marina-test" })!;
    const id = db.insertArenaSubmission({
      entrant: "marina-test",
      roundId: round.round_id,
      requestId: "r-1",
      url: "https://x",
      meta: "{}",
      body: JSON.stringify({ round_id: round.round_id, topline: { mean: 41, sd: 1.5 } }),
    });
    expect(await learnFromResolutions(db, { config, data })).toBe(0); // not accepted yet
    db.updateArenaSubmission(id, { status: "accepted", httpStatus: 201 });
    expect(await learnFromResolutions(db, { config, data })).toBe(1);
    expect(await learnFromResolutions(db, { config, data })).toBe(0);
    expect(recallLessons(db, "civiqs_net_approval")[0]).toContain("published 45");
  });

  it("accepts a crew spec with one model or one per role", () => {
    expect(parseForecasterSpec("crew:openrouter/deepseek/deepseek-v4-pro")).toContain("crew:");
    expect(
      parseForecasterSpec(
        "crew:openrouter/deepseek/deepseek-v4-pro,openrouter/anthropic/claude-sonnet-5,openrouter/openai/gpt-6-luna",
      ),
    ).toContain("claude-sonnet-5");
    expect(() => parseForecasterSpec("crew:a/b,c/d,e/f,g/h")).toThrow();
  });
});
