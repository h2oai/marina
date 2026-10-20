// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Memory under the as-of fence: as-of reconstruction instead of "drop any
 * edited note", and the durable tiers filtered by their own known-at time
 * instead of withheld. The leak proof: with a later revision, source, record
 * or proposal present, no fenced surface — the unified context (every tier,
 * the whole serialized result) or `recall` — ever contains its text; an item
 * with no reliable known-at time is withheld (fail closed).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { fenceEntity } from "../src/engine/evidence-fence";
import { noteAsOf, recordVersionAsOf } from "../src/memory/as-of";
import { findDurableTwin } from "../src/memory/legacy-projection";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { buildUnifiedContext, type UnifiedContextResult } from "../src/memory/unified-context";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import {
  expectedTierIds,
  FIXTURE_QUERY,
  seedUnifiedFixture,
  tierIds,
  type UnifiedFixture,
} from "./fixtures/unified-memory-fixture";
import { cleanupDb, makeTestRoom, stripAnsi } from "./helpers";

const TEST_DB = "test_memory_as_of.db";
const CUTOFF_MS = Date.parse("2026-06-01T00:00:00.000Z");
const BEFORE = CUTOFF_MS - 10 * 86_400_000;
const EARLIER = CUTOFF_MS - 20 * 86_400_000;
const AFTER = CUTOFF_MS + 10 * 86_400_000;

