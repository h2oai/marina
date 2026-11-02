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
