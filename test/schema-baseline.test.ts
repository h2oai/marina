// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarinaDB } from "../src/persistence/database";
import {
  BASE_SCHEMA,
  FORWARD_MIGRATIONS,
  MIGRATIONS,
  SCHEMA_BASELINE,
  SCHEMA_BASELINE_VERSION,
} from "../src/persistence/schema";

test("consolidated baseline has exactly the historical schema and seeded defaults", () => {
  const baseline = new Database(":memory:");
  const history = new Database(":memory:");
  const started = Math.floor(Date.now() / 1000) * 1000;
  try {
    baseline.exec("PRAGMA foreign_keys=ON");
    baseline.transaction(() => baseline.exec(SCHEMA_BASELINE))();
    history.exec(BASE_SCHEMA);
    for (const migration of MIGRATIONS.filter((m) => m.version <= SCHEMA_BASELINE_VERSION))
      history.exec(migration.sql);
    const schema =
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name";
    expect(baseline.query(schema).all()).toEqual(history.query(schema).all());
    const tables = history.query("PRAGMA table_list").all() as { name: string; type: string }[];
    for (const table of tables.filter(
      (t) => t.type === "table" && t.name !== "schema_version" && !t.name.startsWith("sqlite_"),
    )) {
      const query = `SELECT * FROM "${table.name.replaceAll('"', '""')}"`;
      const actual = baseline.query(query).all() as Record<string, unknown>[];
      const expected = history.query(query).all() as Record<string, unknown>[];
      if (table.name === "shell_allowlist") {
        for (const row of [...actual, ...expected]) {
          expect(Number(row.added_at)).toBeGreaterThanOrEqual(started);
          expect(Number(row.added_at)).toBeLessThanOrEqual(Date.now());
          row.added_at = "installation time";
        }
      }
      expect(actual).toEqual(expected);
    }
    expect(baseline.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(baseline.query("SELECT version FROM schema_version").all()).toEqual([
      { version: SCHEMA_BASELINE_VERSION },
    ]);
  } finally {
    baseline.close();
    history.close();
  }
});

test("fresh baseline and subsequent reopen preserve FTS, note IDs and compatibility triggers", () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-schema-baseline-"));
  const path = join(dir, "world.db");
  try {
    const fresh = new MarinaDB(path);
    let id: number;
    try {
      expect(
        fresh.memoryRepository().raw.query("SELECT version FROM schema_version").all(),
      ).toEqual([
        { version: SCHEMA_BASELINE_VERSION },
        ...FORWARD_MIGRATIONS.map(({ version }) => ({ version })),
      ]);
      fresh.createUser({ id: "alice-account", name: "Alice" });
      id = fresh.createNote("Alice", "baseline searchable evidence");
      expect(fresh.searchNotes("Alice", "searchable").map((note) => note.id)).toContain(id);
      expect(
        fresh.memoryRepository().raw.query("SELECT count(*) n FROM memory_note_projections").get(),
      ).toEqual({ n: 1 });
    } finally {
      fresh.close();
    }
    const reopened = new MarinaDB(path);
    try {
      expect(reopened.getNote(id)?.content).toBe("baseline searchable evidence");
      expect(reopened.deleteNote(id, "Alice")).toBe(true);
      expect(reopened.searchNotes("Alice", "searchable")).toEqual([]);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
