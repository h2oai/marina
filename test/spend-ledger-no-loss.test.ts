// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Money already spent is never dropped: a spend write that fails is retried
 * when the database is busy, otherwise kept pending — counted by the cap and
 * the readouts — and written on the next successful write. Scope and purpose
 * rows follow their entry, and no dollar is ever counted twice.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachDbSpendLedger,
  attachSpendLedger,
  attachWorldSpendLedger,
  dailyCapRefusal,
  isTransientSpendWriteError,
  pendingSpendUsd,
  purposeSpendToday,
  recordSpend,
  resetSpendLedgerForTests,
  type SpendSource,
  scopeSpendToday,
  setSpendRetrySleepForTests,
  spentTodayInScopeUsd,
  spentTodayUsd,
  utcDay,
} from "../src/engine/spend-ledger";
import { MarinaDB } from "../src/persistence/database";

const SCOPED = { MARINA_SPEND_SCOPE: "bench", MARINA_DAILY_SPEND_CAP_USD: "off" };

function busy(): Error {
  return Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
}

function worldTotal(db: MarinaDB): number {
  return db.getDailySpend(utcDay()).reduce((s, r) => s + r.cost_usd, 0);
}

function scopeRow(db: MarinaDB, scope: string): number {
  return db.getScopeDailySpend(utcDay(), scope).reduce((s, r) => s + r.cost_usd, 0);
}

let dir = "";
let sleeps: number[] = [];

