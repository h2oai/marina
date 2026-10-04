// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * SpendGuard — the one spend stop for batch work — and the budget split the
 * reproduction kit uses: a budget is a true total, never a per-unit floor.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { budgetShare, setupNamed } from "../benchmarks/repro/setups";
import { capEnvValue, SpendGuard } from "../src/engine/spend-guard";
import { recordSpend, resetSpendLedgerForTests } from "../src/engine/spend-ledger";

beforeEach(() => resetSpendLedgerForTests());
afterEach(() => resetSpendLedgerForTests());

describe("SpendGuard", () => {
  it("stops while the items in flight can still finish under the budget", () => {
    const g = new SpendGuard({
      label: "selection budget",
      budgetUsd: 8,
      concurrency: 4,
      minReserveUsd: 0.5,
      daily: false,
    });
    expect(g.stopReason()).toBeUndefined();
    g.record(1);
    g.record(1);
    // spent 2 + reserve 1.5 × 4 × 1 = 8 reaches the budget.
    expect(g.reserveUsd()).toBe(6);
    expect(g.stopReason()).toContain("selection budget $8.00 reached");
    expect(
      new SpendGuard({ label: "x", budgetUsd: 1, spentUsd: 1, daily: false }).stopReason(),
    ).toContain("x $1.00 reached");
  });

  it("holds the same reserve against the world's and the scope's daily caps", () => {
    const env = {
      MARINA_DAILY_SPEND_CAP_USD: "100",
      MARINA_SPEND_SCOPE: "backtest",
      MARINA_SPEND_SCOPE_CAP_USD: "5",
    };
    const g = new SpendGuard({ label: "backtest", concurrency: 2, minReserveUsd: 2, env });
    recordSpend("forecast", 2.5, Date.now(), env);
    expect(g.stopReason()).toBeUndefined();
    recordSpend("forecast", 0.6, Date.now(), env);
    expect(g.stopReason()).toContain("scope backtest spend cap $5.00");
    // At the world cap the exact refusal wins, reserve or not.
    const world = new SpendGuard({
      label: "bot",
      reserveFactor: 0,
      env: { MARINA_DAILY_SPEND_CAP_USD: "3" },
    });
    expect(world.stopReason()).toContain("daily spend cap reached");
  });

  it("shares never add up to more than the budget left", () => {
    const g = new SpendGuard({ label: "--max-usd", budgetUsd: 10, spentUsd: 2, daily: false });
    const a = g.share(4)!;
    const b = g.share(3)!;
    const c = g.share(2)!;
    const d = g.share(1)!;
    expect(a.capUsd + b.capUsd + c.capUsd + d.capUsd).toBeCloseTo(8, 9);
    expect(g.share(1)).toBeUndefined();
    a.settle(0.5); // returns the unspent part of its share
    a.settle(9); // a second settle is ignored
    expect(g.spentUsd).toBe(2.5);
    expect(g.share(1)!.capUsd).toBeCloseTo(8 - 0.5 - b.capUsd - c.capUsd - d.capUsd + 0, 9);
    expect(new SpendGuard({ label: "none", daily: false }).share(2)?.capUsd).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("capEnvValue rounds down and never means uncapped", () => {
    expect(capEnvValue(2.5)).toBe("2.5");
    expect(capEnvValue(1 / 3)).toBe("0.333333");
    expect(capEnvValue(0)).toBe("0.000001");
    expect(capEnvValue(Number.NaN)).toBe("0.000001");
    expect(capEnvValue(Number.POSITIVE_INFINITY)).toBe("0.000001");
  });
});

describe("reproduction kit budgets are true totals", () => {
  it("splits the budget evenly with no per-server floor", () => {
    expect(budgetShare(10, 4)).toBe(2.5);
    expect(budgetShare(10, 0)).toBe(10);
    expect(budgetShare(-1, 2)).toBe(0);
  });

  it("HLE servers and SWE-bench runs together stay within --budget-usd", () => {
    const flags = {
      budgetUsd: 10,
      replicates: 2,
      seed: 1,
      runDir: "/tmp/repro-test",
      ledgerDb: "/tmp/repro-test/ledger.db",
    } as never;
    const caps = (setup: string) => {
      const plan = setupNamed(setup)!.plan(flags, "frontier");
      const server = plan.steps
        .filter((s) => s.kind === "server")
        .map((s) => Number((s as { env: Record<string, string> }).env.MARINA_DAILY_SPEND_CAP_USD));
      const runs = plan.steps
        .filter((s) => s.kind === "command" && s.argv.includes("--max-usd"))
        .map((s) => {
          const argv = (s as { argv: string[] }).argv;
          return Number(argv[argv.indexOf("--max-usd") + 1]);
        });
      return [...server, ...runs];
    };
    const hle = caps("hle-verified");
    expect(hle).toHaveLength(4);
    expect(hle.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10);
    const swe = caps("swebench-verified");
    expect(swe).toHaveLength(4);
    expect(swe.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10);
  });
});
