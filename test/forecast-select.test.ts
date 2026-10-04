// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForecastConfig } from "../benchmarks/forecasting/configs";
import { auditForecast, hardLeaks } from "../benchmarks/forecasting/leak-audit";
import { type BacktestItem, selectConfiguration } from "../benchmarks/forecasting/select";
import type { TypedForecastAnswer } from "../src/forecast/typed";

const config = (label: string): ForecastConfig => ({
  label,
  formation: "ensemble",
  analysts: [`openrouter/v/${label}`],
});

const items: BacktestItem[] = Array.from({ length: 10 }, (_, i) => ({
  id: `q${i}`,
  request: {
    question: `q${i}`,
    answer: { type: "choice", options: ["Yes", "No"] },
    asOf: "2026-09-13T00:00:00.000Z",
  } as unknown as BacktestItem["request"],
  score: (a) => (a?.prediction === "Yes" ? 1 : 0.75),
}));

const answer = (costUsd: number, prediction?: string) =>
  ({ prediction, costUsd, runs: [], research: [], sources: [] }) as unknown as TypedForecastAnswer;

const releases = { "v/a": "2026-08-01", "v/b": "2026-08-01" };

describe("selectConfiguration", () => {
  it("discards a run stopped before the selection budget instead of scoring fallbacks", async () => {
    const filed: string[] = [];
    const s = await selectConfiguration({
      benchmark: "t",
      items,
      candidates: [config("a"), config("b")],
      releases,
      makeForecaster: () => async () => answer(1, "Yes"),
      replicates: 1,
      minItems: 1,
      budgetUsd: 6,
      isolation: "date-filtered",
      concurrency: 1,
      env: { MARINA_DAILY_SPEND_CAP_USD: "0" },
      ledger: {
        recordBenchmarkLedgerRun: ((run: { id: string }) => {
          filed.push(run.id);
          return run;
        }) as never,
      },
    });
    const a = s.ranking.find((r) => r.label === "a")!;
    expect(a.replicates).toBe(0);
    expect(a.status).toBe("not run (budget)");
    expect(filed).toHaveLength(0);
    expect(s.picked).toEqual([]);
  });

  it("flags items without an answer as fallbacks in the filed run", async () => {
    const runs: Array<{ invalid_reason: string | null }> = [];
    let n = 0;
    await selectConfiguration({
      benchmark: "t",
      items,
      candidates: [config("a")],
      releases,
      makeForecaster: () => async () => {
        n++;
        if (n % 2) throw new Error("upstream");
        return answer(0.01, n % 4 === 0 ? undefined : "Yes");
      },
      replicates: 1,
      minItems: 1,
      budgetUsd: 100,
      isolation: "date-filtered",
      concurrency: 1,
      env: { MARINA_DAILY_SPEND_CAP_USD: "0" },
      ledger: {
        recordBenchmarkLedgerRun: ((run: { id: string; invalid_reason: string | null }) => {
          runs.push(run);
          return run;
        }) as never,
      },
    });
    // 5 threw and 2 had no prediction: 7 of 10 are fallbacks, over the ledger's threshold.
    expect(runs).toHaveLength(1);
    expect(runs[0]!.invalid_reason).toContain("7 of 10 items were fallbacks");
  });
});

describe("selectConfiguration order", () => {
  it("runs candidates in the order given, not by release date", async () => {
    const order: string[] = [];
    await selectConfiguration({
      benchmark: "t",
      items,
      candidates: [config("b"), config("a")],
      releases: { "v/a": "2026-07-01", "v/b": "2026-08-01" },
      makeForecaster: (c) => async () => {
        order.push(c.label);
        return answer(0, "Yes");
      },
      replicates: 1,
      minItems: 1,
      budgetUsd: 100,
      isolation: "date-filtered",
      concurrency: 1,
      env: { MARINA_DAILY_SPEND_CAP_USD: "0" },
    });
    expect(order[0]).toBe("b");
    expect(order.at(-1)).toBe("a");
  });
});

