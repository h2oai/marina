// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

/**
 * Durable admission control shared by processes using the same file. Reserve
 * the maximum possible cost BEFORE sending a request, then settle its usage.
 * Callers must bound input, output, tools and prices; this ledger cannot infer
 * a provider's maximum bill. Unknown/crashed calls retain their reservation.
 * Use a dedicated ledger file per run (caps cannot change on resume).
 */
export class ReservedBudget {
  private db: Database;

  constructor(
    path: string,
    readonly capUsd: number,
  ) {
    if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error("Invalid budget cap");
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY, cap REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, scope TEXT NOT NULL,
        reserve REAL NOT NULL, charged REAL, state TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS scopes (name TEXT PRIMARY KEY, cap REAL NOT NULL);`);
    this.db.query("INSERT OR IGNORE INTO budget VALUES (1, ?)").run(capUsd);
    const saved = this.db.query("SELECT cap FROM budget WHERE id=1").get() as { cap: number };
    if (saved.cap !== capUsd) {
      this.db.close();
      throw new Error("Cannot change an existing run's budget");
    }
  }

  addScope(name: string, cap: number): void {
    if (!name || !Number.isFinite(cap) || cap <= 0) throw new Error("Invalid scope");
    this.db.query("INSERT OR IGNORE INTO scopes VALUES (?, ?)").run(name, cap);
    const saved = this.db.query("SELECT cap FROM scopes WHERE name=?").get(name) as { cap: number };
    if (saved.cap !== cap) throw new Error("Cannot change an existing scope's budget");
  }

  reserve(scope: string, usd: number): string {
    if (!Number.isFinite(usd) || usd <= 0) throw new Error("Invalid reservation");
    return this.db
      .transaction(() => {
        const local = this.db.query("SELECT cap FROM scopes WHERE name=?").get(scope) as {
          cap: number;
        } | null;
        if (!local) throw new Error("Unknown budget scope");
        if (this.total() + usd > this.capUsd || this.total(scope) + usd > local.cap)
          throw new Error("Budget exhausted before request admission");
        const id = randomUUID();
        this.db
          .query("INSERT INTO calls VALUES (?, ?, ?, NULL, 'reserved', ?)")
          .run(id, scope, usd, Date.now());
        return id;
      })
      .immediate();
  }

  /** Undefined usage is uncertain: keep the reservation, never silently charge zero. */
  settle(id: string, usd?: number): void {
    this.db
      .transaction(() => {
        const call = this.db.query("SELECT reserve, state FROM calls WHERE id=?").get(id) as {
          reserve: number;
          state: string;
        } | null;
        if (call?.state !== "reserved") throw new Error("Unknown or settled reservation");
        if (usd !== undefined && (!Number.isFinite(usd) || usd < 0 || usd > call.reserve))
          throw new Error("Usage outside reserved bound; reservation retained");
        this.db
          .query("UPDATE calls SET charged=?, state=? WHERE id=?")
          .run(usd ?? null, usd === undefined ? "uncertain" : "settled", id);
      })
      .immediate();
  }

  total(scope?: string): number {
    const row = (
      scope === undefined
        ? this.db.query("SELECT COALESCE(SUM(COALESCE(charged,reserve)),0) AS n FROM calls").get()
        : this.db
            .query(
              "SELECT COALESCE(SUM(COALESCE(charged,reserve)),0) AS n FROM calls WHERE scope=?",
            )
            .get(scope)
    ) as { n: number };
    return row.n;
  }

  report(): unknown[] {
    return this.db.query("SELECT * FROM calls ORDER BY created, id").all();
  }

  close(): void {
    this.db.close();
  }
}
