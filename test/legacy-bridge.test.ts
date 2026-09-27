// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";

import {
  durableTwinUrl,
  findDurableTwin,
  findLegacyNotesForRecord,
  parseDurableTwinUrl,
} from "../src/memory/legacy-projection";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { expandMemoryRecall } from "../src/memory/retrieval";
import { MarinaDB } from "../src/persistence/database";
import type { MemoryRecord, MemorySearchResult } from "../src/sdk/memory-types";
import { type EntityId, roomId } from "../src/types";
import { MockConnection, makeTestRoom, stripAnsi } from "./helpers";

describe("legacy note ↔ durable twin bridge", () => {
  let directory: string;
  let db: MarinaDB;
  let engine: Engine;
  let alice: MockConnection;
  let ghost: MockConnection;

  const durable = (request: Parameters<typeof residentMemoryOperation>[2], name = "Alice") =>
    residentMemoryOperation(db, name, request);
  const record = async (id: string) =>
    (await durable({ operation: "get", id })).result as MemoryRecord;
  const run = async (connection: MockConnection, text: string) => {
    connection.clear();
    await engine.processCommand(connection.entity as EntityId, text);
    // Commands reply in-tick and bridge the durable twin in the background;
    // sequence on the bridge explicitly so assertions see the twin.
    return stripAnsi(connection.allTextJoined());
  };
  const latestNoteId = (name: string) => db.getNotesByEntity(name, 1)[0]!.id;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "marina-legacy-bridge-"));
    db = new MarinaDB(join(directory, "world.db"));
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    alice = new MockConnection("alice");
    ghost = new MockConnection("ghost");
    engine.addConnection(alice);
    engine.addConnection(ghost);
    // Alice has a durable world account (as `login` would create); Ghost does not.
    db.createUser({ id: crypto.randomUUID(), name: "Alice" });
    engine.spawnEntity(alice.id, "Alice");
    engine.spawnEntity(ghost.id, "Ghost");
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true });
  });

  it("round-trips the twin url scheme", () => {
    expect(parseDurableTwinUrl(durableTwinUrl("rec/with slash"))).toBe("rec/with slash");
    expect(parseDurableTwinUrl("https://example.test")).toBeUndefined();
    expect(parseDurableTwinUrl("marina-memory://record/")).toBeUndefined();
  });

  it("conformance: one `note` is found by legacy recall, durable search/query, and the twin resolves both ways", async () => {
    const reply = await run(alice, "note Amber deploys on port 7419 importance 7 type fact");
    expect(reply).toContain("saved");
    const noteId = latestNoteId("Alice");
    const note = db.getNote(noteId)!;
    expect(note.content).toBe("Amber deploys on port 7419");

    // Legacy retrieval surface.
    expect(db.recallNotes("Alice", "Amber port").map((n) => n.id)).toContain(noteId);

    // Twin link, legacy → durable.
    const twin = findDurableTwin(db, noteId);
    expect(twin).toBeDefined();
    expect(twin!.version).toBe(1);
    expect(twin!.sourceId).toBeUndefined();
    expect(db.getNoteSources(noteId)).toEqual([]);
    expect(
      db.memoryRepository().raw.query("SELECT content FROM notes WHERE id=?").get(noteId),
    ).toEqual({ content: "" });

    // Durable record carries the note verbatim with provenance metadata + captured source.
    const durableRecord = await record(twin!.recordId);
    expect(durableRecord.content).toBe("Amber deploys on port 7419");
    expect(durableRecord.type).toBe("fact");
    expect(durableRecord.importance).toBe(7);
    expect(durableRecord.metadata).toMatchObject({
      legacy_note_id: noteId,
      note_type: "fact",
    });
    expect(durableRecord.source_ids).toEqual([]);

    // Durable retrieval surfaces.
    const search = (await durable({ operation: "search", input: { query: "Amber port" } }))
      .result as MemorySearchResult;
    expect(search.results.map((r) => r.id)).toContain(twin!.recordId);
    const query = (await durable({ operation: "query", input: {} })).result as {
      results: MemoryRecord[];
    };
    expect(query.results.map((r) => r.id)).toContain(twin!.recordId);
    const shown = await run(alice, `memory show ${twin!.recordId}`);
    expect(shown).toContain("Amber deploys on port 7419");

    // Twin link, durable → legacy.
    expect(findLegacyNotesForRecord(db, "Alice", twin!.recordId).map((n) => n.id)).toEqual([
      noteId,
    ]);

    // The durable record stays hidden from the legacy surface (silo boundary).
    const legacy = db.getNotesByEntity("Alice", 50).filter((n) => !db.isServiceMemoryNote(n.id));
    expect(legacy.map((n) => n.id)).toEqual([noteId]);
  });

  it("a twin is provenance, not evidence: it never promotes its note into the trusted tier", async () => {
    // High confidence + a credible-looking source is exactly what `recall … trusted`
    // accepts; the twin row must not satisfy that predicate on its own.
    const noteId = db.createNote("Alice", "Confident but unsourced claim", undefined, {
      importance: 7,
      noteType: "fact",
      confidence: 0.9,
    });
    expect(
      db.createNote("Alice", "Confident but unsourced claim", undefined, { noteType: "fact" }),
    ).toBe(noteId);
    expect(findDurableTwin(db, noteId)).toBeDefined();
    const hits = db.recallNotes("Alice", "confident unsourced claim");
    expect(hits.map((n) => n.id)).toContain(noteId);
    expect(expandMemoryRecall(db, hits, "Alice", { trusted: true }).map((n) => n.id)).not.toContain(
      noteId,
    );
    // A real source with real credibility still does.
    db.addNoteSource(noteId, { url: "https://example.test/evidence", credibility: 0.8 });
    expect(expandMemoryRecall(db, hits, "Alice", { trusted: true }).map((n) => n.id)).toContain(
      noteId,
    );
  });

  it("bridging is idempotent per note", async () => {
    await run(alice, "note The relay needs a key");
    const noteId = latestNoteId("Alice");
    const first = findDurableTwin(db, noteId)!;
    expect(db.createNote("Alice", "The relay needs a key")).toBe(noteId);
    const again = findDurableTwin(db, noteId);
    expect(again?.recordId).toBe(first.recordId);
    expect(db.getNoteSources(noteId)).toHaveLength(0);
    expect((await record(first.recordId)).version).toBe(1);
  });

  it("`note correct` revises the twin in place and points the successor at the new version", async () => {
    await run(alice, "note The door is red");
    const oldId = latestNoteId("Alice");
    const oldTwin = findDurableTwin(db, oldId)!;

    const reply = await run(alice, `note correct ${oldId} The door is blue`);
    expect(reply).toContain("superseding");
    const newId = latestNoteId("Alice");
    expect(newId).not.toBe(oldId);
    expect(db.getNote(oldId)!.verification_status).toBe("superseded");

    const newTwin = findDurableTwin(db, newId)!;
    expect(newTwin.recordId).toBe(oldTwin.recordId);
    expect(newTwin.version).toBe(2);
    expect(newTwin.sourceId).toBeUndefined();
    // Predecessor keeps its historical twin row untouched.
    expect(findDurableTwin(db, oldId)).toMatchObject({ recordId: oldTwin.recordId, version: 1 });

    const current = await record(oldTwin.recordId);
    expect(current.version).toBe(2);
    expect(current.content).toBe("The door is blue");
    expect(current.metadata).toMatchObject({
      legacy_note_id: newId,
      supersedes_legacy_note_id: oldId,
    });
    expect(current.source_ids).toEqual([]);
    const historical = (
      await durable({ operation: "get", id: oldTwin.recordId, input: { version: 1 } })
    ).result as MemoryRecord;
    expect(historical.content).toBe("The door is red");

    // Inverse lookup: both legacy notes share the record; current-only narrows to the successor.
    expect(
      findLegacyNotesForRecord(db, "Alice", oldTwin.recordId)
        .map((n) => n.id)
        .sort(),
    ).toEqual([oldId, newId].sort());
    expect(
      findLegacyNotesForRecord(db, "Alice", oldTwin.recordId, { currentOnly: true }).map(
        (n) => n.id,
      ),
    ).toEqual([newId]);
  });

  it("`note evolve` advances the twin version too", async () => {
    await run(alice, "note Ferns prefer shade");
    const oldId = latestNoteId("Alice");
    const twin = findDurableTwin(db, oldId)!;
    await run(alice, `note evolve ${oldId}`);
    const newId = latestNoteId("Alice");
    expect(findDurableTwin(db, newId)).toMatchObject({ recordId: twin.recordId, version: 2 });
    const current = await record(twin.recordId);
    expect(current.version).toBe(2);
    expect(current.content).toContain("[Evolved from");
  });

  it("correcting a pending legacy note preserves the predecessor in durable history", async () => {
    const orphan = db.createNote("Alice", "Untwinned legacy note", undefined, { importance: 6 });
    expect(findDurableTwin(db, orphan)).toBeDefined();
    await run(alice, `note correct ${orphan} Now twinned`);
    const newId = latestNoteId("Alice");
    const twin = findDurableTwin(db, newId);
    expect(twin).toBeDefined();
    expect(twin!.version).toBe(2);
    expect((await record(twin!.recordId)).content).toBe("Now twinned");
    expect(findDurableTwin(db, orphan)?.recordId).toBe(twin!.recordId);
    expect(
      (
        (await durable({ operation: "get", id: twin!.recordId, input: { version: 1 } }))
          .result as MemoryRecord
      ).content,
    ).toBe("Untwinned legacy note");
  });

  it("`note delete` retires the durable twin as a closed-validity tombstone (never a cascading forget)", async () => {
    await run(alice, "note Ephemeral thought about heron migration");
    const noteId = latestNoteId("Alice");
    const twin = findDurableTwin(db, noteId)!;
    const before = Date.now();
    const reply = await run(alice, `note delete ${noteId}`);
    expect(reply).toContain("deleted");
    // Legacy behaviour unchanged: the row (and its cascaded sources) is gone.
    expect(db.getNote(noteId)).toBeUndefined();
    expect(db.getNoteSources(noteId)).toEqual([]);

    // The record is retired in place, not forgotten: tombstone content,
    // deletion marker, validity closed at the deletion instant, version +1.
    const current = await record(twin.recordId);
    expect(current.content).toBe(`[deleted legacy note #${noteId}]`);
    expect(current.version).toBe(2);
    expect(current.metadata).toMatchObject({ deleted_legacy_note_id: noteId });
    expect(current.valid_time?.until).toBeNumber();
    expect(current.valid_time!.until!).toBeGreaterThanOrEqual(before);

    // No longer current on the durable retrieval surfaces: the deleted text no
    // longer matches, and temporal reads exclude the closed validity window.
    const search = (await durable({ operation: "search", input: { query: "heron migration" } }))
      .result as MemorySearchResult;
    expect(search.results.map((r) => r.id)).not.toContain(twin.recordId);
    const query = (
      await durable({ operation: "query", input: { valid_at: current.valid_time!.until! + 1 } })
    ).result as { results: MemoryRecord[] };
    expect(query.results.map((r) => r.id)).not.toContain(twin.recordId);

    // History stays inspectable (retirement, not erasure).
    const historical = (
      await durable({ operation: "get", id: twin.recordId, input: { version: 1 } })
    ).result as MemoryRecord;
    expect(historical.content).toBe("Ephemeral thought about heron migration");

    // Idempotent: retiring again is a no-op.
    expect(db.deleteNote(noteId, "Alice")).toBe(false);
    expect((await record(twin.recordId)).version).toBe(2);
  });

  it("deleting a superseded predecessor leaves the successor's live record untouched", async () => {
    await run(alice, "note The bridge is open");
    const oldId = latestNoteId("Alice");
    const twin = findDurableTwin(db, oldId)!;
    await run(alice, `note correct ${oldId} The bridge is closed`);
    const newId = latestNoteId("Alice");
    expect(findDurableTwin(db, newId)?.recordId).toBe(twin.recordId);

    await run(alice, `note delete ${oldId}`);
    expect(db.getNote(oldId)).toBeUndefined();
    const current = await record(twin.recordId);
    expect(current.version).toBe(2);
    expect(current.content).toBe("The bridge is closed");
    expect(current.metadata).not.toHaveProperty("deleted_legacy_note_id");
  });

  it("`note claim` gets a twin like a plain `note`", async () => {
    const reply = await run(alice, "note claim The tide table is published weekly confidence 0.7");
    expect(reply).toContain("Claim #");
    const noteId = latestNoteId("Alice");
    const twin = findDurableTwin(db, noteId);
    expect(twin).toBeDefined();
    expect(twin!.version).toBe(1);
    expect(db.getNoteSources(noteId)).toEqual([]);
    const durableRecord = await record(twin!.recordId);
    expect(durableRecord.content).toBe("The tide table is published weekly");
    expect(durableRecord.type).toBe("fact");
    expect(durableRecord.metadata).toMatchObject({ legacy_note_id: noteId, note_type: "fact" });
  });

  it("url-indexed twin lookup: scoped by owner, newest-first, and not bounded by a recent-notes window", () => {
    const url = durableTwinUrl("rec-shared");
    const a1 = db.createNote("Alice", "alice one", undefined, { skipDedup: true });
    const g1 = db.createNote("Ghost", "ghost one", undefined, { skipDedup: true });
    const a2 = db.createNote("Alice", "alice two", undefined, { skipDedup: true });
    for (const id of [a1, g1, a2]) db.addNoteSource(id, { url, credibility: 0 });
    db.addNoteSource(a2, { url: "https://example.test/other", credibility: 0.5 });

    expect(db.getNotesBySourceUrl(url, "Alice").map((n) => n.id)).toEqual([a2, a1]);
    expect(db.getNotesBySourceUrl(url, "Ghost").map((n) => n.id)).toEqual([g1]);
    expect(db.getNotesBySourceUrl(url).map((n) => n.id)).toEqual([a2, g1, a1]);
    expect(db.getNotesBySourceUrl(url, "Alice", 1).map((n) => n.id)).toEqual([a2]);
    expect(db.getNotesBySourceUrl("marina-memory://record/none", "Alice")).toEqual([]);

    // A twin buried under many newer notes is still found (the previous
    // implementation scanned only the owner's 500 most recent notes).
    const old = db.createNote("Alice", "old twinned note", undefined, { skipDedup: true });
    const oldRecord = findDurableTwin(db, old)!.recordId;
    for (let i = 0; i < 520; i++)
      db.createNote("Alice", `filler ${i}`, undefined, { skipDedup: true });
    expect(findLegacyNotesForRecord(db, "Alice", oldRecord).map((n) => n.id)).toEqual([old]);
    expect(findLegacyNotesForRecord(db, "Ghost", oldRecord)).toEqual([]);
  });

  it("keeps legacy behaviour when the author has no durable world account", async () => {
    const reply = await run(ghost, "note Ghost writes without a durable identity");
    expect(reply).toContain("saved");
    const noteId = latestNoteId("Ghost");
    expect(db.getNote(noteId)!.content).toBe("Ghost writes without a durable identity");
    expect(findDurableTwin(db, noteId)).toBeDefined();
    await expect(durable({ operation: "query", input: {} }, "Ghost")).rejects.toMatchObject({
      code: "world_identity_required",
    });

    const corrected = await run(ghost, `note correct ${noteId} Still no twin`);
    expect(corrected).toContain("superseding");
    expect(findDurableTwin(db, latestNoteId("Ghost"))).toBeDefined();
  });
});
