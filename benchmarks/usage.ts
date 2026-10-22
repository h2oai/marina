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
  const cached = addOptional(total?.cachedPromptTokens, call.cachedPromptTokens);
  const written = addOptional(total?.cacheWriteTokens, call.cacheWriteTokens);
  return {
    calls: (total?.calls ?? 0) + 1,
    promptTokens: addOptional(total?.promptTokens, call.promptTokens),
    completionTokens: addOptional(total?.completionTokens, call.completionTokens),
    ...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
    ...(written !== undefined ? { cacheWriteTokens: written } : {}),
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
      summary.cachedPromptTokens = addOptional(summary.cachedPromptTokens, u.cachedPromptTokens);
      summary.cacheWriteTokens = addOptional(summary.cacheWriteTokens, u.cacheWriteTokens);
    }
    if (item.usage?.costUsd !== undefined) {
      summary.pricedItems++;
      summary.costUsd = addOptional(summary.costUsd, item.usage.costUsd);
    }
    if (item.judgeUsage?.costUsd !== undefined) {
      summary.judgeCostUsd = addOptional(summary.judgeCostUsd, item.judgeUsage.costUsd);
    }
  }
  if (summary.cachedPromptTokens === undefined) delete summary.cachedPromptTokens;
  if (summary.cacheWriteTokens === undefined) delete summary.cacheWriteTokens;
  return summary;
}

/**
 * `Prompt cache: 410000 read (63%) / 12000 written`, or undefined when the
 * endpoint reported neither. A high read share on a single-turn benchmark
 * usually means another run warmed the cache (same items, same key, at once),
 * so its dollars are not comparable to an arm that ran alone.
 */
export function formatCacheUsage(summary: UsageSummary | undefined): string | undefined {
  if (!summary) return undefined;
  const { cachedPromptTokens: read, cacheWriteTokens: written, promptTokens } = summary;
  if (read === undefined && written === undefined) return undefined;
  const share =
    read !== undefined && promptTokens ? ` (${Math.round((100 * read) / promptTokens)}%)` : "";
  return `Prompt cache: ${read ?? "n/a"} read${share} / ${written ?? "n/a"} written`;
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
