// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableResidentMemory, sameCheckpointData } from "../src/agent/durable-memory";
import {
  nextPreferenceRefreshCycles,
  PREFERENCE_REFRESH_MAX_CYCLES,
  PREFERENCE_REFRESH_MIN_CYCLES,
} from "../src/agent/loop-preferences";
import {
  CONTINUITY_RECEIPT_WHERE,
  RETENTION_POLICIES,
  runRetentionPass,
} from "../src/engine/retention";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { MarinaDB } from "../src/persistence/database";
import type { MemoryOperationRequest } from "../src/sdk/memory-operations";

let directory: string;
let db: MarinaDB;
let ops: string[];
let durable: DurableResidentMemory;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "marina-call-economy-"));
  db = new MarinaDB(join(directory, "memory.db"));
  db.createUser({ id: crypto.randomUUID(), name: "Resident" });
  ops = [];
  durable = new DurableResidentMemory({
    memoryService: async (request: MemoryOperationRequest) => {
      ops.push(request.operation);
      return residentMemoryOperation(db, "Resident", request);
    },
  });
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true });
});

const count = (op: string) => ops.filter((o) => o === op).length;
const receipts = () =>
  (
    db.memoryRepository().raw.query("SELECT count(*) AS n FROM memory_requests").get() as {
      n: number;
    }
  ).n;

