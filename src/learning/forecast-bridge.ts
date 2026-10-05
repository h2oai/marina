// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The forecaster's `LessonStore` over the one lesson pool: recall reads the
 * `forecast` and `arena` domains of `lessons:<domain>` (judged lessons from
 * resolved forecasts, FutureX weeks, arena rounds and backtests), plus the
 * cross-board `meta` pool within a third of the budget, applies the leakage
 * rule `visibleAt` at the forecast's cutoff and one shared budget. Every
 * forecasting surface uses it — the `forecast` command, `POST /v1/forecast`,
 * FutureX, Metaculus, ForecastBench, the arena crew and `select` backtests — so
 * a `+nolessons` ablation differs from its base arm only by the lessons.
 *
 *   MARINA_LESSONS=on        recalled lessons are injected (and recorded)
 *   MARINA_LESSONS=observe   recalled lessons are returned `observed: true`:
 *                            the forecaster records them, never injects them
 *   MARINA_LESSONS=off       nothing is recalled
 *   MARINA_LESSONS_META      the meta share alone (on / observe / off)
 *
 * A measurement run passes its eval context (`eval`): lessons learned from the
 * same board are excluded (leakage rule 2), lessons from every other board flow.
 *
 * Recall needs no armed learning loop: without one it reads the pool through
 * `lessonRecallSinkFor`, which never creates the lessons account or a space.
 * Lessons are written only through the judged outcome loop (`noteOutcome`).
 */

import type { ForecastLesson, LessonStore } from "../forecast/lessons";
import type { MarinaDB } from "../persistence/database";
import type { EvalContext } from "./eval-context";
import { formatLesson, type Lesson, type LessonSink, type OutcomeDomain } from "./outcomes";
import { recallForWork } from "./service";

/** The producer domains a forecast recalls from (the `meta` share comes on top). */
export const FORECAST_LESSON_DOMAINS: readonly OutcomeDomain[] = ["forecast", "arena"];

function toForecastLesson(l: Lesson, observed: boolean): ForecastLesson {
  return {
    ...(l.id ? { id: l.id } : {}),
    text: formatLesson(l),
    resolvedAt: l.resolvedAt,
    ...(l.category ? { category: l.category } : {}),
    ...(l.score !== undefined ? { score: l.score } : {}),
    ...(l.source ? { origin: l.source } : {}),
    ...(observed ? { observed: true } : {}),
  };
}

export function forecastLessonsFor(
  db: MarinaDB | undefined,
  opts: { env?: NodeJS.ProcessEnv; sink?: LessonSink; eval?: EvalContext } = {},
): LessonStore {
  return {
    async recall(query, asOf, recallOpts) {
      const r = await recallForWork(db, FORECAST_LESSON_DOMAINS, query, {
        asOf,
        limit: recallOpts?.limit ?? 6,
        maxBytes: recallOpts?.maxBytes ?? 1_500,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.sink ? { sink: opts.sink } : {}),
        ...(opts.eval ? { eval: opts.eval } : {}),
      });
      if (r.mode === "off") return [];
      const injected = new Set(r.inject);
      return r.recalled.map((l) => toForecastLesson(l, !injected.has(l)));
    },
  };
}
