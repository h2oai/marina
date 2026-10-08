// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RoundForecast } from "./forecast";
import type { ArenaLock, ArenaPoint, ArenaRound } from "./types";

const DAY_MS = 86_400_000;

/** Open forecasts use today's information; replays remain bounded by their lock. */
export function forecastCutoff(lockAt: string, asOf = lockAt, now = Date.now()): string {
  const at = Math.min(Date.parse(lockAt), Date.parse(asOf), now);
  if (!Number.isFinite(at)) throw new Error("invalid forecast information cutoff");
  return new Date(at).toISOString();
}

export interface FreshnessAudit {
  asOf: string;
  ok: boolean;
  readings: Record<string, { date?: string; ageDays?: number; maxAgeDays: number }>;
  issues: string[];
}

function validDay(day: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(day)) &&
    new Date(day).toISOString().slice(0, 10) === day
  );
}

function maximumAge(round: ArenaRound, history: ArenaPoint[]): number {
  // These sources publish daily, even though their arena questions are weekly.
  if (round.tracker === "civiqs") return 2;
  if (round.tracker === "wikipedia") return 4; // two-day publication lag plus tolerance
  if (round.tracker === "google_trends" || round.tracker.includes("yougov")) return 14;
  // Monthly period labels are not daily publication dates. Permit two normal
  // releases, rather than rejecting a legitimate monthly series after two days.
  const gaps = history
    .slice(1)
    .map((p, i) => (Date.parse(p.date) - Date.parse(history[i]!.date)) / DAY_MS)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  return Math.max(14, 2 * (gaps[Math.floor(gaps.length / 2)] ?? 7));
}

/** Check observation dates, never the date an old observation was downloaded. */
export function auditForecastFreshness(
  round: ArenaRound,
  lock: ArenaLock,
  forecast: RoundForecast,
  asOf = forecastCutoff(round.lock_at),
): FreshnessAudit {
  const issues: string[] = [];
  const readings: FreshnessAudit["readings"] = {};
  const ids =
    round.target_type === "profile_energy"
      ? (round.cells ?? [])
      : [round.series ?? (round.target_type === "ranking_list" ? "ranking" : "topline")];
  const today = Date.parse(asOf.slice(0, 10));
  if (!Number.isFinite(today)) throw new Error("invalid freshness audit date");
  if (!ids.length) issues.push("no target cells to audit");
  for (const id of ids) {
    const history =
      round.target_type === "profile_energy"
        ? (lock.answer_history_by_cell?.[id] ?? [])
        : (lock.answer_history ?? lock.history ?? []);
    const date =
      forecast.origins?.[id]?.reading.date ??
      forecast.freshness?.readings[id]?.date ??
      (round.target_type === "ranking_list"
        ? lock.answer_obs
            ?.map((o) => o.date)
            .sort()
            .at(-1)
        : history.at(-1)?.date);
    const maxAgeDays = maximumAge(round, history);
    const ageDays =
      date && validDay(date) ? Math.floor((today - Date.parse(date)) / DAY_MS) : undefined;
    readings[id] = { date, ageDays, maxAgeDays };
    if (ageDays === undefined) issues.push(`${id}: missing or invalid observation date`);
    else if (ageDays < 0 && round.tracker !== "google_trends")
      issues.push(`${id}: observation is after the information cutoff`);
    else if (ageDays > maxAgeDays)
      issues.push(`${id}: observation ${date} is ${ageDays} days old (maximum ${maxAgeDays})`);
  }
  return { asOf, ok: issues.length === 0, readings, issues };
}

export function requireFreshForecast<T extends RoundForecast>(
  round: ArenaRound,
  lock: ArenaLock,
  forecast: T,
  asOf?: string,
): T {
  const freshness = auditForecastFreshness(round, lock, forecast, asOf);
  if (!freshness.ok)
    throw new Error(
      `stale forecast inputs; keeping any accepted submission: ${freshness.issues.join("; ")}`,
    );
  return { ...forecast, freshness };
}
