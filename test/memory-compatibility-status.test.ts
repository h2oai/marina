// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// `memory:compatibility status` only reads: on a released database with pending
// migrations it reports them and leaves the file byte-for-byte unchanged;
// `upgrade` is the one verb that migrates.

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compatibilityStatus, statusIsClean } from "../scripts/memory-compatibility";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/persistence/schema";

const FIXTURE_DIR = join(import.meta.dir, "fixtures/upgrade");
const SCRIPT = join(import.meta.dir, "../scripts/memory-compatibility.ts");
const dir = mkdtempSync(join(tmpdir(), "marina-memcompat-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function loadFixture(tag: string): string {
  const path = join(dir, `${tag}.db`);
  const db = new Database(path, { create: true });
  db.exec(readFileSync(join(FIXTURE_DIR, `${tag}.sql`), "utf8"));
  db.close();
  return path;
}

function schemaVersion(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v;
  } finally {
    db.close();
  }
}

function run(...args: string[]) {
  const proc = Bun.spawnSync(["bun", "--no-env-file", SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("memory:compatibility status", () => {
  test("reports pending migrations on a v0.5.0 database without changing it", () => {
    const path = loadFixture("v0.5.0");
    const before = readFileSync(path);
    const version = schemaVersion(path);
    expect(version).toBeLessThan(SCHEMA_VERSION);

    const status = compatibilityStatus(path);
    expect(status.schemaVersion).toBe(version);
    expect(status.latestVersion).toBe(SCHEMA_VERSION);
    expect(status.pendingMigrations).toBe(MIGRATIONS.filter((m) => m.version > version).length);
    expect(status.pendingMigrations).toBeGreaterThan(0);
    expect(status.integrity).toBeNull();
    expect(status.action).toContain("memory:compatibility upgrade");
    expect(statusIsClean(status)).toBe(false);

    expect(readFileSync(path).equals(before)).toBe(true);
    expect(schemaVersion(path)).toBe(version);
  });

  test("the CLI exits nonzero, takes no lease and leaves the file unchanged", () => {
    const path = loadFixture("v0.7.0");
    const before = readFileSync(path);
    const result = run("status", path);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.pendingMigrations).toBeGreaterThan(0);
    expect(report.integrity).toBeNull();
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(existsSync(`${path}.instance-lock`)).toBe(false);
  });

  test("upgrade migrates; status then reports integrity and exits zero", () => {
    const path = loadFixture("v0.8.0");
    expect(run("upgrade", path).code).toBe(0);
    expect(schemaVersion(path)).toBe(SCHEMA_VERSION);

    const result = run("status", path);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      pendingMigrations: 0,
      integrity: { unconverted: 0, broken: 0, duplicateBodies: 0 },
    });
  });

  test("a missing database is an error, never created", () => {
    const path = join(dir, "missing.db");
    const result = run("status", path);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Database not found");
    expect(existsSync(path)).toBe(false);
  });
});
