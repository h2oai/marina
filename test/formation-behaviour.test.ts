// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What the catalogue formations must DO, asserted as properties rather than
 * frozen bytes: the order of their steps, the combiners' math, robustness to
 * failed and junk replies, and determinism given the same replies. Prompts and
 * answers may change; a change that should help is measured (benchmarks,
 * outcomes), not pinned. Per-protocol examples live in
 * `test/forecast-formations.test.ts`, `test/patterns-run.test.ts` and
 * `test/arena-formations.test.ts`; the catalogue's structure in
 * `test/formation-catalogue.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import {
  FORMATION_PATTERNS,
  type FormationMember,
  formationForecastRound,
} from "../src/arena/formations";
import type { ArenaLock, ArenaRound } from "../src/arena/types";
import type { AnswerSpec } from "../src/forecast/answer-types";
import { forecastFormed, TYPED_FORMATIONS, type TypedFormation } from "../src/forecast/formations";
import type { ChosenPrior } from "../src/forecast/prior";
import type { ModelPart, TypedForecastDeps, TypedForecastRequest } from "../src/forecast/typed";
import { FORMATIONS } from "../src/orchestration/formations/catalogue";
import {
  MAX_FINAL_SD_MOVE,
  MAX_PROPOSAL_SD_MOVE,
} from "../src/orchestration/formations/combine-numeric";
import {
  championAnswer,
  combineDelphi,
  combineSkeptic,
  matchWinner,
  SKEPTIC_MAX_SD_MOVE,
  skepticProposals,
  skepticTrust,
} from "../src/orchestration/formations/combine-typed";
import stored from "./fixtures/formations/arena-rounds.json";

/** FNV-1a: a reply is a pure function of who is asked what. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// ─── Typed formations ────────────────────────────────────────────────────────

const SPECS: Record<string, AnswerSpec> = {
  binary: { type: "choice", options: [{ id: "Yes" }, { id: "No" }], probabilities: true },
  choice: { type: "choice", options: [{ id: "A", label: "Alpha" }, { id: "B" }, { id: "C" }] },
  multi: {
    type: "multi",
    options: [{ id: "w" }, { id: "x" }, { id: "y" }, { id: "z" }],
    minPicks: 1,
    probabilities: true,
  },
  number: { type: "number", unit: "points" },
  integer: { type: "number", integer: true },
  ranking: { type: "ranking", size: 3, candidates: ["p", "q", "r", "s"] },
  text: { type: "text", maxLength: 40 },
};

function answerFor(spec: AnswerSpec, h: number): Record<string, unknown> {
  const reason = `reason ${h % 97}`;
  const confidence = ((h >>> 5) % 80) / 100 + 0.1;
  switch (spec.type) {
    case "choice": {
      const raw = spec.options.map((_, i) => ((h >>> (i * 3)) % 9) + 1);
      const sum = raw.reduce((a, b) => a + b, 0);
      const probabilities = Object.fromEntries(spec.options.map((o, i) => [o.id, raw[i]! / sum]));
      const top = spec.options[raw.indexOf(Math.max(...raw))]!.id;
      return { answer: top, confidence, probabilities, reason };
    }
    case "multi": {
      const probabilities = Object.fromEntries(
        spec.options.map((o, i) => [o.id, (((h >>> (i * 4)) % 90) + 5) / 100]),
      );
      const picks = spec.options.filter((o) => probabilities[o.id]! > 0.5).map((o) => o.id);
      return {
        answer: picks.length ? picks : [spec.options[0]!.id],
        confidence,
        probabilities,
        reason,
      };
    }
    case "number":
      return { answer: 100 + (h % 41) - 20, sd: 1 + (h % 5), confidence, reason };
    case "ranking": {
      const c = [...(spec.candidates ?? [])];
      const out: string[] = [];
      let x = h;
      while (c.length && out.length < (spec.size ?? 3)) {
        out.push(c.splice(x % c.length, 1)[0]!);
        x = Math.floor(x / 7) + 3;
      }
      return { answer: out, confidence, reason };
    }
    case "text":
      return { answer: `answer-${h % 3}`, confidence, reason };
  }
}

interface Call {
  part: string;
  system: string;
  user: string;
}

/** Parts whose replies are a pure function of (seed, part, system, user); every call logged. */
function world(seed: number, spec: AnswerSpec, analysts: number, failRate: number) {
  const calls: Call[] = [];
  const part = (name: string, reply: (h: number, system: string) => string): ModelPart => ({
    name,
    complete: async (system: string, user: string) => {
      calls.push({ part: name, system, user });
      const h = hash(`${seed}|${name}|${system}|${user}`);
      if (failRate && h % failRate === 0) throw new Error(`${name} unavailable`);
      if (failRate && h % failRate === 1) return "I cannot answer that.";
      return reply(h, system);
    },
  });
  const judge = part("critic", (h, system) => {
    if (system.startsWith("You plan research")) return '{"restatement":"Q","queries":["q1"]}';
    if (system.startsWith("You review a research dossier")) return '{"done":true}';
    if (system.startsWith("You referee"))
      return JSON.stringify({ winner: ["A", "B"][h % 2], reason: `ruling ${h % 31}` });
    if (system.startsWith("You are the skeptic"))
      return JSON.stringify({ trust: (h % 101) / 100, sd_scale: 1.5, critique: "c" });
    if (system.startsWith("You verify")) return '{"verdict":"ok"}';
    if (system.startsWith("You are the forecaster's critic"))
      return JSON.stringify({ verdict: "keep", reason: "holds" });
    return JSON.stringify(answerFor(spec, h));
  });
  const members = Array.from({ length: analysts }, (_, i) =>
    part(`vendor${i}/model-${i}`, (h) => JSON.stringify(answerFor(spec, h))),
  );
  return { calls, judge, members };
}

function depsFor(w: ReturnType<typeof world>, runs: number): TypedForecastDeps {
  return {
    retriever: async () => ({
      report: "- 2026-09-20 — a fact ([src](https://example.org/1))",
      sources: [{ url: "https://example.org/1" }],
      costUsd: 0,
      searches: 1,
      retriever: "fake",
    }),
    analysts: w.members,
    planner: w.judge,
    critic: w.judge,
    now: () => new Date("2026-10-05T00:00:00Z"),
    options: { runs, researchRounds: 1 },
  };
}

/** The answer as JSON with wall-clock timings zeroed (they measure the test machine). */
function stable(answer: unknown): string {
  return JSON.stringify(answer, (k, v) =>
    k === "latencyMs" || k === "usedMs" || k === "ms" ? 0 : v,
  );
}

async function formed(
  pattern: TypedFormation,
  specName: string,
  seed: number,
  analysts: number,
  failRate: number,
) {
  const spec = SPECS[specName]!;
  const w = world(seed, spec, analysts, failRate);
  const req = { question: `Q${seed}: what happens?`, answer: spec } as TypedForecastRequest;
  const answer = await forecastFormed(req, depsFor(w, analysts), pattern);
  return { answer, calls: w.calls, members: w.members.map((m) => m.name) };
}

const isAnalyst = (c: Call) => c.part.startsWith("vendor");

describe("typed formations: properties over every answer type", () => {
  for (const pattern of TYPED_FORMATIONS) {
    it(`${pattern}: deterministic, well-formed, research before any analyst`, async () => {
      for (const specName of Object.keys(SPECS))
        for (const seed of [1, 2, 3])
          for (const failRate of [0, 5]) {
            const where = `${pattern}/${specName} seed ${seed} fail ${failRate}`;
            const a = await formed(pattern, specName, seed, 3, failRate);
            const b = await formed(pattern, specName, seed, 3, failRate);
            // The same replies give the same answer and the same calls.
            expect(stable(b.answer), where).toBe(stable(a.answer));
            expect(b.calls, where).toEqual(a.calls);
            expect(a.answer.formation.pattern, where).toBe(pattern);
            // The research round runs before the first analyst is asked.
            const firstAnalyst = a.calls.findIndex(isAnalyst);
            const plan = a.calls.findIndex((c) => c.system.startsWith("You plan research"));
            expect(plan, where).toBeGreaterThanOrEqual(0);
            if (firstAnalyst >= 0) expect(plan, where).toBeLessThan(firstAnalyst);
            if (failRate === 0) expect(typeof a.answer.formatted, where).toBe("string");
            // A choice's probabilities stay a distribution.
            const d = a.answer.distribution;
            if (d && SPECS[specName]!.type === "choice") {
              const sum = Object.values(d).reduce((x, y) => x + y, 0);
              expect(sum, where).toBeCloseTo(1, 3); // filed probabilities are rounded
            }
            if (d) for (const p of Object.values(d)) expect(p >= 0 && p <= 1, where).toBe(true);
          }
    });
  }

  it("delphi: every member answers, then revises after ALL first answers, never seeing names", async () => {
    for (const seed of [1, 2, 3]) {
      const r = await formed("delphi", "binary", seed, 3, 0);
      const asked = r.calls.filter(isAnalyst);
      const first = asked.filter((c) => !c.system.includes("Delphi"));
      const revise = asked.filter((c) => c.system.includes("Delphi"));
      expect(first.map((c) => c.part).sort()).toEqual([...r.members].sort());
      expect(revise.map((c) => c.part).sort()).toEqual([...r.members].sort());
      const lastFirst = r.calls.lastIndexOf(first.at(-1)!);
      const firstRevise = r.calls.indexOf(revise[0]!);
      expect(lastFirst).toBeLessThan(firstRevise);
      for (const c of revise)
        for (const name of r.members) expect(c.user.includes(name), name).toBe(false);
      expect(r.answer.formation.revisions).toHaveLength(3);
    }
  });

  it("tournament: n entrants play n − 1 refereed matches after every entrant answered", async () => {
    for (const n of [2, 3, 4, 5])
      for (const seed of [1, 2]) {
        const r = await formed("tournament", "number", seed, n, 0);
        const refereed = r.calls.filter((c) => c.system.startsWith("You referee"));
        expect(refereed, `n=${n}`).toHaveLength(n - 1);
        expect(r.answer.formation.matches, `n=${n}`).toHaveLength(n - 1);
        const lastEntrant = r.calls.findLastIndex(isAnalyst);
        expect(r.calls.indexOf(refereed[0]!)).toBeGreaterThan(lastEntrant);
        expect(r.answer.formation.champion).toBeDefined();
      }
  });

  it("skeptic: one skeptic call after the proposals; its trust is recorded in [0, 1]", async () => {
    for (const seed of [1, 2, 3]) {
      const r = await formed("skeptic", "number", seed, 2, 0);
      const skeptic = r.calls.filter((c) => c.system.startsWith("You are the skeptic"));
      expect(skeptic).toHaveLength(1);
      expect(r.calls.indexOf(skeptic[0]!)).toBeGreaterThan(r.calls.findLastIndex(isAnalyst));
      const trust = r.answer.formation.crew?.trust;
      expect(trust !== undefined && trust >= 0 && trust <= 1).toBe(true);
    }
  });

  it("ensemble: the critic reads the combined runs, after every analyst", async () => {
    const r = await formed("ensemble", "binary", 1, 3, 0);
    const critic = r.calls.findIndex((c) => c.system.startsWith("You are the forecaster's critic"));
    expect(critic).toBeGreaterThan(r.calls.findLastIndex(isAnalyst));
    expect(r.answer.critique).toBeDefined();
  });
});

// ─── Typed combiners ─────────────────────────────────────────────────────────

describe("typed combiners", () => {
  const yesNo = SPECS.binary as Extract<AnswerSpec, { type: "choice" }>;
  const num = SPECS.number as Extract<AnswerSpec, { type: "number" }>;

  it("delphi: per-option medians of the revisions, renormalised; the top option is the answer", () => {
    const out = combineDelphi(yesNo, [
      { value: "Yes", distribution: { Yes: 0.9, No: 0.1 } },
      { value: "No", distribution: { Yes: 0.3, No: 0.7 } },
      { value: "Yes", distribution: { Yes: 0.6, No: 0.4 } },
    ]);
    expect(out.distribution!.Yes).toBeCloseTo(0.6, 9);
    expect(out.distribution!.No).toBeCloseTo(0.4, 9);
    expect(out.prediction).toBe("Yes");
    expect(out.confidence).toBeCloseTo(0.6, 9);
  });

  it("delphi: a number takes the revisions' combined value and a positive sd", () => {
    const out = combineDelphi(num, [
      { value: 10, sd: 1 },
      { value: 12, sd: 2 },
      { value: 14, sd: 1 },
    ]);
    expect(out.prediction).toBe(12);
    expect(out.uncertainty!.sd).toBeGreaterThan(0);
  });

  it("tournament: B wins only when the referee says B; the champion's own numbers are filed", () => {
    expect(matchWinner({ winner: " b " }).winner).toBe("b");
    for (const w of ["A", "neither", "", undefined])
      expect(matchWinner(w === undefined ? undefined : { winner: w }).winner).toBe("a");
    const c = championAnswer(
      yesNo,
      { value: "No", formatted: "No", distribution: { Yes: 0.25, No: 0.75 } },
      undefined,
    );
    expect(c.head.prediction).toBe("No");
    expect(c.tail.confidence).toBe(0.75);
    expect(championAnswer(num, { value: 3, formatted: "3" }, 2).tail.uncertainty).toEqual({
      sd: 2,
    });
  });

  it("skeptic: trust clamps to [0, 1] (default 0.5); a number's sd scale to [1, 2]", () => {
    expect(skepticTrust(num, undefined)).toEqual({ trust: 0.5, sdScale: 1 });
    expect(skepticTrust(num, { trust: 7, sd_scale: 9 })).toEqual({ trust: 1, sdScale: 2 });
    expect(skepticTrust(num, { trust: -1, sd_scale: 0.1 })).toEqual({ trust: 0, sdScale: 1 });
    expect(skepticTrust(yesNo, { trust: 0.3, sd_scale: 2 })).toEqual({ trust: 0.3, sdScale: 1 });
  });

  const start: ChosenPrior = { source: "market", detail: "m", value: 100, sd: 2 };

  it("skeptic: proposals beyond the blowup bound are dropped", () => {
    const edge = 100 + SKEPTIC_MAX_SD_MOVE * 2;
    const kept = skepticProposals(
      num,
      [{ value: 101 }, { value: edge }, { value: edge + 0.01 }],
      start,
    );
    expect(kept.map((r) => r.value)).toEqual([101, edge]);
    // Without a start sd nothing counts as a blowup.
    expect(skepticProposals(num, [{ value: 1e6 }], undefined)).toHaveLength(1);
  });

  it("skeptic: trust 1 keeps the proposals' mean, trust 0 the start; sd floored and widened", () => {
    const proposals = [
      { value: 104, sd: 0.2 },
      { value: 106, sd: 0.2 },
    ];
    const full = combineSkeptic(num, proposals, start, 1, 1);
    const none = combineSkeptic(num, proposals, start, 0, 1);
    const half = combineSkeptic(num, proposals, start, 0.5, 1);
    if (full.kind !== "number" || none.kind !== "number" || half.kind !== "number")
      throw new Error("number expected");
    expect(full.value).toBeCloseTo(105, 9);
    expect(none.value).toBeCloseTo(100, 9);
    expect(half.value).toBeGreaterThan(100);
    expect(half.value).toBeLessThan(105);
    // Never narrower than half the start sd; `sdScale` widens it.
    expect(full.sd!).toBeGreaterThanOrEqual(0.5 * start.sd! - 1e-12);
    const wide = combineSkeptic(num, proposals, start, 1, 2);
    if (wide.kind !== "number") throw new Error("number expected");
    expect(wide.sd!).toBeCloseTo(2 * full.sd!, 9);
  });

  it("skeptic: a choice shrinks only toward an INFORMATIVE prior", () => {
    const proposals = [{ value: "Yes", distribution: { Yes: 0.9, No: 0.1 } }];
    const uniform: ChosenPrior = {
      source: "type-default",
      detail: "d",
      distribution: { Yes: 0.5, No: 0.5 },
    };
    const market: ChosenPrior = {
      ...uniform,
      source: "market",
      distribution: { Yes: 0.2, No: 0.8 },
    };
    const kept = combineSkeptic(yesNo, proposals, uniform, 0, 1);
    expect(kept.unshrunk).toBe(true);
    if (kept.kind !== "choice") throw new Error("choice expected");
    expect(kept.distribution.Yes).toBeCloseTo(0.9, 6);
    const moved = combineSkeptic(yesNo, proposals, market, 0, 1);
    if (moved.kind !== "choice") throw new Error("choice expected");
    expect(moved.unshrunk).toBeUndefined();
    expect(moved.distribution.Yes).toBeCloseTo(0.2, 6);
    expect(combineSkeptic(yesNo, [{ value: "Yes" }], market, 1, 1).kind).toBe("none");
  });
});

// ─── Arena formations run from the catalogue ────────────────────────────────

const ROUNDS = stored.rounds as Array<{ round: ArenaRound; lock: ArenaLock }>;
const FROM_CATALOGUE = FORMATION_PATTERNS.filter(
  (p) => FORMATIONS[p as keyof typeof FORMATIONS]?.numeric?.runtime === "catalogue",
);

function crew(seed: number, n: number, last: number) {
  const calls: Array<{ member: string; system: string; user: string }> = [];
  const members: FormationMember[] = Array.from({ length: n }, (_, i) => ({
    name: `vendor${i}/model-${i}`,
    complete: async (system: string, user: string) => {
      calls.push({ member: `vendor${i}/model-${i}`, system, user });
      const h = hash(`${seed}|${i}|${system}|${user}`);
      for (let k = 0; k < h % 5; k++) await Promise.resolve();
      if (h % 11 === 0) throw new Error("unavailable");
      const scale = Math.max(0.5, Math.abs(last) * 0.02 + 0.5);
      // Now and then a blowup, far beyond the proposal bound.
      const move = h % 17 === 0 ? 50 * scale : (((h % 21) - 10) / 10) * scale;
      return JSON.stringify({
        mean: Math.round((last + move) * 100) / 100,
        sd: Math.round((0.4 + (h % 9) / 5) * scale * 100) / 100,
        reason: `model-${i} sees ${h % 13}`,
      });
    },
  }));
  return { members, calls };
}

describe("arena formations from the catalogue: properties on the stored rounds", () => {
  it("are ensemble and delphi", () => {
    expect([...FROM_CATALOGUE].sort()).toEqual(["delphi", "ensemble"]);
  });

  for (const pattern of FROM_CATALOGUE) {
    it(`${pattern}: deterministic; the move is capped, blowups excluded, each member asked per round`, async () => {
      let formedRounds = 0;
      for (const { round, lock } of ROUNDS) {
        const last = (lock.answer_history ?? []).at(-1)!.value;
        for (const n of [1, 2, 3, 4])
          for (const seed of [1, 2, 3]) {
            const where = `${round.round_id} n=${n} seed=${seed}`;
            const a = crew(seed, n, last);
            const b = crew(seed, n, last);
            const fa = await formationForecastRound(pattern, round, lock, a.members);
            const fb = await formationForecastRound(pattern, round, lock, b.members);
            expect(JSON.stringify(fb), where).toBe(JSON.stringify(fa));
            expect(b.calls, where).toEqual(a.calls);
            // Each member is asked once per round: once for ensemble, at most twice for delphi.
            for (const m of a.members) {
              const asked = a.calls.filter((c) => c.member === m.name).length;
              if (pattern === "ensemble") expect(asked, where).toBe(1);
              else expect(asked >= 1 && asked <= 2, where).toBe(true);
            }
            const start = fa.formationStart;
            if (!fa.proposals || !start || !fa.topline) continue;
            formedRounds++;
            // The filed mean never moves more than MAX_FINAL_SD_MOVE start sds.
            expect(Math.abs(fa.topline.mean - start.mean), where).toBeLessThanOrEqual(
              MAX_FINAL_SD_MOVE * start.sd + 1e-3,
            );
            expect(fa.topline.sd, where).toBeGreaterThanOrEqual(0.5 * start.sd - 1e-3);
            // A proposal beyond the blowup bound never enters the aggregation.
            for (const p of Object.values(fa.proposals))
              expect(Math.abs(p.mean - start.mean), where).toBeLessThanOrEqual(
                MAX_PROPOSAL_SD_MOVE * start.sd + 1e-9,
              );
          }
      }
      expect(formedRounds).toBeGreaterThan(0);
    });
  }
});
