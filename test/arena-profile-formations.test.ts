// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { ArenaData } from "../src/arena/data";
import { scoreShadow } from "../src/arena/evaluate";
import { forecastRound, type RoundForecast } from "../src/arena/forecast";
import {
  aggregateCells,
  checkCellCitations,
  delphiProfileSummary,
  type ProfileProposal,
} from "../src/arena/formation-profile";
import {
  composeForecastRound,
  FORMATION_PATTERNS,
  type FormationMember,
  formationForecastRound,
  MAX_FINAL_SD_MOVE,
} from "../src/arena/formations";
import {
  cellLabels,
  declaresShares,
  parseProfile,
  renormaliseShares,
  SHARE_TOTAL,
  shareBasketTotal,
} from "../src/arena/profile-shape";
import { buildResearchBrief } from "../src/arena/research/briefs";
import { researchForecastRound } from "../src/arena/research/forecaster";
import type { Retriever } from "../src/arena/research/retrieve";
import type { ArenaLock, ArenaPoint, ArenaRound, Distribution } from "../src/arena/types";
import type { DecisionProvider } from "../src/decisions/types";

const weekly = (values: number[], start = "2026-01-02"): ArenaPoint[] =>
  values.map((value, i) => ({
    date: new Date(Date.parse(start) + i * 7 * 86_400_000).toISOString().slice(0, 10),
    value,
  }));
const series = (f: (i: number) => number) => weekly(Array.from({ length: 30 }, (_, i) => f(i)));

