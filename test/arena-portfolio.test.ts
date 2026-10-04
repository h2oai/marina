// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { ArenaData } from "../src/arena/data";
import {
  type ArenaPlan,
  arenaPortfolioPlan,
  mixtureDistribution,
  portfolioHash,
  runArenaPortfolio,
  validateArenaPlan,
} from "../src/arena/portfolio";
import { recordPortfolioShadow, scorePortfolioShadows } from "../src/arena/portfolio-shadow";
import type { ArenaLock, ArenaRound } from "../src/arena/types";
import { WorkBudget } from "../src/coordination/work-budget";
import type { ArenaShadowRow } from "../src/persistence/db-arena";

const models = ["mock/quant", "mock/analyst"];
const round: ArenaRound = {
  round_id: "test-portfolio",
  tracker: "test",
  target_type: "continuous_normal",
  question: "Level?",
  series: "level",
  lock_at: "2026-01-20T00:00:00Z",
  release_at: "2026-01-22T00:00:00Z",
};
const lock: ArenaLock = {
  round_id: round.round_id,
  history: Array.from({ length: 15 }, (_, i) => ({
    date: `2025-12-${String(i + 1).padStart(2, "0")}`,
    value: 10 + (i % 2),
  })),
};
const start = { topline: { mean: 10, sd: 2 }, rules: {}, note: "original anchor" };
const inputs = { round, lock, start };
const budget = (calls = 32, concurrency = 2) =>
  new WorkBudget({ calls, concurrency, timeoutMs: 5000 });
const reply = async () => JSON.stringify({ mean: 10.5, sd: 2, reason: "frozen history" });

describe("arena portfolios reuse Score", () => {
  test("runs parallel branches, aggregation and refinement with one original anchor", async () => {
    const plan = arenaPortfolioPlan("layered", models);
    let active = 0;
    let peak = 0;
    const prompts: string[] = [];
    const run = await runArenaPortfolio(plan, inputs, budget(), async (_model, system, user) => {
      prompts.push(`${system}\n${user}`);
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return reply();
    });
    expect(run.complete).toBe(true);
    expect(Object.keys(run.nodes).sort()).toEqual(["aggregate", "complement", "control", "verify"]);
    expect(peak).toBe(2);
    expect(run.budget.peak).toBe(2);
    expect(prompts.some((p) => p.includes("Upstream candidate distributions"))).toBe(true);
    expect(run.result!.topline!.mean).toBeLessThanOrEqual(14);
    expect(inputs.start).toEqual(start);
    expect(run.inputHash).toBe(portfolioHash(inputs));
  });

  test("mixture preserves both within-forecast uncertainty and disagreement", () => {
    expect(
      mixtureDistribution(
        [
          { mean: 10, sd: 2 },
          { mean: 10, sd: 2 },
        ],
        start.topline,
      ),
    ).toEqual({ mean: 10, sd: 2 });
    expect(
      mixtureDistribution(
        [
          { mean: 8, sd: 2 },
          { mean: 12, sd: 2 },
        ],
        start.topline,
      ).sd,
    ).toBeCloseTo(Math.sqrt(8));
    expect(mixtureDistribution([{ mean: 100, sd: 0.1 }], start.topline)).toEqual({
      mean: 14,
      sd: 1,
    });
  });

  test("budget exhaustion cannot be swallowed by formation fallback", async () => {
    const run = await runArenaPortfolio(
      arenaPortfolioPlan("parallel", models),
      inputs,
      budget(1),
      reply,
    );
    expect(run.complete).toBe(false);
    expect(run.error).toContain("budget exhausted");
    expect(run.budget.attempted).toBe(1);
    expect(run.result).toBeUndefined();
  });

  test("recursive subplans share the same admission budget", async () => {
    const child = arenaPortfolioPlan("control", models);
    const plan: ArenaPlan = {
      version: 1,
      score: {
        id: "nested",
        goal: "recursive",
        author: "test",
        steps: [
          { id: "one", instruction: "first child", assignee: "conduct", access: [] },
          { id: "two", instruction: "second child", assignee: "conduct", access: [] },
          {
            id: "join",
            instruction: "combine",
            assignee: "role:forecaster",
            access: ["one", "two"],
          },
        ],
      },
      operations: {
        one: { kind: "conduct", plan: child },
        two: { kind: "conduct", plan: child },
        join: { kind: "aggregate" },
      },
    };
    const good = await runArenaPortfolio(plan, inputs, budget(8), reply);
    expect(good.complete).toBe(true);
    expect(good.budget.attempted).toBe(8);
    expect(good.nodes["one/control"]?.forecast).toBeDefined();
    const limited = await runArenaPortfolio(plan, inputs, budget(7), reply);
    expect(limited.complete).toBe(false);
    expect(limited.budget.attempted).toBe(7);
  });

  test("validates cycles, excess depth, operation mismatch and unsupported shapes before any call", async () => {
    const cycle = arenaPortfolioPlan("parallel", models);
    cycle.score.steps[0]!.access = ["aggregate"];
    expect(() => validateArenaPlan(cycle)).toThrow();
    const unknown = arenaPortfolioPlan("control", models);
    unknown.score.steps[0]!.assignee = "model:arbitrary";
    expect(() => validateArenaPlan(unknown)).toThrow("mismatch");
    let deep = arenaPortfolioPlan("control", models);
    for (let i = 0; i < 4; i++)
      deep = {
        version: 1,
        score: {
          id: "nested",
          goal: "nested",
          author: "test",
          steps: [{ id: "nested", instruction: "nested", assignee: "conduct", access: [] }],
        },
        operations: { nested: { kind: "conduct", plan: deep } },
      };
    expect(() => validateArenaPlan(deep)).toThrow("depth");
    await expect(
      runArenaPortfolio(
        arenaPortfolioPlan("control", models),
        { ...inputs, round: { ...round, target_type: "ranking_list" } },
        budget(),
        reply,
      ),
    ).rejects.toThrow("ranking");
  });

  test("profile candidates retain exactly the contracted cells", async () => {
    const run = await runArenaPortfolio(
      arenaPortfolioPlan("parallel", models),
      {
        round: { ...round, target_type: "profile_energy", cells: ["a", "b"] },
        lock: { ...lock, answer_history_by_cell: { a: lock.history!, b: lock.history! } },
        start: {
          ...start,
          topline: undefined,
          profile: { a: { mean: 10, sd: 2 }, b: { mean: 10, sd: 2 } },
        },
      },
      budget(),
      async () =>
        JSON.stringify({ profile: { a: { mean: 10.5, sd: 2 }, b: { mean: 10.5, sd: 2 } } }),
    );
    expect(run.complete).toBe(true);
    expect(Object.keys(run.result!.profile!).sort()).toEqual(["a", "b"]);
  });

  test("abort reaches active calls and late transport replies cannot change the returned trace", async () => {
    const controller = new AbortController();
    const b = new WorkBudget({ calls: 10, concurrency: 1, timeoutMs: 5000 }, controller.signal);
    let resolve!: (reply: string) => void;
    let started!: () => void;
    const first = new Promise<void>((r) => {
      started = r;
    });
    let callSignal: AbortSignal | undefined;
    const pending = runArenaPortfolio(
      arenaPortfolioPlan("control", models),
      inputs,
      b,
      async (_model, _system, _user, signal) => {
        callSignal = signal;
        started();
        return new Promise<string>((r) => {
          resolve = r;
        });
      },
    );
    await first;
    controller.abort(new Error("operator cancelled"));
    const run = await pending;
    expect(run.complete).toBe(false);
    expect(callSignal!.aborted).toBe(true);
    const before = JSON.stringify(run);
    resolve(await reply());
    await Promise.resolve();
    expect(JSON.stringify(run)).toBe(before);
  });
});

