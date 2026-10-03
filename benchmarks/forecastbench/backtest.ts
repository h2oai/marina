// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Past ForecastBench rounds as held-out backtest items for configuration
 * selection (`../forecasting/select.ts`): every question of a round with at
 * least one resolved forecast, asked as of that round's due date (00:00 UTC,
 * when the set was released) and scored by the board's own metric — the mean
 * 1 − Brier over its resolved forecasts, with the set's fallback standing in
 * for an unusable answer, as it would have been filed.
 */

import type { TypedForecastAnswer } from "../../src/forecast/typed";
import type { BacktestItem } from "../forecasting/select";
import {
  type FbQuestion,
  type FbQuestionSet,
  type FbResolution,
  type Fetcher,
  isMarket,
} from "./dataset";
import { fallbackForecasts, forecastsFrom, requestFor } from "./map";

/** Due dates with a published resolution set, newest first. */
export async function resolvedRounds(fetcher: Fetcher = fetch): Promise<string[]> {
  const res = await fetcher(
    "https://api.github.com/repos/forecastingresearch/forecastbench-datasets/contents/datasets/resolution_sets",
    { signal: AbortSignal.timeout(30_000), headers: { Accept: "application/vnd.github+json" } },
  );
  if (!res.ok) throw new Error(`resolution set listing → ${res.status}`);
  const files = (await res.json()) as Array<{ name: string }>;
  return files
    .map((f) => /^(\d{4}-\d{2}-\d{2})_resolution_set\.json$/.exec(f.name)?.[1])
    .filter((d): d is string => !!d)
    .sort()
    .reverse();
}

/** 1 − Brier, averaged over a question's resolved forecasts. */
export function scoreQuestion(
  q: FbQuestion,
  resolved: FbResolution[],
  answer: TypedForecastAnswer | undefined,
): number {
  const forecasts = (answer && forecastsFrom(q, answer, null)) || fallbackForecasts(q);
  const pairs = resolved
    .map((r) => ({
      r,
      f: isMarket(q)
        ? forecasts[0]
        : forecasts.find((f) => f.resolution_date === r.resolution_date),
    }))
    .filter((p) => p.f);
  if (!pairs.length) return 0.75;
  return pairs.reduce((s, p) => s + 1 - (p.f!.forecast - p.r.resolved_to) ** 2, 0) / pairs.length;
}

export function backtestItems(
  set: FbQuestionSet,
  resolutions: FbResolution[],
  opts: { sources?: string[] } = {},
): BacktestItem[] {
  const due = set.forecast_due_date;
  const asOf = `${due}T00:00:00.000Z`;
  const byKey = new Map<string, FbResolution[]>();
  for (const r of resolutions) {
    if (!r.resolved) continue;
    const k = `${r.source}|${r.id}`;
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const out: BacktestItem[] = [];
  for (const q of set.questions) {
    if (opts.sources && !opts.sources.includes(q.source)) continue;
    const rs = byKey.get(`${q.source}|${q.id}`);
    if (!rs?.length) continue;
    out.push({
      id: `forecastbench:${due}/${q.source}/${q.id}`,
      request: { ...requestFor(q, due), asOf },
      score: (answer) => scoreQuestion(q, rs, answer),
    });
  }
  return out;
}
