// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import {
  bindNumericRecord,
  linkNumericNotes,
  materializeNumericNote,
  numericRecord,
  retireNumericNote,
  sourceNumericNote,
  verifyNumericNote,
} from "./db-memory-numeric";
import { numericMemoryBinding } from "./db-memory-resident";
import { readMemoryRecord, reviseRecord } from "./db-memory-service";
import { withMemoryUpgrade } from "./db-memory-upgrade-scope";
import type { NoteLinkRow, NoteRow, NoteSourceRow, NoteVerificationRow } from "./db-notes";

/** Version 138 is a data conversion, committed with the DDL and version marker.
 * No requests, background worker, timer or network are involved in startup. */
export function upgradeNumericMemory(
  db: Database,
  importedIntents?: { operation: string; args: string }[],
): void {
  withMemoryUpgrade(db, () => convertNumericMemory(db, importedIntents));
}
function convertNumericMemory(
  db: Database,
  importedIntents?: { operation: string; args: string }[],
): void {
  if (!db.inTransaction) throw new Error("Memory conversion requires an enclosing transaction");
  // Early durable releases could reference an ordinary-name notes row. Its
  // record-version membership, not its spelling, makes it canonical storage.
  // It was already excluded by isServiceMemoryNote; retain its ID and history.
  db.run(`UPDATE notes SET entity_name='memory:' || coalesce(
    (SELECT u.id FROM users u WHERE u.name=notes.entity_name),
    (SELECT s.owner_id FROM memory_record_versions v JOIN memory_records r ON r.id=v.record_id
      JOIN memory_spaces s ON s.id=r.space_id WHERE v.note_id=notes.id))
    WHERE entity_name NOT LIKE 'memory:%' AND EXISTS(SELECT 1 FROM memory_record_versions v WHERE v.note_id=notes.id)`);
  // Restore projections absent from snapshots made before migrations 133/135.
  // Matching ownership and authored content are mandatory; a URL alone is not authority.
  db.run(`INSERT OR IGNORE INTO memory_note_projections(note_id,record_id)
    SELECT n.id,r.id FROM notes n JOIN users u ON u.name=n.entity_name JOIN note_sources ns ON ns.note_id=n.id
    JOIN memory_records r ON r.id=json_extract(CASE WHEN json_valid(ns.metadata) THEN ns.metadata ELSE '{}' END,'$.record_id')
    JOIN memory_spaces s ON s.id=r.space_id AND s.owner_id=u.id JOIN notes c ON c.id=r.current_note_id
    WHERE n.entity_name NOT LIKE 'memory:%' AND ns.captured_by=n.entity_name AND ns.credibility=0
      AND json_extract(ns.metadata,'$.kind')='durable-twin' AND coalesce(json_extract(ns.metadata,'$.mirror'),'')!='institutional'
      AND ns.url='marina-memory://record/' || r.id AND r.status='active' AND s.status='active'
      AND (n.content=c.content OR json_extract(r.metadata,'$.legacy_note_id')=n.id)`);
  const inactive = db
    .query<{ principal_id: string; status: string }, []>(
      "SELECT principal_id,status FROM principals WHERE status!='active'",
    )
    .all();
  // This transaction is not visible to another connection. Preserve suspended
  // owners without exposing a runtime path that can activate their credentials.
  db.run("UPDATE principals SET status='active' WHERE status!='active'");
  const notes = db
    .query(
      "SELECT * FROM notes WHERE entity_name NOT LIKE 'memory:%' AND tier IN ('fact','reflection','skill') ORDER BY id",
    )
    .all() as NoteRow[];
  for (const note of notes) {
    const mapping = numericRecord(db, note.id);
    if (mapping) {
      const version =
        note.verification_status === "superseded"
          ? db
              .query<
                { version: number },
                [string, string]
              >(`SELECT v.version FROM memory_record_versions v JOIN notes c ON c.id=v.note_id
          WHERE v.record_id=? AND c.content=? ORDER BY v.version DESC LIMIT 1`)
              .get(mapping.record_id, note.content)?.version
          : undefined;
      if (note.verification_status === "superseded" && version === undefined)
        throw new Error(`Cannot locate historical memory for numeric note ${note.id}`);
      bindNumericRecord(db, note.id, mapping.record_id, version ?? null);
    } else materializeNumericNote(db, note.id);
  }
  for (const note of notes) {
    for (const source of db
      .query("SELECT * FROM note_sources WHERE note_id=?")
      .all(note.id) as NoteSourceRow[]) {
      sourceNumericNote(db, note.id, {
        url: source.url,
        sourceType: source.source_type as "url",
        credibility: source.credibility,
        observedAt: source.observed_at ?? undefined,
        sourceNoteId: source.source_note_id ?? undefined,
        capturedBy: source.captured_by ?? undefined,
      });
    }
    const verification = db
      .query("SELECT * FROM note_verifications WHERE note_id=? ORDER BY id DESC LIMIT 1")
      .get(note.id) as NoteVerificationRow | null;
    if (verification && verification.status === note.verification_status)
      verifyNumericNote(
        db,
        note.id,
        verification.verifier,
        verification.status,
        verification.confidence,
        verification.id,
        verification.rationale ?? undefined,
      );
  }
  for (const link of db.query("SELECT * FROM note_links ORDER BY id").all() as NoteLinkRow[])
    linkNumericNotes(db, link.source_id, link.target_id, link.relationship);
  // Deletes are the one intent whose originating numeric row no longer exists.
  // Retire through a temporary trusted handle only after checking durable owner
  // and the record's authored legacy identity (never trust a source URL).
  // Pending deletion recovery is implemented below before the outbox is removed.
  finishRetirements(db, importedIntents);
  for (const principal of inactive)
    db.run("UPDATE principals SET status=? WHERE principal_id=?", [
      principal.status,
      principal.principal_id,
    ]);
  db.exec("DROP TABLE IF EXISTS legacy_memory_outbox");
}

