// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

// ─── Shell allowlist and audit log ─────────────────────────────────────────

export function getShellAllowlist(db: Database): string[] {
  const rows = db.query("SELECT binary FROM shell_allowlist ORDER BY binary").all() as {
    binary: string;
  }[];
  return rows.map((r) => r.binary);
}

export function isShellAllowed(db: Database, binary: string): boolean {
  const row = db.query("SELECT 1 FROM shell_allowlist WHERE binary = ?").get(binary);
  return row !== null;
}

export function addToShellAllowlist(db: Database, binary: string, addedBy: string): void {
  db.run("INSERT OR IGNORE INTO shell_allowlist (binary, added_by, added_at) VALUES (?, ?, ?)", [
    binary,
    addedBy,
    Date.now(),
  ]);
}

export function removeFromShellAllowlist(db: Database, binary: string): boolean {
  const result = db.run("DELETE FROM shell_allowlist WHERE binary = ?", [binary]);
  return result.changes > 0;
}

export function logShellExec(
  db: Database,
  entityId: string,
  binary: string,
  args: string,
  exitCode: number | null,
  outputLength: number,
): void {
  db.run(
    "INSERT INTO shell_log (entity_id, binary, args, exit_code, output_length, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [entityId, binary, args, exitCode, outputLength, Date.now()],
  );
}

export function getShellHistory(db: Database, entityId: string, limit = 10): ShellLogRow[] {
  return db
    .query("SELECT * FROM shell_log WHERE entity_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(entityId, limit) as ShellLogRow[];
}

export function getShellLog(db: Database, entityId: string | null, limit = 10): ShellLogRow[] {
  if (entityId) {
    return db
      .query("SELECT * FROM shell_log WHERE entity_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(entityId, limit) as ShellLogRow[];
  }
  return db
    .query("SELECT * FROM shell_log ORDER BY created_at DESC LIMIT ?")
    .all(limit) as ShellLogRow[];
}

/** Drop shell_log rows older than `keepMs`. Returns rows removed. Mirrors
 *  trimFeedEvents — bounds the gated-exec audit trail so it can't grow
 *  unbounded for the life of the DB. (idx_shell_log_created makes this cheap.) */
export function trimShellLog(db: Database, keepMs: number): number {
  const cutoff = Date.now() - keepMs;
  const res = db.run("DELETE FROM shell_log WHERE created_at < ?", [cutoff]);
  return res.changes;
}

// ─── Row types ────────────────────────────────────────────────────────────

export interface ShellLogRow {
  id: number;
  entity_id: string;
  binary: string;
  args: string;
  exit_code: number | null;
  output_length: number;
  created_at: number;
}
