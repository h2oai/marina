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
 * A version, source or proposal with no such event — imported from a bundle
 * (its row times are the exporter's), converted before the event existed, or
 * past the event log's 30-day retention — has no reliable known-at and is
 * NOT served (fail closed). Content served is always the chosen version's
 * own text, never the current one.
 */

import type { MarinaDB } from "../persistence/database";
import { findDurableTwin } from "./legacy-projection";

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

interface VersionRow {
  version: number;
  content: string;
  created_at: number;
}

function versionsUpTo(raw: Raw, recordId: string, maxVersion: number): VersionRow[] {
  return raw
    .query(
      `SELECT v.version AS version, n.content AS content, n.created_at AS created_at
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
  const events = eventTimes(raw, [recordId], RECORD_OPERATIONS);
  for (const row of versions) {
    let knownAt: number | undefined;
    if (row.version === 1 && handleCreatedAt !== undefined) knownAt = handleCreatedAt;
    else {
      const at = events.get(`${recordId}#${row.version}`);
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

/** Known-at times of captured sources (`source.captured`); missing ⇒ unknown. */
export function sourcesKnownAt(db: MarinaDB, sourceIds: readonly string[]): Map<string, number> {
  const times = eventTimes(db.memoryRepository().raw, sourceIds, ["source.captured"]);
  const out = new Map<string, number>();
  for (const [key, at] of times) out.set(key.slice(0, key.lastIndexOf("#")), at);
  return out;
}

/** When each assistance job's answer was recorded (`assistance.completed`); missing ⇒ unknown. */
export function proposalsKnownAt(db: MarinaDB, jobIds: readonly string[]): Map<string, number> {
  const times = eventTimes(db.memoryRepository().raw, jobIds, ["assistance.completed"]);
  const out = new Map<string, number>();
  for (const [key, at] of times) {
    const id = key.slice(0, key.lastIndexOf("#"));
    out.set(id, Math.max(at, out.get(id) ?? 0));
  }
  return out;
}
