// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Usage and cost accounting for harness runs. Only what an endpoint REPORTED is
 * summed: a missing field stays missing, so a run with no reported cost shows
 * "n/a" instead of a guessed dollar figure.
 */

import type { CallUsage, ItemUsage, ResultItem, UsageSummary } from "./types";

function addOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a + b;
}

/** Fold one call's usage into an item's running total. */
export function addCallUsage(total: ItemUsage | undefined, call: CallUsage): ItemUsage {
  return {
    calls: (total?.calls ?? 0) + 1,
    promptTokens: addOptional(total?.promptTokens, call.promptTokens),
    completionTokens: addOptional(total?.completionTokens, call.completionTokens),
    costUsd: addOptional(total?.costUsd, call.costUsd),
  };
}

/** Totals over a run's items. Answer cost and judge cost are kept apart. */
export function summarizeUsage(items: ResultItem[]): UsageSummary {
  const summary: UsageSummary = { items: items.length, calls: 0, pricedItems: 0 };
  for (const item of items) {
    for (const u of [item.usage, item.judgeUsage]) {
      if (!u) continue;
      summary.calls += u.calls;
      summary.promptTokens = addOptional(summary.promptTokens, u.promptTokens);
      summary.completionTokens = addOptional(summary.completionTokens, u.completionTokens);
    }
    if (item.usage?.costUsd !== undefined) {
      summary.pricedItems++;
      summary.costUsd = addOptional(summary.costUsd, item.usage.costUsd);
    }
    if (item.judgeUsage?.costUsd !== undefined) {
      summary.judgeCostUsd = addOptional(summary.judgeCostUsd, item.judgeUsage.costUsd);
    }
  }
  return summary;
}

/** `$0.0123`, or `n/a` when nothing was reported. */
export function formatUsd(value: number | undefined): string {
  if (value === undefined) return "n/a";
  if (value === 0) return "$0";
  if (value < 0.0001) return `$${value.toExponential(2)}`;
  return `$${value.toFixed(4)}`;
}

/** Answer + judge dollars, or undefined when neither was reported. */
export function totalCostUsd(summary: UsageSummary | undefined): number | undefined {
  if (!summary) return undefined;
  return addOptional(summary.costUsd, summary.judgeCostUsd);
}
