// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarinaDB } from "../src/persistence/database";
import { BASE_SCHEMA, MIGRATIONS } from "../src/persistence/schema";

test("a schema-131 database upgrades with stable note IDs; newer schemas fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-upgrade-"));
  const path = join(dir, "world.db");
  try {
    const old = new Database(path);
    old.exec(BASE_SCHEMA);
    for (const migration of MIGRATIONS.filter((m) => m.version <= 131)) {
      old.transaction(() => {
        old.exec(migration.sql);
        old.run("INSERT INTO schema_version(version) VALUES (?)", [migration.version]);
      })();
    }
    old.run(
      "INSERT INTO notes(id, entity_name, content, created_at) VALUES (7419, 'Alice', 'pre-upgrade evidence', 1)",
    );
    old.close();
    const upgraded = new MarinaDB(path);
    try {
      expect(upgraded.getNote(7419)?.content).toBe("pre-upgrade evidence");
      expect(
        upgraded
          .memoryRepository()
          .raw.query("SELECT 1 FROM sqlite_schema WHERE name='legacy_memory_outbox'")
          .get(),
      ).toBeNull();
    } finally {
      upgraded.close();
    }
    const future = new Database(path);
    future.run("INSERT INTO schema_version(version) VALUES (?)", [MIGRATIONS.at(-1)!.version + 1]);
    future.close();
    expect(() => new MarinaDB(path)).toThrow("newer than this binary supports");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema-132 twins and adopted reflections acquire owner-bound projections on upgrade", () => {
  const dir = mkdtempSync(join(tmpdir(), "marina-memory-upgrade-"));
  const path = join(dir, "world.db");
  try {
    const old = new Database(path);
    old.exec(BASE_SCHEMA);
    for (const migration of MIGRATIONS.filter((m) => m.version <= 132)) {
      old.exec(migration.sql);
      old.run("INSERT INTO schema_version(version) VALUES (?)", [migration.version]);
    }
    old.run(
      "INSERT INTO users(id,name,created_at,last_login) VALUES ('alice-account','Alice',1,1),('bob-account','Bob',1,1)",
    );
    old.run(
      "INSERT INTO principals(principal_id,principal_type,display_name,created_at) VALUES ('alice-account','human','Alice',1),('bob-account','human','Bob',1)",
    );
    old.run(
      "INSERT INTO memory_spaces(id,owner_id,name,created_at) VALUES ('resident','alice-account','resident',1)",
    );
    old.run(`INSERT INTO notes(id,entity_name,content,created_at) VALUES
      (810,'Alice','adopted reflection',1),(811,'memory:alice-account','adopted reflection',1),
      (812,'Bob','adopted reflection',1)`);
    old.run(`INSERT INTO memory_records(id,space_id,version,current_note_id,created_at,metadata)
      VALUES ('adopted','resident',1,811,1,'{"adopted_from":"job"}')`);
    old.run(
      "INSERT INTO memory_record_versions(record_id,version,note_id) VALUES ('adopted',1,811)",
    );
    for (const [id, name] of [
      [810, "Alice"],
      [812, "Bob"],
    ] as const)
      old.run(
        `INSERT INTO note_sources(note_id,url,retrieved_at,credibility,captured_by,metadata)
        VALUES (?,'marina-memory://record/adopted',1,0,?,?)`,
        [id, name, JSON.stringify({ kind: "durable-twin", record_id: "adopted", version: 1 })],
      );
    old.close();
    const upgraded = new MarinaDB(path);
    try {
      expect(
        upgraded.memoryRepository().raw.query("SELECT * FROM memory_note_projections").all(),
      ).toContainEqual({ note_id: 810, record_id: "adopted", version: null });
      expect(upgraded.getNote(810)?.content).toBe("adopted reflection");
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
