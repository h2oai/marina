// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Retrieval telemetry and usefulness evidence for memory records.
 *
 * Two append-only tables (migration 188):
 *
 * - `memory_served` — one row per item the unified context surface served,
 *   per build: who it went to, which surface asked (`prompt`, `recall`, …),
 *   which retrieval arm produced it (`lexical`, `hybrid`, `as-of`), the tier,
 *   the item's rank within its tier and a hash of the query. Ids and numbers
 *   only — never the item's text or the query. Telemetry: pruned after 30 d
 *   (`src/engine/retention.ts`).
 * - `memory_ratings` — usefulness evidence per item, written ONLY through
 *   `applyUsefulness` (the one rater chokepoint): a `rater` names the kind of
 *   evidence, `alpha`/`beta` are the Beta-Binomial increments it contributes,
 *   `ref` the thing that proved it (`note:N`, `outcome:N`, `task:N`). Kept
 *   as history, never pruned. Today's only rater is `repeat` (a write that
 *   restated an existing note of the same writer; the new note is kept, the
 *   earlier one gains the evidence); citation, outcome-linked, explicit and
 *   surfaced-but-unused raters arrive with the usefulness posteriors.
 *
 * Nothing here ranks, decays or promotes. A serve is exposure, not
 * usefulness; the readout says so.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export type MemoryServedSurface = "prompt" | "context" | "recall" | "mcp" | "passthru" | "rest";
export type MemoryServedArm = "lexical" | "hybrid" | "as-of";
export const MEMORY_SERVED_SURFACES: readonly MemoryServedSurface[] = [
  "prompt",
  "context",
  "recall",
  "mcp",
  "passthru",
  "rest",
];

/** The kinds of usefulness evidence a rating may carry. */
export type UsefulnessRater = "repeat" | "citation" | "outcome" | "explicit" | "unused";
export const USEFULNESS_RATERS: readonly UsefulnessRater[] = [
  "repeat",
  "citation",
  "outcome",
  "explicit",
  "unused",
];

export interface MemoryServedInput {
  entityName: string;
  surface: MemoryServedSurface;
  arm: MemoryServedArm;
  tier: string;
  itemId: string;
  recordId?: string | null;
  rank: number;
  queryHash: string;
  servedAt?: number;
}

export interface UsefulnessRatingInput {
  itemId: string;
  recordId?: string | null;
  rater: UsefulnessRater;
  /** Whose evidence this is (the writer, the citer, the consumer). */
  raterEntity?: string | null;
  alpha?: number;
  beta?: number;
  ref?: string | null;
  createdAt?: number;
}

export interface MemoryServedItemStats {
  itemId: string;
  recordId: string | null;
  tier: string;
  serves: number;
  distinctQueries: number;
  /** Sum of `repeat` alpha on the item (near-duplicate writes that landed here). */
  repeatAlpha: number;
}

export interface MemoryUsefulnessSummary {
  entityName: string;
  sinceMs: number;
  serves: number;
  distinctItems: number;
  distinctQueries: number;
  bySurface: Record<string, number>;
  byArm: Record<string, number>;
  byTier: Record<string, number>;
  ratingsByRater: Record<string, number>;
  topItems: MemoryServedItemStats[];
}

/** Stable, content-free key for a query: sha256 of the normalised text, 16 hex chars. */
export function memoryQueryHash(query: string): string {
  const normalised = query.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(normalised, "utf8").digest("hex").slice(0, 16);
}

/** Append one row per served item. Returns the number of rows written. */
export function recordMemoryServed(db: Database, rows: readonly MemoryServedInput[]): number {
  if (rows.length === 0) return 0;
  // `query` caches the prepared statement across builds; `prepare` would not.
  const insert = db.query(
    `INSERT INTO memory_served
       (entity_name, surface, arm, tier, item_id, record_id, rank, query_hash, served_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const now = Date.now();
  db.transaction(() => {
    for (const row of rows)
      insert.run(
        row.entityName,
        row.surface,
        row.arm,
        row.tier,
        row.itemId,
        row.recordId ?? null,
        row.rank,
        row.queryHash,
        row.servedAt ?? now,
      );
  })();
  return rows.length;
}

/**
 * The one chokepoint for usefulness evidence. Validates the rater and the
 * increments (non-negative, finite), appends one row and returns its id.
 * Callers never write `memory_ratings` directly.
 */
export function applyUsefulness(db: Database, rating: UsefulnessRatingInput): number {
  if (!USEFULNESS_RATERS.includes(rating.rater))
    throw new Error(`Unknown usefulness rater: ${rating.rater}`);
  const alpha = rating.alpha ?? 0;
  const beta = rating.beta ?? 0;
  if (!Number.isFinite(alpha) || !Number.isFinite(beta) || alpha < 0 || beta < 0)
    throw new Error("Usefulness increments must be finite and non-negative.");
  if (alpha === 0 && beta === 0) throw new Error("A usefulness rating must move alpha or beta.");
  if (!rating.itemId) throw new Error("A usefulness rating names an item.");
  const result = db.run(
    `INSERT INTO memory_ratings
       (item_id, record_id, rater, rater_entity, alpha, beta, ref, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      rating.itemId,
      rating.recordId ?? null,
      rating.rater,
      rating.raterEntity ?? null,
      alpha,
      beta,
      rating.ref ?? null,
      rating.createdAt ?? Date.now(),
    ],
  );
  return Number(result.lastInsertRowid);
}

