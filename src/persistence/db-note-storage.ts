// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Physical rows for immutable canonical versions and process/core journals.
 * Fact-like world writers must use db-notes, which creates numeric handles. */
import type { Database } from "bun:sqlite";
import { DEFAULT_NOTE_IMPORTANCE, type NoteTier } from "../engine/constants";
import { inferTier, type NoteRow, normalizeClaim } from "./db-notes";

export function createStoredNote(
  db: Database,
  entityName: string,
  content: string,
  roomId?: string,
  opts?: {
    importance?: number;
    noteType?: string;
    poolId?: string;
    supersedesId?: number;
    tier?: NoteTier;
    /** Accepted by existing canonical callers; this physical allocator never
     * deduplicates. Numeric write adapters own their logical dedup policy. */
    skipDedup?: boolean;
    confidence?: number;
    verificationStatus?: string;
    claimKey?: string;
  },
): number {
  const noteType = opts?.noteType ?? "observation";
  const tier = opts?.tier ?? inferTier(content, noteType);

  const result = db.run(
    "INSERT INTO notes (entity_name, room_id, content, importance, note_type, pool_id, supersedes_id, tier, confidence, verification_status, claim_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      entityName,
      roomId ?? null,
      content,
      opts?.importance ?? DEFAULT_NOTE_IMPORTANCE,
      noteType,
      opts?.poolId ?? null,
      opts?.supersedesId ?? null,
      tier,
      Math.max(0, Math.min(1, opts?.confidence ?? 0.5)),
      opts?.verificationStatus ?? "unverified",
      opts?.claimKey ?? normalizeClaim(content),
      Date.now(),
    ],
  );
  const id = Number(result.lastInsertRowid);

  return id;
}

export function getStoredNote(db: Database, id: number): NoteRow | undefined {
  return (db.query("SELECT * FROM notes WHERE id=?").get(id) as NoteRow | null) ?? undefined;
}

export function reviseStoredNote(
  db: Database,
  entityName: string,
  id: number,
  content: string,
  opts?: { importance?: number; noteType?: string },
): number | undefined {
  const previous = getStoredNote(db, id);
  if (
    !previous ||
    previous.entity_name !== entityName ||
    previous.verification_status === "superseded"
  )
    return undefined;
  const successor = createStoredNote(db, entityName, content, previous.room_id ?? undefined, {
    importance: opts?.importance ?? previous.importance,
    noteType: opts?.noteType ?? previous.note_type,
    tier: previous.tier,
    supersedesId: id,
    skipDedup: true,
  });
  db.run("UPDATE notes SET verification_status='superseded' WHERE id=?", [id]);
  return successor;
}

export function deleteStoredNote(db: Database, id: number, entityName: string): boolean {
  return db.transaction(() => {
    if (!db.query("SELECT 1 FROM notes WHERE id=? AND entity_name=?").get(id, entityName))
      return false;
    db.run("DELETE FROM note_links WHERE source_id=? OR target_id=?", [id, id]);
    db.run("UPDATE notes SET supersedes_id=NULL WHERE supersedes_id=?", [id]);
    return db.run("DELETE FROM notes WHERE id=?", [id]).changes > 0;
  })();
}
