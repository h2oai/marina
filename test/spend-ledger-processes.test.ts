// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The daily spend ledger shared across processes: a command-line process on
 * the world database (`DB_PATH`) counts against the persisted UTC-day total,
 * not a fresh in-memory $0; concurrent writers never lose an increment; and a
 * `MARINA_SPEND_SCOPE` budget narrows (never widens) the world's cap.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachCliSpendLedger } from "../src/engine/cli-spend-ledger";
import { Engine } from "../src/engine/engine";
import { computeReadiness } from "../src/engine/readiness";
import {
  attachDbSpendLedger,
  DEFAULT_SPEND_SCOPE_CAP_USD,
  dailyBudget,
  dailyCapRefusal,
  dailySpend,
  recordSpend,
  resetSpendLedgerForTests,
  scopeSpendToday,
  spendScope,
  spendScopeCapUsd,
  spentTodayInScopeUsd,
  spentTodayUsd,
  utcDay,
} from "../src/engine/spend-ledger";
import { MarinaDB } from "../src/persistence/database";

const LEDGER = join(import.meta.dir, "../src/engine/spend-ledger.ts");
const CLI_LEDGER = join(import.meta.dir, "../src/engine/cli-spend-ledger.ts");

let dir: string | undefined;
let dbPath = "";

/** A migrated world database on disk (WAL needs a file), so child processes only open it. */
function worldDb(): string {
  dir = mkdtempSync(join(tmpdir(), "marina-spend-"));
  dbPath = join(dir, "world.db");
  new MarinaDB(dbPath).close();
  return dbPath;
}

