// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { calibrationKey, methodOf } from "../src/arena/calibration";
import { parseForecasterSpec } from "../src/arena/config";
import { forecastRound, type RoundForecast } from "../src/arena/forecast";
import { memberSignals, researchSignals, signalLines } from "../src/arena/forecast-signals";
import {
  ANCHOR,
  dossierBlock,
  type FormationMember,
  formationForecastRound,
  UNANCHORED_GUIDANCE,
  unanchoredMember,
} from "../src/arena/formations";
import {
  applyMoveWeight,
  decideMoveWeight,
  MIN_MOVE_RECORDS,
  type MoveRecord,
  moveOf,
  moveWeightHistory,
  moveWeightModeFromEnv,
  type ScalarMoveRecord,
} from "../src/arena/move-weight";
import type { ArenaLock, ArenaPoint, ArenaRound } from "../src/arena/types";
import type { ArenaShadowRow, ArenaSubmissionRow } from "../src/persistence/db-arena";
import type { EvidenceIndex } from "../src/research/evidence-index";
import { mulberry32 } from "../src/stats";

const weekly = (values: number[], start = "2026-01-02"): ArenaPoint[] =>
  values.map((value, i) => ({
    date: new Date(Date.parse(start) + i * 7 * 86_400_000).toISOString().slice(0, 10),
    value,
  }));
const history = weekly(Array.from({ length: 30 }, (_, i) => 40 + (i % 3)));
const round: ArenaRound = {
  round_id: "yougov-2026-w40-approval",
  tracker: "yougov",
  series: "yougov_net_approval",
  question: "Net approval?",
  target_type: "continuous_normal",
  lock_at: "2026-08-01T14:00:00Z",
  release_at: "2026-08-03T14:00:00Z",
};
const lock: ArenaLock = { round_id: round.round_id, answer_history: history };
const base = forecastRound(round, lock).topline!;
const KEY = calibrationKey("yougov", "formation:delphi");

function crew(
  n: number,
  answer: (i: number, system: string) => unknown,
): { members: FormationMember[]; systems: string[] } {
  const systems: string[] = [];
  const members = Array.from({ length: n }, (_, i) => ({
    name: `m${i}`,
    complete: async (system: string, _user: string) => {
      systems.push(system);
      return JSON.stringify(answer(i, system));
    },
  }));
  return { members, systems };
}

/**
 * `n` weekly records whose outcome is start + `beta` · Δ + noise, filed at the
 * formation's half-trust (start + 0.5 Δ).
 */
function records(n: number, beta: number, seed = 7, noise = 0.1): MoveRecord[] {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => {
    const delta = (rand() - 0.5) * 4;
    const start = 30;
    return {
      id: `r${i}`,
      roundId: `r${i}`,
      key: KEY,
      resolvedAt: new Date(Date.parse("2026-01-02") + i * 7 * 86_400_000).toISOString(),
      start,
      delta,
      trust: 0.5,
      filed: { mean: start + 0.5 * delta, sd: 1 },
      outcome: start + beta * delta + (rand() - 0.5) * 2 * noise,
    };
  });
}

describe("moveOf", () => {
  it("uses the recorded start, else recovers it from the median rule", () => {
    const proposals = { a: { mean: 32 }, b: { mean: 34 }, c: { mean: 36 } };
    expect(moveOf({ proposals, formationStart: { mean: 30, sd: 1 }, trust: 0.5 }, 32)).toEqual({
      start: 30,
      startSd: 1,
      delta: 4,
      trust: 0.5,
    });
    // filed 32 = start + 0.5 (34 − start) ⇒ start 30.
    expect(moveOf({ proposals, trust: 0.5 }, 32)?.start).toBeCloseTo(30, 9);
    // A non-formation forecaster weights its proposals: no recovery.
    expect(moveOf({ proposals, trust: 0.5 }, 32, undefined, false)).toBeUndefined();
    // An applied weight moved the filed mean; recovery uses the formation's own mean.
    expect(
      moveOf({ proposals, trust: 0.5, moveWeight: { applied: true, fromMean: 32 } }, 33)?.start,
    ).toBeCloseTo(30, 9);
    expect(moveOf({ proposals: {} }, 32)).toBeUndefined();
  });
});

describe("decideMoveWeight", () => {
  it("adopts a larger weight when the members' moves carry signal (placebo passes)", () => {
    const d = decideMoveWeight(records(30, 1));
    expect(d.adopted).toBe(true);
    expect(d.w!).toBeGreaterThan(0.7);
    expect(d.placebo?.pass).toBe(true);
    expect(d.holdout!.improvement).toBeGreaterThan(d.placebo!.p80);
  });

  it("refuses when shuffled moves gain as much (the gain is shrinkage, not signal)", () => {
    // The outcome ignores Δ: shrinking every move to 0 beats the filed half
    // move, and it does so just as well with the Δs shuffled across rounds.
    const d = decideMoveWeight(records(30, 0, 11));
    expect(d.holdout).toBeDefined();
    expect(d.placebo?.pass).toBe(false);
    expect(d.adopted).toBe(false);
  });

  it("is a no-op with too little history", () => {
    const d = decideMoveWeight(records(MIN_MOVE_RECORDS - 1, 1));
    expect(d.adopted).toBe(false);
    expect(d.reason).toMatch(/insufficient history/);
  });
});

