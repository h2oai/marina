// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared spend ledger (`MARINA_SPEND_LEDGER`, SRV-9): several processes,
 * each on its own world database, record into one ledger file and share one
 * daily total and one cap; concurrent writers never lose an increment; scopes
 * still narrow; and with the variable unset nothing changes.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachCliSpendLedger } from "../src/engine/cli-spend-ledger";
import { openSharedSpendLedger, sharedSpendLedgerPath } from "../src/engine/shared-spend-ledger";
import {
  activeSharedSpendLedger,
  attachDbSpendLedger,
  attachWorldSpendLedger,
  childSpendEnv,
  dailyCapRefusal,
  recordSpend,
  resetSpendLedgerForTests,
  scopeSpendToday,
  spentTodayInScopeUsd,
  spentTodayUsd,
  utcDay,
} from "../src/engine/spend-ledger";
import { MarinaDB } from "../src/persistence/database";
import { scopeProcessState } from "./process-state";

const LEDGER = join(import.meta.dir, "../src/engine/spend-ledger.ts");
const CLI_LEDGER = join(import.meta.dir, "../src/engine/cli-spend-ledger.ts");

let dir = "";

function worldDb(name: string): string {
  const path = join(dir, `${name}.db`);
  new MarinaDB(path).close();
  return path;
}

function worldTotal(path: string): number {
  const db = new MarinaDB(path);
  try {
    return db.getDailySpend(utcDay()).reduce((s, r) => s + r.cost_usd, 0);
  } finally {
    db.close();
  }
}

/** One "process": attach world + shared ledger, run `fn`, detach. */
function asProcess<T>(worldPath: string, env: NodeJS.ProcessEnv, fn: () => T): T {
  resetSpendLedgerForTests();
  const db = new MarinaDB(worldPath);
  const release = attachDbSpendLedger(db, env);
  try {
    return fn();
  } finally {
    release();
    db.close();
  }
}

