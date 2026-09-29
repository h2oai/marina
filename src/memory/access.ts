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
  /**
   * Batch `read`: the readable notes among `notes`, in input order. One
   * service-note query for the whole set; each pool (and its group
   * membership) is looked up once per call rather than once per note.
   */
  function readable(notes: readonly (NoteRow | undefined)[]): NoteRow[] {
    const present = notes.filter((n): n is NoteRow => !!n);
    if (present.length === 0) return [];
    const service = db.serviceMemoryNoteIds(present.map((n) => n.id));
    const pools = new Map<string, boolean>();
    const poolOk = (id: string) => {
      let ok = pools.get(id);
      if (ok === undefined) {
        ok = pool(db.getMemoryPoolById(id));
        pools.set(id, ok);
      }
      return ok;
    };
    return present.filter(
      (note) =>
        !service.has(note.id) &&
        (note.pool_id ? poolOk(note.pool_id) : note.entity_name === actor.name),
    );
  }
  /** Links among `notes`-adjacent ids whose BOTH endpoints are readable. */
  function readableLinks<L extends { source_id: number; target_id: number }>(
    rows: readonly L[],
    known: readonly NoteRow[] = [],
  ): L[] {
    if (rows.length === 0) return [];
    const byId = new Map(known.map((n) => [n.id, n] as const));
    const missing = new Set<number>();
    for (const link of rows) {
      if (!byId.has(link.source_id)) missing.add(link.source_id);
      if (!byId.has(link.target_id)) missing.add(link.target_id);
    }
    for (const note of db.getNotes([...missing])) byId.set(note.id, note);
    const ok = new Set(readable([...byId.values()]).map((n) => n.id));
    return rows.filter((link) => ok.has(link.source_id) && ok.has(link.target_id));
  }
  function links(noteId: number) {
    if (!read(db.getNote(noteId))) return [];
    // One batched read for every note the links reference instead of two
    // getNote round-trips per link (the N+1 the dashboard observer also had).
    return readableLinks(db.getNoteLinks(noteId));
  }

  return {
    pool,
    read,
    readable,
    readableLinks,
    write,
    links,
    trace: (noteId: number, depth = 2) => db.traceNoteGraph(noteId, depth, read),
  };
}
