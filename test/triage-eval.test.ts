// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { FuturexRow } from "../benchmarks/futurex/dataset";
import {
  distribution,
  distributionTable,
  factModelCostPerItem,
  futurexItem,
  scoresByClass,
  scoreTable,
  triageItem,
} from "../benchmarks/triage/eval";

const row = (id: string, title: string, end: string, level = 3): FuturexRow => ({
  id,
  en_title: title,
  prompt: `The event to be predicted: "${title} (resolved around ${end} (GMT+8))."`,
  end_time: end,
  level,
});

const rows = [
  row(
    "cpi",
    "What will the US CPI-U 12-month inflation rate be for August 2026?",
    "2026-10-30T20:30:00+08:00",
  ),
  row(
    "match",
    "Will Arsenal beat Aston Villa in the Premier League on 31 August 2026?",
    "2026-09-01T06:00:00+08:00",
    1,
  ),
  row(
    "films",
    "Which five films will rank first through fifth at the domestic box office for the 18-20 September 2026 weekend?",
    "2026-09-22T23:00:00+08:00",
    4,
  ),
  row("open", "Will the treaty be signed by the parties?", "2026-09-22T23:00:00+08:00", 1),
];

describe("offline triage evaluation", () => {
  it("triages each row at end time minus the horizon, never later", () => {
    const item = futurexItem(rows[0]!, 7)!;
    expect(item.now).toBe("2026-10-23T12:30:00.000Z");
    expect(triageItem(item).class).toBe("lookup");
    // At the event's own week the match is still open; a day after it, it is a lookup.
    expect(triageItem(futurexItem(rows[1]!, 7)!).class).toBe("forecast");
    expect(triageItem({ ...futurexItem(rows[1]!, 0)!, now: "2026-09-02T00:00:00Z" }).class).toBe(
      "lookup",
    );
  });

  it("counts classes, bases and levels", () => {
    const d = distribution(rows.map((r) => futurexItem(r, 7)!));
    expect(d.n).toBe(4);
    expect(d.counts).toEqual({ lookup: 1, anchor: 0, list: 1, forecast: 2 });
    expect(d.lookupBasis).toEqual({ "typical-lag": 1 });
    expect(d.byLevel?.["4"]?.list).toBe(1);
    expect(distributionTable([{ label: "x", d }])).toContain("| x | 4 | 1 (25%)");
  });

  it("scores by class with loss shares", () => {
    const cls = new Map([
      ["a", "lookup"],
      ["b", "forecast"],
      ["c", "forecast"],
    ] as const);
    const s = scoresByClass(
      [
        { id: "a", score: 0, variant: "v" },
        { id: "b", score: 1, variant: "v" },
        { id: "c", score: 0.5, variant: "v" },
        { id: "unknown", score: 0, variant: "v" },
      ],
      (id) => cls.get(id as "a"),
    );
    expect(s.all).toEqual({ n: 3, mean: 0.5, lossShare: 1 });
    expect(s.lookup).toEqual({ n: 1, mean: 0, lossShare: 0.667 });
    expect(s.forecast).toEqual({ n: 2, mean: 0.75, lossShare: 0.333 });
    expect(scoreTable([{ label: "v", s }])).toContain("| v | 3, 0.500 |");
    expect(factModelCostPerItem({ inputPerM: 0.3, outputPerM: 1.2 })).toBeCloseTo(0.000474, 6);
  });
});
