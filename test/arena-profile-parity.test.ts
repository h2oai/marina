// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Profile rounds at parity with scalar rounds (per-cell proposal judge, the
 * learned move weight, the sd floors, the share rescale) and the
 * required-research fallback. Stub providers only — no network.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { calibrationKey, methodOf } from "../src/arena/calibration";
import { forecastRound, type RoundForecast } from "../src/arena/forecast";
import { forecastSettings } from "../src/arena/forecast-config";
import { profileSdFloors } from "../src/arena/formation-profile";
import {
  composeForecastRound,
  type FormationMember,
  type FormationStep,
  formationForecastRound,
} from "../src/arena/formations";
import {
  applyMoveWeight,
  decideMoveWeight,
  MIN_MOVE_RECORDS,
  type MoveRecord,
  moveWeightHistory,
  type ProfileMoveCell,
  type ProfileMoveRecord,
  profilePointSet,
} from "../src/arena/move-weight";
import { MAX_CELLS_PER_CALL, type ProposalJudgeConfig } from "../src/arena/proposal-judge";
import { researchForecastRound } from "../src/arena/research/forecaster";
import type { Retriever } from "../src/arena/research/retrieve";
import { researchFallbackModeFromEnv } from "../src/arena/research-fallback";
import { profileEnergy } from "../src/arena/score-shapes";
import type { ArenaLock, ArenaPoint, ArenaRound, Distribution } from "../src/arena/types";
import type { DecisionProvider } from "../src/decisions/types";
import type { ArenaSubmissionRow } from "../src/persistence/db-arena";
import { mulberry32 } from "../src/stats";
import { scopeProcessState } from "./process-state";

const weekly = (values: number[], start = "2026-01-02"): ArenaPoint[] =>
  values.map((value, i) => ({
    date: new Date(Date.parse(start) + i * 7 * 86_400_000).toISOString().slice(0, 10),
    value,
  }));
const series = (f: (i: number) => number) => weekly(Array.from({ length: 30 }, (_, i) => f(i)));

function subgroupRound(n = 3): { round: ArenaRound; lock: ArenaLock } {
  const cells = Array.from({ length: n }, (_, k) => `xtab_approve_g${k}`);
  const round: ArenaRound = {
    round_id: `yougov-xtab-2026-w40-${n}`,
    tracker: "yougov_xtab",
    series: cells[0],
    question: "Percent approving in each subgroup?",
    unit: "percent approving",
    target_type: "profile_energy",
    cells,
    lock_at: "2026-08-01T14:00:00Z",
    release_at: "2026-08-03T14:00:00Z",
  };
  const lock: ArenaLock = {
    round_id: round.round_id,
    answer_history_by_cell: Object.fromEntries(
      cells.map((c, k) => [c, series((i) => 20 + 10 * k + (i % 3))]),
    ),
  };
  return { round, lock };
}

const basketCells = ["trends_share_alpha", "trends_share_beta", "trends_share_gamma"];
const basketRound: ArenaRound = {
  round_id: "trends-basket-2026-08-08",
  tracker: "google_trends",
  series: "trends_share_alpha",
  question:
    "Google Trends: each brand's share of weekly search interest in the basket. The three shares add to 100.",
  unit: "percent of the three-brand basket (the three add to 100)",
  target_type: "profile_energy",
  cells: basketCells,
  lock_at: "2026-08-01T14:00:00Z",
  release_at: "2026-08-08T14:00:00Z",
};
const basketLock: ArenaLock = {
  round_id: basketRound.round_id,
  answer_history_by_cell: {
    trends_share_alpha: series((i) => 50 + (i % 3) - 1),
    trends_share_beta: series((i) => 30 + (i % 5) - 2),
    trends_share_gamma: series((i) => 100 - (50 + (i % 3) - 1) - (30 + (i % 5) - 2)),
  },
};

/** Members proposing start + move(i, cell) (in start sds) with sd = sdScale × start sd. */
function crew(
  n: number,
  start: Record<string, Distribution>,
  move: (i: number, cell: string) => number,
  sdScale: (i: number) => number = () => 1,
): { members: FormationMember[]; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    members: Array.from({ length: n }, (_, i) => ({
      name: `m${i}`,
      complete: async () => {
        calls++;
        const profile: Record<string, Distribution> = {};
        for (const [c, d] of Object.entries(start))
          profile[c] = { mean: d.mean + move(i, c) * d.sd, sd: d.sd * sdScale(i) };
        return JSON.stringify({
          profile,
          reason: `member ${i} reason`,
          contribution: `member ${i} contribution`,
          credit: `member ${i} credit`,
        });
      },
    })),
  };
}

