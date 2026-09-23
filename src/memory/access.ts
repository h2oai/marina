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
    const rows = db.getNoteLinks(noteId);
    if (rows.length === 0) return rows;
    // One batched read for every note the links reference instead of two
    // getNote round-trips per link (the N+1 the dashboard observer also had).
    const ids = new Set<number>();
    for (const link of rows) {
      ids.add(link.source_id);
      ids.add(link.target_id);
    }
    const byId = new Map(db.getNotes([...ids]).map((n) => [n.id, n] as const));
    return rows.filter((link) => read(byId.get(link.source_id)) && read(byId.get(link.target_id)));
  }

  return {
    pool,
    read,
    write,
    links,
    trace: (noteId: number, depth = 2) => db.traceNoteGraph(noteId, depth, read),
  };
}