beforeEach(() => {
  resetSpendLedgerForTests();
  dir = mkdtempSync(join(tmpdir(), "marina-shared-spend-"));
});
afterEach(() => {
  resetSpendLedgerForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("shared spend ledger (MARINA_SPEND_LEDGER)", () => {
  it("two worlds on one ledger share one total and one cap, and each world keeps its own rows", () => {
    const ledger = join(dir, "nested", "ledger", "spend.db");
    const env = { MARINA_SPEND_LEDGER: ledger, MARINA_DAILY_SPEND_CAP_USD: "40" };
    const a = worldDb("a");
    const b = worldDb("b");

    asProcess(a, env, () => {
      expect(activeSharedSpendLedger()).toBe(ledger);
      recordSpend("model_api", 30, Date.now(), env);
      expect(dailyCapRefusal(env)).toBeUndefined();
    });
    // Directory created; file private to the user.
    expect(statSync(ledger).mode & 0o777).toBe(0o600);

    asProcess(b, env, () => {
      expect(spentTodayUsd()).toBe(30); // world b's own DB has $0, the shared total is $30
      recordSpend("forecast", 15, Date.now(), env);
      expect(spentTodayUsd()).toBe(45);
      expect(dailyCapRefusal(env)).toContain("daily spend cap reached ($45.00 today ≥ $40.00");
    });
    // World a is refused too, though its own spend is under the cap.
    asProcess(a, env, () => {
      expect(dailyCapRefusal(env)).toContain("daily spend cap reached");
    });

    // In addition, not instead: each world database still holds its own spend.
    expect(worldTotal(a)).toBe(30);
    expect(worldTotal(b)).toBe(15);
  });

  it("separate handles on the same file see each other's records immediately", () => {
    const path = join(dir, "spend.db");
    const one = openSharedSpendLedger(path);
    const two = openSharedSpendLedger(path);
    try {
      const day = utcDay();
      one.add(day, "model_api", 1.5);
      two.add(day, "agent", 2.5, "jobs");
      one.add(day, "model_api", 1, "jobs");
      expect(one.totalFor(day)).toBe(5);
      expect(two.totalFor(day)).toBe(5);
      expect(one.scopeTotalFor?.(day, "jobs")).toBe(3.5);
      expect(two.scopeRowsFor(day)).toEqual([{ scope: "jobs", cost_usd: 3.5 }]);
      expect(two.totalFor("2000-01-01")).toBe(0);
    } finally {
      one.close();
      two.close();
    }
  });

  it("scopes still narrow the shared cap, and readouts show the shared scopes", () => {
    const ledger = join(dir, "spend.db");
    const live = {
      MARINA_SPEND_LEDGER: ledger,
      MARINA_DAILY_SPEND_CAP_USD: "100",
      MARINA_SPEND_SCOPE: "live",
      MARINA_SPEND_SCOPE_CAP_USD: "10",
    };
    const plain = { MARINA_SPEND_LEDGER: ledger, MARINA_DAILY_SPEND_CAP_USD: "100" };
    const a = worldDb("a");
    const b = worldDb("b");

    asProcess(a, live, () => recordSpend("forecast", 6, Date.now(), live));
    asProcess(b, live, () => {
      expect(spentTodayInScopeUsd("live")).toBe(6);
      recordSpend("forecast", 4, Date.now(), live);
      expect(dailyCapRefusal(live)).toContain("scope live");
      expect(dailyCapRefusal(plain)).toBeUndefined(); // unscoped work still has budget
    });
    // World a's database never saw world b's scoped spend, but the readout
    // (what the cap is checked against) is the shared one.
    const db = new MarinaDB(a);
    const release = attachDbSpendLedger(db, plain);
    try {
      expect(scopeSpendToday(db)).toEqual([{ scope: "live", spentUsd: 10 }]);
      expect(db.getScopeDailySpend(utcDay(), "live")[0]?.cost_usd).toBe(6);
    } finally {
      release();
      db.close();
    }
  });

  it("concurrent writer processes on different worlds sum exactly", async () => {
    const ledger = join(dir, "spend.db");
    const spawnWriter = (env: Record<string, string>) => {
      const code = `
        const { attachCliSpendLedger } = await import(${JSON.stringify(CLI_LEDGER)});
        const { recordSpend } = await import(${JSON.stringify(LEDGER)});
        const close = attachCliSpendLedger("test writer");
        for (let i = 0; i < 120; i++) recordSpend("forecast", 0.25);
        close();
      `;
      const { DB_PATH: _db, MARINA_SPEND_SCOPE: _scope, ...base } = process.env;
      return Bun.spawn([process.execPath, "-e", code], {
        env: { ...base, MARINA_SPEND_LEDGER: ledger, MARINA_DAILY_SPEND_CAP_USD: "0", ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
    };
    const procs = [
      spawnWriter({ DB_PATH: worldDb("a") }),
      spawnWriter({ DB_PATH: worldDb("b"), MARINA_SPEND_SCOPE: "batch" }),
      spawnWriter({}), // no world database: the shared file alone
    ];
    for (const proc of procs) {
      const exit = await proc.exited;
      if (exit !== 0) throw new Error(await new Response(proc.stderr).text());
    }
    const shared = openSharedSpendLedger(ledger);
    try {
      expect(shared.totalFor(utcDay())).toBe(90);
      expect(shared.scopeTotalFor?.(utcDay(), "batch")).toBe(30);
    } finally {
      shared.close();
    }
    expect(worldTotal(join(dir, "a.db"))).toBe(30);
    expect(worldTotal(join(dir, "b.db"))).toBe(30);
  });

  it("a CLI without DB_PATH attaches the shared ledger instead of warning", () => {
    const ledger = join(dir, "spend.db");
    const lines: string[] = [];
    const close = attachCliSpendLedger("bun run forecast", {
      env: { MARINA_SPEND_LEDGER: ledger },
      warn: (line) => lines.push(line),
    });
    try {
      expect(lines).toEqual([]);
      expect(activeSharedSpendLedger()).toBe(ledger);
      recordSpend("forecast", 2);
    } finally {
      close();
    }
    const shared = openSharedSpendLedger(ledger);
    try {
      expect(shared.totalFor(utcDay())).toBe(2);
    } finally {
      shared.close();
    }
  });

  it("an unusable path fails closed instead of falling back to a per-world cap", () => {
    const blocked = join(dir, "is-a-directory");
    mkdirSync(blocked);
    const db = new MarinaDB(worldDb("a"));
    try {
      expect(() => attachWorldSpendLedger(db, { env: { MARINA_SPEND_LEDGER: blocked } })).toThrow();
      expect(activeSharedSpendLedger()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("unset: today's per-world behaviour, no file, process.env honoured", () => {
    using _state = scopeProcessState({ env: { MARINA_SPEND_LEDGER: undefined } });
    expect(sharedSpendLedgerPath()).toBeUndefined();
    const a = worldDb("a");
    const db = new MarinaDB(a);
    const release = attachDbSpendLedger(db);
    try {
      expect(activeSharedSpendLedger()).toBeUndefined();
      recordSpend("model_api", 3);
      expect(spentTodayUsd()).toBe(3);
      expect(worldTotal(a)).toBe(3);
    } finally {
      release();
      db.close();
    }
    expect(childSpendEnv("kid", {})).toEqual({ MARINA_DAILY_SPEND_CAP_USD: "50" });
  });

  it("process.env MARINA_SPEND_LEDGER is picked up by the default attach", () => {
    const ledger = join(dir, "env", "spend.db");
    using _state = scopeProcessState({ env: { MARINA_SPEND_LEDGER: ledger } });
    expect(sharedSpendLedgerPath()).toBe(ledger);
    const db = new MarinaDB(worldDb("a"));
    const release = attachDbSpendLedger(db);
    try {
      expect(activeSharedSpendLedger()).toBe(ledger);
    } finally {
      release();
      db.close();
    }
    expect(existsSync(ledger)).toBe(true);
  });
});

describe("child worlds under a shared ledger", () => {
  const ledger = "/srv/marina/spend.db";

  it("keep the parent's cap as the shared total and get their own budget as a scope", () => {
    expect(
      childSpendEnv("Research Lab", {
        MARINA_SPEND_LEDGER: ledger,
        MARINA_DAILY_SPEND_CAP_USD: "100",
        MARINA_CHILD_DAILY_SPEND_CAP_USD: "20",
      }),
    ).toEqual({
      MARINA_SPEND_LEDGER: ledger,
      MARINA_DAILY_SPEND_CAP_USD: "100",
      MARINA_SPEND_SCOPE: "child:research-lab",
      MARINA_SPEND_SCOPE_CAP_USD: "20",
    });
    // The child's own budget is still min(child cap, parent cap).
    expect(
      childSpendEnv("kid", { MARINA_SPEND_LEDGER: ledger, MARINA_DAILY_SPEND_CAP_USD: "30" }),
    ).toMatchObject({ MARINA_DAILY_SPEND_CAP_USD: "30", MARINA_SPEND_SCOPE_CAP_USD: "30" });
    expect(
      childSpendEnv("kid", { MARINA_SPEND_LEDGER: ledger, MARINA_DAILY_SPEND_CAP_USD: "off" }),
    ).toMatchObject({ MARINA_DAILY_SPEND_CAP_USD: "off", MARINA_SPEND_SCOPE_CAP_USD: "50" });
  });

  it("a scoped parent passes its scope down with the cap lowered to the child's", () => {
    expect(
      childSpendEnv("kid", {
        MARINA_SPEND_LEDGER: ledger,
        MARINA_SPEND_SCOPE: "Flow",
        MARINA_SPEND_SCOPE_CAP_USD: "8",
      }),
    ).toEqual({
      MARINA_SPEND_LEDGER: ledger,
      MARINA_DAILY_SPEND_CAP_USD: "50",
      MARINA_SPEND_SCOPE: "flow",
      MARINA_SPEND_SCOPE_CAP_USD: "8",
    });
  });

  it("a name that cannot be a scope applies the child cap to the shared total", () => {
    expect(
      childSpendEnv("!!!", {
        MARINA_SPEND_LEDGER: ledger,
        MARINA_DAILY_SPEND_CAP_USD: "100",
        MARINA_CHILD_DAILY_SPEND_CAP_USD: "5",
      }),
    ).toEqual({ MARINA_SPEND_LEDGER: ledger, MARINA_DAILY_SPEND_CAP_USD: "5" });
  });
});