/** A stub decision provider answering each cell question by the cell named in its state. */
function cellJudge(support: (cell: string) => number | Error): {
  provider: DecisionProvider;
  requests: Array<{ cells: string[]; questions: string[] }>;
} {
  const requests: Array<{ cells: string[]; questions: string[] }> = [];
  return {
    requests,
    provider: {
      kind: "decisions-api",
      model: "typesafe/jev-1.13",
      ask: async (req) => {
        const state = req.state as { cells: Array<{ question_id: string; cell: string }> };
        requests.push({
          cells: state.cells.map((c) => c.cell),
          questions: Object.keys(req.questions),
        });
        const answers: Record<string, { type: "noul"; noul: number }> = {};
        for (const c of state.cells) {
          const s = support(c.cell);
          if (s instanceof Error) throw s;
          answers[c.question_id] = { type: "noul", noul: s };
        }
        return {
          answers,
          model: "typesafe/jev-1.13",
          provider: "decisions-api",
          latencyMs: 2,
          costUsd: 0.0001,
        };
      },
    },
  };
}

const VERIFIED =
  "- Pollster X: approval among group 0 rose 3 points since last week ([x](https://x.example/p))";

async function composeProfile(
  round: ArenaRound,
  lock: ArenaLock,
  members: FormationMember[],
  judge?: ProposalJudgeConfig,
  verified = VERIFIED,
) {
  return composeForecastRound(
    round,
    lock,
    [{ pattern: "delphi", members }],
    forecastRound(round, lock),
    { dossier: { since: "2026-07-01", verified, sources: 1, costUsd: 0 } },
    undefined,
    undefined,
    judge,
  );
}

