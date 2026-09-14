// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARMS,
  type ArmResult,
  exactMatchJudge,
  loadSyntheticItems,
  type MemoryBenchmarkReport,
  RESIDENT_CONTEXT_VERSION,
  RESULT_SCHEMA,
  runMemoryBenchmark,
  STUB_KNOWN_FRACTION,
  splitItems,
  stableHash,
  stubKnows,
  tokenF1,
  validateArmResult,
  wilson95,
} from "../benchmarks/memory/genbench";

describe("genbench primitives", () => {
  test("stableHash is deterministic and 32-bit", () => {
    expect(stableHash("syn-001")).toBe(stableHash("syn-001"));
    expect(stableHash("syn-001")).not.toBe(stableHash("syn-002"));
    expect(stableHash("x")).toBeLessThan(2 ** 32);
  });

  test("splitItems is disjoint, exhaustive, seed-stable, and varies by seed", () => {
    const items = loadSyntheticItems();
    const a = splitItems(items, 1, "v1", 0.5);
    const b = splitItems(items, 1, "v1", 0.5);
    const c = splitItems(items, 2, "v1", 0.5);
    const seedIds = new Set(a.seedSet.map((i) => i.id));
    for (const item of a.evalSet) expect(seedIds.has(item.id)).toBe(false);
    expect(a.seedSet.length + a.evalSet.length).toBe(items.length);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
  });

  test("wilson95 brackets the point estimate and clamps to [0,1]", () => {
    const ci = wilson95(60, 100);
    expect(ci.low).toBeLessThan(0.6);
    expect(ci.high).toBeGreaterThan(0.6);
    expect(wilson95(0, 10).low).toBe(0);
    expect(wilson95(10, 10).high).toBeCloseTo(1, 9);
    expect(wilson95(0, 0)).toEqual({ low: 0, high: 0 });
  });

  test("tokenF1 follows SQuAD normalization", () => {
    expect(tokenF1("4.7 meters", "4.7 meters")).toBe(1);
    expect(tokenF1("The Ember Line", "ember line")).toBe(1);
    expect(tokenF1("I do not know.", "malachite")).toBe(0);
    expect(tokenF1("about 38 meters tall", "38 meters")).toBeCloseTo(2 / 3, 5);
  });

  test("exactMatchJudge handles MC letters, numerics, and containment", () => {
    expect(
      exactMatchJudge("The answer is B", {
        id: "m",
        question: "",
        choices: ["x", "y"],
        answer: "B",
      }),
    ).toBe(true);
    expect(exactMatchJudge("A", { id: "m", question: "", choices: ["x", "y"], answer: "B" })).toBe(
      false,
    );
    expect(
      exactMatchJudge("So the total is 1,234.", { id: "n", question: "", answer: "1234" }),
    ).toBe(true);
    expect(exactMatchJudge("It was in 1873.", { id: "s", question: "", answer: "1873" })).toBe(
      true,
    );
    expect(
      exactMatchJudge("phosphor bronze, I believe", {
        id: "s",
        question: "",
        answer: "phosphor bronze",
      }),
    ).toBe(true);
    expect(exactMatchJudge("bronze", { id: "s", question: "", answer: "phosphor bronze" })).toBe(
      false,
    );
  });

  test("stub known subset is close to the declared fraction", () => {
    const items = loadSyntheticItems();
    const known = items.filter((i) => stubKnows(i.id)).length / items.length;
    expect(Math.abs(known - STUB_KNOWN_FRACTION)).toBeLessThan(0.12);
  });
});

