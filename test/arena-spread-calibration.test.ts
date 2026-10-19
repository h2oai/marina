// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  applySpreadCalibration,
  bestSpreadScale,
  calibrationKey,
  MAX_SPREAD_SCALE,
  MIN_SPREAD_SCALE,
  pooledSpreadScale,
  profileSpreadLoss,
  type SiteRoundLike,
  SPREAD_POOL_K,
  type SpreadRecord,
  STALE_FILING_LEAD_MS,
  scalarSpreadLoss,
  spreadCalibrationHistory,
  spreadCalibrationModeFromEnv,
  spreadFamily,
  staleLegacyFiling,
  visibleSpreadRecords,
} from "../src/arena/calibration";
import { ArenaData } from "../src/arena/data";
import type { RoundForecast } from "../src/arena/forecast";
import { loadPrivateKey } from "../src/arena/protocol";
import { crpsNormal } from "../src/arena/score";
import { profileEnergy } from "../src/arena/score-shapes";
import { submitRound } from "../src/arena/submit";
import type { ArenaPoint, ArenaRound } from "../src/arena/types";
import type { ArenaSubmissionRow } from "../src/persistence/db-arena";
import type { ArenaStore } from "../src/persistence/interfaces/arena-store";
import { scopeProcessState } from "./process-state";

const DAY = 86_400_000;
const T0 = Date.parse("2026-09-01T00:00:00Z");

/**
 * `n` scalar records of one (family, method) whose misses are `ratio` × the
 * filed sd (alternating sign), so the best multiplier sits near `ratio`.
 */
function records(
  n: number,
  ratio: number,
  family = "civiqs",
  method = "nowcast",
  start = T0,
): SpreadRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const sd = 1;
    const loss = scalarSpreadLoss({ mean: 0, sd }, (i % 2 ? 1 : -1) * ratio * sd);
    return {
      roundId: `${family}-${method}-${i}`,
      family,
      method,
      knownAt: start + i * 7 * DAY,
      loss,
      norm: crpsNormal(0, 1.5, 2),
    };
  });
}

const scalarRound = (
  id: string,
  tracker = "civiqs",
  lock = "2026-12-02T14:00:00Z",
): ArenaRound => ({
  round_id: id,
  tracker,
  question: "q",
  target_type: "continuous_normal",
  lock_at: lock,
  release_at: "2026-12-04T14:00:00Z",
});