describe("profile proposal judge (per cell)", () => {
  const { round, lock } = subgroupRound(3);
  const start = forecastRound(round, lock).profile!;
  const [c0, c1, c2] = round.cells!;

  it("support differs by cell: an unsupported cell keeps its start, a supported one moves", async () => {
    const j = cellJudge((c) => (c === c1 ? 0 : 1));
    const f = await composeProfile(round, lock, crew(3, start, () => 1).members, {
      mode: "on",
      provider: j.provider,
    });
    const plain = await composeProfile(round, lock, crew(3, start, () => 1).members);
    expect(f.judge?.status).toBe("applied");
    // One call per member: every moved cell is a question of the same request.
    expect(f.judge?.calls).toBe(3);
    expect(j.requests).toHaveLength(3);
    expect(j.requests[0]!.questions).toEqual(["cell_1", "cell_2", "cell_3"]);
    expect(f.judge?.cells?.[c1!]?.meanSupport).toBe(0);
    expect(f.judge?.cells?.[c0!]?.meanSupport).toBe(1);
    expect(f.profile![c1!]!.mean).toBe(start[c1!]!.mean);
    expect(f.profile![c0!]!.mean).toBe(plain.profile![c0!]!.mean);
    expect(f.profile![c2!]!.mean).toBe(plain.profile![c2!]!.mean);
    // Trust only drops.
    for (const c of round.cells!) {
      const cell = f.judge!.cells![c]!;
      expect(cell.judged.trust).toBeLessThanOrEqual(cell.unjudged.trust);
    }
    expect(f.trust!).toBeLessThan(plain.trust!);
  });

  it("weights each cell's centre toward the members supported on that cell", async () => {
    // m0 and m1 move every cell +0.4 sd, m2 moves +1.6 sd; only m2 is supported on c0.
    const members = crew(3, start, (i) => (i === 2 ? 1.6 : 0.4)).members;
    const provider: DecisionProvider = {
      kind: "decisions-api",
      model: "jev",
      ask: async (req) => {
        const state = req.state as {
          member_reason: string;
          cells: Array<{ question_id: string; cell: string }>;
        };
        const m2 = state.member_reason.includes("member 2");
        return {
          answers: Object.fromEntries(
            state.cells.map((c) => [
              c.question_id,
              { type: "noul" as const, noul: c.cell === c0 ? (m2 ? 0.9 : 0.1) : 0.5 },
            ]),
          ),
          model: "jev",
          provider: "decisions-api",
          latencyMs: 1,
        };
      },
    };
    const f = await composeProfile(round, lock, members, { mode: "on", provider });
    const cell0 = f.judge!.cells![c0!]!;
    const cell1 = f.judge!.cells![c1!]!;
    expect(cell0.judged.move).toBeCloseTo(1.6 * start[c0!]!.sd, 3);
    expect(cell1.judged.move).toBeCloseTo(0.4 * start[c1!]!.sd, 3);
  });

  it("batches at the decision API's question limit", async () => {
    const big = subgroupRound(MAX_CELLS_PER_CALL + 4);
    const bigStart = forecastRound(big.round, big.lock).profile!;
    const j = cellJudge(() => 1);
    const f = await composeProfile(big.round, big.lock, crew(2, bigStart, () => 0.5).members, {
      mode: "on",
      provider: j.provider,
    });
    expect(f.judge?.status).toBe("applied");
    // Two requests per member: 16 cells, then 4.
    expect(j.requests.map((r) => r.questions.length).sort()).toEqual([16, 16, 4, 4]);
  });

  it("fails open on any judge error: the unjudged profile is filed", async () => {
    const j = cellJudge((c) => (c === c2 ? new Error("ECONNREFUSED") : 1));
    const f = await composeProfile(round, lock, crew(3, start, () => 1).members, {
      mode: "on",
      provider: j.provider,
    });
    const plain = await composeProfile(round, lock, crew(3, start, () => 1).members);
    expect(f.judge?.status).toBe("unavailable");
    expect(f.judge?.error).toContain("ECONNREFUSED");
    expect(f.profile).toEqual(plain.profile);
    expect(f.trust).toBe(plain.trust);
  });

  it("observe records the judged profile without filing it; no verified lines skips", async () => {
    const j = cellJudge(() => 0);
    const f = await composeProfile(round, lock, crew(3, start, () => 1).members, {
      mode: "observe",
      provider: j.provider,
    });
    const plain = await composeProfile(round, lock, crew(3, start, () => 1).members);
    expect(f.judge?.status).toBe("observed");
    expect(f.profile).toEqual(plain.profile);
    expect(f.judge?.cells?.[c0!]?.judged.mean).toBe(start[c0!]!.mean);
    const none = await composeProfile(
      round,
      lock,
      crew(3, start, () => 1).members,
      { mode: "on", provider: cellJudge(() => 0).provider },
      "",
    );
    expect(none.judge?.status).toBe("skipped");
    expect(none.judge?.calls).toBe(0);
    expect(none.profile).toEqual(plain.profile);
  });

  it("records the per-cell start the formation moved from", async () => {
    const f = await formationForecastRound("delphi", round, lock, crew(3, start, () => 1).members);
    expect(f.formationStartProfile).toEqual(start);
  });
});

describe("profile sd floors", () => {
  const base = { a: { mean: 40, sd: 1 }, b: { mean: 20, sd: 2 } };
  const step = (stage: string, profile: Record<string, Distribution>, status = "ok") =>
    ({ stage, member: "x", status, reply: { profile } }) as FormationStep;

  it("raises a cell to its narrowest final proposal and to the linear pool of every reply", () => {
    const out = profileSdFloors(
      ["a", "b"],
      base,
      { a: { mean: 40.5, sd: 0.6 }, b: { mean: 20, sd: 2.5 } },
      [{ profile: { a: { mean: 41, sd: 0.8 }, b: { mean: 20, sd: 1 } } }],
      [
        step("round1", { a: { mean: 41, sd: 0.8 }, b: { mean: 18, sd: 1 } }),
        step("round1", { a: { mean: 41, sd: 0.8 }, b: { mean: 22, sd: 1 } }),
        // Advocates and dropped replies are not opinions.
        step("advocate-change", { a: { mean: 44, sd: 3 } }),
        step("round2", { a: { mean: 44, sd: 3 } }, "invalid reply (no valid cell)"),
      ],
    );
    expect(out.profile.a!.sd).toBe(0.8);
    expect(out.raised.narrowest).toEqual(["a"]);
    // b: pool of (18, 1) and (22, 1) = √(1 + 4) ≈ 2.236 < 2.5 filed: untouched.
    expect(out.profile.b!.sd).toBe(2.5);
    expect(out.profile.a!.mean).toBe(40.5);
    const wide = profileSdFloors(
      ["b"],
      base,
      { b: { mean: 20, sd: 1.5 } },
      [],
      [step("round1", { b: { mean: 17, sd: 1 } }), step("round1", { b: { mean: 23, sd: 1 } })],
    );
    expect(wide.profile.b!.sd).toBeCloseTo(Math.sqrt(1 + 9), 3);
    expect(wide.raised.linearPool).toEqual(["b"]);
  });

  it("a formation never files a cell narrower than every member asked for", async () => {
    const { round, lock } = subgroupRound(3);
    const start = forecastRound(round, lock).profile!;
    // Members agree on a small move with sds 1.3× the start: the trust blend alone gives less.
    const f = await formationForecastRound(
      "delphi",
      round,
      lock,
      crew(
        3,
        start,
        () => 0.2,
        () => 1.3,
      ).members,
    );
    for (const c of round.cells!) {
      expect(f.profile![c]!.sd).toBeGreaterThanOrEqual(start[c]!.sd * 1.3 - 1e-3);
    }
    expect(f.protocol?.sdFloors).toBeDefined();
  });
});