beforeEach(() => {
  resetSpendLedgerForTests();
  sleeps = [];
  setSpendRetrySleepForTests((ms) => sleeps.push(ms));
  dir = mkdtempSync(join(tmpdir(), "marina-spend-no-loss-"));
});
afterEach(() => {
  resetSpendLedgerForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("spend ledger never loses an increment", () => {
  it("classifies SQLite busy/locked errors as transient", () => {
    expect(isTransientSpendWriteError(busy())).toBe(true);
    expect(isTransientSpendWriteError(new Error("database table is locked"))).toBe(true);
    expect(isTransientSpendWriteError(new Error("disk I/O error"))).toBe(false);
  });

  it("retries a busy write briefly and records it exactly once", () => {
    const db = new MarinaDB(join(dir, "w.db"));
    const release = attachDbSpendLedger(db, {});
    try {
      const original = db.addDailySpend.bind(db);
      let failures = 2;
      const write = spyOn(db, "addDailySpend").mockImplementation((...args) => {
        if (failures-- > 0) throw busy();
        original(...args);
      });
      recordSpend("model_api", 1.5);
      expect(write).toHaveBeenCalledTimes(3);
      expect(sleeps).toEqual([5, 20]);
      expect(worldTotal(db)).toBeCloseTo(1.5, 10);
      expect(db.getDailySpend(utcDay())[0]).toMatchObject({ calls: 1 });
      expect(pendingSpendUsd()).toBe(0);
      write.mockRestore();
    } finally {
      release();
      db.close();
    }
  });

  it("keeps a failed write pending, counts it in the cap and readouts, then flushes it once", () => {
    const path = join(dir, "w.db");
    const db = new MarinaDB(path);
    const other = new MarinaDB(path); // another process on the same world
    const release = attachDbSpendLedger(db, SCOPED);
    try {
      const write = spyOn(db, "addDailySpend").mockImplementation(() => {
        throw new Error("disk I/O error");
      });
      recordSpend("model_api", 2, Date.now(), SCOPED, "lessons");
      expect(write).toHaveBeenCalledTimes(1); // not transient ⇒ no retry
      expect(sleeps).toEqual([]);
      expect(worldTotal(other)).toBe(0);

      // Counted everywhere the cap and the readouts look.
      expect(pendingSpendUsd()).toBe(2);
      expect(spentTodayUsd()).toBe(2);
      expect(spentTodayInScopeUsd("bench")).toBe(2);
      expect(scopeSpendToday(db)).toEqual([{ scope: "bench", spentUsd: 2 }]);
      expect(purposeSpendToday(db)).toEqual([{ purpose: "lessons", spentUsd: 2 }]);
      expect(dailyCapRefusal({ MARINA_DAILY_SPEND_CAP_USD: "1.5" })).toMatch(/cap reached/);
      expect(dailyCapRefusal({ ...SCOPED, MARINA_SPEND_SCOPE_CAP_USD: "1.5" })).toMatch(
        /scope bench/,
      );

      // Another process's spend raises the persisted total past ours: the
      // pending dollars still count on top of it (the old max() lost them).
      other.addDailySpend(utcDay(), "forecast", 5);
      expect(spentTodayUsd()).toBe(7);

      // The next successful write lands the pending entry with it — once.
      write.mockRestore();
      recordSpend("agent", 1, Date.now(), SCOPED, "lessons");
      expect(pendingSpendUsd()).toBe(0);
      expect(worldTotal(other)).toBeCloseTo(8, 10);
      expect(scopeRow(other, "bench")).toBeCloseTo(3, 10);
      expect(scopeRow(other, "purpose:lessons")).toBeCloseTo(3, 10);
      expect(spentTodayUsd()).toBeCloseTo(8, 10);
      expect(spentTodayInScopeUsd("bench")).toBeCloseTo(3, 10);

      // Further writes add only themselves.
      recordSpend("agent", 0.5, Date.now(), SCOPED);
      expect(worldTotal(other)).toBeCloseTo(8.5, 10);
    } finally {
      release();
      db.close();
      other.close();
    }
  });

  it("flushes pending spend when the ledger is released", () => {
    const db = new MarinaDB(join(dir, "w.db"));
    const release = attachDbSpendLedger(db, {});
    const write = spyOn(db, "addDailySpend").mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    recordSpend("decision", 0.25);
    write.mockRestore();
    release();
    try {
      expect(worldTotal(db)).toBeCloseTo(0.25, 10);
    } finally {
      db.close();
    }
  });

  it("a custom sink keeps scope rows pending alongside the total", () => {
    const rows: { scope: string; cost_usd: number }[] = [];
    let total = 0;
    let fail = true;
    attachSpendLedger({
      add: (_day: string, _source: SpendSource, usd: number, scope?: string) => {
        if (fail) throw new Error("ledger unavailable");
        total += usd;
        if (scope) rows.push({ scope, cost_usd: usd });
      },
      totalFor: () => total,
      scopeTotalFor: (_day, scope) =>
        rows.filter((r) => r.scope === scope).reduce((s, r) => s + r.cost_usd, 0),
      scopeRowsFor: () => rows,
    });
    recordSpend("forecast", 3, Date.now(), SCOPED);
    expect(spentTodayInScopeUsd("bench")).toBe(3);
    expect(scopeSpendToday({ getScopeDailySpend: () => [] })).toEqual([
      { scope: "bench", spentUsd: 3 },
    ]);
    fail = false;
    recordSpend("forecast", 1, Date.now(), SCOPED);
    expect(total).toBe(4);
    expect(rows.map((r) => r.cost_usd)).toEqual([1, 3]);
    expect(spentTodayUsd()).toBe(4);
    expect(spentTodayInScopeUsd("bench")).toBe(4);
  });

  it("with a shared ledger, retries only the ledger that failed (no double count)", () => {
    const ledgerPath = join(dir, "shared", "spend.db");
    const env = { MARINA_SPEND_LEDGER: ledgerPath, MARINA_SPEND_SCOPE: "child:a" };
    const db = new MarinaDB(join(dir, "w.db"));
    const release = attachWorldSpendLedger(db, { env });
    try {
      const write = spyOn(db, "addDailySpend").mockImplementation(() => {
        throw new Error("disk I/O error");
      });
      recordSpend("model_api", 2, Date.now(), env);
      // The shared file (which the cap reads) took it; the world row is pending.
      expect(spentTodayUsd()).toBe(2);
      expect(spentTodayInScopeUsd("child:a")).toBe(2);
      expect(worldTotal(db)).toBe(0);
      write.mockRestore();
      recordSpend("model_api", 1, Date.now(), env);
      expect(worldTotal(db)).toBeCloseTo(3, 10);
      expect(scopeRow(db, "child:a")).toBeCloseTo(3, 10);
      expect(spentTodayUsd()).toBeCloseTo(3, 10);
      expect(spentTodayInScopeUsd("child:a")).toBeCloseTo(3, 10);
    } finally {
      release();
      db.close();
    }
  });
});
