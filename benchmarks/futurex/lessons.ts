// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * FutureX rows as outcomes for the one lesson pool (`src/learning`): when a
 * row's outcome counts as known, and the general outcome a scored answer
 * becomes. Shared by `futurex learn` (resolved live weeks) and the clean
 * backtest (each scored row), so both apply the same leakage rule.
 *
 * When an outcome is known: never at the row's end time itself. A FutureX week
 * holds many rows that share one end time, and a replay's cutoff is that end
 * time (`chooseCutoff`), so a lesson stamped at end_time would be visible to
 * its siblings before their truths could have been known. A lesson resolves
 * `SETTLEMENT_MARGIN_MS` after the end time (a day for the event to settle and
 * be reported) — strictly later than any cutoff a sibling row can have.
 */

import type { Outcome } from "../../src/learning/outcomes";
import type { FuturexRow } from "./dataset";
import { endTimeIso } from "./map";
import type { RowResult } from "./run";
import type { ItemScore } from "./score";

/** How long after a row's end time its outcome counts as known. */
export const SETTLEMENT_MARGIN_MS = 86_400_000;

/** When a row's outcome counts as known (ISO), or undefined without a parseable end time. */
export function futurexResolvedAt(row: Pick<FuturexRow, "end_time">): string | undefined {
  const end = endTimeIso(row.end_time);
  return end ? new Date(Date.parse(end) + SETTLEMENT_MARGIN_MS).toISOString() : undefined;
}

/**
 * The general outcome of one scored answer: no question, truth or answer text
 * is stored (they travel only as private context for the leak check).
 */
export function futurexOutcome(input: {
  row: FuturexRow;
  result: Pick<RowResult, "id" | "spec" | "prediction" | "fallback" | "confidence">;
  item: Pick<ItemScore, "score" | "metric">;
  /** The producer label, e.g. the variant (`futurex:<label>`). */
  label: string;
  resolvedAt: string;
  refs?: string[];
}): Outcome {
  const { row, result: r, item, label } = input;
  return {
    domain: "forecast",
    source: `futurex:${label}`,
    succeeded: item.score >= 0.5,
    score: item.score,
    resolvedAt: input.resolvedAt,
    attempted: `forecast a level-${row.level} ${r.spec} question (variant ${label})`,
    detail: `${item.metric} score ${item.score.toFixed(2)}${r.fallback ? " (fallback answer)" : ""}`,
    signals: [
      `variant:${label}`,
      ...(r.confidence !== undefined ? [`confidence:${r.confidence.toFixed(2)}`] : []),
    ],
    refs: [`futurex:${r.id}`, ...(input.refs ?? [])],
    privateContext: `${row.prompt}\n${JSON.stringify(row.ground_truth)}\n${r.prediction}`,
  };
}