describe("share basket rescale stays coherent with the sds", () => {
  it("rescales means to 100 and every sd by the same factor, after the floors", async () => {
    const start = forecastRound(basketRound, basketLock).profile!;
    const f = await formationForecastRound(
      "delphi",
      basketRound,
      basketLock,
      crew(3, start, (_, c) => (c === "trends_share_alpha" ? 2 : 0)).members,
    );
    const sum = basketCells.reduce((s, c) => s + f.profile![c]!.mean, 0);
    expect(sum).toBeCloseTo(100, 1);
    const shares = f.protocol!.shares as { factor: number; sumBefore: number };
    expect(shares.factor).toBeLessThan(1);
    const factor = 100 / shares.sumBefore;
    // Unmoved cells: mean and sd both scaled by the factor from the start (the floor is the start sd).
    for (const c of ["trends_share_beta", "trends_share_gamma"]) {
      expect(f.profile![c]!.mean).toBeCloseTo(start[c]!.mean * factor, 2);
      expect(f.profile![c]!.sd).toBeCloseTo(start[c]!.sd * factor, 2);
    }
  });
});

// ─── The learned move weight on profiles ──────────────────────────────────────

const PROFILE_KEY = calibrationKey("yougov_xtab:profile", "formation:delphi");

/**
 * `n` weekly profile rounds whose outcome per cell is start + beta · Δ + noise,
 * filed at the formation's half trust (start + 0.5 Δ), sd 1 per cell.
 */
function profileRecords(
  n: number,
  beta: number,
  opts: { seed?: number; key?: string; shareTotal?: number; noise?: number } = {},
): ProfileMoveRecord[] {
  const rand = mulberry32(opts.seed ?? 7);
  const noise = opts.noise ?? 0.1;
  return Array.from({ length: n }, (_, i) => {
    const starts = opts.shareTotal ? [50, 30, 20] : [30, 40, 50];
    const deltas = starts.map(() => (rand() - 0.5) * 4);
    // A share basket's moves cancel (its outcome adds to the total too).
    if (opts.shareTotal) deltas[2] = -(deltas[0]! + deltas[1]!) / 2;
    if (opts.shareTotal) deltas[1] = -(deltas[0]! + deltas[2]!);
    const cells: ProfileMoveCell[] = starts.map((start, k) => {
      const delta = deltas[k]!;
      return {
        cell: `c${k}`,
        start,
        startSd: 1,
        delta,
        filed: { mean: start + 0.5 * delta, sd: 1 },
        outcome: start + beta * delta + (rand() - 0.5) * 2 * noise,
      };
    });
    const { dev, t2 } = profilePointSet(cells.map((c) => c.filed.sd));
    // Persistence: the start at sd 1.5 per cell.
    const norm = profileEnergy(
      Object.fromEntries(cells.map((c) => [c.cell, { mean: c.start, sd: 1.5 }])),
      Object.fromEntries(cells.map((c) => [c.cell, c.outcome])),
      cells.map((c) => c.cell),
    );
    return {
      id: `p${i}`,
      roundId: `p${i}`,
      key: opts.key ?? PROFILE_KEY,
      resolvedAt: new Date(Date.parse("2026-01-02") + i * 7 * 86_400_000).toISOString(),
      trust: 0.5,
      profile: {
        cells,
        ...(opts.shareTotal ? { shareTotal: opts.shareTotal } : {}),
        norm,
        dev,
        t2,
      },
    };
  });
}

