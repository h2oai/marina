// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Expiry of dead memory-assistance jobs (2026-10-20).
 *
 * The hygiene / accumulation / shared-write dispatch files jobs against a
 * helper (memory-evaluator, memory-reflector, librarian). When the helper
 * stops, its open jobs stay `pending`/`running` for ever: `active()` refuses
 * every action once the deadline passes, but the state column never moved,
 * so the backlog read as live work (334 pending + 15 running on the live
 * world after the Evaluator left).
 *
 * The hourly pass closes them with a clear status: state `expired`, one
 * `assistance.expired.<deadline|worker_absent>` memory event each (actor
 * `system:assistance-expiry`) and one log line with the counts. A job is
 * expired when its deadline (or its root's cancellation) has passed, or when
 * its worker's world account has no running agent and no live connection and
 * the job is older than `ASSISTANCE_ABSENT_GRACE_MS` with no live lease.
 * Workers that are not world accounts (an external service principal) are
 * never judged absent. Nothing is deleted; `ops assistance restore <id>`
 * reopens an expired job whose deadline is still ahead.
 */

import type { MarinaDB } from "../persistence/database";
import type { AssistanceExpiry, AssistanceExpiryReason } from "../persistence/db-memory-assistance";
import type { EntityId } from "../types";
import type { Engine } from "./engine";

/** Hourly phase (distinct from every other hourly job in tick-jobs.ts). */
export const ASSISTANCE_EXPIRY_PHASE = 1950;

export interface AssistanceExpiryDeps {
  db: MarinaDB;
  /** Is the world account `name` live — a running agent or a connected entity? */
  isPresent(name: string): boolean;
}

export interface AssistanceExpiryReport {
  applied: boolean;
  expired: AssistanceExpiry[];
  byReason: Record<AssistanceExpiryReason, number>;
  /** `role:count` per helper role, for the log line. */
  byRole: Record<string, number>;
}

/** Worker principal ids among open jobs whose world account is not live. */
export function absentWorkers(deps: AssistanceExpiryDeps): Set<string> {
  const raw = deps.db.memoryRepository().raw;
  const workers = raw
    .query(
      "SELECT DISTINCT worker_id FROM memory_assistance_jobs WHERE state IN ('pending','running')",
    )
    .all() as { worker_id: string }[];
  const absent = new Set<string>();
  for (const { worker_id } of workers) {
    const user = deps.db.getUser(worker_id);
    // Not a world account: an external service principal we cannot see.
    if (!user) continue;
    if (!deps.isPresent(user.name)) absent.add(worker_id);
  }
  return absent;
}

/** One pass. `apply: false` reports what would expire and changes nothing. */
export function runAssistanceExpiry(
  deps: AssistanceExpiryDeps,
  options: { apply?: boolean; now?: number } = {},
): AssistanceExpiryReport {
  const apply = options.apply !== false;
  const expired = deps.db.memoryRepository().assistance.expireStale({
    ...(options.now === undefined ? {} : { now: options.now }),
    absentWorkers: absentWorkers(deps),
    apply,
  });
  const byReason: Record<AssistanceExpiryReason, number> = { deadline: 0, worker_absent: 0 };
  const byRole: Record<string, number> = {};
  for (const job of expired) {
    byReason[job.reason]++;
    byRole[job.role] = (byRole[job.role] ?? 0) + 1;
  }
  return { applied: apply, expired, byReason, byRole };
}

/** One-line summary: `expired 349 (deadline 349, worker absent 0; evaluator 349)`. */
export function formatAssistanceExpiry(report: AssistanceExpiryReport): string {
  const roles = Object.entries(report.byRole)
    .map(([role, n]) => `${role} ${n}`)
    .join(", ");
  const verb = report.applied ? "expired" : "would expire";
  return `${verb} ${report.expired.length} (deadline ${report.byReason.deadline}, worker absent ${report.byReason.worker_absent}${roles ? `; ${roles}` : ""})`;
}

/** The engine's view of presence: a running agent, or a live connected entity. */
export function engineAssistanceExpiryDeps(engine: Engine, db: MarinaDB): AssistanceExpiryDeps {
  return {
    db,
    isPresent: (name) => {
      if (engine.agentRuntime.get(name)) return true;
      const entity = engine.entities.findAgentByName(name);
      return !!entity && engine.getConnectionForEntity(entity.id as EntityId) !== undefined;
    },
  };
}
