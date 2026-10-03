// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What every model role is told about a round, in one place, so the research
 * analysts, the crew and the model forecaster all read the same TRUE account:
 *
 *   - what the start forecast actually is (the Civiqs nowcast — the freshest
 *     daily reading, with its date — or the persistence baseline);
 *   - how the round resolves (Civiqs: the dashboard value on the release day,
 *     i.e. the daily readings after the lock, and Civiqs revises its history
 *     nightly) and how it is scored (CRPS skill vs persistence);
 *   - every value with its date (a list of bare numbers invites misreading
 *     weekly samples as daily ones).
 *
 * Pure string building: no I/O, no model.
 */

import type { RoundForecast } from "./forecast";
import type { CiviqsDaily } from "./research/civiqs-nowcast";
import type { ArenaPoint, ArenaRound } from "./types";

export interface Reading {
  date: string;
  value: number;
}

/** The nowcast's reading for this round's series, when the start forecast carries one. */
export function freshestReading(
  start: RoundForecast,
  series: string | undefined,
): Reading | undefined {
  const used = (start as { nowcast?: Record<string, Reading> }).nowcast;
  return series ? used?.[series] : undefined;
}

/** The recent daily series the start forecast carries (Civiqs rounds with `daily` on). */
export function dailyOf(start: RoundForecast): CiviqsDaily | undefined {
  return (start as { daily?: CiviqsDaily }).daily;
}

/** A forecast without the daily series it was given to read (keeps records small). */
export function withoutDaily<T extends RoundForecast>(f: T): T {
  if (!("daily" in f)) return f;
  const { daily: _daily, ...rest } = f as T & { daily?: unknown };
  return rest as T;
}

const DAY_MS = 86_400_000;
const round2 = (x: number) => Math.round(x * 100) / 100;

function weekday(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t)
    ? new Date(t).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })
    : "";
}

/** `date value` lines, oldest first. */
export function datedLines(points: ArenaPoint[] | Reading[], n: number): string {
  return points
    .slice(-n)
    .map((p) => `${p.date} ${p.value}`)
    .join("\n");
}

/** One line naming the start forecast truthfully. */
export function startLine(round: ArenaRound, start: RoundForecast, history: ArenaPoint[]): string {
  const base = start.topline;
  const dist = base ? `{"mean": ${base.mean}, "sd": ${base.sd}}` : "(none)";
  const origin = round.series ? start.origins?.[round.series] : undefined;
  if (origin) {
    const p = origin.projection;
    const rule = p
      ? `horizon policy ${origin.mode}, drift ${p.drift}, damping ${p.phi}; the projected start is ${JSON.stringify(origin.start)}`
      : origin.reason;
    return `Start forecast ${dist}: ${origin.selected === "daily" ? "NOWCAST" : "weekly anchor"} reading ${origin.reading.value} dated ${origin.reading.date}; ${origin.horizonDays} day(s) to resolution ${origin.targetDate}. ${rule}. The reading is an observation, not the future outcome. Project any further change from the start distribution above; do not apply an already included trend twice. Compare changes within the same snapshot: the weekly history and daily snapshot can have different revisions.`;
  }
  const fresh = freshestReading(start, round.series);
  if (fresh) {
    const lead = Math.round(
      (Date.parse(round.release_at.slice(0, 10)) - Date.parse(fresh.date)) / DAY_MS,
    );
    return `Start forecast ${dist}: the NOWCAST — the freshest daily Civiqs reading (${fresh.value}, dated ${fresh.date}), with the baseline's spread; ${lead} day(s) from that reading to the resolution date.`;
  }
  const last = history.at(-1);
  return `Start forecast ${dist}: the persistence baseline — the last published value${last ? ` (${last.value} on ${last.date})` : ""} with a spread sized to how this series moves.`;
}

/** The resolution and scoring rules, stated plainly. */
export function rulesLines(round: ArenaRound): string[] {
  const day = round.release_at.slice(0, 10);
  const resolution =
    round.tracker === "civiqs"
      ? `Resolution: the value the Civiqs dashboard shows for this series on ${weekday(round.release_at)} ${day} — i.e. the daily reading(s) after the lock, as published then. Civiqs re-estimates its whole daily history every night, so recent days (the start reading included) can still be revised before then.`
      : `Resolution: the next value this source publishes (expected around ${day}).`;
  return [
    resolution,
    "Scoring: CRPS of your normal {mean, sd} against that value; skill = 1 − CRPS / CRPS(persistence), where persistence is the last published value with sd 1.5, averaged per round. Moving the mean on weak evidence loses skill; a too-narrow sd is punished hard, a too-wide one wastes skill.",
  ];
}

/** The history block, labeled for what it is. */
export function historyBlock(round: ArenaRound, history: ArenaPoint[], n: number): string {
  const label =
    round.tracker === "civiqs"
      ? "Weekly history — the arena's published values for this series, one per week (date value, oldest first)"
      : "History — the benchmark's published values (date value, oldest first)";
  return `${label}:\n${datedLines(history, n) || "(none)"}`;
}

/** The daily tracker block (the quant's input), or "" when there is none. */
export function dailyBlock(daily: CiviqsDaily | undefined): string {
  if (!daily?.points.length) return "";
  const pts = daily.points;
  const change = pts.length > 1 ? round2(pts.at(-1)!.value - pts[0]!.value) : 0;
  return `DAILY TRACKER — the Civiqs daily series this round resolves on, as snapshot ${daily.source} showed it (date value, oldest first; ${pts.length} days, net change ${change >= 0 ? "+" : ""}${change}; recent days can still be revised):\n${datedLines(pts, pts.length)}`;
}