describe("profile move weight", () => {
  it("fits a larger weight by energy score when the members' cell moves carry signal", () => {
    const d = decideMoveWeight(profileRecords(24, 1));
    expect(d.adopted).toBe(true);
    expect(d.w!).toBeGreaterThan(0.7);
    expect(d.placebo?.pass).toBe(true);
  });

  it("the placebo refuses a gain that shuffled cell moves reproduce", () => {
    const d = decideMoveWeight(profileRecords(24, 0, { seed: 11 }));
    expect(d.holdout).toBeDefined();
    expect(d.placebo?.pass).toBe(false);
    expect(d.adopted).toBe(false);
  });

  it("is a no-op below the minimum history", () => {
    const d = decideMoveWeight(profileRecords(MIN_MOVE_RECORDS - 1, 1));
    expect(d.adopted).toBe(false);
    expect(d.reason).toMatch(/insufficient history/);
  });

  const round = subgroupRound(3).round;
  const now = Date.parse("2027-01-01");
  const profileForecast = (): RoundForecast =>
    ({
      profile: {
        xtab_approve_g0: { mean: 30.5, sd: 1 },
        xtab_approve_g1: { mean: 40, sd: 1 },
        xtab_approve_g2: { mean: 49.5, sd: 1 },
      },
      note: "route yougov_xtab → formation:delphi:a,b,c; marina delphi formation, per cell",
      profileProposals: {
        a: {
          profile: { xtab_approve_g0: { mean: 31, sd: 1 }, xtab_approve_g2: { mean: 49, sd: 1 } },
        },
        b: {
          profile: { xtab_approve_g0: { mean: 31, sd: 1 }, xtab_approve_g2: { mean: 49, sd: 1 } },
        },
      },
      formationStartProfile: {
        xtab_approve_g0: { mean: 30, sd: 1 },
        xtab_approve_g1: { mean: 40, sd: 1 },
        xtab_approve_g2: { mean: 50, sd: 1 },
      },
      trust: 0.5,
      rules: {},
    }) as unknown as RoundForecast;

  it("applies an earned weight to every cell's move; sds untouched; observe records only", () => {
    const out = applyMoveWeight(round, profileForecast(), profileRecords(24, 1), { now });
    expect(out.moveWeight?.applied).toBe(true);
    expect(out.moveWeight?.scope).toBe("key");
    expect(out.profile!.xtab_approve_g0!.mean).toBeGreaterThan(30.5);
    expect(out.profile!.xtab_approve_g2!.mean).toBeLessThan(49.5);
    expect(out.profile!.xtab_approve_g1!.mean).toBe(40);
    expect(out.profile!.xtab_approve_g0!.sd).toBe(1);
    expect(out.note).toMatch(
      /move weight .* learned on arena:yougov_xtab:profile\|formation:delphi/,
    );
    const observed = applyMoveWeight(round, profileForecast(), profileRecords(24, 1), {
      now,
      mode: "observe",
    });
    expect(observed.moveWeight?.adopted).toBe(true);
    expect(observed.profile).toEqual(profileForecast().profile);
  });

  it("pools every profile family of the method when the key has too few rounds", () => {
    const others = profileRecords(24, 1, {
      key: calibrationKey("civiqs:profile", "formation:delphi"),
    });
    const out = applyMoveWeight(round, profileForecast(), others, { now });
    expect(out.moveWeight?.scope).toBe("profile-families");
    expect(out.moveWeight?.evidenceKey).toBe("arena:*:profile|formation:delphi");
    expect(out.moveWeight?.applied).toBe(true);
    // A different method is never pooled in.
    const symbiosis = profileRecords(24, 1, {
      key: calibrationKey("civiqs:profile", "formation:symbiosis"),
    });
    expect(applyMoveWeight(round, profileForecast(), symbiosis, { now }).moveWeight?.nFit).toBe(0);
    // Scalar records of the same key are no profile evidence.
    const scalar = profileRecords(24, 1).map(
      (r) =>
        ({
          ...r,
          profile: undefined,
          start: 0,
          delta: 0,
          filed: { mean: 0, sd: 1 },
          outcome: 0,
        }) as MoveRecord,
    );
    expect(applyMoveWeight(round, profileForecast(), scalar, { now }).moveWeight?.nFit).toBe(0);
  });

  it("never reads the round being filed or outcomes after now", () => {
    const rs = profileRecords(24, 1).map((r, i) => ({
      ...r,
      roundId: i < 20 ? round.round_id : r.roundId,
    }));
    expect(applyMoveWeight(round, profileForecast(), rs, { now }).moveWeight?.applied).toBe(false);
    const early = applyMoveWeight(round, profileForecast(), profileRecords(24, 1), {
      now: Date.parse("2026-01-01"),
    });
    expect(early.moveWeight?.nFit).toBe(0);
  });

  it("re-closes a share basket after re-weighting: means to the total, sds by the same factor", () => {
    const basket = {
      ...profileForecast(),
      profile: {
        trends_share_alpha: { mean: 51.98, sd: 0.99 },
        trends_share_beta: { mean: 29.7, sd: 0.99 },
        trends_share_gamma: { mean: 18.32, sd: 0.99 },
      },
      profileProposals: {
        a: {
          profile: {
            trends_share_alpha: { mean: 54, sd: 1 },
            trends_share_gamma: { mean: 17, sd: 1 },
          },
        },
      },
      formationStartProfile: {
        trends_share_alpha: { mean: 50, sd: 1 },
        trends_share_beta: { mean: 30, sd: 1 },
        trends_share_gamma: { mean: 20, sd: 1 },
      },
      note: "route google_trends → formation:delphi:a; marina delphi formation, per cell, shares rescaled to 100",
      protocol: { shares: { total: 100, sumBefore: 101, factor: 0.99 } },
    } as unknown as RoundForecast;
    const rs = profileRecords(24, 1, {
      shareTotal: 100,
      key: calibrationKey("google_trends:profile", "formation:delphi"),
    });
    const out = applyMoveWeight(basketRound, basket, rs, { now });
    expect(out.moveWeight?.applied).toBe(true);
    const cells = Object.values(out.profile!);
    expect(cells.reduce((s, d) => s + d.mean, 0)).toBeCloseTo(100, 2);
    const factor = out.profile!.trends_share_beta!.mean / 30;
    for (const d of cells) expect(d.sd).toBeCloseTo((0.99 / 0.99) * factor, 2);
  });

  it("builds profile records from filings and the site's outcomes (recorded or recovered start)", () => {
    const cells = ["g0", "g1"];
    const site = [
      {
        round_id: "yougov-xtab-2026-w41",
        tracker: "yougov_xtab",
        target_type: "profile_energy",
        status: "resolved",
        cells,
        resolution: { outcome: { g0: 33, g1: 40 }, release_date: "2026-10-06" },
        scores: { persistence: { energy: 2.5 } },
      },
      {
        round_id: "yougov-xtab-2026-w42",
        tracker: "yougov_xtab",
        target_type: "profile_energy",
        status: "resolved",
        cells,
        resolution: { outcome: { g0: 31, g1: 41 }, release_date: "2026-10-13" },
      },
    ];
    const row = (id: number, roundId: string, forecast: Record<string, unknown>) =>
      ({
        id,
        round_id: roundId,
        status: "accepted",
        body: JSON.stringify({
          profile: { g0: { mean: 31, sd: 1.2 }, g1: { mean: 40, sd: 1.1 } },
        }),
        detail: JSON.stringify({
          round: { tracker: "yougov_xtab", target_type: "profile_energy", cells },
          forecast: {
            note: "route yougov_xtab → formation:delphi:a,b; marina delphi formation, per cell",
            profileProposals: {
              a: { profile: { g0: { mean: 32 }, g1: { mean: 40 } } },
              b: { profile: { g0: { mean: 32 }, g1: { mean: 40 } } },
            },
            trust: 0.5,
            ...forecast,
          },
        }),
      }) as ArenaSubmissionRow;
    const out = moveWeightHistory(
      [
        row(1, "yougov-xtab-2026-w41", {
          formationStartProfile: { g0: { mean: 30, sd: 1 }, g1: { mean: 40, sd: 1 } },
        }),
        // Legacy: no recorded start; recovered from 31 = start + 0.5 (32 − start) ⇒ 30.
        row(2, "yougov-xtab-2026-w42", {
          protocol: { cells: { g0: { n: 2, trust: 0.5 }, g1: { n: 2, trust: 0.5 } } },
        }),
      ],
      {},
      {},
      [],
      site,
    ) as ProfileMoveRecord[];
    expect(out).toHaveLength(2);
    expect(out[0]!.key).toBe(PROFILE_KEY);
    expect(out[0]!.profile.cells.map((c) => c.delta)).toEqual([2, 0]);
    expect(out[0]!.profile.norm).toBe(2.5);
    expect(out[0]!.resolvedAt).toBe("2026-10-07T00:00:00.000Z");
    expect(out[1]!.profile.cells[0]!.start).toBeCloseTo(30, 6);
    expect(out[1]!.profile.cells[0]!.delta).toBeCloseTo(2, 6);
    // Without a persistence score the filing's own energy is the denominator.
    expect(out[1]!.profile.norm).toBeGreaterThan(0);
  });
});

