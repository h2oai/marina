// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { arenaConfigFromEnv, arenaWindowHours, parseForecasterSpec } from "../src/arena/config";
import { ArenaData } from "../src/arena/data";
import { evaluateResolved } from "../src/arena/evaluate";
import { forecastRound, forecastScalar, PERSISTENCE_SD } from "../src/arena/forecast";
import {
  blend,
  buildPrompt,
  DEFAULT_MODEL_OPTIONS,
  modelForecastRound,
  parseReply,
} from "../src/arena/model-forecaster";
import { baselineForecaster } from "../src/arena/submit";
import type { ArenaLock, ArenaPoint, ArenaRound } from "../src/arena/types";

const weekly = (values: number[], start = "2026-01-02"): ArenaPoint[] =>
  values.map((value, i) => ({
    date: new Date(Date.parse(start) + i * 7 * 86_400_000).toISOString().slice(0, 10),
    value,
  }));
const nextWeek = (h: ArenaPoint[]) =>
  new Date(Date.parse(h.at(-1)!.date) + 7 * 86_400_000).toISOString();

describe("spread selection targets the leaderboard's metric", () => {
  it("keeps exact persistence on a spiky series where a wide spread loses most weeks", () => {
    // Flat with rare huge spikes (pageview-like): RMS is dominated by the spikes,
    // but most weeks land on the last value — per-round skill says don't widen.
    const values = Array.from({ length: 50 }, (_, i) => (i % 17 === 0 ? 5000 : 1000 + (i % 2)));
    const h = weekly(values);
    const f = forecastScalar(h, nextWeek(h));
    expect(f.rule === "persistence" || f.rule === "robust").toBe(true);
    expect(f.sd).toBeLessThan(50);
  });

  it("calibrates a series that genuinely moves far more than 1.5 every week", () => {
    const h = weekly(Array.from({ length: 40 }, (_, i) => (i % 2 ? 10 : -10) + i * 0.1));
    const f = forecastScalar(h, nextWeek(h));
    expect(f.rule).not.toBe("persistence");
    expect(f.sd).toBeGreaterThan(5);
    expect(f.evidence?.points).toBeGreaterThan(6);
  });
});

