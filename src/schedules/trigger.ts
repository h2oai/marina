// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * When a schedule runs. Pure: parse a trigger, render it, and compute the next
 * run from WALL-CLOCK time (never tick counts, so a restart or a stalled tick
 * never shifts the schedule).
 *
 *   every:<dur>              repeating, anchored to the previous due time
 *   daily:HH:MM              every day at that UTC time
 *   at:<ISO time>            once
 *   before:<ISO time> lead:<dur>   once, `lead` before a deadline
 *
 * Missed runs (the server was down, or busy past the slot) follow the
 * schedule's catch-up policy: `once` runs one late run now, then returns to the
 * cadence; `none` skips to the next slot. A one-shot `before:` run is never
 * run after its deadline (`missed`).
 */

import { parseDuration } from "../engine/commands/format-duration";

export type Trigger =
  | { kind: "every"; everyMs: number }
  | { kind: "daily"; minuteOfDay: number }
  | { kind: "at"; at: number }
  | { kind: "before"; deadline: number; leadMs: number };

export type CatchUp = "none" | "once";

const DAY_MS = 86_400_000;

/** Parse one trigger from its modifiers; an error message when it is not a valid trigger. */
export function parseTrigger(mods: {
  every?: string;
  daily?: string;
  at?: string;
  before?: string;
  lead?: string;
}): Trigger | { error: string } {
  const given = (["every", "daily", "at", "before"] as const).filter((k) => mods[k] !== undefined);
  if (given.length === 0)
    return {
      error: "give one trigger: every:<dur>, daily:HH:MM, at:<time> or before:<time> lead:<dur>",
    };
  if (given.length > 1) return { error: `give one trigger, not ${given.join(" and ")}` };
  if (mods.lead !== undefined && given[0] !== "before")
    return { error: "lead: goes with before:<time>" };
  switch (given[0]) {
    case "every": {
      const ms = parseDuration(mods.every);
      if (!ms || ms <= 0)
        return { error: `every:${mods.every} is not a duration (e.g. 30m, 6h, 1d)` };
      return { kind: "every", everyMs: ms };
    }
    case "daily": {
      const m = /^(\d{1,2}):(\d{2})$/.exec(mods.daily ?? "");
      const h = m ? Number(m[1]) : Number.NaN;
      const min = m ? Number(m[2]) : Number.NaN;
      if (!m || h > 23 || min > 59) return { error: `daily:${mods.daily} is not HH:MM (UTC)` };
      return { kind: "daily", minuteOfDay: h * 60 + min };
    }
    case "at": {
      const at = parseTime(mods.at);
      if (at === undefined)
        return { error: `at:${mods.at} is not an ISO time (e.g. 2026-10-14T13:00Z)` };
      return { kind: "at", at };
    }
    case "before": {
      const deadline = parseTime(mods.before);
      if (deadline === undefined)
        return { error: `before:${mods.before} is not an ISO time (e.g. 2026-10-14T14:00Z)` };
      const leadMs = mods.lead === undefined ? 0 : parseDuration(mods.lead);
      if (leadMs === undefined || leadMs < 0)
        return { error: `lead:${mods.lead} is not a duration` };
      return { kind: "before", deadline, leadMs };
    }
  }
  return { error: "unknown trigger" };
}

/** An ISO-like time with an explicit zone (`Z` or an offset); a bare date means 00:00 UTC. */
function parseTime(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  const zoned = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/i.test(s);
  if (!zoned) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

export function renderTrigger(t: Trigger): string {
  switch (t.kind) {
    case "every":
      return `every ${renderDuration(t.everyMs)}`;
    case "daily": {
      const h = String(Math.floor(t.minuteOfDay / 60)).padStart(2, "0");
      const m = String(t.minuteOfDay % 60).padStart(2, "0");
      return `daily ${h}:${m} UTC`;
    }
    case "at":
      return `at ${new Date(t.at).toISOString()}`;
    case "before":
      return `${renderDuration(t.leadMs)} before ${new Date(t.deadline).toISOString()}`;
  }
}

function renderDuration(ms: number): string {
  for (const [unit, size] of [
    ["d", DAY_MS],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1000],
  ] as const)
    if (ms % size === 0) return `${ms / size}${unit}`;
  return `${ms}ms`;
}

/** The smallest interval between two runs (one-shot triggers have none). */
export function intervalMs(t: Trigger): number | undefined {
  if (t.kind === "every") return t.everyMs;
  if (t.kind === "daily") return DAY_MS;
  return undefined;
}

/** The first run time of a new schedule created at `now`; null when it can never run. */
export function firstRun(t: Trigger, now: number): number | null {
  switch (t.kind) {
    case "every":
      return now + t.everyMs;
    case "daily":
      return nextDaily(t.minuteOfDay, now);
    case "at":
      return t.at > now ? t.at : null;
    case "before": {
      if (t.deadline <= now) return null;
      return Math.max(now, t.deadline - t.leadMs);
    }
  }
}

function nextDaily(minuteOfDay: number, after: number): number {
  const dayStart = Math.floor(after / DAY_MS) * DAY_MS;
  const today = dayStart + minuteOfDay * 60_000;
  return today > after ? today : today + DAY_MS;
}

export interface DueDecision {
  /** Run now (true) or record the slot as missed (false). */
  run: boolean;
  /** The next run time after this one; null when the schedule is finished. */
  next: number | null;
}

/**
 * What to do with a schedule whose `dueAt` has come at `now`. A late repeating
 * schedule runs once (`once`) or skips (`none`) and returns to its cadence; a
 * late one-shot runs if catch-up allows and its deadline has not passed.
 */
export function decideDue(t: Trigger, dueAt: number, now: number, catchUp: CatchUp): DueDecision {
  const interval = intervalMs(t);
  if (interval !== undefined) {
    // Next slot on the cadence strictly after now (anchored to dueAt, or to the UTC day).
    const next =
      t.kind === "daily"
        ? nextDaily(t.minuteOfDay, now)
        : dueAt + Math.max(1, Math.ceil((now - dueAt + 1) / interval)) * interval;
    const late = now - dueAt >= interval;
    return { run: !late || catchUp === "once", next };
  }
  if (t.kind === "before" && now >= t.deadline) return { run: false, next: null };
  const late = now - dueAt > LATE_GRACE_MS;
  return { run: !late || catchUp === "once", next: null };
}

/** A one-shot run within this long after its time is on time, not a catch-up. */
export const LATE_GRACE_MS = 5 * 60_000;