// ─── Required research: fall back instead of skipping ─────────────────────────

describe("required research fallback", () => {
  const { round, lock } = subgroupRound(3);
  const start = forecastRound(round, lock);
  const failing = {
    since: "2026-07-01",
    verified: "",
    sources: 0,
    costUsd: 0.2,
    retriever: "search",
  };

  it("no verified evidence → the same formation closed-book, marked in the detail and note", async () => {
    const { members, calls } = crew(3, start.profile!, () => 1);
    const f = await composeForecastRound(round, lock, [{ pattern: "delphi", members }], start, {
      required: true,
      fallback: "closed-book",
      dossier: failing,
    });
    expect(calls()).toBeGreaterThan(0);
    expect(f.researchFallback).toMatchObject({ mode: "closed-book", used: "closed-book" });
    expect(f.researchFallback!.reason).toContain("no verified research evidence");
    expect(f.note).toContain("research fallback (closed-book)");
    expect(f.dossier?.costUsd).toBe(0.2);
    expect(f.formation).toBe("delphi");
    // The briefing carried no dossier.
    expect(JSON.stringify(f.rounds)).not.toContain("RESEARCH DOSSIER");
    // Keyed as a closed-book filing, never as researched.
    expect(methodOf(`route yougov_xtab → formation:delphi:a+research@search; ${f.note}`)).toBe(
      "formation:delphi",
    );
  });

  it("a closed-book run with nothing usable → the start forecast", async () => {
    const members: FormationMember[] = [0, 1, 2].map((i) => ({
      name: `m${i}`,
      complete: async () => {
        throw new Error("model unavailable");
      },
    }));
    const f = await composeForecastRound(round, lock, [{ pattern: "delphi", members }], start, {
      required: true,
      fallback: "closed-book",
      dossier: failing,
    });
    expect(f.researchFallback?.used).toBe("start");
    expect(f.researchFallback?.closedBookError).toBe("no usable proposal");
    expect(f.profile).toEqual(start.profile);
    expect(f.note).toContain("research fallback (start)");
  });

  it("a formation with no usable proposal over the dossier also falls back", async () => {
    let n = 0;
    const members: FormationMember[] = [0, 1, 2].map((i) => ({
      name: `m${i}`,
      complete: async (_s: string, user: string) => {
        n++;
        if (user.includes("RESEARCH DOSSIER")) throw new Error("model unavailable");
        return JSON.stringify({
          profile: Object.fromEntries(
            Object.entries(start.profile!).map(([c, d]) => [c, { mean: d.mean + 0.5, sd: d.sd }]),
          ),
          reason: `member ${i}`,
        });
      },
    }));
    const f = await composeForecastRound(round, lock, [{ pattern: "delphi", members }], start, {
      required: true,
      fallback: "closed-book",
      dossier: { ...failing, verified: "verified fact", sources: 1 },
    });
    expect(n).toBeGreaterThan(3);
    expect(f.researchFallback?.used).toBe("closed-book");
    expect(f.researchFallback?.reason).toContain("no usable proposal");
  });

  it("start mode files the start at once; skip mode keeps the refusal", async () => {
    const { members, calls } = crew(3, start.profile!, () => 1);
    const f = await composeForecastRound(round, lock, [{ pattern: "delphi", members }], start, {
      required: true,
      fallback: "start",
      dossier: failing,
    });
    expect(calls()).toBe(0);
    expect(f.researchFallback).toMatchObject({ mode: "start", used: "start" });
    expect(f.profile).toEqual(start.profile);
    await expect(
      composeForecastRound(round, lock, [{ pattern: "delphi", members }], start, {
        required: true,
        fallback: "skip",
        dossier: failing,
      }),
    ).rejects.toThrow("Required research refused");
  });

  it("reads MARINA_ARENA_RESEARCH_FALLBACK (default closed-book) into the forecast fingerprint", () => {
    expect(researchFallbackModeFromEnv({})).toBe("closed-book");
    expect(researchFallbackModeFromEnv({ MARINA_ARENA_RESEARCH_FALLBACK: "START" })).toBe("start");
    expect(researchFallbackModeFromEnv({ MARINA_ARENA_RESEARCH_FALLBACK: "skip" })).toBe("skip");
    expect(researchFallbackModeFromEnv({ MARINA_ARENA_RESEARCH_FALLBACK: "junk" })).toBe(
      "closed-book",
    );
    expect(
      forecastSettings("nowcast", { MARINA_ARENA_RESEARCH_REQUIRED: "on" }).researchFallback,
    ).toBe("closed-book");
    expect(forecastSettings("nowcast", {}).researchFallback).toBeUndefined();
  });
});

