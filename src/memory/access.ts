// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MarinaDB, MemoryPoolRow, NoteRow } from "../persistence/database";

/** Resource policy for the legacy name-scoped memory surface. Rank is unrelated
 * to ownership. Callers supply an authenticated namespace, never a claimed ID. */
export function memoryAccess(db: MarinaDB, actor: { name: string; id?: string }) {
  const entityId = actor.id ?? db.findEntityIdByName(actor.name);
  function pool(pool: MemoryPoolRow | undefined): boolean {
    return (
      !!pool && (!pool.group_id || (!!entityId && !!db.getGroupMember(pool.group_id, entityId)))
    );
  }
  function read(note: NoteRow | undefined): note is NoteRow {
    if (!note || db.isServiceMemoryNote(note.id)) return false;
    return note.pool_id
      ? pool(db.getMemoryPoolById(note.pool_id))
      : note.entity_name === actor.name;
  }
  function write(note: NoteRow | undefined): note is NoteRow {
    return read(note) && note.entity_name === actor.name;
  }
  function links(noteId: number) {
    if (!read(db.getNote(noteId))) return [];
    return db
      .getNoteLinks(noteId)
      .filter((link) => read(db.getNote(link.source_id)) && read(db.getNote(link.target_id)));
  }
  return {
    pool,
    read,
    write,
    links,
    trace: (noteId: number, depth = 2) => db.traceNoteGraph(noteId, depth, read),
  };
}
