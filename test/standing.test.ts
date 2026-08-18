// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  computeFromLedger,
  getStanding,
  leaderboard,
  ledgerFor,
  recomputeAll,
  record,
  recordFromEvent,
  STANDING_AMOUNTS,
  STANDING_HALF_LIFE_DAYS,
} from "../src/agent/standing";
import { MarinaDB } from "../src/persistence/database";
import { type EngineEvent, entityId } from "../src/types";
import { cleanupDb } from "./helpers";

const TEST_DB = "test_standing.db";

describe("Standing — civic-contribution ledger", () => {
  let db: MarinaDB;

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
  });

  it("default half-life is 60 days", () => {
    expect(STANDING_HALF_LIFE_DAYS).toBe(60);
  });

  it("record() appends a ledger row and standing reads back the amount", () => {
    record(db, "e_alice", "Alice", "pool_note", "pool_note:1");
    expect(computeFromLedger(db, "e_alice")).toBeCloseTo(STANDING_AMOUNTS.pool_note, 2);
  });

  it("record() is idempotent on (entity, kind, ref) — re-recording is a no-op", () => {
    record(db, "e_alice", "Alice", "pool_note", "pool_note:1");
    record(db, "e_alice", "Alice", "pool_note", "pool_note:1");
    record(db, "e_alice", "Alice", "pool_note", "pool_note:1");
    expect(computeFromLedger(db, "e_alice")).toBeCloseTo(1, 2); // not 3
  });

  it("different refs accumulate", () => {
    record(db, "e_alice", "Alice", "pool_note", "pool_note:1");
    record(db, "e_alice", "Alice", "pool_note", "pool_note:2");
    record(db, "e_alice", "Alice", "pool_note", "pool_note:3");
    expect(computeFromLedger(db, "e_alice")).toBeCloseTo(3, 2);
  });

  it("decays exponentially with the configured half-life", () => {
    const now = Date.now();
    const halfLifeMs = STANDING_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;
    // Insert via raw DB so we can backdate cleanly.
    db.appendStandingEvent({
      entityId: "e_alice",
      entityName: "Alice",
      kind: "pool_note",
      ref: "old:1",
      amount: 10,
      earnedAt: now - halfLifeMs,
    });
    // After one half-life, 10 should decay to 5.
    expect(computeFromLedger(db, "e_alice", now)).toBeCloseTo(5, 1);
  });

  it("crew_complete_lead pays more than crew_complete_member", () => {
    expect(STANDING_AMOUNTS.crew_complete_lead).toBeGreaterThan(
      STANDING_AMOUNTS.crew_complete_member,
    );
  });

  it("getStanding caches and returns floor-zero values", () => {
    record(db, "e_alice", "Alice", "pool_note", "pool_note:1");
    const first = getStanding(db, "e_alice");
    expect(first).toBeGreaterThan(0);

    // Read again — comes from cache (verified by checking standing didn't drift)
    const cached = getStanding(db, "e_alice");
    expect(cached).toBeCloseTo(first, 5);

    // Empty entity returns 0
    expect(getStanding(db, "e_nobody")).toBe(0);
  });

  it("getStanding floors at 0 even when penalties dominate", () => {
    record(db, "e_alice", "Alice", "crew_member_stalled", "stall:1"); // -3
    record(db, "e_alice", "Alice", "crew_member_stalled", "stall:2"); // -3
    expect(getStanding(db, "e_alice")).toBe(0);
  });

  it("recordFromEvent translates pool_note events into ledger rows", () => {
    const event: EngineEvent = {
      type: "pool_note",
      entity: entityId("e_alice"),
      noteId: 42,
      poolName: "research",
      content: "found something",
      importance: 5,
      timestamp: Date.now(),
    };
    recordFromEvent(db, event, () => "Alice");
    const ledger = ledgerFor(db, "e_alice");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.kind).toBe("pool_note");
    expect(ledger[0]!.ref).toBe("pool_note:42");
  });

  it("recordFromEvent skips events that don't map to standing kinds", () => {
    const event: EngineEvent = {
      type: "tick",
      timestamp: Date.now(),
    };
    recordFromEvent(db, event, () => undefined);
    expect(ledgerFor(db, "e_alice")).toHaveLength(0);
  });

  it("recomputeAll refreshes cache for every entity in the ledger", () => {
    record(db, "e_alice", "Alice", "pool_note", "1");
    record(db, "e_bob", "Bob", "pool_note", "1");
    record(db, "e_bob", "Bob", "pool_note", "2");

    const refreshed = recomputeAll(db);
    expect(refreshed).toBe(2);

    const board = leaderboard(db);
    const bob = board.find((r) => r.entityId === "e_bob");
    const alice = board.find((r) => r.entityId === "e_alice");
    expect(bob?.standing).toBeGreaterThan(alice?.standing ?? 0);
  });

  it("getStanding serves the cache within the TTL and recomputes after it expires", () => {
    const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // mirrors standing.ts
    const t0 = 1_700_000_000_000;
    db.appendStandingEvent({
      entityId: "e_ttl",
      entityName: "Ttl",
      kind: "pool_note",
      ref: "1",
      amount: 10,
      earnedAt: t0,
    });
    const seeded = getStanding(db, "e_ttl", t0); // populates cache at t0
    // Within the TTL: returns the cached value verbatim (no recompute → no decay).
    expect(getStanding(db, "e_ttl", t0 + CACHE_TTL_MS - 1)).toBe(seeded);
    // Past the TTL: recomputes with additional decay, so strictly less.
    expect(getStanding(db, "e_ttl", t0 + CACHE_TTL_MS + 1)).toBeLessThan(seeded);
  });

  it("a fresh ledger write invalidates the cache so the next read reflects it (gate-relevant)", () => {
    record(db, "e_inv", "Inv", "pool_note", "a");
    const first = getStanding(db, "e_inv"); // seeds a fresh cache row
    record(db, "e_inv", "Inv", "pool_note", "b"); // 2nd event must invalidate the cache
    // If the write didn't invalidate, this would return the stale `first` within
    // the 6h TTL. checkGate reads standing via getStanding, so this is the path
    // that keeps a freshly-earned (or penalized) entity's gate decisions current.
    expect(getStanding(db, "e_inv")).toBeGreaterThan(first);
  });

  it("leaderboard shows a freshly-earned entity's real standing without waiting for recomputeAll", () => {
    // record() invalidates the cache (last_recomputed=0). Previously the
    // leaderboard read the raw cache and showed 0 until the hourly pass; now
    // leaderboard() refreshes stale rows first.
    record(db, "e_carol", "Carol", "pool_note", "1");
    const board = leaderboard(db); // NOTE: no recomputeAll() between earn and read
    const carol = board.find((r) => r.entityId === "e_carol");
    expect(carol).toBeDefined();
    expect(carol?.standing).toBeGreaterThan(0);
  });

  it("ledgerFor returns rows newest-first", () => {
    db.appendStandingEvent({
      entityId: "e_alice",
      entityName: "Alice",
      kind: "pool_note",
      ref: "old",
      amount: 1,
      earnedAt: 1_000_000,
    });
    db.appendStandingEvent({
      entityId: "e_alice",
      entityName: "Alice",
      kind: "pool_note",
      ref: "new",
      amount: 1,
      earnedAt: 2_000_000,
    });
    const rows = ledgerFor(db, "e_alice");
    expect(rows[0]!.ref).toBe("new");
    expect(rows[1]!.ref).toBe("old");
  });

  it("preserves the existing recordStandingEarned task path", () => {
    // Backward-compat: db.recordStandingEarned should still work and the
    // value should show up in the unified ledger. Need a real task row
    // since entity_standing.task_id has an FK to tasks.id.
    const taskId = db.createTask({
      title: "test task",
      creatorId: "e_owner",
      creatorName: "Owner",
      standing: 7,
    });
    db.recordStandingEarned("e_alice", "Alice", taskId, 7);
    const ledger = ledgerFor(db, "e_alice");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.kind).toBe("task_complete");
    expect(ledger[0]!.ref).toBe(String(taskId));
    expect(ledger[0]!.amount).toBe(7);
  });
});
