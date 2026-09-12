// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { cosine } from "../memory/embeddings";
import { authorizeMemorySpace, type MemoryFilter, memoryFilters } from "./db-memory-service";
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
