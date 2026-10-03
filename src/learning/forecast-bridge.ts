// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The forecaster's `LessonStore` over the general lesson pool: recall reads the
 * `forecast` domain of `lessons:<domain>` (judged lessons from resolved
 * forecasts, arena rounds and benchmark runs) and, when given, a legacy
 * forecast-lesson store (`src/forecast/lessons.ts`), merged under the same
 * leakage rule and budget. `MARINA_LESSONS=observe|off` inject nothing.
 * Writes go to the legacy store when one is given: the general pool is written
 * only through the judged outcome loop.
 */

import type { ForecastLesson, LessonStore } from "../forecast/lessons";
import type { MarinaDB } from "../persistence/database";
import { formatLesson, type Lesson, type LessonSink } from "./outcomes";
import { recallAcross } from "./service";

function toForecastLesson(l: Lesson): ForecastLesson {
  return {
    ...(l.id ? { id: l.id } : {}),
    text: formatLesson(l),
    answerType: "text",
    ...(l.category ? { category: l.category } : {}),
    ...(l.rule ? { rule: l.rule } : {}),
    ...(l.score !== undefined ? { score: l.score } : {}),
    resolvedAt: l.resolvedAt,
    origin: l.source,
  };
}

export function forecastLessonsFor(
  db: MarinaDB | undefined,
  opts: { legacy?: LessonStore; env?: NodeJS.ProcessEnv; sink?: LessonSink } = {},
): LessonStore {
  return {
    async write(lesson) {
      return opts.legacy ? opts.legacy.write(lesson) : {};
    },
    async recall(query, asOf, recallOpts) {
      const limit = recallOpts?.limit ?? 6;
      const maxBytes = recallOpts?.maxBytes ?? 1_500;
      const general = await recallAcross(db, ["forecast", "arena"], query, {
        asOf,
        limit,
        maxBytes,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.sink ? { sink: opts.sink } : {}),
      });
      if (general.mode !== "on") return [];
      const legacy = opts.legacy
        ? await opts.legacy.recall(query, asOf, recallOpts).catch(() => [])
        : [];
      const merged = [...general.inject.map(toForecastLesson), ...legacy];
      const out: ForecastLesson[] = [];
      let bytes = 0;
      for (const l of merged) {
        const n = Buffer.byteLength(l.text);
        if (out.length >= limit || bytes + n > maxBytes) break;
        out.push(l);
        bytes += n;
      }
      return out;
    },
  };
}
