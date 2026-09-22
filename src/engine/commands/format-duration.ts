// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Format milliseconds as short human-readable duration (e.g. "3h 12m"). */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  mo: 30 * 86_400_000,
};

/** Long spellings collapse onto the canonical unit letters above. */
const DURATION_UNIT_ALIASES: Record<string, keyof typeof DURATION_UNITS> = {
  sec: "s",
  secs: "s",
  second: "s",
  seconds: "s",
  min: "m",
  mins: "m",
  minute: "m",
  minutes: "m",
  hr: "h",
  hrs: "h",
  hour: "h",
  hours: "h",
  day: "d",
  days: "d",
  wk: "w",
  wks: "w",
  week: "w",
  weeks: "w",
  month: "mo",
  months: "mo",
};

const UNIT_RANK: Record<string, number> = { s: 0, m: 1, h: 2, d: 3, w: 4, mo: 5 };

export interface ParseDurationOptions {
  /**
   * Smallest unit accepted. `market live` windows are day-scale, so it passes
   * `"h"` and a bare `1m` (minutes) is rejected rather than misread — the
   * historical `market.parseDurationMs` behaviour.
   */
  minUnit?: "s" | "m" | "h" | "d";
}

/**
 * Parse a duration token into ms. ONE grammar for every command surface:
 * `30s`, `5m` (minutes), `2h`, `1d`, `1w`, `1mo` (months, 30 days); long
 * spellings (`5min`, `2hours`, `1month`) are accepted too. Returns undefined
 * on failure. `m` is ALWAYS minutes; months are `mo`.
 */
export function parseDuration(
  arg: string | undefined,
  opts: ParseDurationOptions = {},
): number | undefined {
  if (!arg) return undefined;
  const m = arg.match(/^(\d+)\s*([a-z]+)$/i);
  if (!m) return undefined;
  const n = Number.parseInt(m[1]!, 10);
  const spelled = m[2]!.toLowerCase();
  const unit = DURATION_UNITS[spelled] !== undefined ? spelled : DURATION_UNIT_ALIASES[spelled];
  if (!unit) return undefined;
  if (opts.minUnit && UNIT_RANK[unit]! < UNIT_RANK[opts.minUnit]!) return undefined;
  return n * DURATION_UNITS[unit]!;
}

/** Parse a "30m" / "2h" / "1d" / "1w" / "1mo" since-window into ms. undefined on failure.
 *  Alias of `parseDuration` kept for the feed/chronicle callers (m = minutes). */
export function parseSince(arg: string | undefined): number | undefined {
  return parseDuration(arg);
}

/** The unit legend shown in usage strings and modifier errors. */
export const DURATION_UNITS_HINT = "30s, 5m, 2h, 1d, 1w, 1mo";

/** Friendly single-unit relative age: "42s", "3m", "5h", "2d" (rounded). */
export function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Format milliseconds as full duration with days (e.g. "2d 3h 12m 5s"). */
export function formatDurationFull(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}
