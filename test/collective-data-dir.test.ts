// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Child worlds under `MARINA_DATA_DIR`: each variant gets its own data
 * directory inside the parent's, never the parent's endpoint.json, auth
 * database or scratch, and no inherited embedding lifecycle
 * (`src/world/world-collective-manager.ts`). In-world benchmark results move
 * under the data directory too.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { benchmarkResultsDir } from "../src/engine/benchmark-runner";
import { MarinaDB } from "../src/persistence/database";
import { inheritedChildEnv, WorldCollectiveManager } from "../src/world/world-collective-manager";
import { scopeProcessState } from "./process-state";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "marina-collective-"));
  made.push(dir);
  return dir;
}

describe("a child world's environment", () => {
  test("gets its own data directory and none of the parent's derived paths", () => {
    const parent = "/srv/marina";
    const env = inheritedChildEnv(
      {
        MARINA_DATA_DIR: parent,
        BETTER_AUTH_DB_PATH: `${parent}/marina-auth.db`,
        MARINA_SCRATCH_DIR: `${parent}/scratch`,
        MARINA_MEMORY_EMBEDDING_CACHE: `${parent}/memory-models`,
        MARINA_IDLE_SHUTDOWN: "15m",
        MARINA_SINGLE_PORT: "true",
        MARINA_PARENT_PID: "1",
        ANTHROPIC_API_KEY: "k",
      },
      `${parent}/collective/alpha`,
    );
    expect(env.MARINA_DATA_DIR).toBe(`${parent}/collective/alpha`);
    expect(env.BETTER_AUTH_DB_PATH).toBeUndefined();
    expect(env.MARINA_SCRATCH_DIR).toBeUndefined();
    // Model caches are shared downloads, not per-instance state.
    expect(env.MARINA_MEMORY_EMBEDDING_CACHE).toBe(`${parent}/memory-models`);
    expect(env.MARINA_IDLE_SHUTDOWN).toBeUndefined();
    expect(env.MARINA_SINGLE_PORT).toBeUndefined();
    expect(env.MARINA_PARENT_PID).toBe(String(process.pid));
    expect(env.ANTHROPIC_API_KEY).toBe("k");
  });

  test("keeps explicit paths, and adds no data directory when the parent has none", () => {
    const env = inheritedChildEnv(
      { BETTER_AUTH_DB_PATH: "/explicit/auth.db", MARINA_IDLE_SHUTDOWN: "1h" },
      "/checkout/data/collective/alpha",
    );
    expect(env.MARINA_DATA_DIR).toBeUndefined();
    expect(env.BETTER_AUTH_DB_PATH).toBe("/explicit/auth.db");
    expect(env.MARINA_IDLE_SHUTDOWN).toBeUndefined();
    expect(env.MARINA_PARENT_PID).toBe(String(process.pid));
  });
});

describe("variant and result locations", () => {
  test("variants live under MARINA_DATA_DIR when it is set", () => {
    const dataDir = tmp();
    const db = new MarinaDB(":memory:");
    try {
      const manager = new WorldCollectiveManager(db);
      {
        using _state = scopeProcessState({ env: { MARINA_DATA_DIR: dataDir } });
        const inside = manager.create({
          name: "inside",
          worldTemplate: "empty",
          createdBy: "Operator",
        });
        expect(dirname(inside.db_path)).toBe(join(dataDir, "collective", "inside"));
        expect(benchmarkResultsDir()).toBe(join(dataDir, "benchmark-results"));
      }
      {
        using _state = scopeProcessState({ env: { MARINA_DATA_DIR: undefined } });
        expect(benchmarkResultsDir()).toBe(join(process.cwd(), "benchmarks", "results"));
      }
    } finally {
      db.close();
    }
  });
});
