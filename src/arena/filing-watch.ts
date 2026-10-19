// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Watch the arena filings of rounds about to lock. Filing itself is an
 * operator act outside the world (`bun run arena`, the operator's timers);
 * this watch only READS what those runs recorded in the world DB
 * (`arena_submissions`, `arena_attempts`) against the open rounds, and raises
 * an operational alert per round in trouble, resolved once it is fine again.
 * An outage of the outside runner — a broken build, a failing timer — is then
 * visible within one pass instead of after the lock.
 */

import type { ArenaStore } from "../persistence/interfaces/arena-store";
import { type AnchorReference, describeStale, filedAnchorCheck } from "./anchor";
import { roundHealth } from "./health";
import type { ArenaRound } from "./types";

/** Rounds locking within this many hours are watched. */
export const WATCH_WINDOW_HOURS = 24;
/** An unfiled round this close to its lock is critical. */
const CRITICAL_UNFILED_HOURS = 6;
/** Inside this many hours of the lock, the near-lock refresh should have run… */
const NEAR_LOCK_HOURS = 0.75;
/** …within this long (the operator's near-lock pass runs about an hour before lock). */
const NEAR_LOCK_ACTIVITY_MS = 90 * 60_000;
/** A refresh still "started" after this long is stuck. */
const STUCK_ATTEMPT_MS = 30 * 60_000;

export type FilingProblem =
  | "unfiled"
  | "not-refreshed"
  | "failed-refresh"
  | "stuck-refresh"
  | "no-near-lock-refresh"
  | "stale-anchor";

export interface FilingFinding {
  roundId: string;
  lockAt: string;
  severity: "critical" | "warning";
  problem: FilingProblem;
  detail: string;
}

/**
 * Problems with the filings of rounds locking within {@link WATCH_WINDOW_HOURS},
 * plus — for EVERY open round, given the arena's latest values (`references`,
 * `ArenaData.anchorReference`) — an accepted filing anchored on an older
 * release than the arena's (`stale-anchor`; critical within 6 h of the lock).
 */
export function filingFindings(
  rounds: readonly ArenaRound[],
  store: ArenaStore,
  entrant: string,
  now = Date.now(),
  references?: ReadonlyMap<string, AnchorReference>,
): FilingFinding[] {
  const out: FilingFinding[] = [];
  for (const round of rounds) {
    const lockIn = (Date.parse(round.lock_at) - now) / 3_600_000;
    if (!(lockIn > 0)) continue;
    const accepted = store.acceptedArenaSubmission(entrant, round.round_id);
    const filed = accepted
      ? filedAnchorCheck(round, accepted, references?.get(round.round_id))
      : undefined;
    if (filed?.stale) {
      out.push({
        roundId: round.round_id,
        lockAt: round.lock_at,
        severity: lockIn <= CRITICAL_UNFILED_HOURS ? "critical" : "warning",
        problem: "stale-anchor",
        detail: `the accepted filing is anchored on an older release than the arena's — ${describeStale(filed)}; locks in ${lockIn.toFixed(1)} h`,
      });
    }
    if (!(lockIn <= WATCH_WINDOW_HOURS)) continue;
    const h = roundHealth(round, store, entrant, now);
    const base = { roundId: round.round_id, lockAt: round.lock_at };
    const hours = lockIn.toFixed(1);
    if (h.state === "unfiled") {
      out.push({
        ...base,
        severity: lockIn <= CRITICAL_UNFILED_HOURS ? "critical" : "warning",
        problem: "unfiled",
        detail: `no accepted filing; locks in ${hours} h${h.lastAttempt ? ` (last attempt ${h.lastAttempt.status}${h.lastAttempt.reason ? `: ${h.lastAttempt.reason}` : ""})` : ""}`,
      });
      continue;
    }
    const acceptedAt = h.accepted ? Date.parse(h.accepted.at) : 0;
    const attemptAt = h.lastAttempt ? Date.parse(h.lastAttempt.at) : 0;
    // Filed before this lock's refresh window and nothing has tried since: a
    // runner that crashes before recording an attempt (a broken build) leaves
    // only this trace. The stale filing is scored against a persistence baseline
    // frozen on fresher data; an unanswered round would have scored nothing.
    const windowStart = Date.parse(round.lock_at) - WATCH_WINDOW_HOURS * 3_600_000;
    if (acceptedAt < windowStart && attemptAt < windowStart) {
      out.push({
        ...base,
        severity: lockIn <= CRITICAL_UNFILED_HOURS ? "critical" : "warning",
        problem: "not-refreshed",
        detail: `the filing from ${h.accepted?.at} predates this round's refresh window and no refresh has run; locks in ${hours} h`,
      });
    }
    if (h.lastAttempt?.unfinished && now - attemptAt > STUCK_ATTEMPT_MS) {
      out.push({
        ...base,
        severity: "warning",
        problem: "stuck-refresh",
        detail: `a refresh started ${Math.round((now - attemptAt) / 60_000)} min ago never finished; locks in ${hours} h`,
      });
    } else if (
      h.lastAttempt &&
      !h.lastAttempt.unfinished &&
      attemptAt > acceptedAt &&
      ["error", "rejected", "skipped"].includes(h.lastAttempt.status)
    ) {
      out.push({
        ...base,
        severity: "warning",
        problem: "failed-refresh",
        detail: `last refresh ${h.lastAttempt.status}${h.lastAttempt.reason ? `: ${h.lastAttempt.reason}` : ""}; the filing from ${h.accepted?.at} stands; locks in ${hours} h`,
      });
    }
    if (
      !filed?.stale &&
      h.lastAttempt &&
      !h.lastAttempt.unfinished &&
      h.lastAttempt.status === "stale_anchor"
    ) {
      out.push({
        ...base,
        severity: "warning",
        problem: "stale-anchor",
        detail: `the last refresh found Marina's inputs older than the arena's latest release${h.lastAttempt.reason ? `: ${h.lastAttempt.reason}` : ""}; locks in ${hours} h`,
      });
    }
    if (
      lockIn <= NEAR_LOCK_HOURS &&
      now - Math.max(acceptedAt, attemptAt) > NEAR_LOCK_ACTIVITY_MS
    ) {
      out.push({
        ...base,
        severity: "warning",
        problem: "no-near-lock-refresh",
        detail: `no refresh in the last ${Math.round((now - Math.max(acceptedAt, attemptAt)) / 60_000)} min; locks in ${Math.round(lockIn * 60)} min — the near-lock pass did not run`,
      });
    }
  }
  return out;
}

export interface FilingWatchResult {
  checkedAt: number;
  /** Rounds locking within the window. */
  watched: number;
  findings: FilingFinding[];
  /** The open rounds could not be read (network, arena data source). */
  error?: string;
}

let lastResult: FilingWatchResult | undefined;

/** The most recent watch pass in this process (readiness reads it). */
export function lastFilingWatch(): FilingWatchResult | undefined {
  return lastResult;
}

/** Test seam: forget the last pass. */
export function resetFilingWatchForTests(): void {
  lastResult = undefined;
}

/** Record a pass (the tick job calls this with what it found). */
export function recordFilingWatch(result: FilingWatchResult): FilingWatchResult {
  lastResult = result;
  return result;
}
