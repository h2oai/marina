// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Engine } from "../engine/engine";
import { getRank } from "../engine/permissions";
import { checkUnattendedGate } from "../engine/safety-gates";
import { memoryAccess } from "../memory/access";
import type { MarinaDB, NoteRow } from "../persistence/database";
import { RoutingService } from "../routing/service";
import type { EngineEvent, EntityId } from "../types";
import { isOperatorPrincipal, isSentinelPrincipal } from "./auth-middleware";

/** Existing explicit local-development/operator policy, shared by HTTP and WS. */
export function memoryObserver(engine: Engine, principal?: string) {
  const id = principal as EntityId | undefined;
  const entity = id ? engine.entities.get(id) : undefined;
  const operator =
    !!id &&
    (isOperatorPrincipal(id) ||
      (!!entity && getRank(entity) >= 9) ||
      (!!engine.db && checkUnattendedGate(engine.db, id, "admin.destructive").ok));
  const privilegedRead =
    operator || principal === "loopback-anon" || (!!id && isSentinelPrincipal(id));
  const access = engine.db ? memoryAccess(engine.db, { name: entity?.name ?? "", id }) : undefined;
  const read = (note: NoteRow | undefined): note is NoteRow =>
    !!note && (privilegedRead || !!access?.read(note));
  // Batch `read` for list surfaces (`/api/graph`): one service-note query and
  // one ACL lookup per pool for the whole set, never a `getNote` per row.
  const readable = (notes: readonly (NoteRow | undefined)[]): NoteRow[] =>
    privilegedRead ? notes.filter((n): n is NoteRow => !!n) : (access?.readable(notes) ?? []);
  const readableLinks = <L extends { source_id: number; target_id: number }>(
    rows: readonly L[],
    known: readonly NoteRow[] = [],
  ): L[] => {
    const db = engine.db;
    if (!db || rows.length === 0) return [];
    const byId = new Map(known.map((n) => [n.id, n] as const));
    const missing = rows
      .flatMap((l) => [l.source_id, l.target_id])
      .filter((noteId) => !byId.has(noteId));
    for (const [noteId, note] of notesById(db, missing)) byId.set(noteId, note);
    const ok = new Set(readable([...byId.values()]).map((n) => n.id));
    return rows.filter((l) => ok.has(l.source_id) && ok.has(l.target_id));
  };
  return {
    privilegedRead,
    operator,
    entity,
    read,
    readable,
    readableLinks,
    pool: (pool: Parameters<NonNullable<typeof access>["pool"]>[0]) =>
      !!pool && (privilegedRead || !!access?.pool(pool)),
    write: (note: NoteRow | undefined) => !!note && (operator || !!access?.write(note)),
    // Both endpoints of every link (and every source note) are fetched in ONE
    // batched read, then filtered in memory — the per-link `getNote` pair was
    // an N+1 on every hydrated note detail.
    links: (id: number) => {
      const db = engine.db;
      if (!db) return [];
      const links = db.getNoteLinks(id);
      const notes = notesById(
        db,
        links.flatMap((link) => [link.source_id, link.target_id]),
      );
      return links.filter(
        (link) => read(notes.get(link.source_id)) && read(notes.get(link.target_id)),
      );
    },
    sources: (id: number) => {
      const db = engine.db;
      if (!db) return [];
      const sources = db.getNoteSources(id);
      const notes = notesById(
        db,
        sources.flatMap((source) => (source.source_note_id ? [source.source_note_id] : [])),
      );
      return sources.filter(
        (source) => !source.source_note_id || read(notes.get(source.source_note_id)),
      );
    },
    event: (event: EngineEvent): boolean => {
      if (event.type === "resource_changed") {
        if (event.resource === "coding") return true; // Same policy as coding snapshot reads.
        if (!engine.db || !principal || isSentinelPrincipal(id!)) return false;
        if (!event.id) return !!entity; // Overflow hint contains no private identifier.
        try {
          new RoutingService(engine.db, engine.db.durableEntityKey(id!)).get(event.id);
          return true;
        } catch {
          return false;
        }
      }
      if (privilegedRead) return true;
      const own = "entity" in event && event.entity === principal;
      switch (event.type) {
        case "note_created":
        case "pool_note":
          return read(engine.db?.getNote(event.noteId));
        case "note_deleted":
        case "recall_trace":
        case "command":
          return own;
        case "note_link_created":
        case "note_link_deleted": {
          // One batched read, same as links()/sources() above.
          if (!engine.db) return false;
          const ends = notesById(engine.db, [event.sourceId, event.targetId]);
          return read(ends.get(event.sourceId)) && read(ends.get(event.targetId));
        }
        // Raw traces/logs can contain tool arguments and retrieved memory. They
        // require the operator endpoint, not a public projection of their body.
        case "entity_enter":
        case "entity_leave":
        case "rank_change":
        case "coordination_change":
          return true;
        case "feed_event": {
          if (event.kind === "note_created" || event.kind === "pool_note")
            return (
              !!engine.db && isPublicMemory(engine.db, Number(event.ref?.replace("note:", "")))
            );
          return event.kind !== "note_link_created";
        }
        default:
          return own;
      }
    },
  };
}

/** One `getNotes` round trip for every distinct id, as a lookup map. */
function notesById(db: MarinaDB, ids: number[]): Map<number, NoteRow> {
  const map = new Map<number, NoteRow>();
  if (ids.length === 0) return map;
  for (const note of db.getNotes(ids)) map.set(note.id, note);
  return map;
}

/** The global civic feed may publish only deliberately world-shared notes. */
export function isPublicMemory(db: MarinaDB, id: number): boolean {
  const note = db.getNote(id);
  if (!note?.pool_id) return false;
  const pool = db.getMemoryPoolById(note.pool_id);
  return !!pool && !pool.group_id;
}