describe("spread fit and pooling", () => {
  it("finds the CRPS-best multiplier on the grid", () => {
    // Misses of 0.4 filed sds want a narrower spread; misses of 3 sds a much wider one.
    const narrow = bestSpreadScale(records(10, 0.4))!;
    const wide = bestSpreadScale(records(10, 3))!;
    expect(narrow).toBeLessThan(0.7);
    expect(narrow).toBeGreaterThan(0.3);
    expect(wide).toBeGreaterThan(2);
    expect(bestSpreadScale([])).toBeUndefined();
  });

  it("pools (family, method) → family → global in log space with w = n / (n + k)", () => {
    const civ = records(12, 0.4, "civiqs", "nowcast");
    const civOther = records(2, 3, "civiqs", "formation:delphi");
    const xtab = records(4, 3, "yougov_xtab:profile", "formation:delphi");
    const all = [...civ, ...civOther, ...xtab];
    const k = SPREAD_POOL_K;
    const p = pooledSpreadScale(all, "civiqs", "formation:delphi");
    const sCiv = bestSpreadScale([...civ, ...civOther])!;
    const sX = bestSpreadScale(xtab)!;
    // Global: geometric mean of the two families' ŝ, shrunk toward 1 by F/(F+k).
    const gHat = Math.sqrt(sCiv * sX);
    expect(p.global.families).toBe(2);
    expect(p.global.n).toBe(18);
    expect(p.global.sHat!).toBeCloseTo(gHat, 3);
    const g = Math.exp((2 / (2 + k)) * Math.log(gHat));
    expect(p.global.s).toBeCloseTo(g, 3);
    // Family: 14 rounds toward the global.
    const wF = 14 / (14 + k);
    const f = Math.exp(wF * Math.log(sCiv) + (1 - wF) * Math.log(g));
    expect(p.family).toMatchObject({ n: 14, sHat: sCiv });
    expect(p.family.w).toBeCloseTo(wF, 3);
    expect(p.family.s).toBeCloseTo(f, 3);
    // Method: 2 rounds toward the family.
    const sM = bestSpreadScale(civOther)!;
    const wM = 2 / (2 + k);
    const m = Math.exp(wM * Math.log(sM) + (1 - wM) * Math.log(f));
    expect(p.method.s).toBeCloseTo(m, 3);
    expect(p.scale).toBeCloseTo(m, 3);
    // An unseen method takes its family's multiplier; an unseen family the global one.
    expect(pooledSpreadScale(all, "civiqs", "never").scale).toBeCloseTo(f, 3);
    expect(pooledSpreadScale(all, "aaii", "never").scale).toBeCloseTo(g, 3);
    // No evidence: identity.
    expect(pooledSpreadScale([], "civiqs", "nowcast")).toMatchObject({
      scale: 1,
      global: { n: 0, s: 1 },
    });
  });

  it("clamps the pooled multiplier to [0.35, 3]", () => {
    const tiny = records(200, 0.01);
    const huge = records(200, 50);
    expect(pooledSpreadScale(tiny, "civiqs", "nowcast").scale).toBe(MIN_SPREAD_SCALE);
    // The grid tops out at the upper clamp; with no shrinkage (k = 0) it is reached exactly.
    expect(pooledSpreadScale(huge, "civiqs", "nowcast").scale).toBeLessThanOrEqual(
      MAX_SPREAD_SCALE,
    );
    expect(pooledSpreadScale(huge, "civiqs", "nowcast", 0).scale).toBe(MAX_SPREAD_SCALE);
    expect(pooledSpreadScale(tiny, "civiqs", "nowcast", 0).scale).toBe(MIN_SPREAD_SCALE);
  });

  it("is the arena's energy score on a profile, exactly, at every multiplier", () => {
    const cells = ["a", "b", "c"];
    const forecast = { a: { mean: 10, sd: 1.2 }, b: { mean: -3, sd: 0.4 }, c: { mean: 50, sd: 2 } };
    const outcome = { a: 11.5, b: -2.9, c: 46 };
    const loss = profileSpreadLoss(
      cells.map((c) => ({ ...forecast[c as "a"], outcome: outcome[c as "a"] })),
    );
    for (const s of [0.35, 1, 1.7, 3]) {
      const scaled = Object.fromEntries(
        cells.map((c) => [c, { mean: forecast[c as "a"].mean, sd: forecast[c as "a"].sd * s }]),
      );
      expect(loss(s)).toBeCloseTo(profileEnergy(scaled, outcome, cells), 9);
    }
  });
});

describe("leakage guard", () => {
  it("drops the round itself and every outcome published after min(now, lock)", () => {
    const hist = records(6, 3);
    const cutoff = hist[2]!.knownAt;
    const v = visibleSpreadRecords(hist, cutoff, hist[1]!.roundId);
    expect(v.map((r) => r.roundId)).toEqual([hist[0]!.roundId, hist[2]!.roundId]);
  });

  it("ignores an outcome released after the lock even when filing later", () => {
    const f: RoundForecast = { topline: { mean: 0, sd: 1 }, rules: {}, note: "x" };
    const lock = "2026-09-20T14:00:00Z";
    const late = records(10, 3, "civiqs", "baseline", Date.parse("2026-09-21T00:00:00Z"));
    // `now` after every release, but the round locked before any of them.
    const out = applySpreadCalibration(scalarRound("civiqs-x", "civiqs", lock), f, late, {
      now: Date.parse("2027-06-01T00:00:00Z"),
    });
    expect(out.topline).toEqual({ mean: 0, sd: 1 });
    expect(out.spreadCalibration).toMatchObject({
      applied: false,
      scale: 1,
      cutoff: lock.replace("Z", ".000Z"),
    });
    expect(out.spreadCalibration?.reason).toContain("no resolved rounds");
  });
});

