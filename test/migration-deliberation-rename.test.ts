// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Migration 82: nsed → deliberation rename. Fresh databases never contain the
// legacy strings (the pattern was renamed at the source), so these tests seed
// legacy rows into a fully-migrated database and REPLAY the migration's SQL —
// which is exactly what an upgrading pre-82 database experiences, and also
// proves the statements are idempotent.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MarinaDB, MIGRATIONS } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

const TEST_DB = "test-migration-82.db";
const M82_SQL = MIGRATIONS.find((m) => m.version === 82)!.sql;

let marina: MarinaDB;
let raw: Database;

function insertPool(id: string, name: string): void {
  raw.run(
    "INSERT INTO memory_pools (id, name, created_by, created_at) VALUES (?, ?, 'system', 1)",
    [id, name],
  );
}

function insertNote(poolId: string, content: string): void {
  raw.run(
    "INSERT INTO notes (entity_name, content, pool_id, created_at) VALUES ('tester', ?, ?, 1)",
    [content, poolId],
  );
}

function poolNames(): string[] {
  return (
    raw.query("SELECT name FROM memory_pools WHERE name LIKE 'orchestration:%'").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

function notesInPool(poolId: string): number {
  return (
    raw.query("SELECT COUNT(*) AS c FROM notes WHERE pool_id = ?").get(poolId) as { c: number }
  ).c;
}

describe("migration 82: nsed → deliberation rename", () => {
  beforeEach(() => {
    cleanupDb(TEST_DB);
    marina = new MarinaDB(TEST_DB);
    raw = new Database(TEST_DB);
  });

  afterEach(() => {
    raw.close();
    marina.close();
    cleanupDb(TEST_DB);
  });

  it("rewrites legacy project orchestration and crew formation values", () => {
    raw.run(
      "INSERT INTO projects (id, name, orchestration, created_by, created_at) VALUES ('p1', 'Legacy', 'nsed', 'tester', 1)",
    );
    raw.run(
      "INSERT INTO crews (id, name, goal, formation, owner_id, state, created_at, last_activity_at) VALUES ('c1', 'oldcrew', 'g', 'nsed', 'e_1', 'active', 1, 1)",
    );

    raw.exec(M82_SQL);

    const project = raw.query("SELECT orchestration FROM projects WHERE id = 'p1'").get() as {
      orchestration: string;
    };
    expect(project.orchestration).toBe("deliberation");
    const crew = raw.query("SELECT formation FROM crews WHERE id = 'c1'").get() as {
      formation: string;
    };
    expect(crew.formation).toBe("deliberation");
  });

  it("merges orchestration:nsed into an existing orchestration:deliberation pool", () => {
    insertPool("pool_legacy", "orchestration:nsed");
    insertPool("pool_new", "orchestration:deliberation");
    insertNote("pool_legacy", "legacy lesson one");
    insertNote("pool_legacy", "legacy lesson two");
    insertNote("pool_new", "new lesson");

    raw.exec(M82_SQL);

    expect(poolNames()).toEqual(["orchestration:deliberation"]);
    expect(notesInPool("pool_new")).toBe(3);
    expect(notesInPool("pool_legacy")).toBe(0);
  });

  it("renames orchestration:nsed in place when no deliberation pool exists", () => {
    insertPool("pool_legacy", "orchestration:nsed");
    insertNote("pool_legacy", "legacy lesson");

    raw.exec(M82_SQL);

    expect(poolNames()).toEqual(["orchestration:deliberation"]);
    expect(notesInPool("pool_legacy")).toBe(1);
  });

  it("is idempotent — replaying changes nothing", () => {
    insertPool("pool_legacy", "orchestration:nsed");
    insertPool("pool_new", "orchestration:deliberation");
    insertNote("pool_legacy", "legacy lesson");

    raw.exec(M82_SQL);
    raw.exec(M82_SQL);

    expect(poolNames()).toEqual(["orchestration:deliberation"]);
    expect(notesInPool("pool_new")).toBe(1);
  });
});
