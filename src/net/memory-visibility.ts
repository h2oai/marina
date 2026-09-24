// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Engine } from "../engine/engine";
import { getRank } from "../engine/permissions";
import { checkUnattendedGate } from "../engine/safety-gates";
import { memoryAccess } from "../memory/access";
import type { MarinaDB, NoteRow } from "../persistence/database";
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
  return {
    privilegedRead,
    operator,
    entity,
    read,
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
