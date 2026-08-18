// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Rank Progression — derived from civic standing, not metric scoring.
 *
 * Rank 0–4 is a *descriptive tier* read off the standing ledger. You don't
 * grind for rank 3; your standing crosses a threshold and the system
 * observes "you've become an organizer." Demotion is the natural consequence
 * of standing decay (60-day half-life — see `src/agent/standing.ts`).
 *
 * Above rank 4 (the safety threshold) standing keeps accruing but does NOT
 * auto-promote. The named tiers above 4 (engineer / steward / guardian /
 * sovereign) are honorifics, not progression states. Existing rank-≥5
 * entities are grandfathered: their stored rank stays put. Phase 3 will
 * gate dangerous operations through per-operation competence proofs rather
 * than tier ladders, so above-threshold rank no longer controls capability.
 */
import { getRank, setRank } from "../engine/permissions";
import type { MarinaDB } from "../persistence/database";
import type { Entity, EntityRank } from "../types";
import { getStanding } from "./standing";

// ─── Threshold table ────────────────────────────────────────────────────────
//
// Standing values needed to read at each tier. Highest match wins. Tuned to
// the 60-day half-life: rank 4 (~100 standing) is reachable in a few weeks
// of sustained, varied contribution; staying there requires staying active.

interface RankThreshold {
  rank: EntityRank;
  /** Minimum decayed standing required to reach this tier. */
  min: number;
}

/* biome-ignore format: vertical alignment aids readability */
export const RANK_THRESHOLDS: ReadonlyArray<RankThreshold> = [
  { rank: 4, min: 100 },  // builder — the safety threshold
  { rank: 3, min:  40 },  // organizer
  { rank: 2, min:  15 },  // coordinator
  { rank: 1, min:   5 },  // canvas
  { rank: 0, min:   0 },  // newcomer
];

/** Rank above which auto-progression stops. */
export const SAFETY_THRESHOLD: EntityRank = 5;

/**
 * Derive the descriptive rank tier from a decayed standing value.
 * Pure — no DB access. Floor at 0, ceiling at 4 (above-threshold ranks
 * are not auto-derived).
 */
export function deriveRankFromStanding(standing: number): EntityRank {
  for (const t of RANK_THRESHOLDS) {
    if (standing >= t.min) return t.rank;
  }
  return 0;
}

// ─── Core Logic ─────────────────────────────────────────────────────────────

/**
 * Check whether an entity's rank should change based on current standing.
 * Returns the new rank if it differs from the current rank, or null if no
 * change. Grandfathered above the safety threshold — entities at rank 5+
 * are never auto-adjusted by this function.
 */
export function checkRankProgression(db: MarinaDB, entity: Entity): EntityRank | null {
  const currentRank = getRank(entity);
  // Grandfather: above-threshold entities keep their stored rank. Phase 3
  // safety gates handle their capability access.
  if (currentRank >= SAFETY_THRESHOLD) return null;

  const standing = getStanding(db, entity.id);
  const derived = deriveRankFromStanding(standing);
  if (derived === currentRank) return null;
  return derived;
}

/**
 * Apply rank progression and persist. Returns true if rank changed.
 */
export function applyRankProgression(db: MarinaDB, entity: Entity): boolean {
  const newRank = checkRankProgression(db, entity);
  if (newRank === null) return false;

  setRank(entity, newRank);
  const user = db.getUserByName(entity.name);
  if (user) db.updateUserRank(user.id, newRank);
  return true;
}

/**
 * Promotion progress summary. Shows the gap to the next tier — if any.
 * Returns null when the entity is already at the safety threshold (or
 * grandfathered above it), since further promotion isn't automatic.
 */
export function getPromotionProgress(db: MarinaDB, entity: Entity): string | null {
  const currentRank = getRank(entity);
  if (currentRank >= SAFETY_THRESHOLD - 1) return null; // already at builder or above

  const standing = getStanding(db, entity.id);
  const next = RANK_THRESHOLDS.find((t) => t.rank === ((currentRank + 1) as EntityRank));
  if (!next) return null;
  if (standing >= next.min) return null; // already eligible — apply will pick it up

  const remaining = next.min - standing;
  return `standing ${standing.toFixed(1)}/${next.min} (${remaining.toFixed(1)} more for rank ${next.rank})`;
}