describe("memory as of the evidence cutoff", () => {
  let db: MarinaDB;
  let engine: Engine;
  let fx: UnifiedFixture;

  const raw = () => db.memoryRepository().raw;
  /** Date one service event (`version` null = any). */
  const dateEvent = (ref: string, operation: string, at: number | null, version?: number) => {
    const where = `reference_id = ? AND operation = ?${version === undefined ? "" : " AND version = ?"}`;
    const params = version === undefined ? [ref, operation] : [ref, operation, version];
    if (at === null) raw().run(`DELETE FROM memory_service_events WHERE ${where}`, params);
    else
      raw().run(`UPDATE memory_service_events SET created_at = ? WHERE ${where}`, [at, ...params]);
  };
  const dateVersionRow = (recordId: string, version: number, at: number) =>
    raw().run(
      "UPDATE notes SET created_at = ? WHERE id = (SELECT note_id FROM memory_record_versions WHERE record_id = ? AND version = ?)",
      [at, recordId, version],
    );
  const dateHandle = (noteId: number, at: number) =>
    raw().run("UPDATE notes SET created_at = ? WHERE id = ?", [at, noteId]);
  const revise = async (recordId: string, expected: number, content: string) =>
    residentMemoryOperation(db, fx.owner, {
      operation: "revise",
      id: recordId,
      key: `revise:${recordId}:${expected}`,
      input: { expected_version: expected, content },
    });
  /** Everything served, as one string: content, provenance, meta. */
  const served = (result: UnifiedContextResult) => JSON.stringify(result.tiers);
  /** Date the whole fixture before the cutoff. */
  const dateFixtureBefore = () => {
    for (const id of [fx.verifiedNoteId, fx.plainNoteId, fx.skillNoteId]) {
      dateHandle(id, EARLIER);
      const twin = findDurableTwin(db, id);
      if (twin) {
        dateEvent(twin.recordId, "memory.created", EARLIER);
        dateVersionRow(twin.recordId, 1, EARLIER);
      }
    }
    dateEvent(fx.recordId, "memory.created", EARLIER);
    dateVersionRow(fx.recordId, 1, EARLIER);
    dateEvent(fx.sourceId, "source.captured", EARLIER);
    dateEvent(fx.jobId, "assistance.completed", BEFORE);
  };

  beforeEach(async () => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    fx = await seedUnifiedFixture(engine, db);
    dateFixtureBefore();
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("serves every tier known by the cutoff, the durable ones included", async () => {
    const result = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY, { asOf: CUTOFF_MS });
    // Before: the evidence and proposal tiers were withheld outright under a fence.
    expect(tierIds(result)).toEqual(expectedTierIds(fx));
    expect(result.degraded.map((d) => `${d.tier}:${d.code}`).sort()).toEqual([
      "evidence:fenced",
      "proposal:fenced",
    ]);
    // A proposal's inputs may have been verified after the cutoff: never raised under the fence.
    const proposal = result.tiers.find((t) => t.tier === "proposal")!.items[0]!;
    const inherited = proposal.meta?.inherited as { verification: string } | undefined;
    expect(inherited?.verification).toBe("unverified");
  });

  it("a record, source or proposal known only after the cutoff is never served", async () => {
    dateEvent(fx.recordId, "memory.created", AFTER);
    dateEvent(fx.sourceId, "source.captured", AFTER);
    dateEvent(fx.jobId, "assistance.completed", AFTER);
    const result = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY, { asOf: CUTOFF_MS });
    const ids = tierIds(result);
    expect(ids.evidence ?? []).toEqual([]);
    expect(ids.proposal ?? []).toEqual([]);
    expect(served(result)).not.toContain("Ops wiki excerpt");
    expect(served(result)).not.toContain("per the remembered record");
    // The cutoff is inclusive.
    const at = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY, { asOf: AFTER });
    expect(tierIds(at).evidence?.sort()).toEqual([fx.recordId, fx.sourceId].sort());
  });

  it("an item with no reliable known-at time is withheld (fail closed)", async () => {
    // As after a bundle import (row times are the exporter's) or past the event
    // log's retention: the row times say "early", but no local event dates them.
    dateEvent(fx.recordId, "memory.created", null);
    dateEvent(fx.sourceId, "source.captured", null);
    dateEvent(fx.jobId, "assistance.completed", null);
    const result = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY, { asOf: CUTOFF_MS });
    expect(tierIds(result).evidence ?? []).toEqual([]);
    expect(tierIds(result).proposal ?? []).toEqual([]);
    // Unfenced reads are unchanged.
    const open = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY);
    expect(tierIds(open)).toEqual(expectedTierIds(fx));
  });

  it("a record revised after the cutoff is served as it stood at the cutoff", async () => {
    await revise(fx.recordId, 1, "Amber deployment uses port 8800 after the migration");
    dateEvent(fx.recordId, "memory.revised", AFTER, 2);

    const fenced = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY, { asOf: CUTOFF_MS });
    const record = fenced.tiers
      .find((t) => t.tier === "evidence")!
      .items.find((i) => i.id === fx.recordId)!;
    expect(record.content).toBe("Amber deployment uses port 7419");
    expect(record.provenance).toBe(`record ${fx.recordId} v1 as-of (current v2)`);
    expect(served(fenced)).not.toContain("8800");

    // Revised BEFORE the cutoff: the revision is what was known (no longer dropped).
    dateEvent(fx.recordId, "memory.revised", BEFORE, 2);
    dateVersionRow(fx.recordId, 2, BEFORE);
    const later = await buildUnifiedContext(db, fx.owner, FIXTURE_QUERY, { asOf: CUTOFF_MS });
    const current = later.tiers
      .find((t) => t.tier === "evidence")!
      .items.find((i) => i.id === fx.recordId)!;
    expect(current.content).toContain("8800");
    expect(current.provenance).toBe(`record ${fx.recordId} v2`);
  });

  it("an edited numeric note is served at its as-of version, never the later text", async () => {
    const twin = findDurableTwin(db, fx.plainNoteId)!;
    await revise(twin.recordId, 1, "Amber deployment hunch: staging uses port 9100 now");
    await revise(twin.recordId, 2, "Amber deployment hunch: staging uses port 9200 finally");
    // The handle follows the current version (it is edited in place, not superseded).
    expect(findDurableTwin(db, fx.plainNoteId)?.version).toBe(3);
    dateEvent(twin.recordId, "memory.revised", BEFORE, 2);
    dateVersionRow(twin.recordId, 2, BEFORE);
    dateEvent(twin.recordId, "memory.revised", AFTER, 3);

    const note = db.getNote(fx.plainNoteId)!;
    expect(note.content).toContain("9200");
    const asOf = noteAsOf(db, note, CUTOFF_MS)!;
    expect(asOf.content).toContain("9100");
    expect(asOf.asOf).toEqual({ version: 2, current: 3 });

    const fenced = await buildUnifiedContext(db, fx.owner, "Amber deployment hunch staging", {
      asOf: CUTOFF_MS,
    });
    const item = fenced.tiers.flatMap((t) => t.items).find((i) => i.id === String(fx.plainNoteId));
    expect(item?.tier).toBe("unverified");
    expect(item?.content).toContain("9100");
    expect(item?.provenance).toBe(`#${fx.plainNoteId} imp=5 as-of v2/3`);
    expect(served(fenced)).not.toContain("9200");
    expect(served(fenced)).not.toContain("finally");

    // `recall` under the fence: the as-of text, never the later one.
    fenceEntity(fx.ownerEntityId, "t", CUTOFF_MS, Date.now() + 60_000);
    fx.ownerConn.clear();
    await engine.processCommand(fx.ownerEntityId, "recall Amber deployment hunch staging");
    const plain = stripAnsi(fx.ownerConn.allTextJoined());
    expect(plain).toContain("9100");
    expect(plain).not.toContain("9200");
    fx.ownerConn.clear();
    await engine.processCommand(fx.ownerEntityId, "recall Amber deployment hunch staging all");
    const unified = stripAnsi(fx.ownerConn.allTextJoined());
    expect(unified).toContain("9100");
    expect(unified).not.toContain("9200");
  });

  it("an undated revision falls back to the newest dated version, else nothing", async () => {
    const twin = findDurableTwin(db, fx.plainNoteId)!;
    await revise(twin.recordId, 1, "Amber deployment hunch: staging uses port 9100 now");
    dateEvent(twin.recordId, "memory.revised", null, 2); // undated (e.g. pruned / imported)
    dateVersionRow(twin.recordId, 2, EARLIER); // a row time alone never dates a version

    const note = db.getNote(fx.plainNoteId)!;
    const asOf = noteAsOf(db, note, CUTOFF_MS)!;
    expect(asOf.content).toContain("probably uses the same port");
    expect(asOf.asOf).toEqual({ version: 1, current: 2 });

    // A handle created after the cutoff: nothing at all.
    dateHandle(fx.plainNoteId, AFTER);
    expect(noteAsOf(db, db.getNote(fx.plainNoteId)!, CUTOFF_MS)).toBeUndefined();
    // A durable record with no dated version: nothing.
    dateEvent(fx.recordId, "memory.created", null);
    expect(recordVersionAsOf(db, fx.recordId, 1, CUTOFF_MS)).toBeUndefined();
  });

  it("an unrevised note keeps the old rule (its own time decides)", () => {
    const note = db.getNote(fx.verifiedNoteId)!;
    expect(noteAsOf(db, note, CUTOFF_MS)).toBe(note);
    dateHandle(fx.verifiedNoteId, AFTER);
    expect(noteAsOf(db, db.getNote(fx.verifiedNoteId)!, CUTOFF_MS)).toBeUndefined();
  });
});