function countBy(
  db: Database,
  column: "surface" | "arm" | "tier",
  entityName: string,
  sinceMs: number,
): Record<string, number> {
  const rows = db
    .query<{ k: string; n: number }, [string, number]>(
      `SELECT ${column} AS k, count(*) AS n FROM memory_served
       WHERE entity_name = ? AND served_at >= ? GROUP BY ${column} ORDER BY n DESC, k`,
    )
    .all(entityName, sinceMs);
  return Object.fromEntries(rows.map((r) => [r.k, r.n]));
}

/** What was served to `entityName` since `sinceMs`, with the evidence recorded on it. */
export function memoryUsefulnessSummary(
  db: Database,
  entityName: string,
  sinceMs: number,
  opts: { topItems?: number } = {},
): MemoryUsefulnessSummary {
  const totals = db
    .query<{ serves: number; items: number; queries: number }, [string, number]>(
      `SELECT count(*) AS serves, count(DISTINCT item_id) AS items,
              count(DISTINCT query_hash) AS queries
       FROM memory_served WHERE entity_name = ? AND served_at >= ?`,
    )
    .get(entityName, sinceMs) ?? { serves: 0, items: 0, queries: 0 };
  const top = db
    .query<
      {
        item_id: string;
        record_id: string | null;
        tier: string;
        serves: number;
        queries: number;
        repeat_alpha: number | null;
      },
      [string, number, number]
    >(
      `SELECT s.item_id, max(s.record_id) AS record_id, max(s.tier) AS tier,
              count(*) AS serves, count(DISTINCT s.query_hash) AS queries,
              (SELECT sum(alpha) FROM memory_ratings r
                WHERE r.item_id = s.item_id AND r.rater = 'repeat') AS repeat_alpha
       FROM memory_served s
       WHERE s.entity_name = ? AND s.served_at >= ?
       GROUP BY s.item_id
       ORDER BY serves DESC, queries DESC, s.item_id
       LIMIT ?`,
    )
    .all(entityName, sinceMs, Math.max(1, Math.floor(opts.topItems ?? 10)));
  const ratings = db
    .query<{ rater: string; n: number }, [number, string]>(
      `SELECT rater, count(*) AS n FROM memory_ratings
       WHERE created_at >= ?1 AND item_id IN (
         SELECT DISTINCT item_id FROM memory_served WHERE entity_name = ?2 AND served_at >= ?1)
       GROUP BY rater ORDER BY rater`,
    )
    .all(sinceMs, entityName);
  return {
    entityName,
    sinceMs,
    serves: totals.serves,
    distinctItems: totals.items,
    distinctQueries: totals.queries,
    bySurface: countBy(db, "surface", entityName, sinceMs),
    byArm: countBy(db, "arm", entityName, sinceMs),
    byTier: countBy(db, "tier", entityName, sinceMs),
    ratingsByRater: Object.fromEntries(ratings.map((r) => [r.rater, r.n])),
    topItems: top.map((r) => ({
      itemId: r.item_id,
      recordId: r.record_id,
      tier: r.tier,
      serves: r.serves,
      distinctQueries: r.queries,
      repeatAlpha: r.repeat_alpha ?? 0,
    })),
  };
}

