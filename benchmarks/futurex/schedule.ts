// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The watcher's cadence for one FutureX batch, as pure functions over the
 * batch, its standing answers and its run schedule (`out/<sha>/schedule.json`):
 *
 *   - `batchDeadline`: the batch's submission deadline, derived from the batch
 *     itself — never from when this machine happened to fetch it;
 *   - `scheduleState`: when the last run started and whether one is still
 *     running (a run is recorded when it STARTS and marked when it ends);
 *   - `dailyRows`: which open rows a daily re-forecast touches.
 *
 * The cadence itself (`dueRun`) and the revision rule are generic
 * (`src/forecast/revision.ts`).
 */

import { nextWeeklyDeadline, type StandingAnswer } from "../../src/forecast/revision";
import type { FuturexBatch, FuturexRow } from "./dataset";
import { endTimeIso } from "./map";

/** FutureX's weekly submission deadline: Wednesday 16:00 UTC. */
export const DEADLINE_WEEKDAY = 3;
export const DEADLINE_HOUR_UTC = 16;

export interface ScheduleEntry {
  /** ISO time the run started. */
  at: string;
  kind: string;
  variants: string[];
  /** `running` from the start until the run ends; absent on entries written before it existed. */
  status?: "running" | "done" | "failed";
  finishedAt?: string;
  /** Rows forecast per variant. */
  rows?: Record<string, number>;
  error?: string;
}

export interface Schedule {
  runs: ScheduleEntry[];
}

const endMs = (r: FuturexRow) => Date.parse(endTimeIso(r.end_time) ?? "") || 0;

/**
 * The batch's deadline: the first weekly deadline (Wednesday 16:00 UTC) strictly
 * after the batch was PUBLISHED — the Hugging Face commit time of its sha — and
 * never later than its last row's end time (a deadline after every question has
 * closed is no deadline). A batch saved before the publication time was recorded
 * falls back to when it was first fetched. A batch first seen after its deadline
 * therefore has a deadline in the past and gets no daily re-forecasts.
 */
export function batchDeadline(
  batch: Pick<FuturexBatch, "fetchedAt" | "publishedAt" | "rows">,
  weekday = DEADLINE_WEEKDAY,
  hourUtc = DEADLINE_HOUR_UTC,
): { deadline: Date; basis: "published" | "fetched"; boundedByEnd: boolean } {
  const basis = batch.publishedAt ? "published" : "fetched";
  const anchor = new Date(batch.publishedAt ?? batch.fetchedAt);
  const weekly = nextWeeklyDeadline(anchor, weekday, hourUtc);
  const lastEnd = Math.max(0, ...batch.rows.map(endMs));
  if (lastEnd > 0 && lastEnd < weekly.getTime()) {
    return { deadline: new Date(lastEnd), basis, boundedByEnd: true };
  }
  return { deadline: weekly, basis, boundedByEnd: false };
}

/**
 * Where the schedule stands at `now`: when the last run started (finished or
 * not — an abandoned run still used its slot) and, when the last run never
 * recorded its end, when it started (`dueRun` treats it as in progress for a
 * few hours).
 */
export function scheduleState(schedule: Schedule): {
  lastRunAt?: string;
  inProgressSince?: string;
} {
  const last = schedule.runs.at(-1);
  if (!last) return {};
  return {
    lastRunAt: last.at,
    ...(last.status === "running" ? { inProgressSince: last.at } : {}),
  };
}

export type DailyRowsMode = "all" | "stale";
export const DAILY_ROWS_MODES: readonly DailyRowsMode[] = ["all", "stale"];

const noAnswer = (a: StandingAnswer | undefined) =>
  !a || a.fallback === true || a.prediction.trim() === "";

/**
 * The rows a daily re-forecast touches. Only open rows (end time after `now`)
 * are ever re-forecast; `all` takes every one of them, `stale` only those whose
 * standing answer is missing or a fallback, or whose end time is within
 * `nearEndMs` of now (the last chance to revise it on fresh news). Revision
 * semantics are unchanged: whatever is re-forecast still replaces a standing
 * answer only on a material change.
 */
export function dailyRows(
  rows: readonly FuturexRow[],
  standing: Readonly<Record<string, StandingAnswer>>,
  now: Date,
  opts: { mode: DailyRowsMode; nearEndMs: number },
): FuturexRow[] {
  const t = now.getTime();
  const open = rows.filter((r) => endMs(r) > t);
  if (opts.mode === "all") return open;
  return open.filter((r) => noAnswer(standing[r.id]) || endMs(r) - t <= opts.nearEndMs);
}
