// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { forecastRound } from "../src/arena/forecast";
import { forecastSettings } from "../src/arena/forecast-config";
import {
  composeForecastRound,
  type FormationMember,
  type FormationPattern,
  median,
} from "../src/arena/formations";
import {
  type ProposalJudgeConfig,
  proposalJudgeFromEnv,
  weightedMedian,
} from "../src/arena/proposal-judge";
import type { ArenaLock, ArenaPoint, ArenaRound } from "../src/arena/types";
import { DecisionError, type DecisionProvider } from "../src/decisions/types";

const weekly = (values: number[]): ArenaPoint[] =>
  values.map((value, i) => ({
    date: new Date(Date.parse("2026-01-02") + i * 7 * 86_400_000).toISOString().slice(0, 10),
    value,
  }));
const round: ArenaRound = {
  round_id: "yougov-2026-w40-approval",
  tracker: "yougov",
  series: "yougov_net_approval",
  question: "Net approval?",
  target_type: "continuous_normal",
  lock_at: "2026-08-01T14:00:00Z",
  release_at: "2026-08-03T14:00:00Z",
};
const lock: ArenaLock = {
  round_id: round.round_id,
  answer_history: weekly(Array.from({ length: 30 }, (_, i) => 40 + (i % 3))),
};
const base = forecastRound(round, lock).topline!;
const VERIFIED = "- Echelon: approval fell 3 points since last week ([e](https://e.example/p))";

/** Members with fixed moves (in start sds) and a reason naming the member; delphi round 2 repeats round 1. */
function members(moves: number[]): FormationMember[] {
  return moves.map((m, i) => ({
    name: `m${i}`,
    complete: async () =>
      JSON.stringify({
        mean: base.mean + m * base.sd,
        sd: base.sd,
        reason: `member ${i} reason`,
        contribution: `member ${i} contribution`,
        credit: `member ${i} credit`,
      }),
  }));
}

/** A stub decision provider: support by the member index named in its reason. */
function stubJudge(
  support: (member: number) => number | Error,
  model = "typesafe/jev-1.13",
): { provider: DecisionProvider; states: Array<Record<string, unknown>> } {
  const states: Array<Record<string, unknown>> = [];
  return {
    states,
    provider: {
      kind: "decisions-api",
      model,
      ask: async (req) => {
        const state = req.state as Record<string, unknown>;
        states.push(state);
        const i = Number(String(state.member_reason).match(/member (\d)/)?.[1] ?? -1);
        const s = support(i);
        if (s instanceof Error) throw s;
        return {
          answers: { supported: { type: "noul", noul: s } },
          model,
          provider: "decisions-api",
          latencyMs: 3,
          costUsd: 0.0001,
        };
      },
    },
  };
}

async function run(
  moves: number[],
  judge?: ProposalJudgeConfig,
  verified = VERIFIED,
  pattern: FormationPattern = "delphi",
) {
  return composeForecastRound(
    round,
    lock,
    [{ pattern, members: members(moves) }],
    forecastRound(round, lock),
    { dossier: { since: "2026-07-01", verified, sources: 1, costUsd: 0 } },
    undefined,
    undefined,
    judge,
  );
}

const MOVES = [0.2, 0.4, 1.5];

