// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `memoryObserver().links()` / `.sources()` fetch every referenced note in ONE
 * batched `getNotes` call instead of one `getNote` per endpoint (an N+1 on
 * every hydrated note detail), and return exactly what the per-note filter did.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Engine } from "../src/engine/engine";
import { memoryObserver } from "../src/net/memory-visibility";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_memory_visibility_batch.db";

let db: MarinaDB;
let engine: Engine;
let bob: string;

beforeEach(() => {
  db = new MarinaDB(TEST_DB);
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom());
  const login = (name: string) => {
    const conn = new MockConnection(name);
    engine.addConnection(conn);
    const session = engine.login(conn.id, name);
    if ("error" in session) throw new Error(session.error);
    return session.entityId as string;
  };
  login("Alice");
  bob = login("Bob");
});

afterEach(() => {
  db.close();
  cleanupDb(TEST_DB);
});

describe("links() / sources() batch their note lookups", () => {
  it("a note with 20 links costs one getNotes and zero getNote, same result as the per-link filter", () => {
    const own = db.createNote("Bob", "hub");
    const bobNotes = Array.from({ length: 10 }, (_, i) => db.createNote("Bob", `bob-${i}`));
    const aliceNotes = Array.from({ length: 10 }, (_, i) => db.createNote("Alice", `alice-${i}`));
    for (const id of bobNotes) db.createNoteLink(own, id, "related_to");
    for (const id of aliceNotes) db.createNoteLink(id, own, "related_to");
    expect(db.getNoteLinks(own)).toHaveLength(20);

    const observer = memoryObserver(engine, bob);
    // Oracle: the previous implementation, one getNote per endpoint.
    const legacy = db
      .getNoteLinks(own)
      .filter(
        (l) => observer.read(db.getNote(l.source_id)) && observer.read(db.getNote(l.target_id)),
      );
    expect(legacy).toHaveLength(10);

    const single = spyOn(db, "getNote");
    const batch = spyOn(db, "getNotes");
    const links = observer.links(own);
    // Before: 40 getNote calls (2 per link). After: 1 getNotes, 0 getNote.
    expect(single).toHaveBeenCalledTimes(0);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toHaveLength(40); // both endpoints of every link, deduped inside
    expect(links).toEqual(legacy);
    expect(links.every((l) => bobNotes.includes(l.target_id))).toBe(true);
  });

  it("sources with a source note are filtered from one batch; url-only sources always pass", () => {
    const own = db.createNote("Bob", "sourced");
    const mine = [db.createNote("Bob", "mine-a"), db.createNote("Bob", "mine-b")];
    const theirs = [db.createNote("Alice", "theirs-a"), db.createNote("Alice", "theirs-b")];
    for (const id of [...mine, ...theirs])
      db.addNoteSource(own, { url: `note:${id}`, sourceNoteId: id, excerpt: `x${id}` });
    db.addNoteSource(own, { url: "https://example.com/paper", excerpt: "web" });

    const observer = memoryObserver(engine, bob);
    const legacy = db
      .getNoteSources(own)
      .filter((s) => !s.source_note_id || observer.read(db.getNote(s.source_note_id)));
    expect(legacy).toHaveLength(3);

    const single = spyOn(db, "getNote");
    const batch = spyOn(db, "getNotes");
    const sources = observer.sources(own);
    expect(single).toHaveBeenCalledTimes(0);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(sources).toEqual(legacy);
  });

  it("a note with no links or sources issues no batch read at all", () => {
    const own = db.createNote("Bob", "lonely");
    const observer = memoryObserver(engine, bob);
    const batch = spyOn(db, "getNotes");
    expect(observer.links(own)).toEqual([]);
    expect(observer.sources(own)).toEqual([]);
    expect(batch).toHaveBeenCalledTimes(0);
  });
});

describe("getNotes", () => {
  it("dedupes ids, skips missing ones, and chunks past 500 ids", () => {
    const ids = Array.from({ length: 1_200 }, (_, i) => db.createNote("Bob", `bulk-${i}`));
    const rows = db.getNotes([...ids, ...ids.slice(0, 50), 999_999]);
    expect(rows).toHaveLength(1_200);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(ids));
    expect(db.getNotes([])).toEqual([]);
    expect(db.getNotes([999_999])).toEqual([]);
  });
});