function finishRetirements(
  db: Database,
  importedIntents?: { operation: string; args: string }[],
): void {
  const pending =
    importedIntents ??
    (db.query("SELECT 1 FROM sqlite_schema WHERE name='legacy_memory_outbox'").get()
      ? db
          .query<{ operation: string; args: string }, []>(
            "SELECT operation,args FROM legacy_memory_outbox ORDER BY id",
          )
          .all()
      : []);
  for (const job of pending) {
    if (
      !["bridgeLegacyConsolidation", "retireDurableTwin", "bridgeLegacyUnlink"].includes(
        job.operation,
      )
    )
      continue;
    const args = JSON.parse(job.args) as unknown[];
    if (job.operation === "bridgeLegacyUnlink") {
      const [owner, source, target, relation] = args as [string, number, number, string];
      if (
        db
          .query("SELECT 1 FROM note_links WHERE source_id=? AND target_id=? AND relationship=?")
          .get(source, target, relation)
      )
        continue;
      // A delete may already have removed either numeric address. Retire the
      // author's relation assertion directly; this never creates a note binding.
      const relations = db
        .query<
          { id: string; space_id: string },
          [string, number, number, string]
        >(`SELECT r.id,r.space_id FROM memory_records r
        JOIN memory_spaces s ON s.id=r.space_id JOIN users u ON u.id=s.owner_id
        WHERE u.name=? AND r.status='active' AND json_extract(r.metadata,'$.kind')='legacy-link'
          AND json_extract(r.metadata,'$.legacy_source_note_id')=? AND json_extract(r.metadata,'$.legacy_target_note_id')=?
          AND json_extract(r.metadata,'$.relationship')=? AND r.valid_until IS NULL`)
        .all(owner, source, target, relation);
      if (relations.length) {
        const { actor } = numericMemoryBinding(db, owner);
        for (const row of relations) {
          const record = readMemoryRecord(db, actor, row.space_id, row.id);
          reviseRecord(
            db,
            actor,
            row.space_id,
            row.id,
            record.version,
            {
              content: record.content,
              importance: record.importance,
              metadata: { ...record.metadata, unlinked_at: Date.now() },
              valid_time: { from: record.valid_time?.from ?? null, until: Date.now() },
            },
            `numeric:upgrade:unlink:${row.id}:${record.version}`,
          );
        }
      }
      continue;
    }
    if (job.operation === "bridgeLegacyConsolidation") {
      for (const id of args[2] as number[]) {
        db.run(
          `UPDATE memory_note_projections SET version=NULL WHERE note_id=? AND version=(SELECT r.version FROM memory_records r WHERE r.id=record_id)`,
          [id],
        );
        retireNumericNote(db, id, "superseded", Number(args[1]));
      }
      continue;
    }
    const [owner, id, twin] = args as [string, number, { recordId: string }];
    const record = db
      .query<
        { id: string; metadata: string; content: string; version: number },
        [string, string]
      >(`SELECT r.id,r.metadata,n.content,r.version FROM memory_records r
      JOIN memory_spaces s ON s.id=r.space_id JOIN users u ON u.id=s.owner_id JOIN notes n ON n.id=r.current_note_id
      WHERE r.id=? AND u.name=? AND r.status='active'`)
      .get(twin.recordId, owner);
    if (!record) continue;
    const metadata = JSON.parse(record.metadata);
    if (
      metadata.deleted_legacy_note_id !== undefined ||
      metadata.retired_legacy_note_id !== undefined ||
      (metadata.legacy_note_id !== undefined && metadata.legacy_note_id !== id)
    )
      continue;
    if (db.query("SELECT 1 FROM notes WHERE id=?").get(id)) continue;
    db.run("INSERT INTO notes(id,entity_name,content,created_at) VALUES (?,?,?,?)", [
      id,
      owner,
      record.content,
      Date.now(),
    ]);
    bindNumericRecord(db, id, record.id);
    retireNumericNote(db, id);
    db.run("DELETE FROM memory_note_projections WHERE note_id=?", [id]);
    db.run("DELETE FROM notes WHERE id=?", [id]);
  }
}
