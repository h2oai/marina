// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What the typed forecaster needs from lessons: a recall-only store. There is
 * ONE lesson system — the judged, audited outcome loop in `src/learning`
 * (`lessons:<domain>` spaces, retire/supersede). `forecastLessonsFor`
 * (`src/learning/forecast-bridge.ts`) is the store every forecasting surface
 * uses; this file holds only the interface, so `src/forecast` never depends on
 * how lessons are kept.
 *
 * The leakage rule is the pool's `visibleAt`: a lesson whose outcome became
 * known at T is never recalled for a forecast whose evidence cutoff precedes T.
 *
 * An earlier, unjudged store kept records with subject `forecast-lesson` in a
 * `forecast-lessons` space of a `Forecaster` account. Those records are never
 * read for a forecast any more; `migrateLegacyForecastLessons`
 * (`src/learning/legacy-forecast.ts`) copies them into the pool as
 * `unverified` lessons with provenance and leaves the originals readable.
 */

export interface ForecastLesson {
  id?: string;
  /** One terse line, the part a forecaster reads (labelled `(unverified)` when not judged). */
  text: string;
  /** ISO time the outcome became known; the lesson is invisible before it. */
  resolvedAt: string;
  category?: string;
  score?: number;
  /** The producer label (e.g. `futurex:cheap`, `forecast:probability`). */
  origin?: string;
  /**
   * `MARINA_LESSONS=observe`: the lesson WOULD have been injected. The
   * forecaster records it on the answer (`observedLessons`) and never shows it
   * to a model — the ablation arm.
   */
  observed?: boolean;
}

export interface LessonStore {
  /** Lessons known at `asOf` that match `query`, served first, within `maxBytes`. */
  recall(
    query: string,
    asOf: string,
    opts?: { limit?: number; maxBytes?: number },
  ): Promise<ForecastLesson[]>;
}

/** The subject of the retired, unjudged store's records (read only by the migration). */
export const LEGACY_LESSON_SUBJECT = "forecast-lesson";
