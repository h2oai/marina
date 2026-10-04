// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The daily spend ledger for a command-line process (`bun run futurex`,
 * `forecast`, `arena`, …). A CLI that spends opens its own connection to the
 * world database and attaches it for the life of the process, so its dollars
 * land in the same `spend_daily` rows the server and every other process on
 * that database read: an hourly timer or a backtest can no longer start each
 * run with a fresh $0 budget. `MARINA_SPEND_SCOPE` / `_CAP_USD` narrow it
 * further (src/engine/spend-ledger.ts).
 *
 * The connection is the ledger's own, independent of whatever databases the
 * command opens and closes along the way; it is released and closed on exit.
 * Without a database path the process counts in memory and warns once.
 */

import { MarinaDB } from "../persistence/database";
import { attachDbSpendLedger, warnInMemorySpend } from "./spend-ledger";

export interface CliSpendLedgerOptions {
  /** The world database. Default: `DB_PATH`; none ⇒ in-memory with a warning. */
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Where the one-line in-memory warning goes (default stderr). */
  warn?: (line: string) => void;
}

/**
 * Attach the world database's spend ledger for this process. Returns a close
 * function (idempotent; also run on process exit).
 */
export function attachCliSpendLedger(label: string, opts: CliSpendLedgerOptions = {}): () => void {
  const env = opts.env ?? process.env;
  const path = (opts.dbPath ?? env.DB_PATH)?.trim();
  if (!path || path === ":memory:") {
    warnInMemorySpend(label, opts.warn);
    return () => {};
  }
  const db = new MarinaDB(path);
  const release = attachDbSpendLedger(db);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    process.off("exit", close);
    release();
    db.close();
  };
  process.once("exit", close);
  return close;
}