describe("genbench offline pipeline (stub model + stub judge)", () => {
  const resultsDir = mkdtempSync(join(tmpdir(), "genbench-test-"));
  const originalFetch = globalThis.fetch;
  let outerFetchCalls = 0;
  let report: MemoryBenchmarkReport;
  const byArm = (arm: string): ArmResult => {
    const found = report.results.find((r) => r.config.arm === arm);
    if (!found) throw new Error(`missing arm ${arm}`);
    return found;
  };

  beforeAll(async () => {
    // Spy under the harness's own guard: any call that leaks past the guard
    // would land here; any call the guard refuses is counted in the report.
    globalThis.fetch = Object.assign(
      async (...args: Parameters<typeof fetch>) => {
        outerFetchCalls++;
        return originalFetch(...args);
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;
    report = await runMemoryBenchmark({
      dataset: "synthetic-v1",
      arms: ARMS,
      model: "stub",
      judge: "stub",
      seeds: 3,
      resultsDir,
      quiet: true,
    });
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    rmSync(resultsDir, { recursive: true, force: true });
  });

  test("runs every arm across every seed with no per-query errors", () => {
    expect(report.results.map((r) => r.config.arm)).toEqual([...ARMS]);
    for (const r of report.results) {
      expect(r.metrics.skipped).toBeUndefined();
      expect(r.metrics.errors).toBe(0);
      expect(r.perSeed.map((s) => s.seed)).toEqual([1, 2, 3]);
      expect(r.metrics.n).toBe(r.perSeed.reduce((n, s) => n + s.n, 0));
    }
  });

  test("no network was attempted", () => {
    expect(report.networkAttempts).toBe(0);
    expect(outerFetchCalls).toBe(0);
    for (const r of report.results) {
      expect(r.config.offline).toBe(true);
      expect(r.config.networkAttempts).toBe(0);
      expect(r.config.endpoint).toBeNull();
    }
  });

  test("held-out discipline: scored items are disjoint from the seed split", () => {
    for (const r of report.results) {
      for (const s of r.perSeed) {
        const seedIds = new Set(s.seedIds);
        expect(s.evalIds.length).toBe(s.n);
        for (const id of s.evalIds) expect(seedIds.has(id)).toBe(false);
        const scored = r.items.filter((i) => i.seed === s.seed).map((i) => i.id);
        expect(new Set(scored)).toEqual(new Set(s.evalIds));
      }
    }
  });

  test("stub stair-step: warm beats bare, bare sits near the known fraction", () => {
    const bare = byArm("bare").metrics.judgeAccuracy;
    const warm = byArm("warm").metrics.judgeAccuracy;
    const cold = byArm("cold").metrics.judgeAccuracy;
    expect(Math.abs(bare.pooled - STUB_KNOWN_FRACTION)).toBeLessThan(0.15);
    expect(warm.pooled).toBeGreaterThan(bare.pooled);
    expect(cold.pooled).toBeGreaterThanOrEqual(bare.pooled);
    expect(byArm("warm").metrics.memoryHitRate).toBeGreaterThan(0);
    expect(byArm("bare").metrics.memoryHitRate).toBe(0);
    expect(byArm("bare").metrics.injectedTokens.max).toBe(0);
  });

  test("matched controls run under the same harness with the same corpus", () => {
    const bm25 = byArm("bm25");
    const full = byArm("fullcontext");
    const warm = byArm("warm");
    expect(bm25.metrics.judgeAccuracy.pooled).toBeGreaterThan(
      byArm("bare").metrics.judgeAccuracy.pooled,
    );
    expect(full.metrics.judgeAccuracy.pooled).toBeGreaterThan(
      byArm("bare").metrics.judgeAccuracy.pooled,
    );
    expect(full.metrics.injectedTokens.mean).toBeGreaterThan(warm.metrics.injectedTokens.mean);
    for (const arm of [bm25, full, warm]) {
      for (const s of arm.perSeed) expect(s.seedPass?.notes).toBeGreaterThan(0);
      const fp = arm.perSeed.map((s) => s.splitFingerprint);
      expect(fp).toEqual(warm.perSeed.map((s) => s.splitFingerprint));
    }
  });

  test("confidence intervals and both metrics are present", () => {
    for (const r of report.results) {
      const ja = r.metrics.judgeAccuracy;
      expect(ja.wilson95.low).toBeLessThanOrEqual(ja.pooled);
      expect(ja.wilson95.high).toBeGreaterThanOrEqual(ja.pooled);
      expect(ja.wilson95.high).toBeGreaterThan(ja.wilson95.low);
      expect(ja.perSeed).toHaveLength(3);
      expect(ja.seedCi95.low).toBeLessThanOrEqual(ja.seedMean);
      expect(ja.seedCi95.high).toBeGreaterThanOrEqual(ja.seedMean);
      expect(r.metrics.tokenF1.mean).toBeGreaterThanOrEqual(0);
      expect(r.metrics.tokenF1.mean).toBeLessThanOrEqual(1);
      expect(r.metrics.latencyMs.total.p95).toBeGreaterThanOrEqual(r.metrics.latencyMs.total.p50);
      expect(r.metrics.costUsd).toBeNull();
    }
  });

  test("result files exist, validate, carry the config block, and are never overwritten", () => {
    expect(report.files).toHaveLength(ARMS.length);
    for (const path of report.files) {
      expect(existsSync(path)).toBe(true);
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as ArmResult;
      expect(validateArmResult(parsed)).toEqual([]);
      expect(parsed.schema).toBe(RESULT_SCHEMA);
      expect(parsed.config.model).toBe("stub");
      expect(parsed.config.judge).toBe("stub");
      expect(parsed.config.seeds).toEqual([1, 2, 3]);
      expect(parsed.config.residentContextVersion).toBe(RESIDENT_CONTEXT_VERSION);
      expect(parsed.config.harnessGitSha.length).toBeGreaterThan(0);
      expect(parsed.config.splitSalt).toBe("v1");
    }
    expect(report.summaryPath).not.toBeNull();
    expect(report.summaryMarkdown).toContain("| warm |");
    const files = readdirSync(resultsDir);
    expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(ARMS.length);
    expect(files.filter((f) => f.endsWith(".md"))).toHaveLength(1);
    expect(validateArmResult({ schema: "wrong" }).length).toBeGreaterThan(0);
  });
});
