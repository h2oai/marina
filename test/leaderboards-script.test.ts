// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarinaDB } from "../src/persistence/database";

test("leaderboard inspection neither creates nor migrates the operator database", () => {
  const directory = mkdtempSync(join(tmpdir(), "marina-leaderboards-"));
  const path = join(directory, "ledger.db");
  const inspect = () =>
    Bun.spawnSync([process.execPath, "--env-file=/dev/null", "scripts/leaderboards.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, DB_PATH: path },
      stdout: "pipe",
      stderr: "pipe",
    });
  try {
    expect(inspect().exitCode).toBe(0);
    expect(existsSync(path)).toBe(false);

    const legacy = new Database(path);
    legacy.run("CREATE TABLE old_schema (id INTEGER)");
    legacy.close();
    const before = readFileSync(path);
    expect(inspect().exitCode).not.toBe(0);
    expect(readFileSync(path)).toEqual(before);

    const current = new MarinaDB(path);
    current.close();
    const initialized = readFileSync(path);
    const result = inspect();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("External submissions");
    expect(result.stdout.toString()).toContain("Social Simulation Arena");
    expect(result.stdout.toString()).toContain("Benchmark ledger");
    expect(readFileSync(path)).toEqual(initialized);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
