// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * ONE benchmark registry: the harness, the in-world runner and the web UI all
 * derive from `src/engine/benchmark-registry.ts`. These tests fail the moment
 * a consumer grows its own list again or stops matching the registry.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BENCHMARKS as HARNESS_BENCHMARKS } from "../benchmarks/registry";
import {
  BENCHMARK_KEYS,
  BENCHMARK_REGISTRY,
  type BenchmarkEntry,
  benchmarkCatalog,
  benchmarkEntry,
  benchmarkUsesJudge,
} from "../src/engine/benchmark-registry";
import { BenchmarkRunner, BENCHMARKS as WORLD_BENCHMARKS } from "../src/engine/benchmark-runner";
import type { MarinaDB } from "../src/persistence/database";

const ROOT = join(import.meta.dir, "..");
const sorted = (xs: Iterable<string>) => [...xs].sort();

describe("one benchmark registry", () => {
  test("the harness registry is the shared registry plus loaders", () => {
    expect(sorted(Object.keys(HARNESS_BENCHMARKS))).toEqual(sorted(BENCHMARK_KEYS));
    for (const key of BENCHMARK_KEYS) {
      const entry: BenchmarkEntry = BENCHMARK_REGISTRY[key];
      const def = HARNESS_BENCHMARKS[key];
      expect(def, key).toBeDefined();
      expect(typeof def?.download, key).toBe("function");
      expect({
        name: def?.name,
        dataset: def?.dataset,
        adapter: def?.adapter,
        scoring: def?.scoring,
        description: def?.description,
        phase: def?.phase,
      }).toEqual({
        name: entry.name,
        dataset: entry.dataset,
        adapter: entry.adapter,
        scoring: entry.scoring,
        description: entry.description,
        phase: entry.phase,
      });
    }
  });

  test("the in-world list is every registered benchmark, datasets where the harness caches them", () => {
    expect(sorted(Object.keys(WORLD_BENCHMARKS))).toEqual(sorted(BENCHMARK_KEYS));
    for (const key of BENCHMARK_KEYS) {
      const entry: BenchmarkEntry = BENCHMARK_REGISTRY[key];
      const spec = WORLD_BENCHMARKS[key];
      expect(spec?.name).toBe(key);
      expect(spec?.description).toBe(entry.description);
      expect(spec?.datasetFile).toBe(`${entry.dataset}.json`);
      expect(spec?.datasetPath).toBe(
        entry.source.kind === "tracked" ? entry.source.path : undefined,
      );
      expect(spec?.generated === true).toBe(entry.source.kind === "generated");
    }
  });

  test("the benchmarks the world had drifted away from are runnable in-world", () => {
    for (const key of ["narrativeqa", "mt-bench", "retention", "aime-2025"]) {
      expect(Object.keys(WORLD_BENCHMARKS)).toContain(key);
    }
    // Generated items need no download: always ready.
    const runner = new BenchmarkRunner({} as MarinaDB, () => {});
    expect(runner.datasetReady("retention")).toBe(true);
    expect(runner.datasetReady("smoke")).toBe(true);
  });

  test("a tracked dataset is ready whatever directory the server started in", () => {
    const runner = new BenchmarkRunner({} as MarinaDB, () => {});
    const before = process.cwd();
    const elsewhere = mkdtempSync(join(tmpdir(), "marina-cwd-"));
    try {
      process.chdir(elsewhere);
      expect(runner.datasetReady("smoke")).toBe(true);
    } finally {
      process.chdir(before);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("the web UI serves the registry's catalog, not a copy", () => {
    expect(benchmarkCatalog().map((r) => r.key)).toEqual(BENCHMARK_KEYS);
    const src = readFileSync(join(ROOT, "benchmarks/server.ts"), "utf-8");
    expect(src).toContain("benchmarkCatalog()");
    // No inline benchmark rows left behind.
    expect(src).not.toMatch(/key:\s*"mmlu-pro"/);
  });

  test("no consumer declares its own benchmark table", () => {
    for (const file of [
      "benchmarks/harness.ts",
      "benchmarks/server.ts",
      "src/engine/benchmark-runner.ts",
    ]) {
      const src = readFileSync(join(ROOT, file), "utf-8");
      expect(src, file).not.toMatch(/"mmlu-pro":\s*\{/);
      expect(src, file).not.toContain("Kept in sync manually");
    }
  });

  test("lookup and judge classification", () => {
    expect(benchmarkEntry("frames")?.adapter).toBe("short-answer");
    expect(benchmarkEntry("toString")).toBeUndefined();
    expect(benchmarkEntry("nope")).toBeUndefined();
    const judged = BENCHMARK_KEYS.filter((k) => benchmarkUsesJudge(BENCHMARK_REGISTRY[k]));
    expect(judged).toEqual(
      expect.arrayContaining(["frames", "simple-qa", "hle-verified-gold", "narrativeqa"]),
    );
    expect(judged).not.toContain("mmlu-pro");
    expect(judged).not.toContain("smoke");
  });
});