describe("auditForecast", () => {
  it("counts evidence, lessons and lookups dated after the cutoff", () => {
    const report = [
      "## asof:gdelt",
      "- 2026-09-12 — before [a](https://a.example)",
      "- 2026-09-14 — after [b](https://b.example)",
      "-  — undated [c](https://c.example)",
      "Nothing else.",
    ].join("\n");
    const a = {
      lessons: [
        { text: "x", resolvedAt: "2026-09-01T00:00:00Z" },
        { text: "y", resolvedAt: "2026-09-20T00:00:00Z" },
      ],
      lookups: [
        {
          name: "kalshi",
          lines: ["p"],
          sources: [],
          mode: "historical",
          asOf: "2026-09-12T00:00:00Z",
        },
        { name: "polymarket", lines: ["p"], sources: [], mode: "live" },
        { name: "bls", lines: [], sources: [], skipped: "past cutoff" },
      ],
    } as unknown as TypedForecastAnswer;
    const c = auditForecast("2026-09-13T00:00:00.000Z", [report], a);
    expect(c).toMatchObject({
      forecasts: 1,
      evidenceLines: 3,
      evidenceAfterCutoff: 1,
      evidenceUndated: 1,
      lessons: 2,
      lessonsAfterCutoff: 1,
      lookups: 2,
      lookupsLive: 1,
      lookupsAfterCutoff: 0,
    });
    expect(hardLeaks(c)).toBe(3);
    expect(hardLeaks(auditForecast("2026-09-13T00:00:00.000Z", [], undefined))).toBe(0);
  });
});

describe("selectConfiguration journals", () => {
  it("keeps a stopped run's answers, files nothing partial, and resumes only the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "select-journal-"));
    try {
      const filed: string[] = [];
      const ledger = {
        recordBenchmarkLedgerRun: ((run: { id: string }) => {
          filed.push(run.id);
          return run;
        }) as never,
      };
      const base = {
        benchmark: "t",
        items,
        candidates: [config("a")],
        releases,
        replicates: 1,
        minItems: 1,
        isolation: "date-filtered" as const,
        concurrency: 1,
        env: { MARINA_DAILY_SPEND_CAP_USD: "0" },
        ledger,
        journalDir: dir,
      };
      let calls = 0;
      const makeForecaster = () => async () => {
        calls++;
        return answer(1, "Yes");
      };
      // $1 an item against a $6 budget: stopped partway, with the reserve held back.
      const first = await selectConfiguration({ ...base, makeForecaster, budgetUsd: 6 });
      const done = calls;
      expect(done).toBeGreaterThan(0);
      expect(done).toBeLessThan(items.length);
      expect(first.ranking[0]?.status).toBe("not run (budget)");
      expect(filed).toHaveLength(0);
      const path = join(dir, "a-r1.jsonl");
      expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1 + done);

      // A different configuration under the same journal is refused.
      await expect(
        selectConfiguration({
          ...base,
          candidates: [{ ...config("a"), runs: 5 }],
          makeForecaster,
          budgetUsd: 100,
          resume: true,
        }),
      ).rejects.toThrow("refusing --resume");

      const second = await selectConfiguration({
        ...base,
        makeForecaster,
        budgetUsd: 100,
        resume: true,
      });
      expect(calls).toBe(items.length);
      const a = second.ranking.find((r) => r.label === "a")!;
      expect(a.replicates).toBe(1);
      expect(a.mean).toBe(1);
      // The resumed answers' cost is the run's cost; the budget counts only new spend.
      expect(a.costPerItem).toBe(1);
      expect(second.costUsd).toBe(items.length - done);
      expect(filed).toHaveLength(1);

      // Resuming a filed run re-files nothing and forecasts nothing.
      const third = await selectConfiguration({
        ...base,
        makeForecaster,
        budgetUsd: 100,
        resume: true,
      });
      expect(calls).toBe(items.length);
      expect(filed).toHaveLength(1);
      expect(third.ranking[0]?.ledgerRuns).toEqual([filed[0]!]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
