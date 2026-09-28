// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { contextCacheStats } from "../src/memory/context-cache";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { buildUnifiedContext } from "../src/memory/unified-context";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import {
  FIXTURE_QUERY,
  seedUnifiedFixture,
  type UnifiedFixture,
} from "./fixtures/unified-memory-fixture";
import { makeTestRoom } from "./helpers";

let directory: string;
let db: MarinaDB;
let engine: Engine;
let fixture: UnifiedFixture;
let closed = false;
const context = () =>
  buildUnifiedContext(db, fixture.owner, FIXTURE_QUERY, {
    scope: "evidence",
    creditReflections: false,
  });
const ids = async () =>
  (await context()).tiers.flatMap((tier) => tier.items.map((item) => item.id));
beforeEach(async () => {
  closed = false;
  directory = mkdtempSync(join(tmpdir(), "marina-context-cache-"));
  db = new MarinaDB(join(directory, "world.db"));
  engine = new Engine({ db, startRoom: roomId("test/cache") });
  engine.registerRoom(roomId("test/cache"), makeTestRoom());
  fixture = await seedUnifiedFixture(engine, db);
});
afterEach(async () => {
  if (!closed) {
    await engine.shutdown();
    db.close();
  }
  rmSync(directory, { recursive: true, force: true });
});

it("reuses pure context and isolates callers' mutations and budgets", async () => {
  const first = await context();
  expect(first.degraded).toEqual([]);
  const expected = structuredClone(first);
  first.tiers.length = 0;
  expect(await context()).toEqual(expected);
  expect(contextCacheStats(db).hits).toBe(1);
  const small = await buildUnifiedContext(db, fixture.owner, FIXTURE_QUERY, {
    scope: "evidence",
    budgetBytes: 256,
  });
  expect(small.usedBytes).toBeLessThanOrEqual(256);
  expect(contextCacheStats(db).misses).toBe(2);
});

it("invalidates deletion, suspension, revocation and a change of space ownership", async () => {
  expect(await ids()).toContain(fixture.recordId);
  const raw = db.memoryRepository().raw;
  raw.run("UPDATE memory_records SET status='forgotten' WHERE id=?", [fixture.recordId]);
  expect(await ids()).not.toContain(fixture.recordId);
  raw.run("UPDATE principals SET status='suspended' WHERE display_name=?", [fixture.owner]);
  expect((await context()).degraded.length).toBeGreaterThan(0);
  raw.run("UPDATE principals SET status='active' WHERE display_name=?", [fixture.owner]);
  await context();
  raw.run("UPDATE principal_credentials SET revoked_at=? WHERE principal_id=?", [
    Date.now(),
    db.getUserByName(fixture.owner)!.id,
  ]);
  expect((await context()).degraded.length).toBeGreaterThan(0);
  raw.run("UPDATE principal_credentials SET revoked_at=NULL WHERE principal_id=?", [
    db.getUserByName(fixture.owner)!.id,
  ]);
  await context();
  raw.run("UPDATE memory_spaces SET owner_id=? WHERE id=?", [
    db.getUserByName(fixture.worker)!.id,
    fixture.spaceId,
  ]);
  expect((await context()).tiers.every((tier) => tier.items.length === 0)).toBe(true);
});

it("notices writes from a separate SQLite connection", async () => {
  expect(await ids()).toContain(fixture.recordId);
  const writer = new Database(join(directory, "world.db"));
  try {
    writer.run("UPDATE memory_records SET status='forgotten' WHERE id=?", [fixture.recordId]);
    expect(await ids()).not.toContain(fixture.recordId);
  } finally {
    writer.close();
  }
});

it("expires evidence on time without a database write and rejects clock rollback", async () => {
  const now = Date.now();
  await residentMemoryOperation(db, fixture.owner, {
    operation: "revise",
    id: fixture.recordId,
    input: {
      content: "Amber deployment uses port 7419",
      expected_version: 1,
      valid_time: { from: null, until: now + 1000 },
    },
  });
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    expect(await ids()).toContain(fixture.recordId);
    clock.mockReturnValue(now + 1001);
    expect(await ids()).not.toContain(fixture.recordId);
    const hits = contextCacheStats(db).hits;
    clock.mockReturnValue(now - 1000);
    expect(await ids()).toContain(fixture.recordId);
    expect(contextCacheStats(db).hits).toBe(hits);
  } finally {
    clock.mockRestore();
  }
});

it("does not publish context from a retrieval racing an erasure", async () => {
  const reading = context();
  db.memoryRepository().raw.run("UPDATE memory_records SET status='forgotten' WHERE id=?", [
    fixture.recordId,
  ]);
  expect((await reading).tiers.flatMap((tier) => tier.items.map((item) => item.id))).not.toContain(
    fixture.recordId,
  );
  expect(await ids()).not.toContain(fixture.recordId);
});

it("does not retain uncommitted context after rollback or serve a closed database", async () => {
  await context();
  const raw = db.memoryRepository().raw;
  raw.exec("BEGIN");
  try {
    raw.run("UPDATE memory_records SET status='forgotten' WHERE id=?", [fixture.recordId]);
    expect(await ids()).not.toContain(fixture.recordId);
  } finally {
    raw.exec("ROLLBACK");
  }
  expect(await ids()).toContain(fixture.recordId);
  // Close is normally owned by the fixture; a second close is explicitly supported.
  await engine.shutdown();
  db.close();
  closed = true;
  await expect(context()).rejects.toThrow(/closed/);
});
