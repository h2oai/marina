// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";
import { liveEntityIdSql } from "./db-entities";

// ─── Macros ────────────────────────────────────────────────────────────────

// `macros.author_id` is durable-keyed (migration 119); project the live id back on read.
const MACRO_COLUMNS = `m.*, ${liveEntityIdSql("m", "author_id")} AS author_id`;

export function createMacro(
  db: Database,
  entityKey: string,
  name: string,
  command: string,
): number {
  const now = Date.now();
  const result = db.run(
    "INSERT INTO macros (name, author_id, command, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [name, entityKey, command, now, now],
  );
  return Number(result.lastInsertRowid);
}

export function getMacro(db: Database, id: number): MacroRow | undefined {
  return (
    (db.query(`SELECT ${MACRO_COLUMNS} FROM macros m WHERE m.id = ?`).get(id) as MacroRow | null) ??
    undefined
  );
}

export function getMacroByName(
  db: Database,
  entityKey: string,
  name: string,
): MacroRow | undefined {
  return (
    (db
      .query(`SELECT ${MACRO_COLUMNS} FROM macros m WHERE m.name = ? AND m.author_id = ?`)
      .get(name, entityKey) as MacroRow | null) ?? undefined
  );
}

/** `authorKey` is the caller's durable key (resolved by the facade), or undefined for all macros. */
export function listMacros(db: Database, authorKey?: string): MacroRow[] {
  if (authorKey) {
    return db
      .query(`SELECT ${MACRO_COLUMNS} FROM macros m WHERE m.author_id = ? ORDER BY m.name`)
      .all(authorKey) as MacroRow[];
  }
  return db.query(`SELECT ${MACRO_COLUMNS} FROM macros m ORDER BY m.name`).all() as MacroRow[];
}

export function updateMacro(db: Database, id: number, command: string): void {
  db.run("UPDATE macros SET command = ?, updated_at = ? WHERE id = ?", [command, Date.now(), id]);
}

export function deleteMacro(db: Database, id: number): void {
  db.run("DELETE FROM macros WHERE id = ?", [id]);
}

// ─── Row types ────────────────────────────────────────────────────────────

export interface MacroRow {
  id: number;
  name: string;
  author_id: string;
  command: string;
  created_at: number;
  updated_at: number;
}
