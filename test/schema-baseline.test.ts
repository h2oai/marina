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
  SCHEMA_VERSION,
} from "../src/persistence/schema";
import { MIGRATIONS as HISTORY } from "../src/persistence/schema-history";
import { migrateEmptyTo } from "./schema-replay";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Values a migration writes per installation, normalized before comparing rows. */
function normalizeInstallValues(table: string, rows: Record<string, unknown>[], since: number) {
  for (const row of rows) {
    if (table === "shell_allowlist") {
      expect(Number(row.added_at)).toBeGreaterThanOrEqual(since);
      expect(Number(row.added_at)).toBeLessThanOrEqual(Date.now());
      row.added_at = "installation time";
    }
    if (table === "investigation_instance") {
      expect(String(row.uuid)).toMatch(/^[0-9a-f]{32}$/);
      row.uuid = "per-installation id";
    }
  }
  return rows;
}

/** Every fact the comparison covers: schema objects verbatim, column/index/FK
 * pragmas, every table's rows (FTS shadow tables included), integrity checks. */
function snapshot(db: Database, since: number) {
  const objects = db
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  const tables = (db.query("PRAGMA table_list").all() as { name: string; type: string }[])
    .filter((t) => t.type !== "view" && !t.name.startsWith("sqlite_"))
    .map((t) => ({ name: t.name, type: t.type }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const pragmas: Record<string, unknown> = {};
  const rows: Record<string, unknown> = {};
  for (const { name, type } of tables) {
    const indexes = db.query(`PRAGMA index_list(${quote(name)})`).all() as {
      seq: number;
      name: string;
    }[];
    pragmas[name] = {
      columns: db.query(`PRAGMA table_xinfo(${quote(name)})`).all(),
      foreignKeys: db.query(`PRAGMA foreign_key_list(${quote(name)})`).all(),
      // Automatic index names and list order encode creation order; compare content.
      indexes: indexes
        .map(({ seq: _seq, ...index }) => ({
          ...index,
          name: index.name.startsWith("sqlite_autoindex_") ? "(automatic)" : index.name,
          columns: db.query(`PRAGMA index_xinfo(${quote(index.name)})`).all(),
        }))
        .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
    };
    // A virtual table's rows are its content table's; the version marker differs by path.
    if (type === "virtual" || name === "schema_version") continue;
    // An empty FTS5 index's averages record depends on whether a migration
    // ran 'rebuild'; integrity-check below proves each index matches its content.
    if (type === "shadow" && name.endsWith("_data")) continue;
    rows[name] = normalizeInstallValues(
      name,
      db.query(`SELECT * FROM ${quote(name)} ORDER BY 1`).all() as Record<string, unknown>[],
      since,
    );
  }
  for (const fts of objects.filter((o) => o.type === "table" && /USING\s+fts5/i.test(o.sql ?? "")))
    db.run(`INSERT INTO ${quote(fts.name)}(${quote(fts.name)}) VALUES ('integrity-check')`);
  expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  return { objects, tables, pragmas, rows };
}

test("migration history splits exactly at the baseline and keeps every data conversion", () => {
  expect(HISTORY.at(-1)?.version).toBe(SCHEMA_BASELINE_VERSION);
  expect(FORWARD_MIGRATIONS[0]?.version ?? SCHEMA_BASELINE_VERSION + 1).toBe(
    SCHEMA_BASELINE_VERSION + 1,
  );
  expect(MIGRATIONS.map((m) => m.version)).toEqual(
    Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1),
  );
  // The folded conversions still run when an existing database upgrades through them.
  expect(
    MIGRATIONS.filter((m) => m.apply && m.version <= SCHEMA_BASELINE_VERSION).map((m) => m.version),
  ).toEqual([138, 143]);
});

test("consolidated baseline has exactly the historical schema and seeded defaults", () => {
  const baseline = new Database(":memory:");
  const history = new Database(":memory:");
  const started = Math.floor(Date.now() / 1000) * 1000;
  try {
    baseline.exec("PRAGMA foreign_keys=ON");
    baseline.transaction(() => baseline.exec(SCHEMA_BASELINE))();
    history.exec("PRAGMA foreign_keys=ON");
    migrateEmptyTo(history, SCHEMA_BASELINE_VERSION);
    // Migration 138's conversion drops the historical outbox: the baseline must
    // reflect hooks, not only SQL.
    expect(
      baseline.query("SELECT name FROM sqlite_schema WHERE name='legacy_memory_outbox'").get(),
    ).toBeNull();
    expect(snapshot(baseline, started)).toEqual(snapshot(history, started));
    expect(baseline.query("SELECT version FROM schema_version").all()).toEqual([
      { version: SCHEMA_BASELINE_VERSION },
    ]);
  } finally {
    baseline.close();
    history.close();
  }
});

test("a fresh install equals an empty database migrated one version at a time from 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-schema-stepwise-"));
  const started = Math.floor(Date.now() / 1000) * 1000;
  const stepwise = new Database(":memory:");
  try {
    new MarinaDB(join(dir, "fresh.db")).close();
    // The upgrade path MarinaDB.runMigrations takes, one transaction per version.
    stepwise.exec("PRAGMA foreign_keys=ON");
    stepwise.exec(BASE_SCHEMA);
    for (const migration of MIGRATIONS)
      stepwise.transaction(() => {
        stepwise.exec(migration.sql);
        migration.apply?.(stepwise);
        stepwise.run("INSERT OR REPLACE INTO schema_version (version) VALUES (?)", [
          migration.version,
        ]);
      })();
    const fresh = new Database(join(dir, "fresh.db"));
    try {
      expect(snapshot(fresh, started)).toEqual(snapshot(stepwise, started));
      // Fresh databases record the baseline marker, then each forward version.
      expect(fresh.query("SELECT version FROM schema_version ORDER BY version").all()).toEqual([
        { version: SCHEMA_BASELINE_VERSION },
        ...FORWARD_MIGRATIONS.map(({ version }) => ({ version })),
      ]);
    } finally {
      fresh.close();
    }
  } finally {
    stepwise.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("per-installation values are generated at install time, never baked into the baseline", () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-schema-install-"));
  try {
    const ids = ["a.db", "b.db"].map((file) => {
      new MarinaDB(join(dir, file)).close();
      const db = new Database(join(dir, file), { readonly: true });
      try {
        return (db.query("SELECT uuid FROM investigation_instance").get() as { uuid: string }).uuid;
      } finally {
        db.close();
      }
    });
    expect(ids[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(ids[0]).not.toBe(ids[1]);
    expect(SCHEMA_BASELINE).not.toContain(ids[0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
