// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Standing — single blended civic-contribution metric.
 *
 * Replaces the prior task-only `entity_standing` view with a unified ledger
 * that absorbs every contribution stream: task completion, pool note
 * deposits, crew leadership, helping acts, recalled reflections. Rank is
 * derived from this number (later phase); safety gates check it as a
 * necessary-but-not-sufficient signal.
 *
 * Storage: ledger rows in `entity_standing` (one per event, idempotent on
 * `(entity_id, kind, ref)`), rollup in `entity_standing_cache`. Permission
 * checks hit the cache; the ledger is recomputed periodically by the engine
 * tick, on stale read, or on demand.
 *
 * Decay: exponential with a 60-day half-life. Recent contribution dominates;
 * a quarter of effort persists past six months. Floor at 0 — sustained-
 * penalty entities don't go negative; civic exclusion is a separate
 * procedure, not a sub-zero number.
 */

import type { MarinaDB } from "../persistence/database";
import type { EngineEvent } from "../types";

/** Half-life in days. Tunable via STANDING_HALF_LIFE_DAYS env var. */
export const STANDING_HALF_LIFE_DAYS = Math.max(
  1,
  Number.parseFloat(process.env.STANDING_HALF_LIFE_DAYS ?? "60"),
);

const HALF_LIFE_MS = STANDING_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;

/** Events older than this don't contribute to the rollup (still ledgered). */
const ROLLUP_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

/** Cache freshness — beyond this, a read triggers a recompute. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Contribution kinds. Each carries a different default amount; the credit
 * table at `STANDING_AMOUNTS` is the source of truth. Add new kinds here +
 * in the amounts table together; consumers stay decoupled from the values.
 */
export type StandingKind =
  | "task_complete"
  | "quest_complete"
  | "pool_note"
  | "reflection_recalled"
  | "crew_complete_member"
  | "crew_complete_lead"
  | "crew_stage_completed"
  | "crew_artifact_deposited"
  | "helping_act"
  | "crew_member_stalled"
  | "experiment_complete"
  | "chronicled";

/**
 * Default amounts per kind. Callers can override via the `amount` arg to
 * `record()` (e.g. tasks pass their `task.standing` value). Negatives are
 * penalties — the rollup floors at 0 so a chronic-stall entity won't go
 * sub-zero.
 */
export const STANDING_AMOUNTS: Record<StandingKind, number> = {
  task_complete: 0, // overridden per-task by caller
  // Completing an onboarding/tutorial quest is a real (if modest) first act of
  // engagement — it should advance progression so the obvious onboarding path
  // isn't a dead end. Kept small: it moves a newcomer toward Citizen (rank 1 =
  // 5) without, on its own, clearing capability gates (e.g. code.exec = 5).
  quest_complete: 3,
  pool_note: 1,
  reflection_recalled: 0.5,
  crew_complete_member: 5,
  crew_complete_lead: 10,
  crew_stage_completed: 2,
  crew_artifact_deposited: 1,
  helping_act: 1,
  crew_member_stalled: -3,
  // Running a controlled comparison to a decided outcome is real contribution
  // (designing arms, gathering samples, recording a reusable result).
  experiment_complete: 3,
  // Default carries no credit; callers pass amount by chronicle entry kind
  // (event ≈ 0.25, narrative ≈ 2.0, digest ≈ 1.0, correction ≈ 0.5).
  // Being chronicled is recognition, not contribution — the entity already
  // got contribution credit (task_complete, crew_*, pool_note) at the time
  // of the act. This is the second-order layer.
  chronicled: 0,
};

/**
 * Idempotent ledger write. Re-recording the same `(entity_id, kind, ref)`
 * is a no-op (UNIQUE index + ON CONFLICT IGNORE). Callers can fire freely
 * without dedup logic — the entity completing a task and the same task
 * firing a `task_approved` event both route to the same row.
 */
export function record(
  db: MarinaDB,
  entityId: string,
  entityName: string,
  kind: StandingKind,
  ref: string,
  amount?: number,
  taskId?: number,
): void {
  const finalAmount = amount ?? STANDING_AMOUNTS[kind];
  if (finalAmount === 0 && kind !== "task_complete") {
    // Skip zero-credit events except task_complete (zero is a real value
    // for task standing — `task !0` means "no civic credit, just done").
    return;
  }
  db.appendStandingEvent({
    entityId,
    entityName,
    kind,
    ref,
    taskId: taskId ?? null,
    amount: finalAmount,
  });
}

/**
 * Compute the decayed standing for an entity from the ledger. Floors at 0.
 */
export function computeFromLedger(db: MarinaDB, entityId: string, now = Date.now()): number {
  const raw = db.computeStanding(entityId, HALF_LIFE_MS, ROLLUP_HORIZON_MS, now);
  return Math.max(0, raw);
}

/**
 * Read the cached standing, recomputing if stale. This is the hot path for
 * permission checks — call this, not `computeFromLedger`, on every gate.
 */