describe("portfolio shadow ledger", () => {
  test("records once, keeps late/failure evidence, scores only complete matched runs", async () => {
    const run = await runArenaPortfolio(
      arenaPortfolioPlan("parallel", models),
      inputs,
      budget(),
      reply,
    );
    const rows: ArenaShadowRow[] = [];
    const store = {
      recordArenaShadow: (row: {
        roundId: string;
        forecaster: string;
        forecast: string;
        detail: string;
        costUsd: number;
      }) => {
        rows.push({
          id: rows.length + 1,
          round_id: row.roundId,
          forecaster: row.forecaster,
          forecast: row.forecast,
          detail: row.detail,
          cost_usd: row.costUsd,
          created_at: Date.parse("2026-01-19T01:00:00Z"),
        });
        return true;
      },
    };
    const metadata = {
      capturedAt: "2026-01-19T00:00:00Z",
      completedAt: "2026-01-19T01:00:00Z",
      costUsd: 0.1,
    };
    expect(recordPortfolioShadow(store, run, metadata).eligible).toBe(true);
    const data = new ArenaData("https://arena.test", async (url) => {
      const path = String(url);
      if (path.endsWith("season0.json")) return Response.json({ rounds: [round] });
      if (path.includes("resolutions"))
        return Response.json({
          [round.round_id]: {
            value: 11,
            resolved_at: "2026-01-22T00:00:00Z",
            observed_date: "2026-01-21",
          },
        });
      if (path.includes("locks/")) return Response.json(lock);
      throw new Error(`unexpected request ${path}`);
    });
    const scored = await scorePortfolioShadows(data, rows);
    expect(scored.comparisons[0]?.status).toBe("resolved");
    expect(scored.evidence).toHaveLength(1);
    recordPortfolioShadow(
      store,
      { ...run, complete: false, error: "budget exhausted", result: undefined },
      metadata,
    );
    const failed = await scorePortfolioShadows(data, rows);
    expect(failed.comparisons).toHaveLength(1);
    expect(failed.comparisons[0]?.status).toBe("failed");
    expect(failed.evidence).toHaveLength(1);
    expect(failed.evidence[0]?.status).toBe("failed");
    expect(failed.evidence[0]?.candidateValue).toBeUndefined();
    expect(
      recordPortfolioShadow(store, run, { ...metadata, completedAt: round.lock_at }).eligible,
    ).toBe(false);
  });
});