describe("model forecaster", () => {
  const history = weekly(Array.from({ length: 30 }, (_, i) => 40 + (i % 3)));
  const round: ArenaRound = {
    round_id: "yougov-2026-w40-rv-approval",
    tracker: "economist_yougov",
    question: "Approve?",
    unit: "% approve",
    target_type: "continuous_normal",
    lock_at: "2026-09-27T14:00:00Z",
    release_at: nextWeek(history),
  };
  const lock: ArenaLock = { round_id: round.round_id, answer_history: history };
  const base = forecastRound(round, lock);

  it("shows the model the question, the dated history and the start forecast, and asks for JSON", () => {
    const prompt = buildPrompt(round, lock, base);
    expect(prompt).toContain("Approve?");
    expect(prompt).toContain(`${history.at(-1)!.date} ${history.at(-1)!.value}`);
    expect(prompt).toContain("Start forecast");
    expect(prompt).toContain("the persistence baseline");
    expect(prompt).toContain("Resolution: the next value this source publishes");
    expect(prompt).toContain("CRPS");
    expect(prompt).not.toContain("nowcast");
    expect(prompt).toContain('"mean"');
  });

  it("names a Civiqs nowcast with its date, the Friday resolution and the daily tracker", () => {
    const civiqs: ArenaRound = {
      ...round,
      tracker: "civiqs",
      series: "civiqs_net_approval",
      release_at: "2026-10-02T14:00:00Z",
    };
    const start = {
      ...base,
      topline: { mean: 38.5, sd: base.topline!.sd },
      nowcast: { civiqs_net_approval: { date: "2026-09-28", value: 38.5 } },
      daily: {
        series: "civiqs_net_approval",
        source: "civiqs/approve_president_trump_2025/2026-09-29.json",
        points: [
          { date: "2026-09-27", value: 38.9 },
          { date: "2026-09-28", value: 38.5 },
        ],
      },
    };
    const prompt = buildPrompt(civiqs, lock, start);
    expect(prompt).toContain(
      "the NOWCAST — the freshest daily Civiqs reading (38.5, dated 2026-09-28)",
    );
    expect(prompt).toContain("4 day(s) from that reading to the resolution date");
    expect(prompt).toContain("Civiqs dashboard shows for this series on Friday 2026-10-02");
    expect(prompt).toContain("revised");
    expect(prompt).toContain("DAILY TRACKER");
    expect(prompt).toContain("2026-09-27 38.9");
    expect(prompt).toContain("one per week");
  });

  it("keeps the daily series out of what it files", async () => {
    const start = {
      ...base,
      daily: { series: "x", source: "s", points: [{ date: "2026-09-28", value: 1 }] },
    };
    const f = await modelForecastRound(round, lock, start, async () => '{"mean": 41, "sd": 2}');
    expect("daily" in f).toBe(false);
  });

  it("shrinks the model's move toward the baseline", async () => {
    const f = await modelForecastRound(
      round,
      lock,
      base,
      async () => '```json\n{"mean": 44, "sd": 2, "reason": "trend"}\n```',
      { weight: 0.25, maxSdMove: 4 },
    );
    const m = base.topline!.mean;
    expect(f.topline!.mean).toBeCloseTo(m + 0.25 * (44 - m), 3);
    expect(f.raw?.topline).toEqual({ mean: 44, sd: 2 });
    expect(f.reason).toBe("trend");
    expect(f.fallback).toBeUndefined();
  });

  it("keeps the baseline on garbage, a failed call, or an implausible jump", async () => {
    expect((await modelForecastRound(round, lock, base, async () => "no idea")).fallback).toContain(
      "JSON",
    );
    const thrown = await modelForecastRound(round, lock, base, async () => {
      throw new Error("429");
    });
    expect(thrown.fallback).toContain("429");
    expect(thrown.topline).toEqual(base.topline);
    const far = await modelForecastRound(round, lock, base, async () => '{"mean": 90, "sd": 1}');
    expect(far.fallback).toContain("implausibly far");
    expect(far.topline).toEqual(base.topline);
    expect(
      (await modelForecastRound(round, lock, base, async () => '{"mean": 41, "sd": 0}')).fallback,
    ).toBeDefined();
  });

  it("blends every profile cell, keeping the baseline for a cell that blows up", async () => {
    const cells = ["cell_a", "cell_b"];
    const prof: ArenaRound = { ...round, target_type: "profile_energy", cells };
    const plock: ArenaLock = {
      round_id: prof.round_id,
      answer_history_by_cell: { cell_a: history, cell_b: history },
    };
    const pbase = forecastRound(prof, plock);
    const f = await modelForecastRound(
      prof,
      plock,
      pbase,
      async () =>
        '{"profile": {"cell_a": {"mean": 43, "sd": 2}, "cell_b": {"mean": 400, "sd": 2}}}',
    );
    expect(f.profile!.cell_a!.mean).not.toBe(pbase.profile!.cell_a!.mean);
    expect(f.profile!.cell_b).toEqual(pbase.profile!.cell_b!);
    const missing = await modelForecastRound(prof, plock, pbase, async () => '{"profile": {}}');
    expect(missing.fallback).toContain("cell_a");
  });

  it("parses the first JSON object and validates a ranking's length and uniqueness", async () => {
    expect(parseReply('thinking… {"a": 1} done')).toEqual({ a: 1 });
    expect(parseReply("[1,2]")).toBeUndefined();
    const rank: ArenaRound = { ...round, target_type: "ranking_list", ranking: { length: 2 } };
    const rlock: ArenaLock = {
      round_id: rank.round_id,
      answer_obs: [{ date: "2026-09-20", items: ["A", "B", "C"], views: { A: 3, B: 2, C: 1 } }],
    };
    const rbase = forecastRound(rank, rlock);
    expect(
      (await modelForecastRound(rank, rlock, rbase, async () => '{"ranking": ["C", "A"]}')).ranking,
    ).toEqual(["C", "A"]);
    expect(
      (await modelForecastRound(rank, rlock, rbase, async () => '{"ranking": ["C", "C"]}'))
        .fallback,
    ).toBeDefined();
  });

  it("blend clamps the weight and never narrows below half the baseline sd", () => {
    expect(blend({ mean: 10, sd: 2 }, { mean: 12, sd: 0.1 }, { weight: 5, maxSdMove: 4 })).toEqual({
      mean: 12,
      sd: 1,
    });
    expect(DEFAULT_MODEL_OPTIONS.weight).toBe(0.5);
  });
});

