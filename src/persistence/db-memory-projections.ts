// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import type { MemoryRecordInput } from "../memory/service-types";
import { bindNumericRecord } from "./db-memory-numeric";
import { deleteStoredNote } from "./db-note-storage";
import { normalizeClaim } from "./db-notes";

export function boundMemoryRecordId(db: Database, noteId: number): string | undefined {
  return db
    .query<{ record_id: string }, [number]>(
      "SELECT record_id FROM memory_note_projections WHERE note_id=?",
    )
    .get(noteId)?.record_id;
}
export const bindMemoryNote = bindNumericRecord;

/** Only world metadata changes here. Content/importance are read through the
 * numeric_notes view from the exact canonical version, never copied. */
export function projectMemoryRevision(
  db: Database,
  recordId: string,
  input: MemoryRecordInput,
  previousContent: string,
): void {
  const record = db
    .query<{ metadata: string; valid_until: number | null }, [string]>(
      "SELECT metadata,valid_until FROM memory_records WHERE id=?",
    )
    .get(recordId)!;
  const resolution = JSON.parse(record.metadata).resolution as { status?: string } | undefined;
  const changed = previousContent !== input.content;
  const closed = record.valid_until !== null && record.valid_until <= Date.now();
  db.run(
    `UPDATE notes SET
    verification_status=CASE WHEN ? THEN 'superseded' WHEN ? THEN 'disputed'
      WHEN ? OR verification_status='disputed' THEN 'unverified' ELSE verification_status END,
    confidence=CASE WHEN ? THEN 0.5 ELSE confidence END,
    claim_key=CASE WHEN ? THEN ? ELSE claim_key END,
    note_type=coalesce(?,note_type),tier=coalesce(?,tier)
    WHERE id IN (SELECT note_id FROM memory_note_projections WHERE record_id=? AND version IS NULL)
      AND verification_status!='superseded'`,
    [
      resolution?.status === "superseded" ? 1 : 0,
      closed ? 1 : 0,
      changed ? 1 : 0,
      changed ? 1 : 0,
      changed ? 1 : 0,
      normalizeClaim(input.content),
      input.type ?? null,
      input.tier ?? null,
      recordId,
    ],
  );
}

/** Explicit erasure includes all numeric addresses; no replay can recreate them. */
export function forgetMemoryNotes(db: Database, recordId: string): void {
  const handles = db
    .query<{ id: number; entity_name: string }, [string]>(`SELECT n.id,n.entity_name FROM notes n
    JOIN memory_note_projections p ON p.note_id=n.id WHERE p.record_id=?`)
    .all(recordId);
  for (const handle of handles) deleteStoredNote(db, handle.id, handle.entity_name);
}

export function numericMemoryReference(db: Database, noteId: number) {
  return (
    db
      .query<
        { recordId: string; version: number; spaceId: string },
        [number]
      >(`SELECT p.record_id AS recordId,
    coalesce(p.version,r.version) AS version,r.space_id AS spaceId
    FROM memory_note_projections p JOIN memory_records r ON r.id=p.record_id WHERE p.note_id=?`)
      .get(noteId) ?? undefined
  );
}

export function numericNotesForRecord(
  db: Database,
  owner: string,
  recordId: string,
  limit: number,
) {
  return db
    .query(`SELECT n.* FROM numeric_notes n JOIN memory_note_projections p ON p.note_id=n.id
    WHERE p.record_id=? AND n.entity_name=? ORDER BY n.id DESC LIMIT ?`)
    .all(recordId, owner, limit) as import("./db-notes").NoteRow[];
}

export function numericMemoryIntegrity(db: Database) {
  const count = (sql: string) => db.query<{ n: number }, []>(sql).get()!.n;
  return {
    unconverted: count(`SELECT count(*) n FROM notes n WHERE n.entity_name NOT LIKE 'memory:%'
      AND n.tier IN ('fact','reflection','skill') AND NOT EXISTS (SELECT 1 FROM memory_note_projections p WHERE p.note_id=n.id)`),
    broken:
      count(`SELECT count(*) n FROM memory_note_projections p JOIN memory_records r ON r.id=p.record_id
      LEFT JOIN memory_record_versions v ON v.record_id=r.id AND v.version=coalesce(p.version,r.version)
      WHERE r.status!='active' OR v.note_id IS NULL`),
    duplicateBodies: count(
      `SELECT count(*) n FROM memory_note_projections p JOIN notes n ON n.id=p.note_id WHERE n.content!=''`,
    ),
  };
}