export function getStanding(db: MarinaDB, entityId: string, now = Date.now()): number {
  const cache = db.getStandingCache(entityId);
  if (cache && now - cache.last_recomputed < CACHE_TTL_MS) {
    return cache.standing;
  }
  const fresh = computeFromLedger(db, entityId, now);
  db.setStandingCache(entityId, fresh, now);
  return fresh;
}

/**
 * Periodic engine-tick recompute pass. Refreshes every cache row.
 */
export function recomputeAll(db: MarinaDB, now = Date.now()): number {
  const entityIds = db.listStandingEntities();
  for (const entityId of entityIds) {
    const fresh = computeFromLedger(db, entityId, now);
    db.setStandingCache(entityId, fresh, now);
  }
  return entityIds.length;
}

/** Top-N leaderboard by current standing. Refreshes stale / just-invalidated
 *  cache rows first so a freshly-earned entity isn't shown as 0 (or dropped
 *  below the cutoff) until the hourly recompute pass. */
export function leaderboard(
  db: MarinaDB,
  limit = 10,
  now = Date.now(),
): { entityId: string; standing: number }[] {
  for (const entityId of db.staleStandingEntities(now - CACHE_TTL_MS)) {
    db.setStandingCache(entityId, computeFromLedger(db, entityId, now), now);
  }
  return db.standingLeaderboard(limit);
}

/**
 * Standing credit per chronicle entry kind. Being chronicled is recognition,
 * not contribution — the entity already got contribution credit at the time
 * of the act. This second-order layer just rewards being noted.
 *
 *   event:      0.25 — the engine recorded a fact you were involved in
 *   narrative:  2.00 — the Chronicler interpreted the moment as noteworthy
 *   digest:     1.00 — period summary cited you
 *   correction: 0.50 — a revision still names you (lighter; could be reframing)
 */
const CHRONICLED_AMOUNTS: Record<string, number> = {
  event: 0.25,
  narrative: 2,
  digest: 1,
  correction: 0.5,
};

/**
 * Fire a `chronicled` standing event for every participant of a chronicle
 * entry. Idempotent via ref=`chronicle:<entryId>` per (entity_id, kind, ref):
 * re-recording the same entry is a no-op.
 *
 * `lookupId` returns the entity id for a participant name; participants that
 * don't resolve to a real entity (offline, never-existed) are skipped
 * silently — the chronicle records names, not ids, so dangling participants
 * are normal and not a bug.
 */
export function recordChronicleCitation(
  db: MarinaDB,
  entry: { id: number; kind: string; participants: string[] },
  lookupId: (name: string) => string | undefined,
): void {
  const amount = CHRONICLED_AMOUNTS[entry.kind] ?? 0;
  if (amount === 0) return;
  const ref = `chronicle:${entry.id}`;
  for (const name of entry.participants) {
    const id = lookupId(name);
    if (!id) continue;
    record(db, id, name, "chronicled", ref, amount);
  }
}

/**
 * Wire from `engine.logEvent` — translate engine events into ledger writes.
 * Idempotent and silent on irrelevant events.
 *
 * Does NOT credit `task_approved` here — that's already handled by
 * `db.recordStandingEarned()` on the task path (preserves task.standing
 * value). Doing it here too would double-count. Crew member/leader
 * completion crediting happens in CrewManager.complete() with full member
 * context; here we only handle agent-name-keyed events that need an
 * entity-id lookup.
 */
export function recordFromEvent(
  db: MarinaDB,
  event: EngineEvent,
  lookupName: (entityId: string) => string | undefined,
  lookupId: (agentName: string) => string | undefined = () => undefined,
): void {
  switch (event.type) {
    case "pool_note": {
      const name = lookupName(event.entity) ?? "unknown";
      record(db, event.entity, name, "pool_note", `pool_note:${event.noteId}`);
      return;
    }
    case "crew_stage_completed": {
      const id = lookupId(event.agentName);
      if (!id) return;
      record(db, id, event.agentName, "crew_stage_completed", `${event.crew}:${event.stage}`);
      return;
    }
    case "crew_artifact_deposited": {
      const id = lookupId(event.agentName);
      if (!id) return;
      record(
        db,
        id,
        event.agentName,
        "crew_artifact_deposited",
        `${event.crew}:${event.artifactRef}`,
      );
      return;
    }
    case "crew_member_stalled": {
      // Only record a penalty after repeated offenses — first stalls are
      // signal, not punishment. The CrewManager hook decides when to fire.
      if (event.offenseCount < 3) return;
      const id = lookupId(event.agentName);
      if (!id) return;
      record(db, id, event.agentName, "crew_member_stalled", `${event.crew}:${event.timestamp}`);
      return;
    }
    default:
      return;
  }
}

/**
 * Per-entity ledger for introspection (e.g. a future `standing show` cmd).
 * Returns recent rows, newest-first within `limit`.
 */
export function ledgerFor(
  db: MarinaDB,
  entityId: string,
  limit = 50,
): {
  kind: StandingKind;
  ref: string;
  amount: number;
  earnedAt: number;
}[] {
  const rows = db.ledgerForEntity(entityId, limit);
  return rows.map((r) => ({
    kind: r.kind as StandingKind,
    ref: r.ref,
    amount: r.amount,
    earnedAt: r.earned_at,
  }));
}
