// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Migration 171: the as-of fence's known-at times live on the rows themselves
 * (version, source, proposal), so the event log's 30-day retention can no
 * longer erase the date of an older revision. New events date their row by
 * trigger; older rows are filled by a bounded seq-range backfill, and until
 * the backfill passes a dating event, retention keeps it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { runRetentionPass } from "../src/engine/retention";
import { proposalsKnownAt, recordVersionAsOf, sourcesKnownAt } from "../src/memory/as-of";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { MarinaDB } from "../src/persistence/database";
import {
  backfillMemoryKnownAt,
  KNOWN_AT_OPERATIONS,
  knownAtBackfillState,
} from "../src/persistence/db-memory-known-at";
import { MIGRATIONS } from "../src/persistence/schema";
import { roomId } from "../src/types";
import { seedUnifiedFixture, type UnifiedFixture } from "./fixtures/unified-memory-fixture";
import { cleanupDb, makeTestRoom } from "./helpers";

const TEST_DB = "test_memory_known_at.db";
const DAY = 86_400_000;

describe("memory known-at persistence (migration 171)", () => {
  let db: MarinaDB;
  let engine: Engine;
  let fx: UnifiedFixture;
  const raw = () => db.memoryRepository().raw;
  const versionKnownAt = (recordId: string, version: number) =>
    (
      raw()
        .query("SELECT known_at FROM memory_record_versions WHERE record_id = ? AND version = ?")
        .get(recordId, version) as { known_at: number | null }
    ).known_at;
  const eventAt = (ref: string, operation: string, version?: number) =>
    (
      raw()
        .query(
          `SELECT MAX(created_at) AS at FROM memory_service_events WHERE reference_id = ? AND operation = ?${version === undefined ? "" : " AND version = ?"}`,
        )
        .get(...(version === undefined ? [ref, operation] : [ref, operation, version])) as {
        at: number;
      }
    ).at;
  /** Rewind to the state of a database migrated with history: rows undated, backfill owed. */
  const rewindToPreMigration = () => {
    raw().run("UPDATE memory_record_versions SET known_at = NULL");
    raw().run("UPDATE memory_sources SET known_at = NULL");
    raw().run("UPDATE memory_assistance_jobs SET completed_known_at = NULL");
    raw().run(
      "UPDATE memory_known_at_backfill SET cursor = 0, upto = (SELECT max(seq) FROM memory_service_events)",
    );
  };
  const revise = (recordId: string, expected: number, content: string) =>
    residentMemoryOperation(db, fx.owner, {
      operation: "revise",
      id: recordId,
      key: `revise:${recordId}:${expected}`,
      input: { expected_version: expected, content },
    });

  beforeEach(async () => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    fx = await seedUnifiedFixture(engine, db);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("a fresh database owes no backfill and every write dates its own row", async () => {
    expect(knownAtBackfillState(raw())).toEqual({ cursor: 0, upto: 0, done: true });
    expect(versionKnownAt(fx.recordId, 1)).toBe(eventAt(fx.recordId, "memory.created", 1));
    await revise(fx.recordId, 1, "Amber deployment uses port 8800");
    expect(versionKnownAt(fx.recordId, 2)).toBe(eventAt(fx.recordId, "memory.revised", 2));
    expect(sourcesKnownAt(db, [fx.sourceId]).get(fx.sourceId)).toBe(
      eventAt(fx.sourceId, "source.captured"),
    );
    expect(proposalsKnownAt(db, [fx.jobId]).get(fx.jobId)).toBe(
      eventAt(fx.jobId, "assistance.completed"),
    );
  });

  it("the migration is additive and idempotent", () => {
    const migration = MIGRATIONS.find((m) => m.version === 171)!;
    expect(migration.sql).not.toMatch(/\b(DROP|DELETE)\b/i);
    const before = raw().query("SELECT * FROM memory_known_at_backfill").all();
    // Re-running it over a migrated database changes nothing.
    raw().exec(migration.sql);
    migration.apply?.(raw());
    expect(raw().query("SELECT * FROM memory_known_at_backfill").all()).toEqual(before);
    const triggers = raw()
      .query(
        "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'memory_known_at_%'",
      )
      .all() as { name: string }[];
    expect(triggers.map((t) => t.name).sort()).toEqual([
      "memory_known_at_proposal",
      "memory_known_at_source",
      "memory_known_at_version",
    ]);
  });

  it("the backfill dates existing rows from surviving events in bounded batches", async () => {
    await revise(fx.recordId, 1, "Amber deployment uses port 8800");
    rewindToPreMigration();
    const upto = knownAtBackfillState(raw())!.upto;
    expect(upto).toBeGreaterThan(2);

    // One window of one seq per batch, two batches: bounded, not done.
    const partial = backfillMemoryKnownAt(raw(), { window: 1, batches: 2 })!;
    expect(partial).toEqual({ cursor: 2, upto, done: false });

    // While owed, fenced reads still date rows through the event log.
    expect(recordVersionAsOf(db, fx.recordId, 2, Date.now() + 1)?.version).toBe(2);

    let state = partial;
    while (!state.done) state = backfillMemoryKnownAt(raw(), { window: 3, batches: 1 })!;
    expect(state.cursor).toBe(upto);
    expect(versionKnownAt(fx.recordId, 1)).toBe(eventAt(fx.recordId, "memory.created", 1));
    expect(versionKnownAt(fx.recordId, 2)).toBe(eventAt(fx.recordId, "memory.revised", 2));
    const source = raw().query("SELECT known_at FROM memory_sources WHERE id = ?").get(fx.sourceId);
    expect(source).toEqual({ known_at: eventAt(fx.sourceId, "source.captured") });
    const job = raw()
      .query("SELECT completed_known_at AS at FROM memory_assistance_jobs WHERE id = ?")
      .get(fx.jobId);
    expect(job).toEqual({ at: eventAt(fx.jobId, "assistance.completed") });
    // A finished backfill is a no-op.
    expect(backfillMemoryKnownAt(raw())).toEqual(state);
  });

  it("retention keeps undated dating events, and a backfilled revision stays dated past it", async () => {
    await revise(fx.recordId, 1, "Amber deployment uses port 8800");
    rewindToPreMigration();
    const now = Date.now() + 40 * DAY; // every event is past the 30-day window
    const ops = (): Record<string, number> => {
      const rows = raw()
        .query("SELECT operation, count(*) AS n FROM memory_service_events GROUP BY operation")
        .all() as { operation: string; n: number }[];
      return Object.fromEntries(rows.map((r) => [r.operation, r.n]));
    };
    const dating = (counts: Record<string, number>) =>
      KNOWN_AT_OPERATIONS.reduce((sum, op) => sum + (counts[op] ?? 0), 0);
    const before = ops();
    expect(dating(before)).toBeGreaterThan(0);

    runRetentionPass(db, { now, overridesEnv: "" });
    const owed = ops();
    // Backfill owed: every dating event survives; everything else is pruned.
    expect(dating(owed)).toBe(dating(before));
    expect(
      Object.keys(owed).every((op) => (KNOWN_AT_OPERATIONS as readonly string[]).includes(op)),
    ).toBe(true);

    while (!backfillMemoryKnownAt(raw())!.done) {}
    runRetentionPass(db, { now, overridesEnv: "" });
    expect(dating(ops())).toBe(0);

    // The events are gone; the rows still carry their dates, so the older
    // revision is still served as of a cutoff between the two versions.
    const v1 = versionKnownAt(fx.recordId, 1)!;
    const v2 = versionKnownAt(fx.recordId, 2)!;
    expect(v1).toBeGreaterThan(0);
    expect(recordVersionAsOf(db, fx.recordId, 2, v2)?.version).toBe(2);
    raw().run(
      "UPDATE memory_record_versions SET known_at = ? WHERE record_id = ? AND version = 2",
      [v1 + 1000, fx.recordId],
    );
    expect(recordVersionAsOf(db, fx.recordId, 2, v1 + 500)?.version).toBe(1);
    expect(sourcesKnownAt(db, [fx.sourceId]).has(fx.sourceId)).toBe(true);
    expect(proposalsKnownAt(db, [fx.jobId]).has(fx.jobId)).toBe(true);
  });

  it("a row with neither a persisted date nor an event is never dated (fail closed)", async () => {
    raw().run("UPDATE memory_record_versions SET known_at = NULL WHERE record_id = ?", [
      fx.recordId,
    ]);
    raw().run("DELETE FROM memory_service_events WHERE reference_id = ?", [fx.recordId]);
    expect(recordVersionAsOf(db, fx.recordId, 1, Date.now() + DAY)).toBeUndefined();
  });
});
