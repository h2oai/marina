// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findDurableRelation,
  findDurableTwin,
  replayPendingBridges,
} from "../src/memory/legacy-bridge";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { closeWorldMemoryService } from "../src/memory/world-service";
import { MarinaDB } from "../src/persistence/database";
import type { MemoryRecord } from "../src/sdk/memory-types";

let db: MarinaDB;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "marina-unification-"));
  db = new MarinaDB(join(directory, "world.db"));
  db.createUser({ id: crypto.randomUUID(), name: "Alice" });
  db.createUser({ id: crypto.randomUUID(), name: "Bob" });
});
afterEach(async () => {
  await closeWorldMemoryService(db);
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
const durable = (request: Parameters<typeof residentMemoryOperation>[2], name = "Alice") =>
  residentMemoryOperation(db, name, request);
const record = async (id: string) =>
  (await durable({ operation: "get", id })).result as MemoryRecord;

test("durable edits update the same numeric note and FTS atomically, preserving scopes and history", async () => {
  const noteId = db.createNote("Alice", "cobalt listens on 7420", undefined, {
    verificationStatus: "verified",
  });
  await replayPendingBridges(db);
  const twin = findDurableTwin(db, noteId)!;
  await durable({
    operation: "revise",
    id: twin.recordId,
    key: "correction",
    input: { expected_version: 1, content: "cobalt listens on 8430", importance: 8 },
  });
  expect(db.getNote(noteId)).toMatchObject({
    content: "cobalt listens on 8430",
    importance: 8,
    entity_name: "Alice",
    verification_status: "unverified",
  });
  expect(db.searchNotes("Alice", "7420")).toEqual([]);
  expect(db.searchNotes("Alice", "8430").map((n) => n.id)).toEqual([noteId]);
  expect(db.searchNotes("Bob", "8430")).toEqual([]);
  const history = (await durable({ operation: "get", id: twin.recordId, input: { version: 1 } }))
    .result as MemoryRecord;
  expect(history.content).toBe("cobalt listens on 7420");
  await expect(
    durable({
      operation: "revise",
      id: twin.recordId,
      key: "stale",
      input: { expected_version: 1, content: "stale edit" },
    }),
  ).rejects.toThrow();
  expect(db.getNote(noteId)?.content).toBe("cobalt listens on 8430");
});

test("forget erases every legacy revision and queued work cannot resurrect it", async () => {
  const original = db.createNote("Alice", "private cobalt credential");
  await replayPendingBridges(db);
  const successor = db.reviseNote("Alice", original, "corrected cobalt credential")!;
  await replayPendingBridges(db);
  const twin = findDurableTwin(db, successor)!;
  db.enqueueLegacyBridge("bridgeLegacyNote", ["Alice", successor]);
  await durable({ operation: "forget", input: { record_ids: [twin.recordId] }, key: "erase" });
  expect(db.getNote(original)).toBeUndefined();
  expect(db.getNote(successor)).toBeUndefined();
  await replayPendingBridges(db);
  expect(db.pendingLegacyBridges()).toEqual([]);
  expect(db.searchNotes("Alice", "cobalt")).toEqual([]);
  await expect(record(twin.recordId)).rejects.toThrow();
});

test("untrusted URLs and metadata cannot bind or erase another owner's note", async () => {
  const bob = db.createNote("Bob", "Bob private cobalt evidence");
  const response = await durable({
    operation: "remember",
    key: "forged",
    input: { content: "Alice evidence", metadata: { legacy_note_id: bob } },
  });
  const id = (response.result as { id: string }).id;
  db.addNoteSource(bob, {
    url: `marina-memory://record/${id}`,
    capturedBy: "Alice",
    metadata: { kind: "durable-twin", record_id: id },
  });
  await durable({
    operation: "revise",
    id,
    key: "forged-edit",
    input: { expected_version: 1, content: "overwrite Bob" },
  });
  await durable({ operation: "forget", key: "forged-delete", input: { record_ids: [id] } });
  expect(db.getNote(bob)?.content).toBe("Bob private cobalt evidence");
});

test("adding a record-shaped source URL cannot redirect an established note projection", async () => {
  const first = db.createNote("Alice", "first independent assertion");
  const other = db.createNote("Alice", "other independent assertion");
  await replayPendingBridges(db);
  const original = findDurableTwin(db, first)!;
  const target = findDurableTwin(db, other)!;
  db.addNoteSource(first, { url: target.url, capturedBy: "Alice", credibility: 1 });
  expect(findDurableTwin(db, first)?.recordId).toBe(original.recordId);
  db.recordNoteVerification(first, "Alice", "disputed", 0.1);
  await replayPendingBridges(db);
  expect((await record(original.recordId)).valid_time?.until).toBeNumber();
  expect((await record(target.recordId)).valid_time?.until ?? null).toBeNull();
  const native = await durable({
    operation: "remember",
    key: "native-canonical-record",
    input: { content: "independent canonical assertion" },
  });
  const nativeId = (native.result as { id: string }).id;
  db.addNoteSource(first, { url: `marina-memory://record/${nativeId}`, capturedBy: "Alice" });
  db.deleteNote(first, "Alice");
  await replayPendingBridges(db);
  expect((await record(nativeId)).content).toBe("independent canonical assertion");
  expect(db.pendingLegacyBridges()).toEqual([]);
});

test("provenance, verification and graph intents survive restart without command orchestration", async () => {
  const a = db.createNote("Alice", "cobalt recovery assertion");
  const b = db.createNote("Alice", "corroborating cobalt observation");
  db.addNoteSource(a, {
    url: "https://example.test/evidence",
    capturedBy: "Alice",
    credibility: 0,
  });
  db.createNoteLink(a, b, "supports");
  db.recordNoteVerification(a, "Alice", "disputed", 0.2, "evidence disagrees");
  db.close();
  db = new MarinaDB(join(directory, "world.db"));
  await replayPendingBridges(db);
  expect(db.pendingLegacyBridges()).toEqual([]);
  const twinA = findDurableTwin(db, a)!;
  const state = await record(twinA.recordId);
  expect(state.valid_time?.until).toBeNumber();
  expect(state.metadata.legacy_sources).toMatchObject([{ credibility: 0 }]);
  expect(state.metadata.legacy_verification).toBe("disputed");
  expect(
    await findDurableRelation(
      db,
      "Alice",
      twinA.recordId,
      "supports",
      findDurableTwin(db, b)!.recordId,
    ),
  ).toBeDefined();
});

test("verification rollback removes its audit and retry intent together", () => {
  const id = db.createNote("Alice", "transactional review");
  const raw = db.memoryRepository().raw;
  const before = db.pendingLegacyBridges();
  raw.exec(`CREATE TRIGGER reject_review BEFORE UPDATE OF verification_status ON notes
    BEGIN SELECT RAISE(ABORT,'fixture rejects review'); END`);
  expect(() => db.recordNoteVerification(id, "Alice", "verified", 1)).toThrow(
    "fixture rejects review",
  );
  expect(db.getNoteVerifications(id)).toEqual([]);
  expect(db.pendingLegacyBridges()).toEqual(before);
  expect(db.getNote(id)?.verification_status).toBe("unverified");
});

test("durable mutation rolls back if its legacy projection cannot commit", async () => {
  const id = db.createNote("Alice", "original atomic assertion");
  await replayPendingBridges(db);
  const twin = findDurableTwin(db, id)!;
  db.memoryRepository().raw.exec(`CREATE TRIGGER reject_projection BEFORE UPDATE OF content ON notes
    WHEN OLD.entity_name='Alice' BEGIN SELECT RAISE(ABORT,'projection unavailable'); END`);
  await expect(
    durable({
      operation: "revise",
      id: twin.recordId,
      key: "atomic-revision",
      input: { expected_version: 1, content: "must roll back" },
    }),
  ).rejects.toThrow();
  expect((await record(twin.recordId)).version).toBe(1);
  expect(db.getNote(id)?.content).toBe("original atomic assertion");
});

test("pending corrections cannot be overwritten, and forgetting includes unmirrored successors", async () => {
  const id = db.createNote("Alice", "original pending assertion");
  await replayPendingBridges(db);
  const twin = findDurableTwin(db, id)!;
  const next = db.reviseNote("Alice", id, "pending correction")!;
  await expect(
    durable({
      operation: "revise",
      id: twin.recordId,
      key: "concurrent-revision",
      input: { expected_version: 1, content: "would overwrite pending correction" },
    }),
  ).rejects.toMatchObject({ code: "compatibility_pending" });
  await durable({
    operation: "forget",
    key: "erase-pending",
    input: { record_ids: [twin.recordId] },
  });
  expect(db.getNote(next)).toBeUndefined();
  await replayPendingBridges(db);
  expect(db.pendingLegacyBridges()).toEqual([]);
  expect(db.getNotesByEntity("Alice")).toEqual([]);
});

test("queued verification of old text cannot endorse or dispute a durable correction", async () => {
  const id = db.createNote("Alice", "old confidence assertion");
  await replayPendingBridges(db);
  const twin = findDurableTwin(db, id)!;
  db.recordNoteVerification(id, "Alice", "disputed", 0.1);
  await durable({
    operation: "revise",
    id: twin.recordId,
    key: "new-assertion",
    input: { expected_version: 1, content: "corrected confidence assertion" },
  });
  await replayPendingBridges(db);
  expect((await record(twin.recordId)).valid_time?.until ?? null).toBeNull();
  expect(db.getNote(id)?.verification_status).toBe("unverified");
});

test("source metadata updates retain zero credibility and reuse the captured source", async () => {
  const id = db.createNote("Alice", "updated source assertion");
  db.addNoteSource(id, {
    url: "https://example.test/report",
    capturedBy: "Alice",
    credibility: 0.8,
  });
  await replayPendingBridges(db);
  const twin = findDurableTwin(db, id)!;
  const before = await record(twin.recordId);
  db.addNoteSource(id, { url: "https://example.test/report", capturedBy: "Alice", credibility: 0 });
  await replayPendingBridges(db);
  const after = await record(twin.recordId);
  expect(after.source_ids).toEqual(before.source_ids);
  expect(after.metadata.legacy_sources).toMatchObject([{ credibility: 0 }]);
});

test("process and core notes never become fact evidence during compatibility replay", async () => {
  const process = db.createNote("Alice", "[compaction] internal journal");
  const core = db.createNote("Alice", "core identity", undefined, { tier: "core" });
  await replayPendingBridges(db);
  expect(findDurableTwin(db, process)).toBeUndefined();
  expect(findDurableTwin(db, core)).toBeUndefined();
  expect(db.queueLegacyBridgeBackfill().scanned).toBe(0);
});

test("a committed verification is acknowledged after a crash without another revision", async () => {
  const id = db.createNote("Alice", "crash-safe verification");
  await replayPendingBridges(db);
  const twin = findDurableTwin(db, id)!;
  db.recordNoteVerification(id, "Alice", "verified", 0.9);
  const complete = spyOn(db, "completeLegacyBridge").mockImplementation(() => {
    throw new Error("crash after canonical commit");
  });
  try {
    await replayPendingBridges(db);
  } finally {
    complete.mockRestore();
  }
  expect((await record(twin.recordId)).version).toBe(2);
  expect(db.pendingLegacyBridges()).toHaveLength(1);
  await replayPendingBridges(db);
  expect(db.pendingLegacyBridges()).toEqual([]);
  expect((await record(twin.recordId)).version).toBe(2);
});

test("backfill reconciles provenance and verdicts even when a prerequisite already created the twin", async () => {
  const a = db.createNote("Historical", "historical sourced assertion");
  const b = db.createNote("Historical", "historical related assertion");
  db.addNoteSource(b, {
    url: "https://example.test/old",
    credibility: 0,
    capturedBy: "Historical",
  });
  db.recordNoteVerification(b, "Historical", "disputed", 0.1);
  db.createNoteLink(a, b, "supports");
  db.createUser({ id: crypto.randomUUID(), name: "Historical" });
  const first = db.queueLegacyBridgeBackfill("Historical", 0, 1);
  await replayPendingBridges(db);
  expect(findDurableTwin(db, b)).toBeDefined();
  expect(db.queueLegacyBridgeBackfill("Historical", first.afterId, 1).scanned).toBe(1);
  await replayPendingBridges(db);
  const twin = findDurableTwin(db, b)!;
  const current = (await durable({ operation: "get", id: twin.recordId }, "Historical"))
    .result as MemoryRecord;
  expect(current.metadata.legacy_sources).toMatchObject([{ credibility: 0 }]);
  expect(current.valid_time?.until).toBeNumber();
  db.queueLegacyBridgeBackfill("Historical");
  await replayPendingBridges(db);
  expect(db.pendingLegacyBridges()).toEqual([]);
});
