// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Known-at times for the as-of fence (`src/memory/as-of.ts`), persisted on the
 * rows themselves (migration 172): `memory_record_versions.known_at`,
 * `memory_sources.known_at`, `memory_assistance_jobs.completed_known_at`.
 *
 * New events date their row through AFTER INSERT triggers on
 * `memory_service_events`. Rows older than the migration are filled here from
 * the events that survive, by seq range (the table's INTEGER PRIMARY KEY —
 * never a scan of the whole log), in short transactions driven by a tick job.
 * Until the cursor passes an event, row retention keeps it
 * (`KNOWN_AT_RETENTION_WHERE`), so the 30-day prune can never lose a date the
 * backfill has not copied yet. The value is the same one the event lookup
 * produced: the latest matching event's time.
 */

import type { Database } from "bun:sqlite";

/** The service events that date a version, source or proposal. */
export const KNOWN_AT_OPERATIONS = [
  "memory.created",
  "memory.revised",
  "source.captured",
  "assistance.completed",
] as const;

const OPERATIONS_SQL = KNOWN_AT_OPERATIONS.map((op) => `'${op}'`).join(",");

/**
 * Retention predicate for `memory_service_events`: a dating event inside the
 * backfill's pending range is kept. Missing state (NULL) keeps it too.
 */
export const KNOWN_AT_RETENTION_WHERE =
  `NOT coalesce(operation IN (${OPERATIONS_SQL}) AND ` +
  "seq > (SELECT cursor FROM memory_known_at_backfill WHERE id = 1) AND " +
  "seq <= (SELECT upto FROM memory_known_at_backfill WHERE id = 1), 1)";

/** Event seqs scanned per batch (one short transaction). */
export const KNOWN_AT_BACKFILL_WINDOW = 5_000;
/** Batches per pass; the rest is picked up on the next pass. */
export const KNOWN_AT_BACKFILL_BATCHES = 8;

export interface KnownAtBackfillState {
  cursor: number;
  upto: number;
  done: boolean;
}

/** The backfill cursor; `done` when nothing older than the migration is left. */
export function knownAtBackfillState(db: Database): KnownAtBackfillState | undefined {
  try {
    const row = db
      .query("SELECT cursor, upto FROM memory_known_at_backfill WHERE id = 1")
      .get() as { cursor: number; upto: number } | null;
    return row ? { ...row, done: row.cursor >= row.upto } : undefined;
  } catch {
    // A schema without migration 172 has no backfill state.
    return undefined;
  }
}

/** Copy the dates of events with `lo < seq <= hi` onto their rows. */
function copyRange(db: Database, lo: number, hi: number): void {
  const range = "seq > ? AND seq <= ? AND reference_id IS NOT NULL";
  db.run(
    `UPDATE memory_record_versions SET known_at = max(coalesce(known_at, 0), e.at)
       FROM (SELECT reference_id AS ref, version, MAX(created_at) AS at FROM memory_service_events
              WHERE ${range} AND operation IN ('memory.created','memory.revised')
              GROUP BY reference_id, version) e
      WHERE memory_record_versions.record_id = e.ref AND memory_record_versions.version = e.version`,
    [lo, hi],
  );
  db.run(
    `UPDATE memory_sources SET known_at = max(coalesce(known_at, 0), e.at)
       FROM (SELECT reference_id AS ref, MAX(created_at) AS at FROM memory_service_events
              WHERE ${range} AND operation = 'source.captured' GROUP BY reference_id) e
      WHERE memory_sources.id = e.ref`,
    [lo, hi],
  );
  db.run(
    `UPDATE memory_assistance_jobs SET completed_known_at = max(coalesce(completed_known_at, 0), e.at)
       FROM (SELECT reference_id AS ref, MAX(created_at) AS at FROM memory_service_events
              WHERE ${range} AND operation = 'assistance.completed' GROUP BY reference_id) e
      WHERE memory_assistance_jobs.id = e.ref`,
    [lo, hi],
  );
}

/**
 * One bounded backfill pass: at most `batches` windows of `window` event seqs,
 * each in its own transaction (a writer waits at most one window). Returns the
 * state after the pass; a no-op once done.
 */
export function backfillMemoryKnownAt(
  db: Database,
  opts: { window?: number; batches?: number } = {},
): KnownAtBackfillState | undefined {
  const window = Math.max(1, opts.window ?? KNOWN_AT_BACKFILL_WINDOW);
  const batches = Math.max(1, opts.batches ?? KNOWN_AT_BACKFILL_BATCHES);
  let state = knownAtBackfillState(db);
  for (let i = 0; i < batches && state && !state.done; i++) {
    const { cursor, upto } = state;
    const hi = Math.min(upto, cursor + window);
    db.transaction(() => {
      copyRange(db, cursor, hi);
      db.run("UPDATE memory_known_at_backfill SET cursor = ? WHERE id = 1 AND cursor = ?", [
        hi,
        cursor,
      ]);
    })();
    state = knownAtBackfillState(db);
  }
  return state;
}
