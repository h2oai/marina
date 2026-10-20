// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * As-of reconstruction of memory under the evidence fence
 * (`src/engine/evidence-fence.ts`).
 *
 * A fenced reader may see only what was KNOWN by the cutoff. A canonical
 * record keeps every version (`memory_record_versions`, one note row each),
 * so an edited note is not dropped: it is served as it stood at the cutoff —
 * the newest version whose known-at time is at or before it.
 *
 * Known-at is taken only from timestamps the local write path sets itself:
 * - version 1 of a numeric note: the numeric handle's own `created_at` (the
 *   fence's rule before revisions were served);
 * - every other version, and every durable record version: the
 *   `memory.created` / `memory.revised` service event written in the same
 *   transaction (`db-memory-service.ts`), combined with the version row's time;
 * - a captured source: its `source.captured` event;
 * - an assistance proposal: its `assistance.completed` event.
 * Since migration 171 that event time is persisted on the row itself
 * (`memory_record_versions.known_at`, `memory_sources.known_at`,
 * `memory_assistance_jobs.completed_known_at`) by a trigger on the event, and
 * older rows are filled by a bounded backfill (`db-memory-known-at.ts`), so
 * the event log's 30-day retention no longer erases a date. While that
 * backfill is still running, an undated row falls back to the event lookup.
 * A version, source or proposal with neither — imported from a bundle (its
 * row times are the exporter's), converted before the event existed, or
 * pruned before migration 171 — has no reliable known-at and is NOT served
 * (fail closed). Content served is always the chosen version's own text,
 * never the current one.
 *
 * Ranking under a cutoff (`fencedNoteRecall`, `rankAsOf`): which notes appear
 * and in what order is decided by the AS-OF text alone. Candidates are every
 * handle known by the cutoff with ANY version matching the query; each is
 * reduced to its as-of version, dropped unless that text matches, and ordered
 * by its term coverage, then by known-by-the-cutoff times — never by the
 * current text, current importance, recency or link graph, any of which can
 * carry what changed after the cutoff.
 */

import { FACT_LIKE_TIERS } from "../engine/constants";
import type { MarinaDB, ScoredNoteRow } from "../persistence/database";
import { knownAtBackfillState } from "../persistence/db-memory-known-at";
import { buildFtsQuery } from "../persistence/fts";
import { findDurableTwin } from "./legacy-projection";
import { isTrustedNote } from "./retrieval";
import { queryTerms, termMatcher } from "./term-match";

type Raw = ReturnType<MarinaDB["memoryRepository"]>["raw"];

/** The version an as-of read served, when older than the current one. */
export interface AsOfServed {
  version: number;
  current: number;
}

const RECORD_OPERATIONS = ["memory.created", "memory.revised"] as const;

/** Latest event time per `(reference, version)` for the given operations. */
function eventTimes(
  raw: Raw,
  references: readonly string[],
  operations: readonly string[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (references.length === 0) return out;
  const rows = raw
    .query(
      `SELECT reference_id AS ref, version, MAX(created_at) AS at FROM memory_service_events
        WHERE reference_id IN (SELECT value FROM json_each(?))
          AND operation IN (SELECT value FROM json_each(?))
        GROUP BY reference_id, version`,
    )
    .all(JSON.stringify(references), JSON.stringify(operations)) as {
    ref: string;
    version: number | null;
    at: number;
  }[];
  for (const row of rows) out.set(`${row.ref}#${row.version ?? ""}`, row.at);
  return out;
}

/**
 * Whether undated rows may still be dated by the event log: true until the
 * migration-171 backfill has copied every older event (afterwards the event
 * triggers keep every row current, so the scan would find nothing new).
 */
function eventsMayDate(raw: Raw): boolean {
  return !knownAtBackfillState(raw)?.done;
}

interface VersionRow {
  version: number;
  content: string;
  created_at: number;
  known_at: number | null;
}

function versionsUpTo(raw: Raw, recordId: string, maxVersion: number): VersionRow[] {
  return raw
    .query(
      `SELECT v.version AS version, n.content AS content, n.created_at AS created_at,
              v.known_at AS known_at
         FROM memory_record_versions v JOIN notes n ON n.id = v.note_id
        WHERE v.record_id = ? AND v.version <= ?
        ORDER BY v.version DESC`,
    )
    .all(recordId, maxVersion) as VersionRow[];
}

/**
 * The newest version of `recordId` (at most `maxVersion`) known by `asOf`, or
 * undefined. `handleCreatedAt` dates version 1 for a numeric handle; without
 * it every version needs its service event.
 */
export function recordVersionAsOf(
  db: MarinaDB,
  recordId: string,
  maxVersion: number,
  asOf: number,
  handleCreatedAt?: number,
): VersionRow | undefined {
  const raw = db.memoryRepository().raw;
  const versions = versionsUpTo(raw, recordId, maxVersion);
  if (versions.length === 0) return undefined;
  let events: Map<string, number> | undefined;
  for (const row of versions) {
    let knownAt: number | undefined;
    if (row.version === 1 && handleCreatedAt !== undefined) knownAt = handleCreatedAt;
    else {
      let at = row.known_at ?? undefined;
      if (at === undefined && eventsMayDate(raw)) {
        events ??= eventTimes(raw, [recordId], RECORD_OPERATIONS);
        at = events.get(`${recordId}#${row.version}`);
      }
      if (at === undefined) continue; // no reliable known-at: never served
      knownAt = Math.max(at, row.created_at);
    }
    if (knownAt <= asOf) return row;
  }
  return undefined;
}

/**
 * A numeric note as it stood at `asOf`: undefined when the note was not yet
 * known; the note itself when it was never revised (as before); otherwise the
 * newest version known by then, with its own content and `asOf` set.
 */
export function noteAsOf<T extends { id: number; content: string; created_at: number }>(
  db: MarinaDB,
  note: T,
  asOf: number,
): (T & { asOf?: AsOfServed }) | undefined {
  if (note.created_at > asOf) return undefined;
  const twin = findDurableTwin(db, note.id);
  const current = twin?.version ?? 1;
  if (!twin || current <= 1) return note;
  const row = recordVersionAsOf(db, twin.recordId, current, asOf, note.created_at);
  if (!row) return undefined;
  if (row.version === current) return note;
  return { ...note, content: row.content, asOf: { version: row.version, current } };
}

/** Persisted known-at per id (`table.column`, migration 171); NULLs omitted. */
function persistedKnownAt(
  raw: Raw,
  table: "memory_sources" | "memory_assistance_jobs",
  column: "known_at" | "completed_known_at",
  ids: readonly string[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const rows = raw
    .query(
      `SELECT id, ${column} AS at FROM ${table}
        WHERE id IN (SELECT value FROM json_each(?)) AND ${column} IS NOT NULL`,
    )
    .all(JSON.stringify(ids)) as { id: string; at: number }[];
  for (const row of rows) out.set(row.id, row.at);
  return out;
}

/** Persisted times first; ids still undated fall back to the event log while it may date them. */
function knownAtWithFallback(
  raw: Raw,
  ids: readonly string[],
  persisted: Map<string, number>,
  operation: string,
): Map<string, number> {
  const missing = ids.filter((id) => !persisted.has(id));
  if (missing.length === 0 || !eventsMayDate(raw)) return persisted;
  for (const [key, at] of eventTimes(raw, missing, [operation])) {
    const id = key.slice(0, key.lastIndexOf("#"));
    persisted.set(id, Math.max(at, persisted.get(id) ?? 0));
  }
  return persisted;
}

/** Known-at times of captured sources (`source.captured`); missing ⇒ unknown. */
export function sourcesKnownAt(db: MarinaDB, sourceIds: readonly string[]): Map<string, number> {
  const raw = db.memoryRepository().raw;
  const persisted = persistedKnownAt(raw, "memory_sources", "known_at", sourceIds);
  return knownAtWithFallback(raw, sourceIds, persisted, "source.captured");
}

/** When each assistance job's answer was recorded (`assistance.completed`); missing ⇒ unknown. */
export function proposalsKnownAt(db: MarinaDB, jobIds: readonly string[]): Map<string, number> {
  const raw = db.memoryRepository().raw;
  const persisted = persistedKnownAt(raw, "memory_assistance_jobs", "completed_known_at", jobIds);
  return knownAtWithFallback(raw, jobIds, persisted, "assistance.completed");
}

// ─── Ranking under a cutoff ──────────────────────────────────────────────

/** Candidate handles considered per fenced recall (ordered by creation, newest first). */
export const FENCED_RECALL_CANDIDATES = 500;

/** Share of the query's terms a text matches, and how many. */
function coverage(text: string, terms: readonly string[]): { matched: number; share: number } {
  if (terms.length === 0) return { matched: 0, share: 0 };
  const matches = termMatcher(text);
  let matched = 0;
  for (const term of terms) if (matches(term)) matched++;
  return { matched, share: matched / terms.length };
}

/**
 * Keep the items whose SERVED (as-of) text matches at least `minMatched` of
 * the query's terms, best coverage first; ties broken by `tiebreak`, which
 * must read only what was known by the cutoff. Nothing current is consulted.
 */
export function rankAsOf<T>(
  items: readonly T[],
  query: string,
  opts: {
    text: (item: T) => string;
    tiebreak: (a: T, b: T) => number;
    minMatched?: number;
  },
): { item: T; share: number }[] {
  const terms = queryTerms(query);
  const min = Math.max(1, opts.minMatched ?? 1);
  return items
    .map((item) => ({ item, ...coverage(opts.text(item), terms) }))
    .filter((hit) => hit.matched >= min)
    .sort((a, b) => b.share - a.share || opts.tiebreak(a.item, b.item))
    .map(({ item, share }) => ({ item, share }));
}

/**
 * `recall` as of `asOf`: the entity's own fact-like notes known by the cutoff
 * whose AS-OF text matches the query (any term, as the unfenced FTS OR does),
 * served at that version and ranked on it (`score` = term coverage). A note
 * whose only match is a later revision is never selected and never moves
 * another; graph expansion is skipped (links carry no as-of date). With
 * `trusted`, only unrevised notes that are trusted now (a historical version
 * is never trusted).
 */
export function fencedNoteRecall(
  db: MarinaDB,
  entityName: string,
  query: string,
  asOf: number,
  opts: { noteType?: string; trusted?: boolean; limit?: number } = {},
): (ScoredNoteRow & { asOf?: AsOfServed })[] {
  const fts = buildFtsQuery(query, "or");
  if (!fts) return [];
  const raw = db.memoryRepository().raw;
  const tiers = FACT_LIKE_TIERS.map((t) => `'${t}'`).join(", ");
  const rows = raw
    .query(
      `WITH matched AS MATERIALIZED (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)
       SELECT n.*, 0 AS score FROM numeric_notes n
        WHERE n.entity_name = ? AND n.pool_id IS NULL AND n.verification_status != 'superseded'
          AND n.tier IN (${tiers}) AND (? IS NULL OR n.note_type = ?) AND n.created_at <= ?
          AND (n.content_id IN (SELECT rowid FROM matched)
               OR n.id IN (SELECT p.note_id FROM memory_note_projections p
                             JOIN memory_record_versions v ON v.record_id = p.record_id
                            WHERE v.note_id IN (SELECT rowid FROM matched)))
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT ?`,
    )
    .all(
      fts,
      entityName,
      opts.noteType ?? null,
      opts.noteType ?? null,
      asOf,
      FENCED_RECALL_CANDIDATES,
    ) as ScoredNoteRow[];
  const known = rows.flatMap((row) => {
    const note = noteAsOf(db, row, asOf);
    if (!note) return [];
    if (opts.trusted && (note.asOf || !isTrustedNote(db, note))) return [];
    return [note];
  });
  return rankAsOf(known, query, {
    text: (n) => n.content,
    tiebreak: (a, b) => b.created_at - a.created_at || b.id - a.id,
  })
    .slice(0, opts.limit ?? 20)
    .map(({ item, share }) => ({ ...item, score: share }));
}