/** Ratings recorded on one item, newest first (the readout and tests). */
export function usefulnessRatingsFor(
  db: Database,
  itemId: string,
  limit = 50,
): {
  id: number;
  rater: string;
  rater_entity: string | null;
  alpha: number;
  beta: number;
  ref: string | null;
  created_at: number;
}[] {
  return db
    .query<
      {
        id: number;
        rater: string;
        rater_entity: string | null;
        alpha: number;
        beta: number;
        ref: string | null;
        created_at: number;
      },
      [string, number]
    >(
      `SELECT id, rater, rater_entity, alpha, beta, ref, created_at FROM memory_ratings
       WHERE item_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(itemId, limit);
}

// ─── Ranking mode and the bounded term ───────────────────────────────────────

export type UsefulnessRankingMode = "off" | "observe" | "on";

/**
 * `MARINA_MEMORY_USEFULNESS_RANKING`: `off` computes nothing; `observe`
 * (default) reports each shared record's posterior and would-be term in the
 * search `ranking`; `on` adds the term to the score. Shared retrieval only.
 */
export function usefulnessRankingMode(env: NodeJS.ProcessEnv = process.env): UsefulnessRankingMode {
  const v = env.MARINA_MEMORY_USEFULNESS_RANKING?.trim().toLowerCase();
  if (v === "off" || v === "false" || v === "0" || v === "none") return "off";
  if (v === "on" || v === "true" || v === "1") return "on";
  return "observe";
}

/** The bounded weight: a posterior mean of 1 adds this much of one rank-1 hit; 0 subtracts it. */
export const USEFULNESS_WEIGHT = 0.1;

/** The signed, bounded term for a posterior mean: `USEFULNESS_WEIGHT × (2·mean − 1)` ∈ [−w, w]. */
export function usefulnessTerm(mean: number): number {
  const m = Math.min(1, Math.max(0, mean));
  return USEFULNESS_WEIGHT * (2 * m - 1);
}

// ─── Posterior and the raters' queries ───────────────────────────────────────

/** Beta prior: one pseudo-success and one pseudo-failure — neutral mean 0.5. */
export const USEFULNESS_PRIOR_ALPHA = 1;
export const USEFULNESS_PRIOR_BETA = 1;

export interface UsefulnessPosterior {
  itemId: string;
  /** Evidence sums (prior excluded). */
  alpha: number;
  beta: number;
  /** Rating rows counted. */
  n: number;
  /** Posterior mean with the prior: (1 + α) / (2 + α + β); 0.5 with no evidence. */
  mean: number;
}

export function posteriorMean(alpha: number, beta: number): number {
  return (
    (USEFULNESS_PRIOR_ALPHA + alpha) /
    (USEFULNESS_PRIOR_ALPHA + USEFULNESS_PRIOR_BETA + alpha + beta)
  );
}

/**
 * α/β per item from `memory_ratings`. `excludeSelf` drops ratings whose
 * `rater_entity` is the item's own author (a legacy note's `entity_name`, a
 * durable record's creating principal's display name), so an entity's own
 * evidence never moves how OTHERS rank its notes — the standing rule. Items
 * with no ratings come back at the prior.
 */
export function usefulnessPosterior(
  db: Database,
  itemIds: readonly string[],
  opts: { excludeSelf?: boolean } = {},
): Map<string, UsefulnessPosterior> {
  const out = new Map<string, UsefulnessPosterior>();
  for (const id of itemIds) out.set(id, { itemId: id, alpha: 0, beta: 0, n: 0, mean: 0.5 });
  if (itemIds.length === 0) return out;
  const selfFilter = opts.excludeSelf
    ? `AND (r.rater_entity IS NULL OR lower(r.rater_entity) IS NOT lower(coalesce(
           (SELECT n.entity_name FROM notes n WHERE CAST(n.id AS TEXT) = r.item_id),
           (SELECT p.display_name FROM memory_service_events e
              JOIN principals p ON p.principal_id = e.actor_id
             WHERE e.operation = 'memory.created' AND e.reference_id = r.item_id
             ORDER BY e.seq LIMIT 1))))`
    : "";
  const rows = db
    .query<{ item_id: string; alpha: number; beta: number; n: number }, [string]>(
      `SELECT r.item_id, sum(r.alpha) AS alpha, sum(r.beta) AS beta, count(*) AS n
       FROM memory_ratings r
       WHERE r.item_id IN (SELECT value FROM json_each(?)) ${selfFilter}
       GROUP BY r.item_id`,
    )
    .all(JSON.stringify(itemIds));
  for (const row of rows)
    out.set(row.item_id, {
      itemId: row.item_id,
      alpha: row.alpha,
      beta: row.beta,
      n: row.n,
      mean: posteriorMean(row.alpha, row.beta),
    });
  return out;
}

/** Whether `itemId` (or the record it projects) was served to `entityName` in [since, until]. */
export function servedToEntity(
  db: Database,
  entityName: string,
  itemId: string,
  since: number,
  until: number = Date.now(),
  recordId?: string | null,
): boolean {
  const row = db
    .query<{ one: number }, [string, number, number, string, string | null]>(
      `SELECT 1 AS one FROM memory_served
       WHERE entity_name = ? AND served_at BETWEEN ? AND ?
         AND (item_id = ?4 OR record_id = ?4 OR (?5 IS NOT NULL AND (item_id = ?5 OR record_id = ?5)))
       LIMIT 1`,
    )
    .get(entityName, since, until, itemId, recordId ?? null);
  return !!row;
}

/** Distinct items served to `entityName` in [since, until], most recent first, capped. */
export function itemsServedTo(
  db: Database,
  entityName: string,
  since: number,
  until: number,
  limit = 50,
): { itemId: string; recordId: string | null }[] {
  return db
    .query<{ item_id: string; record_id: string | null }, [string, number, number, number]>(
      `SELECT item_id, max(record_id) AS record_id FROM memory_served
       WHERE entity_name = ? AND served_at BETWEEN ? AND ?
       GROUP BY item_id ORDER BY max(served_at) DESC LIMIT ?`,
    )
    .all(entityName, since, until, Math.max(1, limit))
    .map((r) => ({ itemId: r.item_id, recordId: r.record_id }));
}

/** A rating of this kind by this entity with this ref already exists (idempotent raters). */
export function hasUsefulnessRating(
  db: Database,
  itemId: string,
  rater: UsefulnessRater,
  raterEntity: string,
  ref: string | null,
  since = 0,
): boolean {
  return !!db
    .query(
      `SELECT 1 FROM memory_ratings
       WHERE item_id = ? AND rater = ? AND rater_entity = ? AND ref IS ? AND created_at >= ? LIMIT 1`,
    )
    .get(itemId, rater, raterEntity, ref, since);
}

/** Count of ratings of one kind on an item since a time (daily caps). */
export function countUsefulnessRatings(
  db: Database,
  itemId: string,
  rater: UsefulnessRater,
  since: number,
  raterEntity?: string,
): number {
  const row = raterEntity
    ? db
        .query<{ n: number }, [string, string, number, string]>(
          `SELECT count(*) AS n FROM memory_ratings
           WHERE item_id = ? AND rater = ? AND created_at >= ? AND rater_entity = ?`,
        )
        .get(itemId, rater, since, raterEntity)
    : db
        .query<{ n: number }, [string, string, number]>(
          `SELECT count(*) AS n FROM memory_ratings WHERE item_id = ? AND rater = ? AND created_at >= ?`,
        )
        .get(itemId, rater, since);
  return row?.n ?? 0;
}

export interface UnsettledServe {
  id: number;
  entityName: string;
  itemId: string;
  arm: MemoryServedArm;
  servedAt: number;
}

/** Serves after `afterId` that are older than `olderThan`, oldest first, bounded. */
export function unsettledServes(
  db: Database,
  afterId: number,
  olderThan: number,
  limit: number,
): UnsettledServe[] {
  return db
    .query<
      { id: number; entity_name: string; item_id: string; arm: MemoryServedArm; served_at: number },
      [number, number, number]
    >(
      `SELECT id, entity_name, item_id, arm, served_at FROM memory_served
       WHERE id > ? AND served_at <= ? ORDER BY id LIMIT ?`,
    )
    .all(afterId, olderThan, Math.max(1, limit))
    .map((r) => ({
      id: r.id,
      entityName: r.entity_name,
      itemId: r.item_id,
      arm: r.arm,
      servedAt: r.served_at,
    }));
}

/** A `citation` by `entityName` on `itemId` at or after `since` (the serve it answers). */
export function citedAfter(
  db: Database,
  entityName: string,
  itemId: string,
  since: number,
): boolean {
  return !!db
    .query(
      `SELECT 1 FROM memory_ratings
       WHERE item_id = ? AND rater = 'citation' AND rater_entity = ? AND created_at >= ? LIMIT 1`,
    )
    .get(itemId, entityName, since);
}

/**
 * Per retrieval arm: serves to `entityName` in the window and how many of them
 * were followed by a `citation` from the same entity — the A/B readout.
 */
export function citationRateByArm(
  db: Database,
  entityName: string,
  sinceMs: number,
): Record<string, { serves: number; cited: number }> {
  const rows = db
    .query<{ arm: string; serves: number; cited: number }, [string, number]>(
      `SELECT s.arm, count(*) AS serves,
              sum(EXISTS (SELECT 1 FROM memory_ratings r
                           WHERE r.item_id = s.item_id AND r.rater = 'citation'
                             AND r.rater_entity = s.entity_name AND r.created_at >= s.served_at)) AS cited
       FROM memory_served s WHERE s.entity_name = ? AND s.served_at >= ?
       GROUP BY s.arm ORDER BY s.arm`,
    )
    .all(entityName, sinceMs);
  return Object.fromEntries(rows.map((r) => [r.arm, { serves: r.serves, cited: r.cited ?? 0 }]));
}
