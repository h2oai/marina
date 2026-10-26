// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  computeFromLedger,
  getStanding,
  leaderboard,
  ledgerFor,
  liveStandingKinds,
  RETIRED_STANDING_KINDS,
  recomputeAll,
  record,
  recordFromEvent,
  retiredStandingMode,
  retiredStandingOf,
  STANDING_AMOUNTS,
  STANDING_HALF_LIFE_DAYS,
} from "../src/agent/standing";
import { MarinaDB } from "../src/persistence/database";
import { type EngineEvent, entityId } from "../src/types";
import { cleanupDb, tempDbPath } from "./helpers";

const TEST_DB = tempDbPath("test_standing.db");
/** A live kind with a fixed default amount, for the ledger mechanics below. */
const KIND = "quest_complete" as const;
const AMOUNT = STANDING_AMOUNTS[KIND];

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

  it("retired kinds (recognition and volume) are refused at the write and pay 0 in the table", () => {
    for (const kind of RETIRED_STANDING_KINDS) {
      expect(STANDING_AMOUNTS[kind]).toBe(0);
      record(db, "e_alice", "Alice", kind, `${kind}:1`, 5);
    }
    expect(ledgerFor(db, "e_alice")).toHaveLength(0);
    expect(liveStandingKinds()).not.toContain("chronicled");
    expect(liveStandingKinds()).toContain("task_complete");
    expect(liveStandingKinds()).toContain("forecast_resolved");
    expect(liveStandingKinds()).toContain("code_verified");
  });

  it("historical rows of a retired kind stay readable but count toward no standing by default", () => {
    const now = Date.now();
    const halfLifeMs = STANDING_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;
    db.appendStandingEvent({
      entityId: "e_alice",
      entityName: "Alice",
      kind: "chronicled",
      ref: "chronicle:1",
      amount: 2,
      earnedAt: now - halfLifeMs,
    });
    record(db, "e_alice", "Alice", KIND, "quest:1");
    expect(ledgerFor(db, "e_alice").map((r) => r.kind)).toContain("chronicled");
    expect(retiredStandingMode({})).toBe("exclude");
    // History only: the live kind counts, the retired row does not.
    expect(computeFromLedger(db, "e_alice", now)).toBeCloseTo(AMOUNT, 2);
    expect(retiredStandingOf(db, "e_alice", now)).toBeCloseTo(1, 2);

    // MARINA_STANDING_RETIRED=decay restores the old fade-out.
    const previous = process.env.MARINA_STANDING_RETIRED;
    process.env.MARINA_STANDING_RETIRED = "decay";
    try {
      expect(computeFromLedger(db, "e_alice", now)).toBeCloseTo(AMOUNT + 1, 2);
    } finally {
      if (previous === undefined) delete process.env.MARINA_STANDING_RETIRED;
      else process.env.MARINA_STANDING_RETIRED = previous;
    }
  });

  it("every live kind still earns (or debits) and counts", () => {
    const liveKinds = liveStandingKinds();
    let expected = 0;
    for (const kind of liveKinds) {
      // task_complete pays the task's own value; the rest their table amount.
      const amount = kind === "task_complete" ? 2 : STANDING_AMOUNTS[kind];
      record(db, "e_bob", "Bob", kind, `${kind}:1`, amount);
      expected += amount;
    }
    expect(ledgerFor(db, "e_bob", 50)).toHaveLength(liveKinds.length);
    expect(liveKinds).toEqual(
      expect.arrayContaining([
        "task_complete",
        "code_verified",
        "forecast_resolved",
        "experiment_complete",
        "assistance_adopted",
        "quest_complete",
      ]),
    );
    expect(computeFromLedger(db, "e_bob")).toBeCloseTo(Math.max(0, expected), 2);
    expect(retiredStandingOf(db, "e_bob")).toBe(0);
  });

  it("record() appends a ledger row and standing reads back the amount", () => {
    record(db, "e_alice", "Alice", KIND, "quest:1");
    expect(computeFromLedger(db, "e_alice")).toBeCloseTo(AMOUNT, 2);
  });

  it("record() is idempotent on (entity, kind, ref) — re-recording is a no-op", () => {
    record(db, "e_alice", "Alice", KIND, "quest:1");
    record(db, "e_alice", "Alice", KIND, "quest:1");
    record(db, "e_alice", "Alice", KIND, "quest:1");
    expect(computeFromLedger(db, "e_alice")).toBeCloseTo(AMOUNT, 2); // not 3×
  });

  it("different refs accumulate", () => {
    record(db, "e_alice", "Alice", KIND, "quest:1");
    record(db, "e_alice", "Alice", KIND, "quest:2");
    record(db, "e_alice", "Alice", KIND, "quest:3");
    expect(computeFromLedger(db, "e_alice")).toBeCloseTo(3 * AMOUNT, 2);
  });

  it("decays exponentially with the configured half-life", () => {
    const now = Date.now();
    const halfLifeMs = STANDING_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;
    db.appendStandingEvent({
      entityId: "e_alice",
      entityName: "Alice",
      kind: KIND,
      ref: "old:1",
      amount: 10,
      earnedAt: now - halfLifeMs,
    });
    // After one half-life, 10 should decay to 5.
    expect(computeFromLedger(db, "e_alice", now)).toBeCloseTo(5, 1);
  });

  it("getStanding caches and returns floor-zero values", () => {
    record(db, "e_alice", "Alice", KIND, "quest:1");
    const first = getStanding(db, "e_alice");
    expect(first).toBeGreaterThan(0);
    expect(getStanding(db, "e_alice")).toBeCloseTo(first, 5);
    expect(getStanding(db, "e_nobody")).toBe(0);
  });

  it("getStanding floors at 0 even when penalties dominate", () => {
    record(db, "e_alice", "Alice", "crew_member_stalled", "stall:1"); // -3
    record(db, "e_alice", "Alice", "crew_member_stalled", "stall:2"); // -3
    expect(getStanding(db, "e_alice")).toBe(0);
  });

  it("recordFromEvent credits nothing for a pool note; only the stall penalty is event-driven", () => {
    recordFromEvent(db, {
      type: "pool_note",
      entity: entityId("e_alice"),
      noteId: 42,
      poolName: "research",
      content: "found something",
      importance: 5,
      timestamp: Date.now(),
    });
    expect(ledgerFor(db, "e_alice")).toHaveLength(0);

    recordFromEvent(
      db,
      {
        type: "crew_member_stalled",
        crew: "c1",
        agentName: "Alice",
        offenseCount: 3,
        timestamp: 1,
      } as EngineEvent,
      () => "e_alice",
    );
    expect(ledgerFor(db, "e_alice")[0]?.kind).toBe("crew_member_stalled");
  });

  it("curation kinds are in the credit table: adoption pays the helper, abstention a quarter, supersession debits", () => {
    expect(STANDING_AMOUNTS.assistance_adopted).toBe(1);
    expect(STANDING_AMOUNTS.assistance_abstained_confirmed).toBe(0.25);
    expect(STANDING_AMOUNTS.assistance_superseded).toBe(-0.5);
    record(db, "e_helper", "Helper", "assistance_adopted", "assistance:j1");
    record(db, "e_helper", "Helper", "assistance_superseded", "assistance:j1:superseded:r1");
    record(db, "e_helper", "Helper", "assistance_superseded", "assistance:j1:superseded:r1"); // idempotent
    expect(computeFromLedger(db, "e_helper")).toBeCloseTo(0.5, 3);
    record(db, "e_helper", "Helper", "assistance_superseded", "assistance:j2:superseded:r2");
    expect(computeFromLedger(db, "e_helper")).toBe(0);
  });

  it("recordFromEvent skips events that don't map to standing kinds", () => {
    recordFromEvent(db, { type: "tick", timestamp: Date.now() } as EngineEvent);
    expect(ledgerFor(db, "e_alice")).toHaveLength(0);
  });

  it("recomputeAll refreshes cache for every entity in the ledger", () => {
    record(db, "e_alice", "Alice", KIND, "1");
    record(db, "e_bob", "Bob", KIND, "1");
    record(db, "e_bob", "Bob", KIND, "2");

    expect(recomputeAll(db)).toBe(2);
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
      kind: KIND,
      ref: "1",
      amount: 10,
      earnedAt: t0,
    });
    const seeded = getStanding(db, "e_ttl", t0);
    expect(getStanding(db, "e_ttl", t0 + CACHE_TTL_MS - 1)).toBe(seeded);
    expect(getStanding(db, "e_ttl", t0 + CACHE_TTL_MS + 1)).toBeLessThan(seeded);
  });

  it("a fresh ledger write invalidates the cache so the next read reflects it (gate-relevant)", () => {
    record(db, "e_inv", "Inv", KIND, "a");
    const first = getStanding(db, "e_inv");
    record(db, "e_inv", "Inv", KIND, "b");
    expect(getStanding(db, "e_inv")).toBeGreaterThan(first);
  });

  it("leaderboard shows a freshly-earned entity's real standing without waiting for recomputeAll", () => {
    record(db, "e_carol", "Carol", KIND, "1");
    const carol = leaderboard(db).find((r) => r.entityId === "e_carol");
    expect(carol?.standing).toBeGreaterThan(0);
  });

  it("ledgerFor returns rows newest-first", () => {
    for (const [ref, earnedAt] of [
      ["old", 1_000_000],
      ["new", 2_000_000],
    ] as const)
      db.appendStandingEvent({
        entityId: "e_alice",
        entityName: "Alice",
        kind: KIND,
        ref,
        amount: 1,
        earnedAt,
      });
    const rows = ledgerFor(db, "e_alice");
    expect(rows[0]!.ref).toBe("new");
    expect(rows[1]!.ref).toBe("old");
  });

  it("preserves the existing recordStandingEarned task path", () => {
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