describe("forecaster configuration", () => {
  it("defaults to nowcast; accepts the documented grammar and nothing else", () => {
    expect(parseForecasterSpec(undefined)).toBe("nowcast");
    expect(parseForecasterSpec("  ")).toBe("nowcast");
    expect(parseForecasterSpec("baseline")).toBe("baseline");
    expect(parseForecasterSpec("discovered")).toBe("discovered");
    expect(() => parseForecasterSpec("gpt")).toThrow(/nowcast, baseline, discovered/);
    expect(arenaConfigFromEnv({ MARINA_ARENA_ENTRANT: "x-y" })?.forecaster).toBe("nowcast");
    expect(parseForecasterSpec("model:openrouter/deepseek/deepseek-v4-pro")).toBe(
      "model:openrouter/deepseek/deepseek-v4-pro",
    );
    expect(() => parseForecasterSpec("gpt")).toThrow();
    expect(
      arenaConfigFromEnv({ MARINA_ARENA_ENTRANT: "x-y", MARINA_ARENA_MODEL_WEIGHT: "7" })
        ?.modelWeight,
    ).toBe(1);
  });
});

describe("evaluation on resolved rounds", () => {
  it("scores each forecaster against the arena's persistence on the frozen inputs", async () => {
    const history = weekly(Array.from({ length: 30 }, (_, i) => 40 + (i % 2)));
    const round: ArenaRound = {
      round_id: "civiqs-2026-w30-approval",
      tracker: "civiqs",
      question: "Net?",
      target_type: "continuous_normal",
      lock_at: "2026-07-20T14:00:00Z",
      release_at: nextWeek(history),
    };
    const files: Record<string, unknown> = {
      "questions/season0.json": { rounds: [round] },
      [`locks/${round.round_id}.json`]: { round_id: round.round_id, answer_history: history },
      "resolutions/resolved.json": { [round.round_id]: { value: history.at(-1)!.value + 1 } },
    };
    const data = new ArenaData("https://example.test", async (url) => {
      const path = url.replace("https://example.test/", "");
      return path in files ? Response.json(files[path]) : new Response("", { status: 404 });
    });
    const perfect = async () => ({
      topline: { mean: history.at(-1)!.value + 1, sd: 0.1 },
      rules: {},
      note: "",
    });
    const report = await evaluateResolved(data, { baseline: baselineForecaster, perfect });
    expect(report.rounds).toHaveLength(1);
    const r = report.rounds[0]!;
    expect(r.results.baseline!.skill).toBeCloseTo(
      1 - r.results.baseline!.crps / r.persistenceCrps,
      6,
    );
    expect(r.results.perfect!.skill).toBeGreaterThan(0.9);
    expect(report.overall.perfect).toBeGreaterThan(report.overall.baseline!);
    expect(PERSISTENCE_SD).toBe(1.5);
  });
});

describe("MARINA_ARENA_WINDOW_HOURS", () => {
  it("one parser: default 24, capped at one week, junk ⇒ default", () => {
    expect(arenaWindowHours({})).toBe(24);
    expect(arenaWindowHours({ MARINA_ARENA_WINDOW_HOURS: "48" })).toBe(48);
    expect(arenaWindowHours({ MARINA_ARENA_WINDOW_HOURS: "168" })).toBe(168);
    expect(arenaWindowHours({ MARINA_ARENA_WINDOW_HOURS: "500" })).toBe(24);
    expect(arenaWindowHours({ MARINA_ARENA_WINDOW_HOURS: "-1" })).toBe(24);
    expect(arenaWindowHours({ MARINA_ARENA_WINDOW_HOURS: "soon" })).toBe(24);
    expect(
      arenaConfigFromEnv({ MARINA_ARENA_ENTRANT: "x-y", MARINA_ARENA_WINDOW_HOURS: "500" })
        ?.windowHours,
    ).toBe(24);
  });
});
