// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Every released version's REAL database upgrades to exactly a fresh install.
//
// The fixtures under test/fixtures/upgrade/ were created by each release's own
// code (scripts/generate-upgrade-fixture.ts boots the tagged release in a
// scratch worktree), not by replaying today's migrations to an old version —
// so drift between what an old binary actually created and what today's
// upgrade path assumes shows up here. Every release keeps a fixture (see
// docs/architecture/persistence.md → "Baseline refresh policy").

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpgradeFixtureManifest } from "../scripts/generate-upgrade-fixture";
import { MarinaDB } from "../src/persistence/database";
import { SCHEMA_VERSION } from "../src/persistence/schema";

const FIXTURE_DIR = join(import.meta.dir, "fixtures/upgrade");

const fixtures = readdirSync(FIXTURE_DIR)
  .filter((file) => file.endsWith(".json"))
  .map(
    (file) => JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as UpgradeFixtureManifest,
  )
  .sort((a, b) => a.schemaVersion - b.schemaVersion);

/**
 * Known differences between an upgraded database and a fresh install, keyed by
 * the normalized schema line that differs. Each entry is a real finding that
 * needs review — never add one to make a new drift pass silently.
 */
const KNOWN_DRIFT: ReadonlyMap<string, string> = new Map();

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Collapse whitespace and identifier quoting so formatting never counts as drift. */
function normalizeSql(sql: string): string {
  return sql
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .replace(/["`[\]]/g, "")
    .replace(/\bIF NOT EXISTS /gi, "")
    .trim();
}

/**
 * One line per schema fact: columns (type, NOT NULL, default, primary key,
 * hidden), foreign keys, indexes (incl. automatic ones) with their columns,
 * the SQL of views, triggers and virtual tables, and each table's normalized
 * definition. The per-column lines make a diff readable; the definition line
 * catches what PRAGMAs do not report (CHECK constraints, column order).
 */
function normalizedSchema(db: Database): string[] {
  const lines: string[] = [];
  const tables = db.query("PRAGMA table_list").all() as { name: string; type: string }[];
  const shadows = new Set(tables.filter((t) => t.type === "shadow").map((t) => t.name));
  const objects = db
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  for (const object of objects) {
    if (shadows.has(object.name)) continue;
    if (object.type === "table" && /^CREATE VIRTUAL TABLE/i.test(object.sql ?? "")) {
      lines.push(`virtual ${object.name}: ${normalizeSql(object.sql ?? "")}`);
      continue;
    }
    if (object.type === "view" || object.type === "trigger") {
      lines.push(`${object.type} ${object.name}: ${normalizeSql(object.sql ?? "")}`);
      continue;
    }
    if (object.type !== "table") continue;
    const table = object.name;
    const columns = db.query(`PRAGMA table_xinfo(${quote(table)})`).all() as {
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
      hidden: number;
    }[];
    for (const c of columns)
      lines.push(
        `column ${table}.${c.name}: ${c.type.toUpperCase() || "(none)"}${c.notnull ? " NOT NULL" : ""}` +
          `${c.dflt_value === null ? "" : ` DEFAULT ${normalizeSql(c.dflt_value)}`}` +
          `${c.pk ? ` PK${c.pk}` : ""}${c.hidden ? ` hidden${c.hidden}` : ""}`,
      );
    // The whole definition too: column order, CHECK and table constraints.
    lines.push(`ddl ${table}: ${normalizeSql(object.sql ?? "")}`);
    const fks = db.query(`PRAGMA foreign_key_list(${quote(table)})`).all() as {
      table: string;
      from: string;
      to: string | null;
      on_update: string;
      on_delete: string;
    }[];
    for (const fk of fks)
      lines.push(
        `fk ${table}.${fk.from} -> ${fk.table}.${fk.to ?? "(pk)"} on update ${fk.on_update} on delete ${fk.on_delete}`,
      );
    const indexes = db.query(`PRAGMA index_list(${quote(table)})`).all() as {
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }[];
    for (const index of indexes) {
      const cols = (
        db.query(`PRAGMA index_info(${quote(index.name)})`).all() as { name: string | null }[]
      ).map((c) => c.name ?? "<expr>");
      // Automatic index names encode creation order; key them by their columns.
      const name = index.origin === "c" ? index.name : `(${index.origin}) ${table}`;
      const sql = objects.find((o) => o.type === "index" && o.name === index.name)?.sql;
      lines.push(
        `index ${name} on ${table}(${cols.join(",")})${index.unique ? " UNIQUE" : ""}` +
          `${sql ? `: ${normalizeSql(sql)}` : ""}`,
      );
    }
  }
  return lines.sort();
}

function schemaDiff(upgraded: string[], fresh: string[]): string[] {
  const a = new Set(upgraded);
  const b = new Set(fresh);
  return [
    ...fresh.filter((line) => !a.has(line)).map((line) => `- fresh only:    ${line}`),
    ...upgraded.filter((line) => !b.has(line)).map((line) => `+ upgraded only: ${line}`),
  ].filter((entry) => !KNOWN_DRIFT.has(entry));
}

let dir: string;
let freshSchema: string[];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "marina-release-upgrade-"));
  const freshPath = join(dir, "fresh.db");
  new MarinaDB(freshPath).close();
  const fresh = new Database(freshPath, { readonly: true });
  try {
    freshSchema = normalizedSchema(fresh);
  } finally {
    fresh.close();
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("every fixture is a distinct real release with a recorded commit", () => {
  expect(fixtures.length).toBeGreaterThan(0);
  for (const fixture of fixtures) {
    expect(fixture.tag).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(fixture.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(fixture.schemaVersion).toBeLessThanOrEqual(SCHEMA_VERSION);
  }
  expect(new Set(fixtures.map((f) => f.tag)).size).toBe(fixtures.length);
});

test("the schema comparison sees a dropped index, a new column and a changed trigger", () => {
  const path = join(dir, "mutated.db");
  new MarinaDB(path).close();
  const mutated = new Database(path);
  try {
    const index = mutated
      .query("SELECT name FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL LIMIT 1")
      .get() as { name: string };
    mutated.exec(`DROP INDEX ${quote(index.name)}`);
    mutated.exec("ALTER TABLE notes ADD COLUMN drift_probe TEXT");
    const trigger = mutated
      .query("SELECT name, sql FROM sqlite_schema WHERE type='trigger' LIMIT 1")
      .get() as { name: string; sql: string };
    mutated.exec(`DROP TRIGGER ${quote(trigger.name)}`);
    mutated.exec(trigger.sql.replace(/\bBEGIN\b/i, "BEGIN SELECT 1;"));
    const diff = schemaDiff(normalizedSchema(mutated), freshSchema);
    expect(diff.some((line) => line.includes(`index ${index.name} `))).toBe(true);
    expect(diff).toContain("+ upgraded only: column notes.drift_probe: TEXT");
    expect(diff.some((line) => line.startsWith(`+ upgraded only: trigger ${trigger.name}:`))).toBe(
      true,
    );
  } finally {
    mutated.close();
  }
});

describe.each(fixtures)("$tag (schema $schemaVersion) upgrades", (fixture) => {
  let path: string;
  let db: MarinaDB;

  beforeAll(() => {
    path = join(dir, `${fixture.tag}.db`);
    const old = new Database(path);
    try {
      // The dump writes FTS virtual tables through writable_schema, as `.dump` does.
      old.exec(readFileSync(join(FIXTURE_DIR, `${fixture.tag}.sql`), "utf8"));
      expect(old.query("SELECT MAX(version) AS v FROM schema_version").get()).toEqual({
        v: fixture.schemaVersion,
      });
    } finally {
      old.close();
    }
    // Normal upgrade path: today's binary opening the release's database.
    db = new MarinaDB(path);
  });

  afterAll(() => db?.close());

  test("to the latest schema version", () => {
    expect(
      db.memoryRepository().raw.query("SELECT MAX(version) AS v FROM schema_version").get(),
    ).toEqual({
      v: SCHEMA_VERSION,
    });
  });

  test("with exactly a fresh install's schema", () => {
    const upgraded = normalizedSchema(db.memoryRepository().raw);
    const diff = schemaDiff(upgraded, freshSchema);
    if (diff.length > 0)
      throw new Error(
        `${fixture.tag} upgraded schema differs from a fresh install (${diff.length}):\n${diff.join("\n")}`,
      );
  });

  test("keeping the rows that release wrote, readable through today's API", () => {
    const { seeded } = fixture;
    expect(db.getUserByName(seeded.user.name)?.id).toBe(seeded.user.id);
    expect(db.loadEntity(seeded.entity.id as never)?.name).toBe(seeded.entity.name);
    expect(db.getNote(seeded.note.id)?.content).toBe(seeded.note.content);
    expect(db.searchNotes(seeded.note.entityName, "survive").map((n) => n.id)).toContain(
      seeded.note.id,
    );
    expect(db.getCoreMemory(seeded.coreMemory.entityName, seeded.coreMemory.key)?.value).toBe(
      seeded.coreMemory.value,
    );
    expect(db.getTask(seeded.task.id)?.title).toBe(seeded.task.title);
    expect(db.getChannelHistory(seeded.channel.id).map((m) => m.content)).toContain(
      seeded.channel.content,
    );
    expect(db.getBoardPost(seeded.boardPost.id)?.body).toBe(seeded.boardPost.body);
    expect(db.getCanvas(seeded.canvas.id)?.name).toBe(seeded.canvas.name);
  });

  test("with an intact file and queryable full-text indexes", () => {
    const raw = db.memoryRepository().raw;
    expect(raw.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const fts = (
      raw
        .query(
          "SELECT name FROM sqlite_schema WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%fts5%'",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(fts.length).toBeGreaterThan(0);
    for (const table of fts) {
      // FTS5's own consistency check, then a real MATCH query.
      raw.exec(`INSERT INTO ${quote(table)}(${quote(table)}) VALUES ('integrity-check')`);
      raw
        .query(`SELECT rowid FROM ${quote(table)} WHERE ${quote(table)} MATCH 'fixture' LIMIT 1`)
        .all();
    }
    expect(db.searchTasks("fixture").map((task) => task.id)).toContain(fixture.seeded.task.id);
  });

  test("and reopen cleanly", () => {
    db.close();
    db = new MarinaDB(path);
    expect(db.getNote(fixture.seeded.note.id)?.content).toBe(fixture.seeded.note.content);
  });
});