describe("required research fallback (research forecaster)", () => {
  let pollLevel: DisposableStack | undefined;
  beforeEach(() => {
    pollLevel = scopeProcessState({ env: { MARINA_ARENA_POLL_LEVEL: "off" } });
  });
  afterEach(() => pollLevel?.dispose());

  const history = weekly(Array.from({ length: 30 }, (_, i) => 35 + (i % 2)));
  const round: ArenaRound = {
    round_id: "midterm-2026-house-margin",
    tracker: "midterm",
    series: "house_margin",
    question: "Generic House margin?",
    unit: "points",
    target_type: "continuous_normal",
    lock_at: "2026-09-27T14:00:00Z",
    release_at: "2026-09-29T14:00:00Z",
  };
  const lock: ArenaLock = { round_id: round.round_id, answer_history: history };
  const last = history.at(-1)!.value;
  const retriever: Retriever = async () => ({
    report: "- Echelon: margin 38, up from 36 ([e](https://e.example/p))",
    sources: [{ url: "https://e.example/p" }],
    costUsd: 0.03,
    searches: 3,
    retriever: "fake",
  });
  /** Grounds nothing on the first `ungrounded` calls, everything after. */
  const judge = (ungrounded: number): DecisionProvider => {
    let calls = 0;
    return {
      kind: "fake",
      model: "fake-jev",
      ask: async () => ({
        answers: {
          quality: { type: "score", score: 2, confidence: 0.9 },
          grounded: { type: "noul", noul: calls++ < ungrounded ? 0 : 1 },
        },
        model: "fake-jev",
        provider: "fake",
        latencyMs: 1,
        costUsd: 0.01,
      }),
    };
  };
  const deps = (ungrounded: number, fallback?: "closed-book" | "start" | "skip") => ({
    requireResearch: true,
    ...(fallback ? { researchFallback: fallback } : {}),
    retriever,
    analysts: [
      {
        name: "a",
        complete: async () =>
          `{"mean": ${last + 2}, "sd": 1.5, "evidence": "trend", "reason": "small rise"}`,
      },
    ],
    judge: judge(ungrounded),
    pageText: async () => "Echelon: margin 38, up from 36",
  });

  it("judge found no grounded proposal → closed-book analysts; still none → the start", async () => {
    const closed = await researchForecastRound(round, lock, deps(1, "closed-book"));
    expect(closed.researchFallback).toMatchObject({ used: "closed-book" });
    expect(closed.researchFallback!.reason).toContain("judge found no grounded proposal");
    expect(closed.dossier?.retriever).toBe("closed-book");
    expect(closed.topline!.mean).toBeGreaterThan(forecastRound(round, lock).topline!.mean);
    // The failed research's spend is still owed to the ledgers.
    expect(closed.researchFallback!.failedCostUsd).toBeCloseTo(0.04, 6);

    const start = await researchForecastRound(round, lock, deps(99, "closed-book"));
    expect(start.researchFallback).toMatchObject({ used: "start" });
    expect(start.researchFallback!.closedBookError).toBe("judge found no grounded proposal");
    expect(start.topline).toEqual(forecastRound(round, lock).topline);
    expect(start.note).toContain("research fallback (start)");
  });

  it("a retriever outage falls back; skip (the library default) still refuses", async () => {
    const down = {
      ...deps(0, "start"),
      retriever: (async () => {
        throw new Error("search unavailable");
      }) as Retriever,
    };
    const f = await researchForecastRound(round, lock, down);
    expect(f.researchFallback).toMatchObject({ mode: "start", used: "start" });
    expect(f.researchFallback!.reason).toContain("search unavailable");
    await expect(researchForecastRound(round, lock, deps(1))).rejects.toThrow(
      "judge found no grounded proposal",
    );
    await expect(researchForecastRound(round, lock, deps(1, "skip"))).rejects.toThrow(
      "Required research forecast refused",
    );
  });
});