describe("applySpreadCalibration", () => {
  const now = Date.parse("2026-12-01T00:00:00Z");
  const hist = records(12, 3, "civiqs", "baseline");

  it("scales a topline's sd, never its mean, and records the evidence", () => {
    const f: RoundForecast = { topline: { mean: 29.8, sd: 0.5 }, rules: {}, note: "x" };
    const out = applySpreadCalibration(scalarRound("civiqs-x"), f, hist, { now });
    const rec = out.spreadCalibration!;
    expect(rec.applied).toBe(true);
    expect(rec.key).toBe(calibrationKey("civiqs", "baseline"));
    expect(rec.scale).toBeGreaterThan(1.5);
    expect(rec.fromSd).toBe(0.5);
    expect(rec.method).toMatchObject({ n: 12 });
    expect(rec.family.sHat).toBeGreaterThan(2);
    expect(out.topline!.mean).toBe(29.8);
    expect(out.topline!.sd).toBeCloseTo(0.5 * rec.scale, 3);
    expect(out.note).toContain("spread-calibrated on arena:civiqs|baseline");
  });

  it("scales every profile cell by the profile family's multiplier", () => {
    const round: ArenaRound = {
      ...scalarRound("yougov-xtab-x", "yougov_xtab"),
      target_type: "profile_energy",
      cells: ["a", "b"],
    };
    const profileHist = records(8, 3, "yougov_xtab:profile", "baseline");
    const f: RoundForecast = {
      profile: { a: { mean: 30, sd: 1.7 }, b: { mean: 40, sd: 2 } },
      rules: {},
      note: "x",
    };
    const out = applySpreadCalibration(round, f, profileHist, { now });
    const s = out.spreadCalibration!.scale;
    expect(spreadFamily(round)).toBe("yougov_xtab:profile");
    expect(out.spreadCalibration).toMatchObject({ applied: true, cells: 2 });
    expect(s).toBeGreaterThan(1.5);
    expect(out.profile!.a).toEqual({ mean: 30, sd: Math.round(1.7 * s * 1000) / 1000 });
    expect(out.profile!.b).toEqual({ mean: 40, sd: Math.round(2 * s * 1000) / 1000 });
  });

  it("passes rankings through; observe records without applying; off is a no-op", () => {
    const ranking: RoundForecast = { ranking: ["a"], rules: {}, note: "x" };
    expect(applySpreadCalibration(scalarRound("wiki-x", "wikipedia"), ranking, hist, { now })).toBe(
      ranking,
    );
    const f: RoundForecast = { topline: { mean: 1, sd: 0.5 }, rules: {}, note: "x" };
    const obs = applySpreadCalibration(scalarRound("civiqs-x"), f, hist, { now, mode: "observe" });
    expect(obs.topline).toEqual(f.topline);
    expect(obs.spreadCalibration).toMatchObject({ mode: "observe", applied: false });
    expect(obs.spreadCalibration!.scale).toBeGreaterThan(1.5);
    expect(applySpreadCalibration(scalarRound("civiqs-x"), f, hist, { now, mode: "off" })).toBe(f);
  });

  it("reads its mode from MARINA_ARENA_SPREAD_CALIBRATION, the retired name as fallback", () => {
    expect(spreadCalibrationModeFromEnv({})).toBe("on");
    expect(spreadCalibrationModeFromEnv({ MARINA_ARENA_SPREAD_CALIBRATION: "OBSERVE" })).toBe(
      "observe",
    );
    expect(spreadCalibrationModeFromEnv({ MARINA_ARENA_SPREAD_CALIBRATION: "off" })).toBe("off");
    expect(spreadCalibrationModeFromEnv({ MARINA_ARENA_CALIBRATION: "off" })).toBe("off");
    expect(
      spreadCalibrationModeFromEnv({
        MARINA_ARENA_SPREAD_CALIBRATION: "on",
        MARINA_ARENA_CALIBRATION: "off",
      }),
    ).toBe("on");
    expect(spreadCalibrationModeFromEnv({ MARINA_ARENA_SPREAD_CALIBRATION: "junk" })).toBe("on");
  });
});

