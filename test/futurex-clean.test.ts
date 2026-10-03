// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  auditRow,
  batchWeek,
  knowledgeBound,
  RELEASE_LAG_DAYS,
  selectCleanRows,
} from "../benchmarks/futurex/clean";
import { bootstrapOverall, weightedOverall } from "../benchmarks/futurex/clean-run";
import type { FuturexRow } from "../benchmarks/futurex/dataset";
import { BUILTIN_VARIANTS, type RowResult } from "../benchmarks/futurex/run";

const row = (id: string, level: number, end: string, truth: unknown = "['A']"): FuturexRow => ({
  id,
  level,
  end_time: end,
  prompt: `Question ${id}\nA. Yes\nB. No`,
  en_title: `Question ${id}`,
  ground_truth: truth,
});

describe("knowledge bounds", () => {
  it("is the latest release among a variant's models", () => {
    expect(knowledgeBound(BUILTIN_VARIANTS.cheap!)).toEqual({ after: "2026-08-12" });
    expect(knowledgeBound(BUILTIN_VARIANTS["frontier-2607"]!)).toEqual({ after: "2026-08-12" });
    expect(knowledgeBound(BUILTIN_VARIANTS.frontier!)).toEqual({ after: "2026-09-29" });
  });

  it("refuses unknown models, floating aliases and crews", () => {
    const base = BUILTIN_VARIANTS.cheap!;
    expect("error" in knowledgeBound({ ...base, analysts: ["openrouter/vendor/unknown-9"] })).toBe(
      true,
    );
    expect(
      (
        knowledgeBound({ ...base, analysts: ["openrouter/deepseek/deepseek-v4-pro"] }) as {
          error: string;
        }
      ).error,
    ).toMatch(/floating alias/);
    expect(
      (knowledgeBound({ ...base, analysts: ["marina:answerer"] }) as { error: string }).error,
    ).toMatch(/cannot be isolated/);
  });
});

describe("clean row selection", () => {
  it("keeps rows released after the bound, balanced by level, in order of end time", () => {
    const rows = [
      row("early", 1, "2026-08-15 12:00:00"), // inside the release lag
      row("r1", 1, "2026-09-03 12:00:00"),
      row("r2", 2, "2026-09-01 12:00:00"),
      row("r3", 3, "2026-09-10 12:00:00"),
      row("r4", 4, "2026-08-30 12:00:00"),
      row("r5", 1, "2026-09-12 12:00:00"),
      row("noTruth", 2, "2026-09-05 12:00:00", ""),
    ];
    const got = selectCleanRows(rows, { after: "2026-08-12", limit: 4 });
    expect(got.map((r) => r.id)).toEqual(["r4", "r2", "r1", "r3"]);
    expect(RELEASE_LAG_DAYS).toBe(10);
  });

  it("names the batch week by its opening Wednesday (UTC+8)", () => {
    expect(batchWeek("2026-09-22T15:00:00.000Z")).toBe("2026-09-16"); // Tue 23:00 UTC+8
    expect(batchWeek("2026-09-22T16:30:00.000Z")).toBe("2026-09-23"); // Wed 00:30 UTC+8
  });
});

describe("leak audit", () => {
  const result = (reason: string, cutoff = "2026-09-01T00:00:00.000Z"): RowResult =>
    ({
      id: "x",
      level: 3,
      spec: "number",
      prediction: "1",
      fallback: false,
      late: false,
      cutoff,
      costUsd: 0,
      latencyMs: 0,
      answer: { runs: [{ reason }], research: [] },
    }) as unknown as RowResult;
  const r = row("x", 3, "2026-09-08 12:00:00", "123456");

  it("flags a quoted exact outcome, a post-event date and result language in evidence", () => {
    expect(auditRow(r, result("Expect about 123,456 units"), "", new Set()).flags.truthQuoted).toBe(
      true,
    );
    expect(auditRow(r, result("revised on 2026-09-20"), "", new Set()).flags.laterDate).toBe(true);
    const ev = "- 2026-08-30 — the figure closed at 120000 [a](https://a.example.com/2026/08/30/x)";
    expect(auditRow(r, result("trend"), ev, new Set()).flags.resultLanguage).toBe(true);
  });

  it("does not flag the event's own schedule, history or option names", () => {
    const a = auditRow(
      r,
      result("The release on 2026-09-08 follows a team that has won three of the last four"),
      "",
      new Set(["A"]),
    );
    expect(a.suspicious).toBe(false);
  });
});

describe("aggregates", () => {
  it("weights levels like FutureX and bootstraps within levels", () => {
    const items = [
      { level: 1, score: 1 },
      { level: 4, score: 0 },
    ];
    expect(weightedOverall(items)).toBeCloseTo(0.2);
    const ci = bootstrapOverall(items, 200);
    expect(ci[0]).toBeCloseTo(0.2);
    expect(ci[1]).toBeCloseTo(0.2);
  });
});
