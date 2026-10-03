// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A leak audit for backtest forecasts made as of a past cutoff: counts, per
 * configuration, everything a forecast saw that could carry its outcome.
 *
 *   evidence  — research report lines carry their page's publication day
 *               (`- YYYY-MM-DD — …`); a day after the cutoff is a hard leak,
 *               an undated line is unproven (a date-strict `asof` retriever
 *               never returns one);
 *   lessons   — a recalled lesson resolved after the cutoff is a hard leak;
 *   lookups   — a lookup that read live values, or values dated after the
 *               cutoff, is a hard leak.
 *
 * Counts only: no question, answer or evidence text is kept.
 */

import type { TypedForecastAnswer } from "../../src/forecast/typed";

export interface LeakCounts {
  forecasts: number;
  evidenceLines: number;
  evidenceAfterCutoff: number;
  evidenceUndated: number;
  lessons: number;
  lessonsAfterCutoff: number;
  lookups: number;
  lookupsLive: number;
  lookupsAfterCutoff: number;
}

export const emptyLeakCounts = (): LeakCounts => ({
  forecasts: 0,
  evidenceLines: 0,
  evidenceAfterCutoff: 0,
  evidenceUndated: 0,
  lessons: 0,
  lessonsAfterCutoff: 0,
  lookups: 0,
  lookupsLive: 0,
  lookupsAfterCutoff: 0,
});

const LINE_DAY = /^\s*-\s*(\d{4}-\d{2}-\d{2})?\s*—/;
const BULLET = /^\s*-\s+\S/;

/** The leak counts of one forecast made as of `asOf`, from its answer and the research reports it read. */
export function auditForecast(
  asOf: string,
  reports: string[],
  answer: TypedForecastAnswer | undefined,
): LeakCounts {
  const c = emptyLeakCounts();
  c.forecasts = 1;
  const cutoffDay = asOf.slice(0, 10);
  const cutoff = Date.parse(asOf);
  for (const line of reports.join("\n").split("\n")) {
    if (!BULLET.test(line)) continue;
    c.evidenceLines++;
    const day = line.match(LINE_DAY)?.[1];
    if (!day) c.evidenceUndated++;
    else if (day > cutoffDay) c.evidenceAfterCutoff++;
  }
  for (const l of answer?.lessons ?? []) {
    c.lessons++;
    if (Date.parse(l.resolvedAt) > cutoff) c.lessonsAfterCutoff++;
  }
  for (const l of answer?.lookups ?? []) {
    if (l.skipped || !l.lines.length) continue;
    c.lookups++;
    if (l.mode === "live") c.lookupsLive++;
    if (l.asOf && Date.parse(l.asOf) > cutoff) c.lookupsAfterCutoff++;
  }
  return c;
}

export function addLeakCounts(a: LeakCounts, b: LeakCounts): LeakCounts {
  const out = { ...a };
  for (const k of Object.keys(out) as Array<keyof LeakCounts>) out[k] += b[k];
  return out;
}

/** Hard leaks: evidence, lessons or lookups dated after the cutoff, or live lookups. */
export const hardLeaks = (c: LeakCounts) =>
  c.evidenceAfterCutoff + c.lessonsAfterCutoff + c.lookupsLive + c.lookupsAfterCutoff;

export function describeLeakCounts(c: LeakCounts): string {
  return `${c.forecasts} forecasts · evidence ${c.evidenceLines} lines (${c.evidenceAfterCutoff} after the cutoff, ${c.evidenceUndated} undated) · lessons ${c.lessons} (${c.lessonsAfterCutoff} resolved after the cutoff) · lookups ${c.lookups} (${c.lookupsLive} live, ${c.lookupsAfterCutoff} after the cutoff)`;
}