describe("spreadCalibrationHistory", () => {
  const ENTRANT = "marina-test";
  const row = (
    id: number,
    roundId: string,
    body: Record<string, unknown>,
    detail: unknown = {},
    status = "accepted",
  ): ArenaSubmissionRow =>
    ({
      id,
      entrant: ENTRANT,
      round_id: roundId,
      request_id: `q${id}`,
      url: "u",
      meta: "{}",
      body: JSON.stringify({ round_id: roundId, ...body }),
      detail: JSON.stringify(detail),
      status,
      http_status: 200,
      response: null,
      created_at: id,
      updated_at: id,
    }) as ArenaSubmissionRow;

  const site: SiteRoundLike[] = [
    {
      round_id: "civiqs-a",
      tracker: "civiqs",
      target_type: "continuous_normal",
      status: "resolved",
      persistence_crps: 0.5,
      resolution: { value: 30, resolved_at: "2026-10-02T22:00:00Z" },
    },
    {
      round_id: "xtab-b",
      tracker: "yougov_xtab",
      target_type: "profile_energy",
      status: "resolved",
      cells: ["x", "y"],
      resolution: { release_date: "2026-10-06", outcome: { x: 30, y: 41 } },
      scores: { persistence: { energy: 3 } },
      forecasts: {
        [ENTRANT]: { cells: { y: { mean: 40, sd: 2 }, x: { mean: 31, sd: 1.5 } } },
      },
    },
    {
      round_id: "midterm-c",
      tracker: "midterm_special",
      target_type: "continuous_normal",
      status: "resolved",
      scoreable: false,
      resolution: { value: 1, resolved_at: "2026-10-02T22:00:00Z" },
      forecasts: { [ENTRANT]: { mean: 1, sd: 1 } },
    },
    {
      round_id: "civiqs-open",
      tracker: "civiqs",
      target_type: "continuous_normal",
      status: "open",
      forecasts: { [ENTRANT]: { mean: 1, sd: 1 } },
    },
  ];

  it("takes the newest accepted filing, undoes an applied multiplier, falls back to the site", () => {
    const rows = [
      row(1, "civiqs-a", { topline: { mean: 0, sd: 9 } }),
      row(
        2,
        "civiqs-a",
        { topline: { mean: 29.5, sd: 0.25 } },
        {
          round: { tracker: "civiqs", target_type: "continuous_normal" },
          forecast: {
            note: "route civiqs → nowcast; x",
            spreadCalibration: { applied: true, scale: 0.5 },
          },
        },
      ),
      row(3, "civiqs-a", { topline: { mean: 1, sd: 1 } }, {}, "rejected"),
      row(4, "civiqs-open", { topline: { mean: 1, sd: 1 } }),
    ];
    const out = spreadCalibrationHistory({ rows, site, entrant: ENTRANT });
    expect(out.map((r) => r.roundId).sort()).toEqual(["civiqs-a", "xtab-b"]);
    const a = out.find((r) => r.roundId === "civiqs-a")!;
    expect(a).toMatchObject({ family: "civiqs", method: "nowcast", norm: 0.5 });
    expect(a.knownAt).toBe(Date.parse("2026-10-02T22:00:00Z"));
    // Loss at s = 1 is the pre-calibration filing (sd 0.25 / 0.5 = 0.5).
    expect(a.loss(1)).toBeCloseTo(crpsNormal(29.5, 0.5, 30), 9);
    const b = out.find((r) => r.roundId === "xtab-b")!;
    expect(b).toMatchObject({ family: "yougov_xtab:profile", method: "baseline", norm: 3 });
    // A profile's outcome is public at the end of its release day, not before.
    expect(b.knownAt).toBe(Date.parse("2026-10-07T00:00:00Z"));
    // Cells in the round's order, whatever order the forecast lists them in.
    expect(b.loss(1)).toBeCloseTo(
      profileEnergy({ x: { mean: 31, sd: 1.5 }, y: { mean: 40, sd: 2 } }, { x: 30, y: 41 }, [
        "x",
        "y",
      ]),
      9,
    );
  });

  it("uses resolutions.json for a scalar the site lacks, its own loss as the denominator", () => {
    const out = spreadCalibrationHistory({
      rows: [row(1, "aaii-z", { topline: { mean: 30, sd: 2 } })],
      site: [],
      resolutions: { "aaii-z": { value: 33, resolved_at: "2026-10-09T00:00:00Z" } },
      entrant: ENTRANT,
      rounds: { "aaii-z": { tracker: "aaii", target_type: "continuous_normal" } },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.family).toBe("aaii");
    expect(out[0]!.norm).toBeCloseTo(crpsNormal(30, 2, 33), 9);
  });
});

describe("filing pipeline", () => {
  const now = Date.parse("2026-10-06T20:00:00Z");
  const weekly = (values: number[], start: string): ArenaPoint[] =>
    values.map((value, i) => ({
      date: new Date(Date.parse(start) + i * 7 * DAY).toISOString().slice(0, 10),
      value,
    }));
  const round: ArenaRound = {
    round_id: "civiqs-2026-w41-approval",
    tracker: "civiqs",
    series: "civiqs_net_approval",
    question: "Net approval?",
    target_type: "continuous_normal",
    lock_at: "2026-10-07T14:00:00Z",
    release_at: "2026-10-09T14:00:00Z",
  };
  const files: Record<string, unknown> = {
    "questions/season0.json": { rounds: [round] },
    "locks/civiqs-2026-w41-approval.json": {
      round_id: round.round_id,
      answer_history: weekly(
        Array.from({ length: 40 }, (_, i) => -27 + (i % 3)),
        "2026-01-02",
      ),
    },
    "resolutions/resolved.json": {},
    "site/data.json": {
      rounds: [
        {
          round_id: "civiqs-2026-w40-approval",
          tracker: "civiqs",
          target_type: "continuous_normal",
          status: "resolved",
          lock_at: "2026-09-30T14:00:00Z",
          persistence_crps: 0.6,
          resolution: { value: -26.02, resolved_at: "2026-10-02T22:00:00Z" },
          forecasts: { "marina-test": { mean: -26, sd: 1.2 } },
        },
      ],
    },
  };
  const data = new ArenaData(
    "https://example.test/arena",
    async (url) => {
      const path = url.replace("https://example.test/arena/", "");
      return path in files ? Response.json(files[path]) : new Response("nope", { status: 404 });
    },
    () => now,
  );
  const store = {
    listArenaSubmissions: () => [],
    listArenaShadow: () => [],
    latestArenaSubmission: () => undefined,
    acceptedArenaSubmission: () => undefined,
  } as unknown as ArenaStore;
  const deps = {
    config: {
      entrant: "marina-test",
      windowHours: 24,
      forecaster: "baseline",
    } as never,
    data,
    store,
    key: loadPrivateKey(Buffer.alloc(32, 7)),
    now: () => now,
  };
  const dry = async (mode: string) => {
    using _env = scopeProcessState({
      env: { MARINA_ARENA_SPREAD_CALIBRATION: mode, MARINA_ARENA_CALIBRATION: undefined },
    });
    const out = await submitRound(deps, round.round_id, { dryRun: true });
    if (out.kind !== "dry-run") throw new Error(`expected a dry run, got ${out.kind}`);
    return out.body;
  };

  it("narrows the filed sd after a resolved round that over-covered, only when on", async () => {
    const off = await dry("off");
    const observe = await dry("observe");
    const on = await dry("on");
    expect(observe.topline).toEqual(off.topline);
    expect(on.topline!.mean).toBe(off.topline!.mean);
    expect(on.topline!.sd).toBeLessThan(off.topline!.sd);
    expect(on.notes).toContain("spread-calibrated on arena:civiqs|baseline");
  });
});

describe("stale legacy filings are no spread evidence", () => {
  const lock = "2026-10-11T14:00:00Z";
  const site = { lock_at: lock, baselines: { persistence: { mean: 38 } } };
  const filedAt = (msBeforeLock: number) => ({ created_at: Date.parse(lock) - msBeforeLock });

  it("excludes the YouGov w42 shape: no anchor, filed 11 days early, mean ≠ persistence at lock", () => {
    expect(staleLegacyFiling(filedAt(11 * 86_400_000), {}, 36, site)).toBe(true);
  });

  it("keeps a filing that matches persistence, was filed close to the lock, or recorded its anchor", () => {
    expect(staleLegacyFiling(filedAt(11 * 86_400_000), {}, 38, site)).toBe(false);
    expect(staleLegacyFiling(filedAt(STALE_FILING_LEAD_MS - 1), {}, 36, site)).toBe(false);
    expect(staleLegacyFiling(filedAt(11 * 86_400_000), { lock: {} }, 36, site)).toBe(false);
    expect(
      staleLegacyFiling(filedAt(11 * 86_400_000), { forecast: { origins: {} } }, 36, site),
    ).toBe(false);
  });

  it("keeps it when the site lacks the lock or persistence", () => {
    expect(staleLegacyFiling(filedAt(11 * 86_400_000), {}, 36, undefined)).toBe(false);
    expect(staleLegacyFiling(filedAt(11 * 86_400_000), {}, 36, { lock_at: lock })).toBe(false);
  });
});

describe("poll-level starts keep their own backtested sd", () => {
  const round = {
    round_id: "yougov-2026-w44-rv-approval",
    tracker: "economist_yougov",
    target_type: "continuous_normal",
    lock_at: "2026-10-25T14:00:00Z",
  } as unknown as Parameters<typeof applySpreadCalibration>[0];
  const note =
    "route economist_yougov → formation:delphi:a,b,c+research@search:duckduckgo; marina delphi formation";
  // Old-start filings that would all have scored best twice as wide.
  const history: SpreadRecord[] = Array.from({ length: 6 }, (_, i) => ({
    roundId: `old-${i}`,
    family: "economist_yougov",
    method: "formation:delphi+research",
    knownAt: 0,
    loss: (s: number) => (s - 2) ** 2 + 1,
    norm: 2,
  }));
  const base = { topline: { mean: 37.8, sd: 1 }, note } as unknown as Parameters<
    typeof applySpreadCalibration
  >[1];

  it("an ordinary start is scaled by the old evidence", () => {
    const out = applySpreadCalibration(round, base, history, {
      now: Date.parse(round.lock_at) - 1,
    });
    expect(out.spreadCalibration?.applied).toBe(true);
    expect(out.topline!.sd).toBeGreaterThan(1);
  });

  it("a poll-level start is left alone until its own filings resolve", () => {
    const f = { ...base, pollLevel: { rule: "blend" } } as unknown as typeof base;
    const out = applySpreadCalibration(round, f, history, { now: Date.parse(round.lock_at) - 1 });
    expect(out.spreadCalibration?.applied).toBe(false);
    expect(out.spreadCalibration?.key).toContain("+poll-level");
    expect(out.topline!.sd).toBe(1);
  });
});