describe("proposal judge", () => {
  it("weighted median equals the median under equal weights and follows the weight otherwise", () => {
    for (const xs of [[1], [3, 1], [5, 1, 3], [4, 2, 8, 6]]) {
      expect(
        weightedMedian(
          xs,
          xs.map(() => 0.37),
        ),
      ).toBe(median(xs));
    }
    expect(weightedMedian([1, 2, 10], [0.1, 0.1, 0.9])).toBe(10);
    expect(weightedMedian([1, 2, 10], [0, 0, 0])).toBe(2);
  });

  it("support weighting moves the centre toward the supported member and lowers trust", async () => {
    const control = await run(MOVES);
    const { provider, states } = stubJudge((i) => (i === 2 ? 0.9 : 0.1));
    const f = await run(MOVES, { mode: "on", provider });
    expect(states).toHaveLength(3);
    expect(states.every((s) => s.verified_evidence === VERIFIED.trim())).toBe(true);
    expect(f.judge!.status).toBe("applied");
    expect(f.judge!.model).toBe("typesafe/jev-1.13");
    expect(f.judge!.support).toEqual({ "1:m0": 0.1, "2:m1": 0.1, "3:m2": 0.9 });
    expect(f.judge!.meanSupport).toBeCloseTo(1.1 / 3, 3);
    expect(f.judge!.calls).toBe(3);
    // The weighted median is the well-supported 1.5-sd move, not the 0.4-sd median.
    expect(f.judge!.judged!.move).toBeCloseTo(1.5 * base.sd, 3);
    expect(f.judge!.unjudged!.move).toBeCloseTo(0.4 * base.sd, 3);
    expect(f.trust!).toBeLessThan(control.trust!);
    expect(f.trust!).toBeCloseTo(control.trust! * (1.1 / 3), 2);
    expect(f.judge!.unjudged!.mean).toBe(control.topline!.mean);
    expect(f.topline!.mean).not.toBe(control.topline!.mean);
  });

  it("trust never exceeds the unjudged trust, and full support is today's forecast exactly", async () => {
    const control = await run(MOVES);
    for (const s of [0, 0.05, 0.3, 0.5, 0.77, 1]) {
      for (const pick of [0, 1, 2]) {
        const { provider } = stubJudge((i) => (i === pick ? 1 : s));
        const f = await run(MOVES, { mode: "on", provider });
        expect(f.trust!).toBeLessThanOrEqual(control.trust!);
        expect(Math.abs(f.topline!.mean - base.mean)).toBeLessThanOrEqual(2 * base.sd + 1e-9);
      }
    }
    const { provider } = stubJudge(() => 1);
    const full = await run(MOVES, { mode: "on", provider });
    expect(full.judge!.status).toBe("applied");
    expect(full.topline).toEqual(control.topline);
    expect(full.trust).toBe(control.trust);
  });

  it("no verified lines: no judge call, today's output exactly", async () => {
    const control = await run(MOVES, undefined, "");
    const { provider, states } = stubJudge(() => 0);
    const f = await run(MOVES, { mode: "on", provider }, "");
    expect(states).toHaveLength(0);
    expect(f.judge).toMatchObject({ status: "skipped", reason: "no verified lines", calls: 0 });
    expect(f.topline).toEqual(control.topline);
    expect(f.trust).toBe(control.trust);
    expect(f.proposals).toEqual(control.proposals);
  });

  it("a proposal that did not move is supported without a call; none moving skips", async () => {
    const { provider, states } = stubJudge(() => 0.5);
    const f = await run([0, 0.4, 1.5], { mode: "on", provider });
    expect(states).toHaveLength(2);
    expect(f.judge!.support!["1:m0"]).toBe(1);
    const still = await run([0, 0, 0], { mode: "on", provider });
    expect(still.judge).toMatchObject({ status: "skipped", reason: "no proposal moved" });
  });

  it("outage, timeout or spend-cap refusal fails open to today's output", async () => {
    const control = await run(MOVES);
    for (const err of [
      new DecisionError("Daily spend cap reached", "spend_cap", 429),
      new DecisionError("timed out", "timeout"),
      new Error("ECONNREFUSED"),
    ]) {
      const { provider } = stubJudge((i) => (i === 1 ? err : 0.2));
      const f = await run(MOVES, { mode: "on", provider });
      expect(f.judge!.status).toBe("unavailable");
      expect(f.judge!.error).toContain(err.message);
      expect(f.topline).toEqual(control.topline);
      expect(f.trust).toBe(control.trust);
    }
    // A malformed answer is no opinion either.
    const bad: DecisionProvider = {
      kind: "x",
      model: "x",
      ask: async () => ({ answers: {}, model: "x", provider: "x", latencyMs: 1 }),
    };
    const f = await run(MOVES, { mode: "on", provider: bad });
    expect(f.judge!.status).toBe("unavailable");
    expect(f.topline).toEqual(control.topline);
  });

  it("observe records the judged forecast without changing the filing", async () => {
    const control = await run(MOVES);
    const { provider } = stubJudge((i) => (i === 2 ? 0.9 : 0.1));
    const f = await run(MOVES, { mode: "observe", provider });
    expect(f.judge!.status).toBe("observed");
    expect(f.judge!.judged!.trust).toBeLessThan(control.trust!);
    expect(f.judge!.judged!.mean).not.toBe(control.topline!.mean);
    expect(f.topline).toEqual(control.topline);
    expect(f.trust).toBe(control.trust);
  });

  it("symbiosis: the judge reads the pair's stated credit and contribution", async () => {
    const { provider, states } = stubJudge(() => 0.5);
    const f = await run([0.3, 0.6], { mode: "on", provider }, VERIFIED, "symbiosis");
    expect(f.judge!.status).toBe("applied");
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((s) => String(s.member_reason).includes("credit"))).toBe(true);
  });

  it("other patterns are never judged", async () => {
    const { provider, states } = stubJudge(() => 0);
    const f = await run(MOVES, { mode: "on", provider }, VERIFIED, "ensemble");
    expect(states).toHaveLength(0);
    expect(f.judge).toBeUndefined();
  });

  it("the judge model is one env change; off and keyless mean no judge", () => {
    const key = { OPENROUTER_API_KEY: "sk-test" };
    expect(proposalJudgeFromEnv(key)!.provider.model).toBe("typesafe/jev-1.13");
    expect(proposalJudgeFromEnv(key)!.mode).toBe("on");
    const lightning = proposalJudgeFromEnv({
      ...key,
      MARINA_ARENA_PROPOSAL_JUDGE_MODEL: "h2oai/h2o-lightning",
      MARINA_ARENA_PROPOSAL_JUDGE: "observe",
    })!;
    expect(lightning.provider.model).toBe("h2oai/h2o-lightning");
    expect(lightning.mode).toBe("observe");
    expect(proposalJudgeFromEnv({ ...key, MARINA_ARENA_PROPOSAL_JUDGE: "off" })).toBeUndefined();
    expect(proposalJudgeFromEnv({})).toBeUndefined();
    // The config fingerprint separates judged from unjudged delphi runs.
    const spec = "formation:delphi:a,b,c+research@search";
    const fp = (env: NodeJS.ProcessEnv) => forecastSettings(spec, env).fingerprint;
    expect(fp({})).not.toBe(fp({ MARINA_ARENA_PROPOSAL_JUDGE: "off" }));
    expect(fp({})).not.toBe(fp({ MARINA_ARENA_PROPOSAL_JUDGE_MODEL: "h2oai/h2o-lightning" }));
    expect(forecastSettings("nowcast", {}).fingerprint).toBe(
      forecastSettings("nowcast", { MARINA_ARENA_PROPOSAL_JUDGE: "off" }).fingerprint,
    );
  });
});
