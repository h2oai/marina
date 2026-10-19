// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What a required-research forecaster files when its research fails
 * (`MARINA_ARENA_RESEARCH_FALLBACK`, read only when
 * `MARINA_ARENA_RESEARCH_REQUIRED=on`):
 *
 *   closed-book (default)  the same forecaster without the dossier; if that
 *                          errors or keeps its start, the start forecast
 *   start                  the start forecast at once
 *   skip                   the old refusal: no filing, the round is skipped
 *                          (an existing accepted filing stays)
 *
 * "Failed" means: no verified evidence, a failed or unfinished research loop,
 * closed-book retrieval, no successful reader, a research judge that grounded
 * no proposal, or a formation with no usable proposal over the dossier. A
 * fallback filing records `researchFallback` in its detail and says so in its
 * note; the anchor guard, error floor and spread calibration apply to it as to
 * any filing, and its method is keyed closed-book (`calibration.ts`
 * `methodOf`), never as researched.
 */

import type { RoundForecast } from "./forecast";

export type ResearchFallbackMode = "closed-book" | "start" | "skip";

/** `MARINA_ARENA_RESEARCH_FALLBACK`: `closed-book` (default), `start`, `skip`. */
export function researchFallbackModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResearchFallbackMode {
  const m = env.MARINA_ARENA_RESEARCH_FALLBACK?.trim().toLowerCase();
  return m === "start" || m === "skip" ? m : "closed-book";
}

/** The audit record on a fallback filing (`forecast.researchFallback`). */
export interface ResearchFallbackRecord {
  mode: Exclude<ResearchFallbackMode, "skip">;
  /** Why required research failed. */
  reason: string;
  /** What was filed instead. */
  used: "closed-book" | "start";
  /** Why the closed-book run was not filed, when it was tried and the start was filed. */
  closedBookError?: string;
  /** What the failed research had already spent (retrieval + judge), still owed to the ledgers. */
  failedCostUsd?: number;
}

/** The note marker `methodOf` reads: a fallback filing is not a researched one. */
export const RESEARCH_FALLBACK_NOTE = /research fallback \((closed-book|start)\)/;

/** The forecast marked as a research fallback (detail record + note). */
export function markResearchFallback<T extends RoundForecast>(
  f: T,
  record: ResearchFallbackRecord,
): T & { researchFallback: ResearchFallbackRecord } {
  const why = record.reason.replace(/\s+/g, " ").slice(0, 160);
  return {
    ...f,
    researchFallback: record,
    note: `${f.note}; research fallback (${record.used}): ${why}`,
  };
}
