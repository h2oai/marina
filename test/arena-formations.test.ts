// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { parseForecasterSpec } from "../src/arena/config";
import { ArenaData } from "../src/arena/data";
import { evaluateResolved } from "../src/arena/evaluate";
import { forecastRound } from "../src/arena/forecast";
import {
  agreement,
  composeForecastRound,
  type FormationMember,
  formationForecastRound,
  formationPattern,
  MAX_FINAL_SD_MOVE,
  median,
  runCheck,
  settle,
} from "../src/arena/formations";
import type { Retriever } from "../src/arena/research/retrieve";
import type { ArenaLock, ArenaPoint, ArenaRound } from "../src/arena/types";

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

interface Call {
  member: string;
  system: string;
  user: string;
}

/** Members whose replies are a pure function of (member, system, user); every call is logged. */
function crew(
  n: number,
  answer: (i: number, system: string, user: string) => unknown,
): { members: FormationMember[]; calls: Call[] } {
  const calls: Call[] = [];
  const members = Array.from({ length: n }, (_, i) => ({
    name: `m${i}`,
    complete: async (system: string, user: string) => {
      calls.push({ member: `m${i}`, system, user });
      const a = answer(i, system, user);
      if (a instanceof Error) throw a;
      return typeof a === "string" ? a : JSON.stringify(a);
    },
  }));
  return { members, calls };
}

const at = (move: number, sd = base.sd) => ({ mean: base.mean + move, sd, reason: "r" });

describe("formation aggregation primitives", () => {
  it("median, agreement and settle shrink toward the start and cap the move", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(agreement(base, [at(1)])).toBe(1);
    expect(agreement(base, [at(1), at(1)])).toBe(1);
    expect(agreement(base, [at(-base.sd), at(base.sd)])).toBeCloseTo(0.5, 6);
    const capped = settle(base, 100, base.sd, 1);
    expect(capped.mean).toBeCloseTo(base.mean + MAX_FINAL_SD_MOVE * base.sd, 2);
    // The sd never drops below half the start sd.
    expect(settle(base, 0, 0.001, 1).sd).toBeCloseTo(base.sd * 0.5, 2);
  });

  it("parses formation specs and aliases, and rejects unknown patterns", () => {
    expect(formationPattern("cascade")).toBe("pipeline");
    expect(formationPattern("Debate")).toBe("debate");
    expect(formationPattern("constructor")).toBeUndefined();
    expect(
      parseForecasterSpec(
        "formation:deliberation:openrouter/openai/gpt-6-luna,openrouter/deepseek/deepseek-v4-flash,openrouter/z-ai/glm-5.3-flash",
      ),
    ).toContain("deliberation");
    expect(parseForecasterSpec("formation:pipeline:openrouter/openai/gpt-6-luna")).toContain(
      "pipeline",
    );
    expect(() => parseForecasterSpec("formation:swarm:openrouter/openai/gpt-6-luna")).toThrow();
    expect(parseForecasterSpec("formation:ensemble:a/b,c/d,e/f,g/h,i/j,k/l")).toContain("k/l");
    expect(() =>
      parseForecasterSpec(
        "formation:ensemble:v0/m,v1/m,v2/m,v3/m,v4/m,v5/m,v6/m,v7/m,v8/m,v9/m,v10/m,v11/m,v12/m",
      ),
    ).toThrow();
  });
});

