// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import {
  awaitPendingBridges,
  bridgeLegacyNote,
  durableTwinUrl,
  findDurableTwin,
  findLegacyNotesForRecord,
  parseDurableTwinUrl,
} from "../src/memory/legacy-bridge";
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
    await awaitPendingBridges();
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
    expect(twin!.sourceId).toBeString();
    const source = db.getNoteSources(noteId).find((s) => s.url === twin!.url)!;
    expect(source.source_type).toBe("artifact");
    expect(source.credibility).toBe(0);
    expect(JSON.parse(source.metadata!)).toMatchObject({ kind: "durable-twin", version: 1 });

    // Durable record carries the note verbatim with provenance metadata + captured source.
    const durableRecord = await record(twin!.recordId);
    expect(durableRecord.content).toBe("Amber deploys on port 7419");
    expect(durableRecord.type).toBe("fact");
    expect(durableRecord.importance).toBe(7);
    expect(durableRecord.metadata).toMatchObject({
      legacy_note_id: noteId,
      note_type: "fact",
      importance: 7,
    });
    expect(durableRecord.source_ids).toEqual([twin!.sourceId!]);

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
    await bridgeLegacyNote(db, "Alice", noteId);
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
    const again = await bridgeLegacyNote(db, "Alice", noteId);
    expect(again?.recordId).toBe(first.recordId);
    expect(db.getNoteSources(noteId).filter((s) => parseDurableTwinUrl(s.url))).toHaveLength(1);
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
    expect(newTwin.sourceId).not.toBe(oldTwin.sourceId);
    // Predecessor keeps its historical twin row untouched.
    expect(findDurableTwin(db, oldId)).toMatchObject({ recordId: oldTwin.recordId, version: 1 });

    const current = await record(oldTwin.recordId);
    expect(current.version).toBe(2);
    expect(current.content).toBe("The door is blue");
    expect(current.metadata).toMatchObject({
      legacy_note_id: newId,
      supersedes_legacy_note_id: oldId,
    });
    expect(current.source_ids).toEqual([newTwin.sourceId!]);
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

  it("correcting a legacy note that never had a twin gives the successor a fresh twin", async () => {
    const orphan = db.createNote("Alice", "Untwinned legacy note", undefined, { importance: 6 });
    expect(findDurableTwin(db, orphan)).toBeUndefined();
    await run(alice, `note correct ${orphan} Now twinned`);
    const newId = latestNoteId("Alice");
    const twin = findDurableTwin(db, newId);
    expect(twin).toBeDefined();
    expect(twin!.version).toBe(1);
    expect((await record(twin!.recordId)).content).toBe("Now twinned");
    expect(findDurableTwin(db, orphan)).toBeUndefined();
  });

  it("`note delete` leaves the durable twin record in place", async () => {
    await run(alice, "note Ephemeral thought");
    const noteId = latestNoteId("Alice");
    const twin = findDurableTwin(db, noteId)!;
    const reply = await run(alice, `note delete ${noteId}`);
    expect(reply).toContain("deleted");
    expect(db.getNote(noteId)).toBeUndefined();
    expect((await record(twin.recordId)).content).toBe("Ephemeral thought");
  });

  it("keeps legacy behaviour when the author has no durable world account", async () => {
    const reply = await run(ghost, "note Ghost writes without a durable identity");
    expect(reply).toContain("saved");
    const noteId = latestNoteId("Ghost");
    expect(db.getNote(noteId)!.content).toBe("Ghost writes without a durable identity");
    expect(findDurableTwin(db, noteId)).toBeUndefined();
    await expect(durable({ operation: "query", input: {} }, "Ghost")).rejects.toMatchObject({
      code: "world_identity_required",
    });

    const corrected = await run(ghost, `note correct ${noteId} Still no twin`);
    expect(corrected).toContain("superseding");
    expect(findDurableTwin(db, latestNoteId("Ghost"))).toBeUndefined();
  });
});
