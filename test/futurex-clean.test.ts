// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  afterKnowledge,
  isFloatingAlias,
  knowledgeBoundOf,
  releaseTable,
} from "../benchmarks/forecasting/knowledge";
import {
  auditRow,
  batchWeek,
  KNOWLEDGE_MARGIN_DAYS,
  knowledgeBound,
  selectCleanRows,
} from "../benchmarks/futurex/clean";
import { bootstrapOverall, weightedOverall } from "../benchmarks/futurex/clean-run";
import type { FuturexRow } from "../benchmarks/futurex/dataset";
import { BUILTIN_VARIANTS, type RowResult } from "../benchmarks/futurex/run";
import { scoreBatchJudged } from "../benchmarks/futurex/score";

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

describe("one knowledge-bound rule (clean backtest and selection)", () => {
  it("refuses floating aliases everywhere: known ones, latest routes, and ids with a pinned sibling", () => {
    expect(isFloatingAlias("openrouter/deepseek/deepseek-v4-pro")).toBe(true);
    expect(isFloatingAlias("~anthropic/claude-latest")).toBe(true);
    expect(isFloatingAlias("vendor/model-latest")).toBe(true);
    expect(isFloatingAlias("vendor/model", ["vendor/model-20260813"])).toBe(true);
    expect(isFloatingAlias("vendor/model", ["vendor/model-pro"])).toBe(false);
    expect(isFloatingAlias("deepseek/deepseek-v4-pro-0813")).toBe(false);
    const bound = knowledgeBoundOf(["vendor/model"], {
      "vendor/model": "2026-07-01",
      "vendor/model-0901": "2026-09-01",
    });
    expect("error" in bound && bound.reason).toBe("floating");
  });

  it("the pinned release table wins over a catalogue date", () => {
    const t = releaseTable({ "anthropic/claude-opus-5.5": "2026-01-01", "x/new": "2026-09-30" });
    expect(t["anthropic/claude-opus-5.5"]).toBe("2026-09-22");
    expect(t["x/new"]).toBe("2026-09-30");
  });

  it("a cutoff is clean only strictly after the bound plus the margin", () => {
    expect(afterKnowledge("2026-08-15T00:00:00.000Z", "2026-08-12")).toBe(false);
    expect(afterKnowledge("2026-08-15T00:00:00.001Z", "2026-08-12")).toBe(true);
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
    // The default 7-day horizon plus the 3-day margin: rows end more than 10 days after the bound.
    expect(KNOWLEDGE_MARGIN_DAYS).toBe(3);
    const atEdge = [row("edge", 1, "2026-08-22 08:00:00"), row("past", 1, "2026-08-22 09:00:00")];
    expect(selectCleanRows(atEdge, { after: "2026-08-12", limit: 4 }).map((r) => r.id)).toEqual([
      "past",
    ]);
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
    const undated = "- the figure closed at 120000 [a](https://a.example.com/x)";
    expect(auditRow(r, result("trend"), undated, new Set()).flags.resultLanguage).toBe(true);
    const late = "- 2026-09-02 — preview [a](https://a.example.com/x)";
    expect(auditRow(r, result("trend"), late, new Set()).flags.laterDate).toBe(true);
  });

  it("treats a page dated before the cutoff as history and schedule, not a leak", () => {
    const ev =
      "- 2026-08-30 — the figure closed at 120000; the next release is on 2026-10-10 [a](https://a.example.com/x)";
    expect(auditRow(r, result("trend"), ev, new Set()).suspicious).toBe(false);
  });

  it("does not flag the event's own schedule, history or option names", () => {
    const a = auditRow(
      r,
      result(
        "As of September 2026, the release on 2026-09-08 follows a team that has won three of the last four",
      ),
      "",
      new Set(["A"]),
    );
    expect(a.suspicious).toBe(false);
  });
});

describe("judged scoring", () => {
  it("grades strings and lists with the judge, leaves options mechanical, survives an outage", async () => {
    const rows: FuturexRow[] = [
      { id: "s", level: 3, end_time: "2026-09-01", prompt: "Who wins?", ground_truth: "Jane Doe" },
      {
        id: "l",
        level: 4,
        end_time: "2026-09-01",
        prompt: "Top three, ordered",
        ground_truth: "['X', 'Y', 'Z']",
      },
      row("o", 1, "2026-09-01 12:00:00", "['A']"),
    ];
    const preds = new Map([
      ["s", "Ms. Jane Doe"],
      ["l", "X, Z, Q"],
      ["o", "B"],
    ]);
    const judge = {
      name: "j",
      complete: async (_s: string, user: string) =>
        user.includes("Kind: list") ? '{"matched": 2, "same_order": false}' : '{"match": true}',
    };
    const s = await scoreBatchJudged(rows, preds, judge);
    const by = new Map(s.items.map((i) => [i.id, i.score]));
    expect(by.get("s")).toBe(1);
    expect(by.get("l")).toBeCloseTo(0.5333, 3);
    expect(by.get("o")).toBe(0);
    expect(s.judged).toBe(2);
    const down = await scoreBatchJudged(rows, preds, {
      name: "j",
      complete: async () => {
        throw new Error("down");
      },
    });
    expect(new Map(down.items.map((i) => [i.id, i.score])).get("s")).toBe(0);
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
