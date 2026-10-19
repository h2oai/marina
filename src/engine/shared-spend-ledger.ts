// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A daily spend ledger shared by several Marina processes (`MARINA_SPEND_LEDGER=<path>`).
 *
 * An embedding host can run one Marina process per world, each on its own
 * world database. Without this file each world keeps its own `spend_daily`
 * total, so N worlds get N caps. With it, every process that names the same
 * file records into it and checks `MARINA_DAILY_SPEND_CAP_USD` (and any
 * `MARINA_SPEND_SCOPE` cap) against its one UTC-day total.
 *
 * The file is a small SQLite database with its own schema (two tables shaped
 * like the world ledger's `spend_daily` / `spend_scope_daily`, keyed the same
 * way by UTC day, scope and source). It is not a world database and takes no
 * world migrations. The source column has no CHECK, so processes running
 * different Marina versions can share it.
 *
 * Concurrency: WAL journal, a 5 s busy timeout, and each record is upserts
 * (`cost_usd = cost_usd + excluded.cost_usd`) in ONE `BEGIN IMMEDIATE`
 * transaction, so concurrent writers serialize and no increment is lost.
 */

import { Database } from "bun:sqlite";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SpendSink, SpendSource } from "./spend-ledger";

/** Schema version stored in `PRAGMA user_version`; bump with an additive change only. */
const SHARED_LEDGER_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spend_daily (
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, source)
);
CREATE TABLE IF NOT EXISTS spend_scope_daily (
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  source TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, scope, source)
);
`;

/** `MARINA_SPEND_LEDGER` as an absolute path; undefined when unset or blank. */
export function sharedSpendLedgerPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.MARINA_SPEND_LEDGER?.trim();
  return raw ? resolve(raw) : undefined;
}

export interface SharedSpendLedger extends SpendSink {
  readonly path: string;
  /** Every scope's rows for the day (all sources). */
  scopeRowsFor(day: string): { scope: string; cost_usd: number }[];
  close(): void;
}

/**
 * Open (creating when missing) the shared ledger at `path`. A new file and a
 * new directory are private to the user (0600 / 0700). Throws when the file
 * cannot be opened — the caller asked for a shared cap and must not silently
 * fall back to a per-world one.
 */
export function openSharedSpendLedger(path: string): SharedSpendLedger {
  const file = resolve(path);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Create the file ourselves so it is born 0600 (SQLite gives its -wal and
  // -shm files the same mode); an existing file keeps its mode.
  closeSync(openSync(file, "a", 0o600));
  const db = new Database(file, { create: true });
  try {
    // busy_timeout first, so the WAL switch and the schema wait for another
    // process opening the same file instead of failing.
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=NORMAL");
    db.transaction(() => {
      db.exec(SCHEMA);
      const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
      if (user_version < SHARED_LEDGER_SCHEMA_VERSION) {
        db.exec(`PRAGMA user_version=${SHARED_LEDGER_SCHEMA_VERSION}`);
      }
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }

  const addGlobal = db.query(
    `INSERT INTO spend_daily (day, source, cost_usd, calls, updated_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(day, source) DO UPDATE SET
       cost_usd = cost_usd + excluded.cost_usd, calls = calls + 1, updated_at = excluded.updated_at`,
  );
  const addScope = db.query(
    `INSERT INTO spend_scope_daily (day, scope, source, cost_usd, calls, updated_at)
     VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(day, scope, source) DO UPDATE SET
       cost_usd = cost_usd + excluded.cost_usd, calls = calls + 1, updated_at = excluded.updated_at`,
  );
  const total = db.query("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM spend_daily WHERE day = ?");
  const scopeTotal = db.query(
    "SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM spend_scope_daily WHERE day = ? AND scope = ?",
  );
  const scopeRows = db.query(
    "SELECT scope, SUM(cost_usd) AS cost_usd FROM spend_scope_daily WHERE day = ? GROUP BY scope ORDER BY scope",
  );
  const record = db.transaction((day: string, source: SpendSource, usd: number, scope?: string) => {
    const now = Date.now();
    addGlobal.run(day, source, usd, now);
    if (scope) addScope.run(day, scope, source, usd, now);
  });

  let closed = false;
  return {
    path: file,
    add: (day, source, usd, scope) => {
      record.immediate(day, source, usd, scope);
    },
    totalFor: (day) => (total.get(day) as { usd: number }).usd,
    scopeTotalFor: (day, scope) => (scopeTotal.get(day, scope) as { usd: number }).usd,
    scopeRowsFor: (day) => scopeRows.all(day) as { scope: string; cost_usd: number }[],
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
