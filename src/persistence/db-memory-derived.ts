// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reads behind ingest-time notes (`src/memory/ingest-notes.ts`): every one runs
 * under the caller's live credential and the space ACL, like any canonical read.
 * Writes go through `rememberRecord`; nothing here mutates.
 */

import type { Database } from "bun:sqlite";
import { authorizeMemorySpace } from "./db-memory-service";
import type { MemoryActor } from "./db-principals";

/** Active derived notes already written for one derivation key (a source set at its versions). */
export function countDerivedNotes(
  db: Database,
  actor: MemoryActor,
  space: string,
  derivedKey: string,
): number {
  authorizeMemorySpace(db, actor, space);
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM memory_records r
        WHERE r.space_id=? AND r.status='active'
          AND json_extract(r.metadata,'$.derived_key')=?`,
    )
    .get(space, derivedKey) as { n: number } | null;
  return row?.n ?? 0;
}

/**
 * Whether an active, current (not stale) record in this space, written by the
 * same principal with one of `types`, already holds exactly `content`
 * (exact-duplicate admission; a note staled by its source's revision does not
 * block its successor). Uses the `(entity_name, note_type, substr(content,1,64))`
 * dedup index.
 */
export function activeRecordWithContent(
  db: Database,
  actor: MemoryActor,
  space: string,
  content: string,
  types: readonly string[],
): boolean {
  authorizeMemorySpace(db, actor, space);
  const row = db
    .query(
      `SELECT 1 FROM notes n JOIN memory_records r ON r.current_note_id=n.id
        WHERE n.entity_name=? AND n.note_type IN (SELECT value FROM json_each(?))
          AND substr(n.content,1,64)=substr(?,1,64) AND n.content=?
          AND r.space_id=? AND r.status='active' AND r.stale=0 LIMIT 1`,
    )
    .get(`memory:${actor.principalId}`, JSON.stringify(types), content, content, space);
  return row !== null;
}

/** Captured source bodies by id (this space only; missing ids are omitted). */
export function readMemorySourceBodies(
  db: Database,
  actor: MemoryActor,
  space: string,
  ids: readonly string[],
): { id: string; body: unknown }[] {
  authorizeMemorySpace(db, actor, space);
  if (!ids.length) return [];
  return (
    db
      .query(
        "SELECT id,body FROM memory_sources WHERE space_id=? AND id IN (SELECT value FROM json_each(?))",
      )
      .all(space, JSON.stringify(ids)) as { id: string; body: string }[]
  ).map((row) => ({ id: row.id, body: JSON.parse(row.body) }));
}