describe("applyMoveWeight", () => {
  const formation = (): RoundForecast =>
    ({
      topline: { mean: base.mean + 0.5, sd: base.sd },
      note: "route yougov → formation:delphi:a,b,c; marina delphi formation",
      proposals: { a: { mean: base.mean + 1, sd: 1 }, b: { mean: base.mean + 1, sd: 1 } },
      formationStart: { mean: base.mean, sd: base.sd },
      trust: 0.5,
    }) as unknown as RoundForecast;
  const now = Date.parse("2027-01-01");

  it("moves the mean along the members' move once the key has earned it", () => {
    const out = applyMoveWeight(round, formation(), records(30, 1), { now });
    expect(out.moveWeight?.applied).toBe(true);
    expect(out.topline!.mean).toBeGreaterThan(base.mean + 0.5);
    expect(out.topline!.sd).toBe(base.sd);
    expect(out.note).toMatch(/move weight .* learned on arena:yougov\|formation:delphi/);
  });

  it("observe records without applying; off skips; other keys and non-formations pass through", () => {
    const observed = applyMoveWeight(round, formation(), records(30, 1), { now, mode: "observe" });
    expect(observed.moveWeight?.adopted).toBe(true);
    expect(observed.moveWeight?.applied).toBe(false);
    expect(observed.topline!.mean).toBe(base.mean + 0.5);
    expect(applyMoveWeight(round, formation(), records(30, 1), { now, mode: "off" })).toEqual(
      formation(),
    );
    const otherKey = records(30, 1).map((r) => ({ ...r, key: "arena:civiqs|formation:delphi" }));
    expect(applyMoveWeight(round, formation(), otherKey, { now }).moveWeight?.adopted).toBe(false);
    const plain = { topline: base, note: "route yougov → nowcast" } as unknown as RoundForecast;
    expect(applyMoveWeight(round, plain, records(30, 1), { now })).toBe(plain);
  });

  it("never reads the round being filed or outcomes after now", () => {
    const rs = records(30, 1).map((r, i) => ({
      ...r,
      roundId: i < 25 ? round.round_id : r.roundId,
    }));
    const out = applyMoveWeight(round, formation(), rs, { now });
    expect(out.moveWeight?.adopted).toBe(false);
    const early = applyMoveWeight(round, formation(), records(30, 1), {
      now: Date.parse("2026-01-01"),
    });
    expect(early.moveWeight?.nFit).toBe(0);
  });

  it("defaults to on", () => {
    expect(moveWeightModeFromEnv({})).toBe("on");
    expect(moveWeightModeFromEnv({ MARINA_ARENA_MOVE_WEIGHT: "observe" })).toBe("observe");
    expect(moveWeightModeFromEnv({ MARINA_ARENA_MOVE_WEIGHT: "OFF" })).toBe("off");
  });
});

describe("moveWeightHistory", () => {
  it("keys filings and pre-lock shadows by (family, method)", () => {
    const resolutions = {
      [round.round_id]: { value: 42, resolved_at: "2026-08-04T00:00:00Z" },
    } as never;
    const rows = [
      {
        id: 1,
        round_id: round.round_id,
        status: "accepted",
        body: JSON.stringify({ topline: { mean: 41, sd: 1 } }),
        detail: JSON.stringify({
          round: { tracker: "yougov" },
          forecast: {
            note: "route yougov → formation:delphi:a,b; x",
            proposals: { a: { mean: 42 }, b: { mean: 42 } },
            formationStart: { mean: 40, sd: 1 },
            trust: 0.5,
          },
        }),
      },
    ] as ArenaSubmissionRow[];
    const shadow = (id: number, created: string, mean: number): ArenaShadowRow => ({
      id,
      round_id: round.round_id,
      forecaster: "formation:delphi~unanchored:a,b",
      forecast: JSON.stringify({ topline: { mean, sd: 1 } }),
      detail: JSON.stringify({
        proposals: { a: { mean: 43 } },
        formationStart: { mean: 40, sd: 1 },
        trust: 0.5,
      }),
      cost_usd: 0,
      created_at: Date.parse(created),
    });
    const out = moveWeightHistory(
      rows,
      resolutions,
      { [round.round_id]: { tracker: "yougov", lock_at: round.lock_at } },
      [shadow(2, "2026-07-30T00:00:00Z", 41.5), shadow(3, "2026-08-02T00:00:00Z", 99)],
    );
    expect(out.map((r) => r.key).sort()).toEqual([
      "arena:yougov|formation:delphi",
      "arena:yougov|formation:delphi~unanchored",
    ]);
    const s = out.find((r) => r.key.endsWith("~unanchored"))! as ScalarMoveRecord;
    // The post-lock shadow (mean 99) is never used.
    expect(s.filed.mean).toBe(41.5);
    expect(s.delta).toBe(3);
  });
});