/** Independent subgroup cells (a YouGov-style crosstab profile). */
function subgroupRound(n = 3): { round: ArenaRound; lock: ArenaLock } {
  const cells = Array.from({ length: n }, (_, k) => `xtab_approve_g${k}`);
  const round: ArenaRound = {
    round_id: `xtab-2026-w40-${n}`,
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

/** A three-brand share basket whose cells add to 100. */
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

interface Call {
  member: string;
  system: string;
  user: string;
}

/**
 * Members that answer every protocol step with one universal reply: each cell
 * at start + `move(cell)`, plus every field any step reads. Every call is logged.
 */
function crew(
  n: number,
  cells: string[],
  start: Record<string, Distribution>,
  move: (member: number, cell: string, system: string) => number | undefined,
  extra: (member: number, system: string) => Record<string, unknown> = () => ({}),
): { members: FormationMember[]; calls: Call[] } {
  const calls: Call[] = [];
  const members = Array.from({ length: n }, (_, i) => ({
    name: `m${i}`,
    complete: async (system: string, user: string) => {
      calls.push({ member: `m${i}`, system, user });
      const profile: Record<string, unknown> = {};
      for (const c of cells) {
        const d = move(i, c, system);
        if (d === undefined) continue;
        profile[c] = { mean: start[c]!.mean + d, sd: start[c]!.sd, adjustment: d };
      }
      return JSON.stringify({
        profile,
        reason: `member reason ${i}`,
        verdict: "change",
        trust: 0.5,
        winner: "A",
        critique: "grounded critique",
        credit: "used the partner's context",
        contribution: "context",
        evidence: "none",
        argument: "an argument",
        strength: 0.4,
        confidence: 1,
        sd_scale: 1,
        decision: "keep",
        hypothesis: "h",
        check: { name: "deltas", k: 4, cell: cells[0] },
        cites: [{ cell: cells[0], date: lockDate, value: lastValue }],
        ...extra(i, system),
      });
    },
  }));
  return { members, calls };
}

// The citation every universal reply carries: the first cell's last published value.
const fixture = subgroupRound(3);
const lockDate = fixture.lock.answer_history_by_cell![fixture.round.cells![0]!]!.at(-1)!.date;
const lastValue = fixture.lock.answer_history_by_cell![fixture.round.cells![0]!]!.at(-1)!.value;

const startOf = (round: ArenaRound, lock: ArenaLock): RoundForecast => forecastRound(round, lock);

describe("profile replies, validated per cell", () => {
  const base = { a: { mean: 40, sd: 1 }, b: { mean: 20, sd: 2 } };

  it("keeps valid cells, and names each missing, malformed or wild one", () => {
    const got = parseProfile(
      { a: { mean: 41, sd: 1.2 }, b: { mean: "x", sd: 1 }, z: { mean: 1, sd: 1 } },
      ["a", "b"],
      base,
      4,
    );
    expect(got.profile).toEqual({ a: { mean: 41, sd: 1.2 } });
    expect(got.issues).toEqual(["b invalid"]);
    const wild = parseProfile(
      { a: { mean: 45, sd: 1 }, b: { mean: 21, sd: 0 } },
      ["a", "b"],
      base,
      4,
    );
    expect(wild.profile).toEqual({});
    expect(wild.issues[0]).toContain("a move 5 beyond 4 start sd");
    expect(wild.issues[1]).toBe("b invalid");
    expect(parseProfile(undefined, ["a"], base, 4).issues).toEqual(["a missing"]);
    // The guard is per cell, in that cell's own start sd.
    expect(parseProfile({ b: { mean: 27.9, sd: 1 } }, ["b"], base, 4).profile.b?.mean).toBe(27.9);
  });

  it("labels cells by their distinguishing suffix", () => {
    expect(cellLabels(basketCells)).toEqual({
      trends_share_alpha: "alpha",
      trends_share_beta: "beta",
      trends_share_gamma: "gamma",
    });
  });
});

describe("share baskets", () => {
  it("detects a basket only when the round says so AND its last values add to 100", () => {
    const start = startOf(basketRound, basketLock);
    expect(declaresShares(basketRound)).toBe(true);
    expect(shareBasketTotal(basketRound, basketLock, start)).toBe(SHARE_TOTAL);
    // Independent cells are never shares, whatever they sum to.
    const { round, lock } = subgroupRound(3);
    expect(declaresShares(round)).toBe(false);
    expect(shareBasketTotal(round, lock, startOf(round, lock))).toBeUndefined();
    // A declared basket whose values do not add to 100 is not rescaled.
    const off: ArenaLock = {
      ...basketLock,
      answer_history_by_cell: {
        ...basketLock.answer_history_by_cell,
        trends_share_gamma: series(() => 40),
      },
    };
    expect(shareBasketTotal(basketRound, off, startOf(basketRound, off))).toBeUndefined();
  });

  it("rescales the means proportionally to the total and leaves the sds", () => {
    const { profile, audit } = renormaliseShares(
      { a: { mean: 55, sd: 1 }, b: { mean: 30, sd: 2 }, c: { mean: 20, sd: 3 } },
      ["a", "b", "c"],
    );
    expect(audit.sumBefore).toBe(105);
    expect(profile.a!.mean + profile.b!.mean + profile.c!.mean).toBeCloseTo(100, 2);
    expect(profile.a!.mean / profile.b!.mean).toBeCloseTo(55 / 30, 3);
    expect(profile.c!.sd).toBe(3);
    const none = renormaliseShares({ a: { mean: 0, sd: 1 } }, ["a"]);
    expect(none.audit.factor).toBe(1);
  });
});

describe("per-cell aggregation", () => {
  const base = { a: { mean: 40, sd: 1 }, b: { mean: 20, sd: 2 }, c: { mean: 10, sd: 1 } };
  const p = (profile: Record<string, Distribution>): ProfileProposal => ({ profile });

  it("median per cell at half trust × agreement; capped; floored; unanswered keeps its start", () => {
    const agg = aggregateCells(["a", "b", "c"], base, [
      p({ a: { mean: 41, sd: 1 }, b: { mean: 60, sd: 2 } }),
      p({ a: { mean: 41, sd: 1 }, b: { mean: 60, sd: 2 } }),
      p({ a: { mean: 41, sd: 0.01 } }),
    ]);
    expect(agg.profile.a!.mean).toBeCloseTo(40.5, 3);
    expect(agg.cells.a).toEqual({ n: 3, trust: 0.5, agreement: 1 });
    // A huge agreed move is capped at MAX_FINAL_SD_MOVE of the cell's own sd.
    expect(agg.profile.b!.mean).toBeCloseTo(20 + MAX_FINAL_SD_MOVE * 2, 3);
    expect(agg.cells.b!.n).toBe(2);
    expect(agg.profile.c).toEqual(base.c);
    expect(agg.cells.c).toEqual({ n: 0, trust: 0 });
    // The sd never drops below half the start sd.
    const narrow = aggregateCells(["a"], base, [p({ a: { mean: 40, sd: 0.001 } })]);
    expect(narrow.profile.a!.sd).toBeGreaterThanOrEqual(0.5);
  });

  it("disagreement on one cell shrinks only that cell", () => {
    const agg = aggregateCells(["a", "b"], base, [
      p({ a: { mean: 42, sd: 1 }, b: { mean: 21, sd: 2 } }),
      p({ a: { mean: 38, sd: 1 }, b: { mean: 21, sd: 2 } }),
    ]);
    expect(agg.cells.a!.agreement!).toBeLessThan(0.5);
    expect(agg.cells.b!.agreement).toBe(1);
    expect(agg.profile.b!.mean).toBeCloseTo(20.5, 3);
  });
});

describe("every formation pattern on a profile round", () => {
  for (const pattern of FORMATION_PATTERNS) {
    it(`${pattern}: one call per member per step for the whole profile, every cell answered`, async () => {
      const counts: number[] = [];
      for (const n of [3, 6]) {
        const { round, lock } = subgroupRound(n);
        const start = startOf(round, lock);
        const cells = round.cells!;
        const { members, calls } = crew(3, cells, start.profile!, (_, c) =>
          c === cells[1] ? -1 : 1,
        );
        const f = await formationForecastRound(pattern, round, lock, members, start);
        counts.push(calls.length);
        expect(f.fallback).toBeUndefined();
        expect(f.formation).toBe(pattern);
        expect(f.topline).toBeUndefined();
        expect(Object.keys(f.profile!).sort()).toEqual([...cells].sort());
        for (const c of cells) {
          const b = start.profile![c]!;
          const d = f.profile![c]!;
          expect(Math.abs(d.mean - b.mean)).toBeLessThanOrEqual(MAX_FINAL_SD_MOVE * b.sd + 1e-9);
          expect(d.sd).toBeGreaterThanOrEqual(b.sd * 0.5 - 1e-9);
        }
        // Every prompt shows every cell's dated history and asks for the whole profile.
        for (const call of calls) {
          for (const c of cells) expect(call.user).toContain(c);
        }
        expect(f.rounds!.length).toBe(calls.length);
        expect(f.protocol?.cells).toBeDefined();
        expect(f.note).toContain("per cell");
      }
      // The number of calls does not grow with the number of cells.
      expect(counts[0]).toBe(counts[1]);
    });
  }

  it("ensemble: a wild cell drops out of its own proposal only", async () => {
    const { round, lock } = subgroupRound(3);
    const start = startOf(round, lock);
    const [c0, c1] = round.cells!;
    const { members } = crew(3, round.cells!, start.profile!, (i, c) =>
      i === 2 && c === c0 ? 50 * start.profile![c0!]!.sd : 1,
    );
    const f = await formationForecastRound("ensemble", round, lock, members, start);
    const cells = f.protocol!.cells as Record<string, { n: number }>;
    expect(cells[c0!]!.n).toBe(2);
    expect(cells[c1!]!.n).toBe(3);
    expect(f.rounds!.find((s) => s.member === "m2")!.status).toContain("1 cell(s) left out");
    expect(f.profile![c0!]!.mean).toBeCloseTo(start.profile![c0!]!.mean + 0.5, 3);
  });

  it("a reply with no usable cell drops out; nothing usable files the start", async () => {
    const { round, lock } = subgroupRound(3);
    const start = startOf(round, lock);
    const { members } = crew(3, round.cells!, start.profile!, () => undefined);
    const f = await formationForecastRound("ensemble", round, lock, members, start);
    expect(f.fallback).toBe("no usable proposal");
    expect(f.profile).toEqual(start.profile);
    expect(f.rounds!.every((s) => s.status === "invalid reply (no valid cell)")).toBe(true);
  });

  it("delphi: round 2 sees only the anonymized per-cell summary", async () => {
    const { round, lock } = subgroupRound(3);
    const start = startOf(round, lock);
    const { members, calls } = crew(
      3,
      round.cells!,
      start.profile!,
      (i) => i - 1,
      (i) => ({
        reason: `thinks so, ${i > 0 ? "up" : "down"}`,
      }),
    );
    const f = await formationForecastRound("delphi", round, lock, members, start);
    const second = calls.filter((c) => c.system.includes("Delphi"));
    expect(second).toHaveLength(3);
    for (const c of second) {
      expect(c.user).toContain("PANEL SUMMARY");
      expect(/\bm[0-2]\b/.test(c.user)).toBe(false);
    }
    const summary = f.protocol!.summary as {
      cells: Record<string, { n: number; meanRange: number[] }>;
    };
    expect(summary.cells[round.cells![0]!]!.n).toBe(3);
    const s = delphiProfileSummary(
      ["a"],
      { a: { mean: 10, sd: 1 } },
      [{ profile: { a: { mean: 11, sd: 1 } }, reason: "vendor/model-x says up" }],
      [{ name: "vendor/model-x", complete: async () => "" }],
    );
    expect(s.text).toContain("- a: mean median 11 (move 1)");
    expect(s.text).toContain("a panelist says up");
  });

  it("debate: a STAY verdict files the start", async () => {
    const { round, lock } = subgroupRound(3);
    const start = startOf(round, lock);
    const { members, calls } = crew(
      3,
      round.cells!,
      start.profile!,
      () => 1,
      (_, system) => (system.includes("you wrote neither") ? { verdict: "stay" } : {}),
    );
    const f = await formationForecastRound("debate", round, lock, members, start);
    expect(calls.map((c) => c.system.includes("MOVE away")).filter(Boolean)).toHaveLength(1);
    expect(f.trust).toBe(0);
    for (const c of round.cells!) expect(f.profile![c]!.mean).toBe(start.profile![c]!.mean);
  });

  it("tournament: the judge compares whole-profile candidates; no judgment advances the smaller move", async () => {
    const { round, lock } = subgroupRound(3);
    const start = startOf(round, lock);
    const { members, calls } = crew(
      3,
      round.cells!,
      start.profile!,
      (i) => (i === 0 ? 2 : 0.5),
      (_, system) => (system.includes("tournament") ? { winner: "neither" } : {}),
    );
    const f = await formationForecastRound("tournament", round, lock, members, start);
    const match = calls.find((c) => c.system.includes("tournament"))!;
    expect(match.user).toContain("Candidate A: {");
    for (const c of round.cells!) expect(match.user).toContain(`"${c}": {"mean"`);
    expect(f.protocol!.champion).toBe("2:m1");
    const bracket = f.protocol!.bracket as Array<{ decided: string }>;
    expect(bracket[0]!.decided).toContain("fallback");
  });

  it("verification: range and sd per cell, citations name their cell", async () => {
    const { round, lock } = subgroupRound(3);
    const start = startOf(round, lock);
    const [c0, c1] = round.cells!;
    // m0 moves c1 far outside its band: c1 fails for m0 alone.
    const { members } = crew(3, round.cells!, start.profile!, (i, c) =>
      i === 0 && c === c1 ? 3.5 * start.profile![c1!]!.sd : 1,
    );
    const f = await formationForecastRound("verification", round, lock, members, start);
    const verdicts = f.protocol!.verdicts as Record<
      string,
      { cells: Record<string, { range: { pass: boolean } }>; cites: { pass: boolean } }
    >;
    expect(verdicts["1:m0"]!.cells[c1!]!.range.pass).toBe(false);
    expect(verdicts["1:m0"]!.cells[c0!]!.range.pass).toBe(true);
    expect(verdicts["1:m0"]!.cites.pass).toBe(true);
    const cells = f.protocol!.cells as Record<string, { n: number }>;
    expect(cells[c1!]!.n).toBe(2);
    expect(cells[c0!]!.n).toBe(3);
    const shown = { [c0!]: lock.answer_history_by_cell![c0!]! };
    expect(checkCellCitations([{ cell: c1, date: lockDate, value: lastValue }], shown).pass).toBe(
      false,
    );
    expect(checkCellCitations([], shown).pass).toBe(false);
  });

  it("a share basket is rescaled to 100 after aggregation; independent cells are not", async () => {
    const start = startOf(basketRound, basketLock);
    const { members, calls } = crew(3, basketCells, start.profile!, (_, c) =>
      c === "trends_share_alpha" ? 2 : 0,
    );
    const f = await formationForecastRound("ensemble", basketRound, basketLock, members, start);
    const sum = basketCells.reduce((s, c) => s + f.profile![c]!.mean, 0);
    expect(sum).toBeCloseTo(100, 2);
    const shares = f.protocol!.shares as { sumBefore: number; factor: number };
    expect(shares.sumBefore).toBeGreaterThan(100);
    expect(shares.factor).toBeLessThan(1);
    expect(calls[0]!.user).toContain("add to 100");
    const { round, lock } = subgroupRound(3);
    const s2 = startOf(round, lock);
    const g = await formationForecastRound(
      "ensemble",
      round,
      lock,
      crew(3, round.cells!, s2.profile!, () => 1).members,
      s2,
    );
    expect(g.protocol!.shares).toBeUndefined();
  });

  it("ranking rounds keep their start with no model call", async () => {
    const { members, calls } = crew(3, [], {}, () => 1);
    const ranking: ArenaRound = {
      ...fixture.round,
      target_type: "ranking_list",
      ranking: { length: 2 },
    };
    const start: RoundForecast = { ranking: ["x", "y"], rules: {}, note: "n" };
    const f = await formationForecastRound("chorus", ranking, fixture.lock, members, start);
    expect(calls).toHaveLength(0);
    expect(f.ranking).toEqual(["x", "y"]);
    expect(f.fallback).toBeDefined();
  });

  it("composition: +then judges the profile handoff, +research feeds an item-by-item dossier", async () => {
    const start = startOf(basketRound, basketLock);
    const { members, calls } = crew(3, basketCells, start.profile!, () => 0.5);
    let asked = "";
    const retriever: Retriever = async (brief) => {
      asked = brief.request;
      return {
        report: "- Alpha launch drew 12,000 preorders ([a](https://a.example/p))",
        sources: [{ url: "https://a.example/p" }],
        costUsd: 0.01,
        searches: 1,
        retriever: "fake",
      };
    };
    const f = await composeForecastRound(
      basketRound,
      basketLock,
      [
        { pattern: "ensemble", members },
        { pattern: "tournament", members },
      ],
      start,
      { retriever, pageText: async () => "Alpha launch drew 12,000 preorders" },
    );
    expect(asked).toContain("For EACH item — alpha, beta, gamma");
    expect(f.dossier!.stats!.verified).toBe(1);
    expect(calls.every((c) => c.user.includes("RESEARCH DOSSIER"))).toBe(true);
    expect(calls.slice(3).some((c) => c.user.includes("UPSTREAM FORMATION (ensemble)"))).toBe(true);
    expect(f.upstream!.profile).toBeDefined();
    expect(f.upstream!.profileProposals).toBeDefined();
    expect(f.rounds![0]!.stage).toBe("ensemble/propose");
    const sum = basketCells.reduce((s, c) => s + f.profile![c]!.mean, 0);
    expect(sum).toBeCloseTo(100, 2);
  });
});

describe("research agent on a profile round", () => {
  const retriever: Retriever = async () => ({
    report: "- Gamma recall covered 40,000 units ([g](https://g.example/p))",
    sources: [{ url: "https://g.example/p" }],
    costUsd: 0.02,
    searches: 2,
    retriever: "fake",
  });
  const judge = (grounded: (draft: string) => number): DecisionProvider => ({
    kind: "fake",
    model: "fake-jev",
    ask: async (req) => {
      const text = JSON.stringify(req);
      return {
        answers: {
          quality: { type: "score", score: 2, confidence: 0.9 },
          grounded: { type: "noul", noul: grounded(text) },
        },
        model: "fake-jev",
        provider: "fake",
        latencyMs: 1,
      };
    },
  });

  it("one reply per analyst for the whole profile, judge-weighted per cell, shares closed", async () => {
    const start = startOf(basketRound, basketLock);
    const b = start.profile!;
    const calls: string[] = [];
    const analyst =
      (moves: Record<string, number>, tag: string) => async (_s: string, u: string) => {
        calls.push(u);
        const profile = Object.fromEntries(
          Object.entries(moves).map(([c, m]) => [c, { mean: b[c]!.mean + m, sd: b[c]!.sd }]),
        );
        return JSON.stringify({ profile, evidence: tag, reason: "recall" });
      };
    const f = await researchForecastRound(basketRound, basketLock, {
      retriever,
      analysts: [
        {
          name: "a",
          complete: analyst({ trends_share_alpha: 1, trends_share_gamma: -1 }, "EVIDENCE-OK"),
        },
        // b answers only two cells, and the judge finds it ungrounded.
        {
          name: "b",
          complete: analyst({ trends_share_alpha: 1, trends_share_beta: 0 }, "EVIDENCE-BAD"),
        },
      ],
      judge: judge((d) => (d.includes("EVIDENCE-OK") ? 1 : 0)),
      trustCap: 0.5,
      pageText: async () => "Gamma recall covered 40,000 units",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("trends_share_gamma:");
    expect(calls[0]).toContain("add to 100");
    expect(f.fallback).toBeUndefined();
    expect(f.profileProposals!.a!.weight).toBeGreaterThan(0);
    expect(f.profileProposals!.b!.weight).toBe(0);
    const cells = f.protocol!.cells as Record<string, { n: number; trust: number }>;
    expect(cells.trends_share_alpha!.n).toBe(2);
    expect(cells.trends_share_gamma!.n).toBe(1);
    const sum = basketCells.reduce((s, c) => s + f.profile![c]!.mean, 0);
    expect(sum).toBeCloseTo(100, 2);
    expect(f.dossier!.verification!.verified).toBe(1);
    expect(f.judge!.calls).toBe(2);
  });

  it("no usable proposal keeps the start profile; numeric no-anchor stays numeric-only", async () => {
    const { round, lock } = subgroupRound(3);
    const start = startOf(round, lock);
    const f = await researchForecastRound(round, lock, {
      retriever,
      analysts: [{ name: "a", complete: async () => '{"profile": {}}' }],
    });
    expect(f.fallback).toBe("no usable proposal");
    expect(f.profile).toEqual(start.profile);
    expect(f.roles!.a).toBe("invalid reply (no valid cell)");
  });

  it("briefs a profile round item by item, since its newest cell value", () => {
    const brief = buildResearchBrief(basketRound, basketLock);
    const last = basketLock.answer_history_by_cell!.trends_share_alpha!.at(-1)!.date;
    expect(brief.since).toBe(last);
    expect(brief.request).toContain("item by item (3 items)");
    expect(brief.request).toContain("Scheduled or likely events");
    expect(brief.queries).toContain("alpha news this week");
    const nowcast = buildResearchBrief(basketRound, basketLock, {
      cellNowcasts: { trends_share_beta: { date: "2099-01-01", value: 31 } },
    });
    expect(nowcast.since).toBe("2099-01-01");
    const { round, lock } = subgroupRound(3);
    expect(buildResearchBrief(round, lock).request).toContain("For EACH subgroup");
  });
});

describe("shadow scoring of profile rounds", () => {
  it("scores a recorded profile on the energy score, next to the baseline", async () => {
    const { round, lock } = subgroupRound(3);
    const base = startOf(round, lock).profile!;
    const outcome = Object.fromEntries(round.cells!.map((c) => [c, base[c]!.mean + 1]));
    const { profileEnergy } = await import("../src/arena/score-shapes");
    const persistence = profileEnergy(
      Object.fromEntries(round.cells!.map((c) => [c, { mean: base[c]!.mean, sd: 1.5 }])),
      outcome,
      round.cells!,
    );
    const files: Record<string, unknown> = {
      "questions/season0.json": { rounds: [round] },
      [`locks/${round.round_id}.json`]: lock,
      "resolutions/resolved.json": {},
      "site/data.json": {
        rounds: [
          {
            round_id: round.round_id,
            status: "resolved",
            target_type: "profile_energy",
            resolution: { outcome },
            scores: { persistence: { energy: persistence } },
          },
        ],
      },
    };
    const data = new ArenaData("https://example.test", async (url) => {
      const path = url.replace("https://example.test/", "");
      return path in files ? Response.json(files[path]) : new Response("", { status: 404 });
    });
    const moved = Object.fromEntries(
      round.cells!.map((c) => [c, { mean: base[c]!.mean + 1, sd: base[c]!.sd }]),
    );
    const scores = await scoreShadow(data, [
      {
        round_id: round.round_id,
        forecaster: "research:x",
        forecast: JSON.stringify({ profile: moved }),
        cost_usd: 0.1,
        created_at: Date.parse(round.lock_at) - 60_000,
      },
    ]);
    expect(scores).toHaveLength(1);
    expect(scores[0]!.shape).toBe("profile_energy");
    expect(scores[0]!.skill).toBeGreaterThan(scores[0]!.baselineSkill);
    expect(scores[0]!.costUsd).toBe(0.1);
  });
});
