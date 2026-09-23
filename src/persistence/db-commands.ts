// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

// ─── Dynamic commands ──────────────────────────────────────────────────────

export function saveCommandSource(
  db: Database,
  opts: { id: string; name: string; source: string; createdBy: string },
): void {
  const existing = getCommandByName(db, opts.name);
  if (existing) {
    // Save history before updating
    db.run(
      "INSERT INTO dynamic_command_history (command_id, source, version, edited_by, edited_at) VALUES (?, ?, ?, ?, ?)",
      [existing.id, existing.source, existing.version, opts.createdBy, Date.now()],
    );
    db.run(
      "UPDATE dynamic_commands SET source = ?, version = version + 1, valid = 0 WHERE id = ?",
      [opts.source, existing.id],
    );
  } else {
    db.run(
      "INSERT INTO dynamic_commands (id, name, source, version, valid, created_by, created_at) VALUES (?, ?, ?, 1, 0, ?, ?)",
      [opts.id, opts.name, opts.source, opts.createdBy, Date.now()],
    );
  }
}

export function getCommand(db: Database, id: string): CommandSourceRow | undefined {
  return (
    (db.query("SELECT * FROM dynamic_commands WHERE id = ?").get(id) as CommandSourceRow | null) ??
    undefined
  );
}

export function getCommandByName(db: Database, name: string): CommandSourceRow | undefined {
  return (
    (db
      .query("SELECT * FROM dynamic_commands WHERE name = ?")
      .get(name) as CommandSourceRow | null) ?? undefined
  );
}

export function listCommands(db: Database): CommandSourceRow[] {
  return db.query("SELECT * FROM dynamic_commands ORDER BY name").all() as CommandSourceRow[];
}

export function markCommandValid(db: Database, name: string): void {
  db.run("UPDATE dynamic_commands SET valid = 1 WHERE name = ?", [name]);
}

export function deleteCommand(db: Database, name: string): void {
  const cmd = getCommandByName(db, name);
  if (cmd) {
    db.run("DELETE FROM dynamic_command_history WHERE command_id = ?", [cmd.id]);
    db.run("DELETE FROM dynamic_commands WHERE id = ?", [cmd.id]);
  }
}

export function getCommandHistory(db: Database, name: string, limit = 20): CommandHistoryRow[] {
  const cmd = getCommandByName(db, name);
  if (!cmd) return [];
  return db
    .query(
      "SELECT * FROM dynamic_command_history WHERE command_id = ? ORDER BY version DESC LIMIT ?",
    )
    .all(cmd.id, limit) as CommandHistoryRow[];
}

export function getAllValidCommandNames(db: Database): string[] {
  return (
    db.query("SELECT name FROM dynamic_commands WHERE valid = 1").all() as { name: string }[]
  ).map((r) => r.name);
}

export function clearDynamicCommands(db: Database): void {
  db.run("DELETE FROM dynamic_command_history");
  db.run("DELETE FROM dynamic_commands");
}

// ─── Row types ────────────────────────────────────────────────────────────

export interface CommandSourceRow {
  id: string;
  name: string;
  source: string;
  version: number;
  valid: number;
  created_by: string;
  created_at: number;
}

export interface CommandHistoryRow {
  id: number;
  command_id: string;
  source: string;
  version: number;
  edited_by: string;
  edited_at: number;
}
