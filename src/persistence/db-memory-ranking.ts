// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { cosine } from "../memory/embeddings";
import { authorizeMemorySpace, type MemoryFilter, memoryFilters } from "./db-memory-service";
import { REPUTATION_STANDING_CEILING, REPUTATION_WEIGHT } from "./db-notes";
import type { MemoryActor } from "./db-principals";

/** Exact optional semantic ranking. Streams stored vectors with O(k + dimension)
 * JS memory; never silently restricts scoring to the lexical candidate set. */
export function rankMemoryVectors(
  db: Database,
  actor: MemoryActor,
  space: string,
  model: string,
  vector: number[],
  filter: MemoryFilter = {},
) {
  authorizeMemorySpace(db, actor, space);
  const filters = memoryFilters(filter);
  const rows =
    db.query(`SELECT r.id,v.vector FROM memory_records r JOIN notes n ON n.id=r.current_note_id
    LEFT JOIN memory_vectors v ON v.note_id=r.current_note_id AND v.model=?
    WHERE r.space_id=? AND r.status='active' AND n.verification_status!='superseded' ${filters.sql}`);
  let scored = 0,
    missing = 0,
    invalid = 0;
  let best: { id: string; score: number }[] = [];
  const compare = (a: { id: string; score: number }, b: { id: string; score: number }) =>
    b.score - a.score || a.id.localeCompare(b.id);
  for (const entry of rows.iterate(model, space, ...filters.values) as Iterable<{
    id: string;
    vector: string | null;
  }>) {
    if (!entry.vector) {
      missing++;
      continue;
    }
    try {
      const score = cosine(vector, JSON.parse(entry.vector));
      scored++;
      if (score > 0) best.push({ id: entry.id, score });
      if (best.length >= 400) best = best.sort(compare).slice(0, 200);
    } catch {
      invalid++;
    }
  }
  return {
    ids: best
      .sort(compare)
      .slice(0, 200)
      .map((item) => item.id),
    scored,
    missing,
    invalid,
  };
}

// ─── Reputation-weighted shared ranking (Phase 3.6) ─────────────────────────
//
// The durable `search` fuses lexical + semantic ranks in `src/memory/service.ts`
// (RRF, k=60) and never sees who wrote a record. Authorship IS recoverable
// without a schema change: the first `memory.created` event for a record id
// carries the writing principal (`memory_service_events.actor_id`), and civic
// standing is keyed by that same durable principal id (`users.id`, migration
// 109). So reputation is applied as a bounded POST-RANK RE-SORT within the
// returned page — the same `REPUTATION_WEIGHT * clamp(standing / 100, 0, 1)`
// term legacy pool recall adds in SQL — and only to records whose author is
// NOT the searching actor. Own records are never weighted by own standing;
// in a private space where the actor wrote everything the re-sort is a no-op.
//
// RRF scores live in [0, ~0.033] per list (1/(60+rank)), so the term is scaled
// by RRF_UNIT (1/61 ≈ 0.0164, the score of a rank-1 hit) to keep it at the
// same relative bound as in the legacy expression: a standing-100 author gains
// 10% of a top lexical hit, never a whole rank tier.

export { REPUTATION_STANDING_CEILING, REPUTATION_WEIGHT };

/** Score of a rank-1 hit in one RRF list — the unit the bounded term is expressed in. */
const RRF_UNIT = 1 / 61;

export interface ReputationRanking {
  /** The bounded weight in force (REPUTATION_WEIGHT). */
  weight: number;
  /** Standing at which the term saturates. */
  standing_ceiling: number;
  /** Records whose score received a non-zero term (author ≠ actor, standing > 0). */
  applied: number;
  /** Records examined. */
  considered: number;
  /** Per-record detail — inspectable, deterministic. */
  authors: Record<string, { author: string | null; standing: number; term: number }>;
}

/** Civic standing of a durable principal from the rollup cache; unknown → 0. */
export function principalStandingFromCache(db: Database, principalId: string | null): number {
  if (!principalId) return 0;
  const row = db
    .query("SELECT standing FROM entity_standing_cache WHERE entity_id = ?")
    .get(principalId) as { standing: number } | null;
  return row ? Math.max(0, row.standing) : 0;
}

/** The bounded reputation term for a standing value — shared by legacy SQL and durable re-sort. */
export function reputationTerm(standing: number): number {
  const unit = Math.min(1, Math.max(0, standing / REPUTATION_STANDING_CEILING));
  return REPUTATION_WEIGHT * unit;
}

/** Writing principal of each record (first `memory.created` event), null when unknown. */
export function recordAuthors(
  db: Database,
  recordIds: readonly string[],
): Map<string, string | null> {
  const authors = new Map<string, string | null>(recordIds.map((id) => [id, null]));
  if (recordIds.length === 0) return authors;
  const rows = db
    .query(
      `SELECT reference_id AS id, actor_id FROM memory_service_events
       WHERE operation = 'memory.created' AND reference_id IN (SELECT value FROM json_each(?))
       ORDER BY seq ASC`,
    )
    .all(JSON.stringify(recordIds)) as { id: string; actor_id: string }[];
  for (const row of rows) if (authors.get(row.id) === null) authors.set(row.id, row.actor_id);
  return authors;
}

/** Author principal of each captured source (`source.captured` event), null when unknown. */
export function sourceAuthors(
  db: Database,
  sourceIds: readonly string[],
): Map<string, string | null> {
  const authors = new Map<string, string | null>(sourceIds.map((id) => [id, null]));
  if (sourceIds.length === 0) return authors;
  const rows = db
    .query(
      `SELECT reference_id AS id, actor_id FROM memory_service_events
       WHERE operation = 'source.captured' AND reference_id IN (SELECT value FROM json_each(?))
       ORDER BY seq ASC`,
    )
    .all(JSON.stringify(sourceIds)) as { id: string; actor_id: string }[];
  for (const row of rows) if (authors.get(row.id) === null) authors.set(row.id, row.actor_id);
  return authors;
}

/**
 * Re-sort one page of durable search results by writer reputation. Pure over
 * its inputs (reads two tables, mutates nothing); returns a new array plus the
 * inspectable `ranking` block. Ties after the term keep RRF order, then id.
 */
export function applyReputationRerank<T extends { id: string; score: number }>(
  db: Database,
  actor: MemoryActor,
  results: readonly T[],
): { results: T[]; ranking: ReputationRanking } {
  const authors = recordAuthors(
    db,
    results.map((r) => r.id),
  );
  const ranking: ReputationRanking = {
    weight: REPUTATION_WEIGHT,
    standing_ceiling: REPUTATION_STANDING_CEILING,
    applied: 0,
    considered: results.length,
    authors: {},
  };
  const standingCache = new Map<string, number>();
  const adjusted = results.map((result, index) => {
    const author = authors.get(result.id) ?? null;
    let standing = 0;
    if (author && author !== actor.principalId) {
      standing = standingCache.get(author) ?? principalStandingFromCache(db, author);
      standingCache.set(author, standing);
    }
    const term = author && author !== actor.principalId ? reputationTerm(standing) * RRF_UNIT : 0;
    if (term > 0) ranking.applied++;
    ranking.authors[result.id] = { author, standing, term };
    return { result, index, score: result.score + term };
  });
  adjusted.sort(
    (a, b) => b.score - a.score || a.index - b.index || a.result.id.localeCompare(b.result.id),
  );
  return {
    results: adjusted.map((entry) => ({ ...entry.result, score: entry.score })),
    ranking,
  };
}
