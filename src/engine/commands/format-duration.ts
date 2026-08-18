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

const SINCE_UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parse a "30m" / "2h" / "1d" / "1w" since-window into ms. undefined on failure.
 *  Single source of truth for the feed/chronicle since-grammar (m = minutes). */
export function parseSince(arg: string | undefined): number | undefined {
  if (!arg) return undefined;
  const m = arg.match(/^(\d+)\s*([smhdw])$/i);
  if (!m) return undefined;
  const n = Number.parseInt(m[1]!, 10);
  const unit = SINCE_UNITS[m[2]!.toLowerCase()];
  if (!unit) return undefined;
  return n * unit;
}

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