describe("unanchored formation variant", () => {
  it("parses as a forecaster spec and keeps its own method key", () => {
    const spec = "formation:delphi~unanchored:openrouter/a/b,openrouter/c/d";
    expect(parseForecasterSpec(spec)).toBe(spec);
    expect(parseForecasterSpec(`${spec}+research@search:tavily`)).toBe(
      `${spec}+research@search:tavily`,
    );
    expect(() => parseForecasterSpec("formation:delphi~loose:openrouter/a/b")).toThrow();
    expect(methodOf(`route civiqs → ${spec}+research@search:tavily; x`)).toBe(
      "formation:delphi~unanchored+research",
    );
  });

  it("drops the anchor, asks for typed signals, and records them with the start", async () => {
    const anchored = crew(3, () => ({ mean: base.mean, sd: base.sd, reason: "r" }));
    await formationForecastRound("delphi", round, lock, anchored.members);
    expect(anchored.systems.every((s) => s.includes(ANCHOR))).toBe(true);

    const signal = {
      claim: "pollster X wave",
      direction: "up",
      magnitude: 2,
      unit: "points",
      observed: "2026-07-28",
      source_date: "2026-07-29",
    };
    const stale = { ...signal, claim: "old wave", observed: "2026-01-02" };
    const loose = crew(3, () => ({
      mean: base.mean + 1,
      sd: base.sd,
      reason: "r",
      signals: [signal, stale, { nonsense: true }],
    }));
    const f = await formationForecastRound(
      "delphi",
      round,
      lock,
      loose.members.map(unanchoredMember),
    );
    expect(loose.systems.length).toBeGreaterThan(0);
    for (const s of loose.systems) {
      expect(s).not.toContain(ANCHOR);
      expect(s).toContain(UNANCHORED_GUIDANCE);
      expect(s).toContain('"signals"');
    }
    expect(f.formationStart).toEqual({ mean: base.mean, sd: base.sd });
    expect(f.signals?.length).toBeGreaterThan(0);
    expect(f.signals!.find((s) => s.claim === "pollster X wave")?.stale).toBe(false);
    expect(f.signals!.find((s) => s.claim === "old wave")?.stale).toBe(true);
    expect(f.signals!.every((s) => s.claim !== undefined)).toBe(true);
  });
});

describe("typed signals", () => {
  it("validates member signals and marks those observed before the start reading", () => {
    const out = memberSignals(
      [
        {
          stage: "round1",
          member: "m0",
          status: "ok",
          reply: {
            signals: [
              { claim: "gas up", direction: "up", magnitude: 0.1, observed: "2026-09-20" },
              { claim: "old", observed: "2026-08-01" },
              { direction: "up" },
              "junk",
            ],
          },
        },
        { stage: "round1", member: "m1", status: "error: x", reply: { signals: [{ claim: "x" }] } },
      ],
      "2026-09-01",
    );
    expect(out.map((s) => [s.claim, s.stale])).toEqual([
      ["gas up", false],
      ["old", true],
    ]);
    expect(signalLines(out)).toContain("STALE old");
  });

  it("reads the dossier's typed measurements and shows them in the dossier block", () => {
    const index = {
      version: 1,
      fingerprint: "f",
      stats: {},
      claims: [
        {
          id: "c1",
          text: "Cleveland Fed 1y expected inflation 2.64% in September",
          urls: [],
          origins: [],
          eligibility: "change",
          reason: "r",
          measurement: {
            measure: "expected inflation 1y",
            value: 2.64,
            unit: "%",
            source: "Cleveland Fed",
            url: "https://example.org/x",
            quote: "2.64",
            observedThrough: "2026-09-30",
            publishedAt: "2026-10-01",
          },
        },
        {
          id: "c2",
          text: "background line",
          urls: [],
          origins: [],
          eligibility: "background",
          reason: "r",
        },
      ],
    } as unknown as EvidenceIndex;
    const verified = "Cleveland Fed 1y expected inflation 2.64% in September [s](x)";
    const signals = researchSignals(index, verified, "2026-09-01");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ value: 2.64, stale: false, origin: "research:change" });
    const block = dossierBlock({
      since: "2026-09-01",
      verified,
      sources: 1,
      costUsd: 0,
      signals,
    });
    expect(block).toContain("Typed signals");
    expect(block).toContain("Cleveland Fed / expected inflation 1y: = 2.64 %");
  });
});