describe("resident continuity journal call economy", () => {
  it("checkpoint-only saves and journal entries reuse the remembered checkpoint", async () => {
    await durable.save({ lastIntent: "one" });
    await durable.save({ lastIntent: "two" });
    await durable.save({ lastIntent: "three" });
    // Before: one checkpoint read per save.
    expect(count("checkpoint")).toBe(1);
    expect(count("save_checkpoint")).toBe(3);
    // One request per journal entry: parts, manifest and checkpoint together.
    await durable.journal({ role: "user", content: "one" });
    await durable.journal({ role: "assistant", content: "two" });
    expect(count("checkpoint")).toBe(1);
    expect(count("capture_checkpoint")).toBe(2);
    expect(ops.filter((o) => o === "capture" || o === "capture_batch")).toEqual([]);
    const saved = await durable.checkpoint();
    expect((saved!.data.journal as { message_count: number }).message_count).toBe(1);
    expect(saved!.data.lastIntent).toBe("three");
  });

  it("captures nothing once a forget has invalidated the checkpoint", async () => {
    await durable.journal({ role: "user", content: "kept" });
    const sources = () =>
      (
        db.memoryRepository().raw.query("SELECT count(*) AS n FROM memory_sources").get() as {
          n: number;
        }
      ).n;
    const journal = (await durable.checkpoint())!.data.journal as { source_ids: string[] };
    const forgotten = await residentMemoryOperation(db, "Resident", {
      operation: "forget",
      input: { source_ids: [journal.source_ids[0]!] },
    });
    expect(forgotten.ok).toBe(true);
    const before = sources();
    await expect(
      durable.journal({ role: "user", content: "must not be captured" }),
    ).rejects.toMatchObject({ code: "checkpoint_invalidated" });
    expect(sources()).toBe(before);
  });

  it("a write made elsewhere rejects a journal entry whole and it retries from a fresh read", async () => {
    await durable.journal({ role: "user", content: "first" });
    const other = new DurableResidentMemory({
      memoryService: async (request: MemoryOperationRequest) =>
        residentMemoryOperation(db, "Resident", request),
    });
    await other.save({ lastIntent: "elsewhere" });
    ops = [];
    await durable.journal({ role: "user", content: "second" });
    expect(count("capture_checkpoint")).toBe(2); // conflict, then the retry
    expect(count("checkpoint")).toBe(1);
    const saved = (await durable.checkpoint())!;
    expect(saved.data.lastIntent).toBe("elsewhere");
    expect((saved.data.journal as { message_count: number }).message_count).toBe(1);
  });

  it("skips a save that changes nothing but its timestamp", async () => {
    await durable.save({ lastIntent: "explore", location: "Start", timestamp: 1 });
    const before = receipts();
    await durable.save({ lastIntent: "explore", location: "Start", timestamp: 2 });
    await durable.save({ lastIntent: "explore", location: "Start", timestamp: 3 });
    expect(count("save_checkpoint")).toBe(1);
    expect(receipts()).toBe(before);
    await durable.save({ lastIntent: "build", location: "Start", timestamp: 4 });
    expect(count("save_checkpoint")).toBe(2);
    expect(sameCheckpointData({ a: 1, timestamp: 1 }, { timestamp: 2, a: 1 })).toBe(true);
    expect(sameCheckpointData({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toBe(true);
    expect(sameCheckpointData(undefined, { a: 1 })).toBe(false);
  });

  it("recovers from a write made elsewhere by re-reading once", async () => {
    await durable.save({ lastIntent: "explore" });
    // Another writer moves the checkpoint on behind this instance's back.
    const other = new DurableResidentMemory({
      memoryService: async (request: MemoryOperationRequest) =>
        residentMemoryOperation(db, "Resident", request),
    });
    await other.save({ lastIntent: "elsewhere" });
    ops = [];
    await durable.save({ lastIntent: "mine" });
    expect(count("save_checkpoint")).toBe(2); // conflict, then the retry
    expect(count("checkpoint")).toBe(1);
    expect((await durable.checkpoint())?.data.lastIntent).toBe("mine");
  });
});

describe("in-process memory callers are paced, not failed, by the request budget", () => {
  it("waits out named rate-limit refusals past the 100-request burst", async () => {
    const started = performance.now();
    for (let i = 0; i < 120; i++) {
      const reply = await residentMemoryOperation(db, "Resident", { operation: "usage" });
      expect(reply.ok).toBe(true);
    }
    // ~20 requests past the burst at one token per 40 ms: paced, well under the old 1 s waits.
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe("core-memory preference refresh backoff", () => {
  it("doubles while nothing changes, capped, and snaps back on a change", () => {
    let every = PREFERENCE_REFRESH_MIN_CYCLES;
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      every = nextPreferenceRefreshCycles(every, false);
      seen.push(every);
    }
    expect(seen).toEqual([100, 200, 400, 400, 400]);
    expect(every).toBe(PREFERENCE_REFRESH_MAX_CYCLES);
    expect(nextPreferenceRefreshCycles(every, true)).toBe(PREFERENCE_REFRESH_MIN_CYCLES);
  });
});

describe("memory_requests retention", () => {
  it("prunes only old continuity-journal receipts and keeps every other receipt", async () => {
    await durable.journal({ role: "user", content: "old" });
    await durable.save({ lastIntent: "old" });
    const raw = db.memoryRepository().raw;
    raw.run(
      "INSERT INTO memory_requests(principal_id,space_id,request_key,request_hash,response,created_at) VALUES ('p','','hygiene:x','h','{}',0)",
    );
    raw.run(
      "INSERT INTO memory_requests(principal_id,space_id,request_key,request_hash,response,created_at) VALUES ('p','','00000000-0000-0000-0000-000000000000','h','{\"id\":\"other\"}',0)",
    );
    const journal = (
      raw
        .query(`SELECT count(*) AS n FROM memory_requests WHERE ${CONTINUITY_RECEIPT_WHERE}`)
        .get() as {
        n: number;
      }
    ).n;
    expect(journal).toBeGreaterThanOrEqual(4);
    const total = receipts();

    // Inside the window nothing goes.
    runRetentionPass(db, {
      policies: RETENTION_POLICIES.filter((p) => p.table === "memory_requests"),
    });
    expect(receipts()).toBe(total);

    const later = Date.now() + 8 * 86_400_000;
    const result = runRetentionPass(db, {
      now: later,
      policies: RETENTION_POLICIES.filter((p) => p.table === "memory_requests"),
    });
    expect(result.deleted.memory_requests).toBe(journal);
    const left = raw
      .query("SELECT request_key FROM memory_requests ORDER BY request_key")
      .all() as {
      request_key: string;
    }[];
    expect(left.map((r) => r.request_key)).toEqual(
      expect.arrayContaining(["00000000-0000-0000-0000-000000000000", "hygiene:x"]),
    );
    expect(
      left.some((r) => /^(archive|archive-batch|manifest|checkpoint):/.test(r.request_key)),
    ).toBe(false);
  });
});