beforeEach(() => {
  resetSpendLedgerForTests();
});
afterEach(() => {
  resetSpendLedgerForTests();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A separate `bun` process that attaches the CLI ledger and records spend. */
async function childSpends(
  calls: number,
  usd: number,
  env: Record<string, string> = {},
): Promise<void> {
  const code = `
    const { attachCliSpendLedger } = await import(${JSON.stringify(CLI_LEDGER)});
    const { recordSpend } = await import(${JSON.stringify(LEDGER)});
    const close = attachCliSpendLedger("test writer");
    for (let i = 0; i < ${calls}; i++) recordSpend("forecast", ${usd});
    close();
  `;
  const proc = Bun.spawn([process.execPath, "-e", code], {
    env: { ...process.env, DB_PATH: dbPath, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exit = await proc.exited;
  if (exit !== 0) throw new Error(await new Response(proc.stderr).text());
}

function persistedTotal(db: MarinaDB): { usd: number; calls: number } {
  const rows = db.getDailySpend(utcDay());
  return {
    usd: rows.reduce((s, r) => s + r.cost_usd, 0),
    calls: rows.reduce((s, r) => s + r.calls, 0),
  };
}

describe("spend ledger across processes", () => {
  it("a new process starts from the persisted day, not $0, and is refused at the cap", () => {
    worldDb();
    const env = { MARINA_DAILY_SPEND_CAP_USD: "40" };
    const first = new MarinaDB(dbPath);
    const releaseFirst = attachDbSpendLedger(first);
    recordSpend("forecast", 30, Date.now(), env);
    releaseFirst();
    first.close();

    // A fresh process: module state gone, same database.
    resetSpendLedgerForTests();
    expect(spentTodayUsd()).toBe(0);
    const second = new MarinaDB(dbPath);
    const releaseSecond = attachDbSpendLedger(second);
    try {
      expect(spentTodayUsd()).toBe(30);
      expect(dailyCapRefusal(env)).toBeUndefined();
      recordSpend("forecast", 10, Date.now(), env);
      expect(dailyCapRefusal(env)).toContain("daily spend cap reached");
      expect(persistedTotal(second).usd).toBe(40);
    } finally {
      releaseSecond();
      second.close();
    }
  });

  it("sees another process's spend on the next check, without reattaching", async () => {
    worldDb();
    const db = new MarinaDB(dbPath);
    const release = attachDbSpendLedger(db);
    try {
      recordSpend("model_api", 1);
      await childSpends(3, 2);
      expect(spentTodayUsd()).toBe(7);
      expect(dailyCapRefusal({ MARINA_DAILY_SPEND_CAP_USD: "7" })).toContain("cap reached");
    } finally {
      release();
      db.close();
    }
  });

  it("two concurrent writer processes never lose an increment (WAL, immediate upserts)", async () => {
    worldDb();
    const scoped = { MARINA_SPEND_SCOPE: "backtest" };
    await Promise.all([childSpends(150, 0.25, scoped), childSpends(150, 0.25)]);
    const db = new MarinaDB(dbPath);
    try {
      expect(persistedTotal(db)).toEqual({ usd: 75, calls: 300 });
      expect(scopeSpendToday(db)).toEqual([{ scope: "backtest", spentUsd: 37.5 }]);
      expect(db.getScopeDailySpend(utcDay(), "backtest")[0]?.calls).toBe(150);
    } finally {
      db.close();
    }
  }, 30_000);
});

describe("budget scopes", () => {
  it("a scope cap refuses its own process while the world and other scopes go on", () => {
    const db = new MarinaDB(":memory:");
    const release = attachDbSpendLedger(db);
    const live = {
      MARINA_DAILY_SPEND_CAP_USD: "100",
      MARINA_SPEND_SCOPE: "futurex-live",
      MARINA_SPEND_SCOPE_CAP_USD: "5",
    };
    const backtest = { ...live, MARINA_SPEND_SCOPE: "backtest", MARINA_SPEND_SCOPE_CAP_USD: "50" };
    try {
      recordSpend("forecast", 5, Date.now(), live);
      recordSpend("forecast", 1, Date.now(), backtest);
      expect(spentTodayInScopeUsd("futurex-live")).toBe(5);
      expect(dailyCapRefusal(live)).toContain("scope futurex-live");
      expect(dailyCapRefusal(live)).toContain("MARINA_SPEND_SCOPE_CAP_USD");
      expect(dailyCapRefusal(backtest)).toBeUndefined();
      expect(dailyCapRefusal({ MARINA_DAILY_SPEND_CAP_USD: "100" })).toBeUndefined();
      expect(dailySpend(live)).toMatchObject({
        spentUsd: 6,
        reached: false,
        scope: { name: "futurex-live", spentUsd: 5, capUsd: 5, reached: true },
      });
      expect(db.getScopeDailySpend(utcDay()).map((r) => r.scope)).toEqual([
        "backtest",
        "futurex-live",
      ]);
    } finally {
      release();
      db.close();
    }
  });

  it("the global cap still refuses a scoped process under its scope cap", () => {
    const db = new MarinaDB(":memory:");
    const release = attachDbSpendLedger(db);
    const env = {
      MARINA_DAILY_SPEND_CAP_USD: "10",
      MARINA_SPEND_SCOPE: "futurex-live",
      MARINA_SPEND_SCOPE_CAP_USD: "100",
    };
    try {
      recordSpend("model_api", 9); // the server, unscoped
      expect(dailyCapRefusal(env)).toBeUndefined();
      recordSpend("forecast", 1, Date.now(), env);
      const refusal = dailyCapRefusal(env);
      expect(refusal).toContain("daily spend cap reached");
      expect(refusal).not.toContain("scope");
      expect(dailyBudget(env)).toMatchObject({ label: "daily", spentUsd: 10, capUsd: 10 });
    } finally {
      release();
      db.close();
    }
  });

  it("junk never lifts a scope cap; 0/off uncaps; an invalid name refuses everything", () => {
    expect(spendScopeCapUsd({})).toBe(DEFAULT_SPEND_SCOPE_CAP_USD);
    expect(spendScopeCapUsd({ MARINA_SPEND_SCOPE_CAP_USD: "lots" })).toBe(50);
    expect(spendScopeCapUsd({ MARINA_SPEND_SCOPE_CAP_USD: "-3" })).toBe(50);
    expect(spendScopeCapUsd({ MARINA_SPEND_SCOPE_CAP_USD: "0" })).toBeUndefined();
    expect(spendScopeCapUsd({ MARINA_SPEND_SCOPE_CAP_USD: "off" })).toBeUndefined();
    expect(spendScopeCapUsd({ MARINA_SPEND_SCOPE_CAP_USD: "12.5" })).toBe(12.5);
    expect(spendScope({ MARINA_SPEND_SCOPE: " FutureX-Live " })).toEqual({
      valid: true,
      name: "futurex-live",
    });
    expect(spendScope({ MARINA_SPEND_SCOPE: "  " })).toBeUndefined();
    const bad = { MARINA_SPEND_SCOPE: "a b; drop" };
    expect(spendScope(bad)).toEqual({ valid: false, raw: "a b; drop" });
    expect(dailyCapRefusal(bad)).toContain("not a valid scope name");
    expect(dailyBudget(bad)).toMatchObject({ capUsd: 0 });
    // An uncapped scope leaves only the world's cap.
    const uncapped = { MARINA_SPEND_SCOPE: "x", MARINA_SPEND_SCOPE_CAP_USD: "off" };
    recordSpend("forecast", 60, Date.now(), uncapped);
    expect(dailyCapRefusal({ ...uncapped, MARINA_DAILY_SPEND_CAP_USD: "off" })).toBeUndefined();
    expect(dailyCapRefusal(uncapped)).toContain("daily spend cap reached");
  });

  it("dailyBudget reports whichever cap has less headroom", () => {
    const env = {
      MARINA_DAILY_SPEND_CAP_USD: "50",
      MARINA_SPEND_SCOPE: "job",
      MARINA_SPEND_SCOPE_CAP_USD: "8",
    };
    recordSpend("forecast", 3, Date.now(), env);
    expect(dailyBudget(env)).toEqual({ spentUsd: 3, capUsd: 8, label: "scope job" });
    expect(dailyBudget({ MARINA_DAILY_SPEND_CAP_USD: "off" })).toBeUndefined();
  });
});

describe("command-line attachment", () => {
  it("without DB_PATH counts in memory and warns once", () => {
    const lines: string[] = [];
    const close = attachCliSpendLedger("bun run forecast", { env: {}, warn: (l) => lines.push(l) });
    attachCliSpendLedger("bun run forecast", { env: {}, warn: (l) => lines.push(l) });
    close();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("counted per process");
    recordSpend("forecast", 2);
    expect(spentTodayUsd()).toBe(2);
  });

  it("with DB_PATH records into the world database and closes cleanly", () => {
    worldDb();
    const lines: string[] = [];
    const close = attachCliSpendLedger("bun run futurex run", {
      env: { DB_PATH: dbPath },
      warn: (l) => lines.push(l),
    });
    recordSpend("forecast", 4, Date.now(), { MARINA_SPEND_SCOPE: "futurex-live" });
    close();
    close();
    expect(lines).toEqual([]);
    const db = new MarinaDB(dbPath);
    try {
      expect(persistedTotal(db).usd).toBe(4);
      expect(scopeSpendToday(db)).toEqual([{ scope: "futurex-live", spentUsd: 4 }]);
    } finally {
      db.close();
    }
  });
});

describe("visibility", () => {
  it("readiness lists today's scopes and this process's scope budget", async () => {
    const db = new MarinaDB(":memory:");
    const engine = new Engine({ db });
    const prior = {
      scope: process.env.MARINA_SPEND_SCOPE,
      cap: process.env.MARINA_SPEND_SCOPE_CAP_USD,
    };
    process.env.MARINA_SPEND_SCOPE = "backtest";
    process.env.MARINA_SPEND_SCOPE_CAP_USD = "2";
    try {
      db.addDailySpend(utcDay(), "forecast", 1.5, "futurex-live");
      recordSpend("forecast", 2);
      const check = computeReadiness(engine).checks.find((c) => c.id === "spend-scopes");
      expect(check?.status).toBe("off");
      expect(check?.detail).toContain("this process: backtest $2.00 of $2.00");
      expect(check?.detail).toContain("futurex-live $1.50");
      expect(check?.remediation).toContain("MARINA_SPEND_SCOPE_CAP_USD");
    } finally {
      if (prior.scope === undefined) delete process.env.MARINA_SPEND_SCOPE;
      else process.env.MARINA_SPEND_SCOPE = prior.scope;
      if (prior.cap === undefined) delete process.env.MARINA_SPEND_SCOPE_CAP_USD;
      else process.env.MARINA_SPEND_SCOPE_CAP_USD = prior.cap;
      await engine.shutdown();
      db.close();
    }
  });
});