describe("formation protocols", () => {
  it("ensemble: median move at half trust when proposals agree; a blowup drops out", async () => {
    const { members, calls } = crew(3, (i) => (i === 2 ? at(50 * base.sd) : at(2)));
    const f = await formationForecastRound("ensemble", round, lock, members);
    expect(calls).toHaveLength(3);
    expect(f.topline!.mean).toBeCloseTo(base.mean + 0.5 * 2, 2);
    expect(f.agreement).toBe(1);
    expect(Object.keys(f.proposals!)).toEqual(["1:m0", "2:m1"]);
    expect(f.rounds!.find((s) => s.member === "m2")!.status).toContain("dropped");
  });

  it("ensemble: disagreement shrinks the move toward the start", async () => {
    const moves = [-2 * base.sd, 0.5, 2 * base.sd];
    const { members } = crew(3, (i) => at(moves[i]!));
    const f = await formationForecastRound("ensemble", round, lock, members);
    expect(f.agreement!).toBeLessThan(0.5);
    expect(Math.abs(f.topline!.mean - base.mean)).toBeLessThan(0.5 * 0.5);
  });

  it("deliberation: revisions see anonymized peers and replace first proposals", async () => {
    const { members, calls } = crew(3, (i, system) =>
      system.includes("deliberating") ? at(1) : at(i === 0 ? 3 : -1),
    );
    const f = await formationForecastRound("deliberation", round, lock, members);
    const revise = calls.filter((c) => c.system.includes("deliberating"));
    expect(revise).toHaveLength(3);
    expect(revise[0]!.user).toContain("Peer B");
    expect(revise.every((c) => !/m[0-2]/.test(c.user))).toBe(true);
    expect(f.topline!.mean).toBeCloseTo(base.mean + 0.5, 2);
    expect(f.rounds!.map((s) => s.stage)).toEqual([
      "propose",
      "propose",
      "propose",
      "revise",
      "revise",
      "revise",
    ]);
  });

  it("debate: sealed advocates, the last model judges; an inconsistent ruling files the start", async () => {
    const ruling = { direction: "up", mean: base.mean + 2, sd: base.sd, trust: 0.4 };
    const { members, calls } = crew(3, (_i, system) => {
      if (system.includes("judge")) return ruling;
      return system.includes("ABOVE")
        ? { ...at(3), argument: "up!" }
        : { ...at(-1), argument: "flat" };
    });
    const f = await formationForecastRound("debate", round, lock, members);
    expect(calls.map((c) => c.member)).toEqual(["m0", "m1", "m2"]);
    const advocates = calls.slice(0, 2);
    // Sealed: neither advocate sees the other's argument.
    expect(advocates.every((c) => !c.user.includes("up!") && !c.user.includes("flat"))).toBe(true);
    expect(calls[2]!.user).toContain("up!");
    expect(f.topline!.mean).toBeCloseTo(base.mean + 0.4 * 2, 2);
    expect(f.trust).toBe(0.4);

    ruling.direction = "down"; // says down but its mean is above the start
    const again = await formationForecastRound(
      "debate",
      round,
      lock,
      crew(3, (_i, s) => (s.includes("judge") ? ruling : at(1))).members,
    );
    expect(again.topline!.mean).toBeCloseTo(base.mean, 3);
    expect(again.trust).toBe(0);
  });

  it("chorus: each member critiques the next and revises from the critique it received", async () => {
    const { members, calls } = crew(3, (i, system) => {
      if (system.includes("Critique ONE")) return { critique: `from m${i}`, suggested_mean: 0 };
      if (system.includes("critiqued your")) return at(1);
      return at(i);
    });
    const f = await formationForecastRound("chorus", round, lock, members);
    expect(calls).toHaveLength(9);
    const reviews = calls.filter((c) => c.system.includes("Critique ONE"));
    expect(reviews[0]!.user).toContain("Review Peer B");
    expect(reviews[2]!.user).toContain("Review Peer A");
    const revisions = calls.filter((c) => c.system.includes("critiqued your"));
    // m1 is revised with m0's critique; m0 with m2's.
    expect(revisions.find((c) => c.member === "m1")!.user).toContain("from m0");
    expect(revisions.find((c) => c.member === "m0")!.user).toContain("from m2");
    expect(f.topline!.mean).toBeCloseTo(base.mean + 0.5, 2);
  });

  it("pipeline: strictly sequential stages; the analyst refines the quant; the skeptic sets trust", async () => {
    const { members, calls } = crew(3, (i) =>
      i === 0 ? at(2) : i === 1 ? at(1) : { trust: 0.8, sd_scale: 1, critique: "fine" },
    );
    const f = await formationForecastRound("pipeline", round, lock, members);
    expect(calls.map((c) => c.member)).toEqual(["m0", "m1", "m2"]);
    expect(calls[1]!.user).toContain("Quant handoff");
    expect(calls[2]!.user).toContain("Analyst handoff");
    expect(f.topline!.mean).toBeCloseTo(base.mean + 0.8 * 1, 2);
    expect(f.critique).toBe("fine");

    // The quant failing still leaves the analyst's stage; a broken skeptic trusts half-way.
    const partial = crew(3, (i) => (i === 0 ? new Error("down") : i === 1 ? at(2) : "nope"));
    const g = await formationForecastRound("pipeline", round, lock, partial.members);
    expect(g.topline!.mean).toBeCloseTo(base.mean + 0.5 * 2, 2);
    expect(g.rounds![0]!.status).toContain("error");
  });

  it("mapreduce: one driver per model; the reduce sums confidence-shrunk adjustments", async () => {
    const { members, calls } = crew(3, (i) => ({
      adjustment: [1, -0.4, 0][i],
      confidence: [1, 0.5, 0.9][i],
      sd: base.sd,
    }));
    const f = await formationForecastRound("mapreduce", round, lock, members);
    expect(
      calls.map((c) => c.system.match(/(LEVEL AND TREND|CALENDAR|SOURCE QUIRKS)/)![1]),
    ).toEqual(["LEVEL AND TREND", "CALENDAR", "SOURCE QUIRKS"]);
    expect(f.topline!.mean).toBeCloseTo(base.mean + 0.5 * 1 - 0.25 * 0.4, 2);
    expect(Object.keys(f.proposals!)).toHaveLength(3);

    const big = crew(1, () => ({ adjustment: 3 * base.sd, confidence: 1, sd: base.sd }));
    const g = await formationForecastRound("mapreduce", round, lock, big.members);
    // Three drivers × 0.5 × 3 sd = 4.5 sd, capped at the final cap.
    expect(g.topline!.mean).toBeCloseTo(base.mean + MAX_FINAL_SD_MOVE * base.sd, 2);
  });

  it("blackboard: two passes; later posts see earlier entries; latest proposals aggregate", async () => {
    const { members, calls } = crew(2, (i) => ({
      evidence: `fact ${i}`,
      corrects: null,
      ...at(1),
    }));
    const f = await formationForecastRound("blackboard", round, lock, members);
    expect(calls).toHaveLength(4);
    expect(calls[0]!.user).toContain("(empty)");
    expect(calls[1]!.user).toContain("#1 (Peer A, pass 1) fact 0");
    expect(calls[3]!.user).toContain("#3 (Peer A, pass 2)");
    expect(f.rounds!.map((s) => s.stage)).toEqual(["pass1", "pass1", "pass2", "pass2"]);
    expect(f.topline!.mean).toBeCloseTo(base.mean + 0.5 * 1, 2);
  });

  it("files the start with no model call for a non-numeric round, and on total failure", async () => {
    const { members, calls } = crew(3, () => at(1));
    const profile = await formationForecastRound(
      "chorus",
      { ...round, target_type: "profile_energy", cells: ["a", "b"] },
      lock,
      members,
      forecastRound(round, lock),
    );
    expect(calls).toHaveLength(0);
    expect(profile.fallback).toContain("numeric");
    const failed = await formationForecastRound(
      "ensemble",
      round,
      lock,
      crew(3, () => new Error("x")).members,
    );
    expect(failed.topline).toEqual(base);
    expect(failed.fallback).toBe("no usable proposal");
  });

  it("starts from the nowcast when given one and says so", async () => {
    const start = {
      ...forecastRound(round, lock),
      topline: { mean: base.mean - 1, sd: base.sd },
      nowcast: { yougov_net_approval: { date: "2026-07-30", value: base.mean - 1 } },
    };
    const { members, calls } = crew(3, () => ({ mean: base.mean - 1, sd: base.sd }));
    const f = await formationForecastRound("ensemble", round, lock, members, start);
    expect(f.topline!.mean).toBeCloseTo(base.mean - 1, 3);
    expect(f.note).toContain("over the nowcast (2026-07-30)");
    expect(calls.every((c) => c.user.includes("the NOWCAST"))).toBe(true);
  });

  it("evaluate keeps the formation's per-round record", async () => {
    const files: Record<string, unknown> = {
      "questions/season0.json": { rounds: [round] },
      [`locks/${round.round_id}.json`]: lock,
      "resolutions/resolved.json": { [round.round_id]: { value: 43 } },
    };
    const data = new ArenaData("https://example.test", async (url) => {
      const path = url.replace("https://example.test/", "");
      return path in files ? Response.json(files[path]) : new Response("", { status: 404 });
    });
    const { members } = crew(3, () => at(1));
    const report = await evaluateResolved(data, {
      f: async (r, l) => ({
        ...(await formationForecastRound("deliberation", r, l, members)),
        costUsd: 0.01,
      }),
    });
    const detail = report.rounds[0]!.results.f!.detail!;
    expect(detail.formation).toBe("deliberation");
    expect((detail.rounds as unknown[]).length).toBe(6);
    expect(detail.costUsd).toBe(0.01);
  });

  it("symbiosis: complementary inputs, credited exchanges, disagreement triggers another round", async () => {
    let exchanges = 0;
    const { members, calls } = crew(2, (i, system) => {
      if (system.includes("CREDIT")) {
        exchanges++;
        // First exchange still apart (quant +3, analyst 0); second converges.
        const move = exchanges <= 2 ? (i === 0 ? 3 : 0) : 1;
        return { credit: "used the daily readings", contribution: "none", ...at(move) };
      }
      return { contribution: i === 0 ? "daily up 2" : "house effect +1", ...at(i === 0 ? 3 : 0) };
    });
    const f = await formationForecastRound("symbiosis", round, lock, members);
    // The quant reads the full numbers, the analyst only the recent values.
    expect(calls[0]!.user).toContain(historyBlockMarker(30));
    expect(calls[1]!.user).not.toContain(history[5]!.date);
    const firstExchange = calls.filter((c) => c.system.includes("CREDIT")).slice(0, 2);
    expect(firstExchange[0]!.user).toContain("house effect +1");
    expect(firstExchange[1]!.user).toContain("daily up 2");
    expect(calls).toHaveLength(6); // open ×2, exchange ×2 (gap 3 sd-ish ⇒ again) ×2
    expect(f.critique).toContain("exchange");
    expect(f.topline!.mean).toBeCloseTo(base.mean + 0.5, 2);
  });

  it("symbiosis with more models: independent pairs, one proposal per pair, median across pairs", async () => {
    // Six members = three pairs. Pair 1 and 2 converge near +1; pair 3 goes wild (+3.5 sd).
    const { members, calls } = crew(6, (i, system) => {
      const pairIndex = Math.floor(i / 2);
      const move = pairIndex === 2 ? 3.5 * base.sd : 1;
      return system.includes("CREDIT")
        ? { credit: "used it", contribution: "none", ...at(move) }
        : { contribution: "x", ...at(move) };
    });
    const f = await formationForecastRound("symbiosis", round, lock, members);
    // Every member opened (6) and exchanged at least once (6).
    expect(calls.length).toBeGreaterThanOrEqual(12);
    expect(Object.keys(f.proposals!).sort()).toEqual(["pair1", "pair2", "pair3"]);
    expect(f.critique).toContain("pair3:");
    // The median across pairs ignores the one wild pair.
    expect(f.topline!.mean).toBeLessThan(base.mean + 1.01);
    expect(f.topline!.mean).toBeGreaterThan(base.mean);
  });

  it("symbiosis: a revision that does not credit the partner is not taken", async () => {
    const { members } = crew(2, (_i, system) =>
      system.includes("CREDIT") ? { credit: "", ...at(2 * base.sd) } : at(0),
    );
    const f = await formationForecastRound("symbiosis", round, lock, members);
    expect(f.topline!.mean).toBeCloseTo(base.mean, 3);
    expect(f.rounds!.some((s) => s.status.includes("no credit"))).toBe(true);
  });

  it("research: checks are computed here and fed back; revert keeps the prior forecast", async () => {
    expect(runCheck("recent_mean", 3, "history", history, undefined)).toContain(
      "mean of the last 3",
    );
    expect(runCheck("deltas", 3, "history", weekly([1, 2, 4]), undefined)).toContain("+1, +2");
    expect(runCheck("trend", 3, "history", weekly([1, 2, 3]), undefined)).toContain("slope");
    expect(runCheck("trend", 3, "history", weekly([1, 2, 3]), undefined)).toContain(" 1 per step");
    expect(runCheck("nonsense", 3, "history", history, undefined)).toContain("unknown check");
    const { members, calls } = crew(1, (_i, _s, user) => {
      const gen = (user.match(/Gen \d/g) ?? []).length;
      return {
        hypothesis: "flat",
        check: { name: "deltas", k: 4, series: "history" },
        decision: gen === 2 ? "revert" : "keep",
        ...at(gen === 0 ? 1 : gen === 1 ? 1.5 : 3),
      };
    });
    const f = await formationForecastRound("research", round, lock, members);
    expect(calls).toHaveLength(3);
    expect(calls[1]!.user).toContain("LAB NOTEBOOK");
    expect(calls[1]!.user).toContain("result=last 3 history changes");
    // Iteration 3 reverted its +3 back to iteration 2's +1.5.
    expect(f.topline!.mean).toBeCloseTo(base.mean + 0.5 * 1.5, 2);
  });

  it("composition: one verified dossier per round to every member; a second formation judges", async () => {
    let searches = 0;
    const retriever: Retriever = async () => {
      searches++;
      return {
        report:
          "- Echelon: 38% approve ([e](https://e.example/p))\n- Fake: 99% approve ([f](https://f.example/p))",
        sources: [{ url: "https://e.example/p" }, { url: "https://f.example/p" }],
        costUsd: 0.02,
        searches: 1,
        retriever: "test",
      };
    };
    const pages: Record<string, string> = {
      "https://e.example/p": "38% approve",
      "https://f.example/p": "nothing here",
    };
    const { members, calls } = crew(3, (_i, system) =>
      system.includes("independent")
        ? at(2)
        : system.includes("judge")
          ? { direction: "up", ...at(1), trust: 1 }
          : at(1),
    );
    const f = await composeForecastRound(
      round,
      lock,
      [
        { pattern: "ensemble", members },
        { pattern: "debate", members },
      ],
      forecastRound(round, lock),
      { retriever, pageText: async (u: string) => pages[u] },
    );
    expect(searches).toBe(1);
    expect(calls).toHaveLength(6);
    expect(calls.every((c) => c.user.includes("Echelon") && !c.user.includes("99%"))).toBe(true);
    // The judging formation sees the upstream handoff; the ensemble does not.
    expect(calls.slice(3).every((c) => c.user.includes("UPSTREAM FORMATION (ensemble)"))).toBe(
      true,
    );
    expect(calls.slice(0, 3).some((c) => c.user.includes("UPSTREAM"))).toBe(false);
    expect(f.upstream!.topline!.mean).toBeCloseTo(base.mean + 1, 2);
    expect(f.topline!.mean).toBeCloseTo(base.mean + 1, 2);
    expect(f.dossier!.stats!.verified).toBe(1);
    expect(f.rounds![0]!.stage).toBe("ensemble/propose");
  });

  it("parses compositions; a research crew is shadow-only and cannot be backtested", () => {
    const M = "openrouter/openai/gpt-6-luna,openrouter/deepseek/deepseek-v4-flash";
    expect(parseForecasterSpec(`formation:mapreduce:${M}+then:debate:${M}`)).toContain("+then:");
    expect(
      parseForecasterSpec(
        `formation:symbiosis:${M}+research@tavily:advanced,sonar:perplexity/sonar-pro`,
      ),
    ).toContain("+research@");
    expect(
      parseForecasterSpec(`formation:research:${M}+then:pipeline:${M}+research@tavily:basic`),
    ).toContain("research");
    expect(() => parseForecasterSpec(`formation:ensemble:${M}+research@google:x`)).toThrow();
    expect(() => parseForecasterSpec(`formation:ensemble:${M}+then:swarm:${M}`)).toThrow();
  });
});

function historyBlockMarker(n: number): string {
  return history.at(-n)!.date;
}
