// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { MemoryError, type MemoryRecordInput } from "../memory/service-types";
import { deleteNote, normalizeClaim } from "./db-notes";

export function boundMemoryRecordId(db: Database, noteId: number): string | undefined {
  return db
    .query<{ record_id: string }, [number]>(
      "SELECT record_id FROM memory_note_projections WHERE note_id=?",
    )
    .get(noteId)?.record_id;
}

/** Server-created identity mapping, never inferred from caller-supplied metadata
 * or a note source URL. Institutional publications are separate records. */
export function bindMemoryNote(db: Database, noteId: number, recordId: string): void {
  const eligible = db
    .query(`SELECT 1 FROM notes n JOIN users u ON u.name=n.entity_name
    JOIN memory_spaces s ON s.owner_id=u.id
    JOIN memory_records r ON r.space_id=s.id
    WHERE n.id=? AND r.id=? AND n.entity_name NOT LIKE 'memory:%'
      AND r.status='active' AND s.status='active'`)
    .get(noteId, recordId);
  // A publication in someone else's space is provenance, not authority over
  // this author's private notes. Keep that explicit copy unbound.
  if (!eligible) return;
  db.run(
    `INSERT INTO memory_note_projections(note_id,record_id) VALUES (?,?)
    ON CONFLICT(note_id) DO NOTHING`,
    [noteId, recordId],
  );
  const bound = db
    .query<{ record_id: string }, [number]>(
      "SELECT record_id FROM memory_note_projections WHERE note_id=?",
    )
    .get(noteId)!;
  if (bound.record_id !== recordId) throw new Error("Memory projection is already bound");
}

const projectionLineage = `WITH RECURSIVE lineage(id) AS (
  SELECT note_id FROM memory_note_projections WHERE record_id=?
  UNION SELECT n.id FROM notes n JOIN notes parent ON parent.id=n.supersedes_id
    JOIN lineage l ON l.id=parent.id WHERE n.entity_name=parent.entity_name
)`;

/** A committed legacy correction must be drained before another durable edit.
 * Only the adapter carrying that exact stored successor may advance it. */
export function requireCurrentMemoryProjection(
  db: Database,
  recordId: string,
  input: MemoryRecordInput,
): void {
  const pending = db
    .query<{ id: number; content: string }, [string]>(`${projectionLineage}
    SELECT n.id,n.content FROM notes n JOIN lineage l ON l.id=n.id
    WHERE NOT EXISTS (SELECT 1 FROM memory_note_projections p WHERE p.note_id=n.id)
    ORDER BY n.id LIMIT 1`)
    .get(recordId);
  if (
    pending &&
    (input.metadata?.legacy_note_id !== pending.id || input.content !== pending.content)
  )
    throw new MemoryError(
      409,
      "compatibility_pending",
      "A legacy correction is pending; drain memory compatibility work before revising this record",
    );
}

/** Called inside the authorized durable revision transaction. Numeric IDs and
 * pool ACLs remain stable. Old legacy correction rows remain historical. */
export function projectMemoryRevision(
  db: Database,
  recordId: string,
  input: MemoryRecordInput,
): void {
  const record = db
    .query<
      {
        content: string;
        importance: number;
        note_type: string;
        tier: string;
        valid_until: number | null;
        metadata: string;
      },
      [string]
    >(`
    SELECT n.content,n.importance,n.note_type,n.tier,r.valid_until,r.metadata
    FROM memory_records r JOIN notes n ON n.id=r.current_note_id WHERE r.id=?`)
    .get(recordId)!;
  const metadata = JSON.parse(record.metadata) as Record<string, unknown>;
  const resolution = metadata.resolution as { status?: string } | undefined;
  const closed = record.valid_until !== null && record.valid_until <= Date.now();
  // An authored durable edit does not inherit verification of different text.
  // A validity closure is disputed; a policy supersession remains historical.
  db.run(
    `UPDATE notes SET
    verification_status=CASE WHEN ? THEN 'superseded' WHEN ? THEN 'disputed'
      WHEN content!=? OR verification_status='disputed' THEN 'unverified'
      ELSE verification_status END,
    confidence=CASE WHEN content!=? THEN 0.5 ELSE confidence END,
    claim_key=CASE WHEN content!=? THEN ? ELSE claim_key END,
    content=?,importance=?,
    note_type=CASE WHEN ? THEN ? ELSE note_type END,
    tier=CASE WHEN ? THEN ? ELSE tier END
    WHERE id IN (SELECT note_id FROM memory_note_projections WHERE record_id=?)
      AND verification_status!='superseded'`,
    [
      resolution?.status === "superseded" ? 1 : 0,
      closed ? 1 : 0,
      record.content,
      record.content,
      record.content,
      normalizeClaim(record.content),
      record.content,
      record.importance,
      input.type !== undefined ? 1 : 0,
      record.note_type,
      input.tier !== undefined ? 1 : 0,
      record.tier,
      recordId,
    ],
  );
}

/** Explicit durable erasure includes all mapped legacy revisions. Remove the
 * mapping/provenance before deleting so legacy retirement cannot loop back. */
export function forgetMemoryNotes(db: Database, recordId: string): void {
  const notes = db
    .query<{ id: number; entity_name: string }, [string]>(`${projectionLineage}
    SELECT n.id,n.entity_name FROM notes n JOIN lineage l ON l.id=n.id`)
    .all(recordId);
  for (const note of notes) {
    db.run("DELETE FROM note_sources WHERE note_id=? AND url LIKE 'marina-memory://record/%'", [
      note.id,
    ]);
    deleteNote(db, note.id, note.entity_name);
    db.run(
      `DELETE FROM legacy_memory_outbox WHERE json_extract(args,'$[0]')=? AND (
      (operation IN ('bridgeLegacyNote','bridgeLegacyPoolNote','bridgeLegacySource',
        'bridgeLegacyVerification','retireDurableTwin') AND json_extract(args,'$[1]')=?) OR
      (operation IN ('bridgeLegacyRevision','bridgeLegacyLink','bridgeLegacyUnlink')
        AND (json_extract(args,'$[1]')=? OR json_extract(args,'$[2]')=?)))`,
      [note.entity_name, note.id, note.id, note.id],
    );
  }
}
