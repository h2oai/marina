// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Tier-4 successor scaffold: runs fully offline with the stub model and
 * checks the protocol's invariants — inheritance surfaces on the shared read
 * path, the metrics compute, fidelity decays monotonically, no network. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSyntheticItems, splitDataset, splitItems } from "../benchmarks/memory/genbench";
import {
  createModelSummarizer,
  createStubSummarizer,
  factsRetained,
  fidelityChain,
  INHERITANCE_POOL,
  predecessorLessons,
  runSuccessorBenchmark,
  SUCCESSOR_ARMS,
  SUCCESSOR_KIND,
  SUCCESSOR_RESULT_SCHEMA,
  type SuccessorReport,
  validateSuccessorResult,
} from "../benchmarks/memory/successor";

const readme = readFileSync(
  join(import.meta.dir, "..", "benchmarks", "memory", "README.md"),
  "utf8",
);

describe("successor primitives", () => {
  test("predecessorLessons writes one lesson per fact, not per paraphrase", () => {
    const items = loadSyntheticItems();
    const { seedSet } = splitItems(items, 1, "v1", 0.5);
    const lessons = predecessorLessons(seedSet);
    const facts = new Set(seedSet.map((i) => String(i.metadata?.factId ?? i.id)));
    expect(lessons).toHaveLength(facts.size);
    expect(lessons.length).toBeLessThanOrEqual(seedSet.length);
    for (const lesson of lessons) expect(lesson.startsWith("Q: ")).toBe(true);
  });

  test("factsRetained is exact-match containment of the normalized gold answer", () => {
    const facts = [
      { id: "a", question: "", answer: "4.7 meters" },
      { id: "b", question: "", answer: "malachite" },
    ];
    expect(factsRetained("The mirror is 4.7 meters across.", facts)).toBe(1);
    expect(factsRetained("4.7 METERS; a malachite dome", facts)).toBe(2);
    expect(factsRetained("", facts)).toBe(0);
  });

  test("fidelityChain starts at full retention and never gains facts under the truncating stub", async () => {
    const items = loadSyntheticItems();
    const { seedSet } = splitItems(items, 3, "v1", 0.5);
    const lessons = predecessorLessons(seedSet);
    const chain = await fidelityChain(createStubSummarizer(), lessons, seedSet, 3, 1024, 0.5);
    expect(chain).toHaveLength(4);
    expect(chain[0]!.retention).toBe(1);
    for (let g = 1; g < chain.length; g++) {
      expect(chain[g]!.retention).toBeLessThanOrEqual(chain[g - 1]!.retention);
      expect(chain[g]!.digestBytes).toBeLessThanOrEqual(chain[g]!.budgetBytes);
    }
    expect(chain[3]!.retention).toBeLessThan(1);
    // Deterministic.
    const again = await fidelityChain(createStubSummarizer(), lessons, seedSet, 3, 1024, 0.5);
    expect(again).toEqual(chain);
  });

  test("a real model with an unreachable endpoint fails loudly instead of falling back to the stub", async () => {
    const dir = mkdtempSync(join(tmpdir(), "successor-unreachable-"));
    try {
      await expect(
        runSuccessorBenchmark({
          model: "marina",
          seeds: 1,
          limit: 4,
          quiet: true,
          offline: false,
          endpoint: "http://127.0.0.1:9",
          requestTimeoutMs: 2_000,
          resultsDir: dir,
        }),
      ).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await expect(
      runSuccessorBenchmark({ model: "marina", seeds: 1, quiet: true, offline: true }),
    ).rejects.toThrow(/offline mode requires/);
    await expect(
      runSuccessorBenchmark({ model: "stub", seeds: 1, quiet: true, summarizer: "model" }),
    ).rejects.toThrow(/needs a real --model/);
  });

  test("the model summariser keeps the digest inside the byte budget", async () => {
    const summarizer = createModelSummarizer({
      id: "fake",
      answer: async () => ({ text: "x".repeat(500) }),
    });
    expect(summarizer.id).toBe("model-digest:fake");
    const digest = await summarizer.summarize(["Q: a | A: b", "Q: c | A: d"], 120);
    expect(new TextEncoder().encode(digest).length).toBeLessThanOrEqual(120);
    expect(await summarizer.summarize([], 120)).toBe("");
  });
});

describe("successor offline run", () => {
  let dir: string;
  let report: SuccessorReport;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "successor-test-"));
    report = await runSuccessorBenchmark({
      model: "stub",
      seeds: 2,
      limit: 60,
      firstK: 5,
      generations: 3,
      resultsDir: dir,
      quiet: true,
    });
  }, 120_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("defaults to the paraphrase split, so the inheriting successor's ceiling is 100%", () => {
    expect(report.result.config.splitMode).toBe("paraphrase");
    for (const seed of report.result.perSeed) expect(seed.reachable).toBe(1);
  });

  test("produces a valid marina.memory.successor.v1 result with both arms and no network", () => {
    const { result } = report;
    expect(validateSuccessorResult(result)).toEqual([]);
    expect(result.schema).toBe(SUCCESSOR_RESULT_SCHEMA);
    expect(result.config.kind).toBe(SUCCESSOR_KIND);
    expect(result.config.offline).toBe(true);
    expect(result.config.networkAttempts).toBe(0);
    expect(report.networkAttempts).toBe(0);
    expect(result.config.inheritance).toBe("shared-pool");
    expect(result.config.inheritancePool).toBe(INHERITANCE_POOL);
    expect(result.config.seeds).toEqual([1, 2]);
    for (const arm of SUCCESSOR_ARMS) {
      expect(result.arms[arm].n).toBeGreaterThan(0);
      expect(result.arms[arm].errors).toBe(0);
    }
    expect(result.perSeed).toHaveLength(4);
    expect(result.items.length).toBe(result.arms.fresh.n + result.arms.inherit.n);
    expect(report.file && existsSync(report.file)).toBe(true);
    expect(report.summaryPath && existsSync(report.summaryPath)).toBe(true);
    expect(report.summaryMarkdown).toContain("# successor");
    expect(report.summaryMarkdown).toContain("Transmission fidelity");
  });

  test("the inheriting successor sees the predecessor's lessons and gets productive faster", () => {
    const { fresh, inherit } = report.result.arms;
    expect(fresh.inheritedHitRate).toBe(0);
    expect(inherit.inheritedHitRate).toBeGreaterThan(0.5);
    expect(inherit.accuracy.pooled).toBeGreaterThan(fresh.accuracy.pooled);
    expect(inherit.transferRate).toBeGreaterThan(fresh.transferRate);
    expect(inherit.firstK.pooled).toBeGreaterThanOrEqual(fresh.firstK.pooled);
    expect(inherit.timeToFirstTransfer.mean).not.toBeNull();
    expect(report.result.delta.accuracy).toBeGreaterThan(0);
    // Held-out by construction: no eval item is in its seed's predecessor set.
    const items = loadSyntheticItems().slice(0, 60);
    for (const seed of report.result.config.seeds) {
      const { seedSet } = splitDataset(items, seed, "v1", 0.5, report.result.config.splitMode);
      const learned = new Set(seedSet.map((i) => i.id));
      for (const record of report.result.items.filter((x) => x.seed === seed))
        expect(learned.has(record.id)).toBe(false);
    }
  });

  test("fidelity is reported per generation and decays monotonically under the stub summariser", () => {
    const { fidelity } = report.result;
    expect(fidelity.generations).toBe(3);
    expect(fidelity.meanRetention).toHaveLength(4);
    expect(fidelity.meanRetention[0]).toBe(1);
    for (let g = 1; g < fidelity.meanRetention.length; g++)
      expect(fidelity.meanRetention[g]).toBeLessThanOrEqual(fidelity.meanRetention[g - 1]!);
    expect(fidelity.perSeed).toHaveLength(2);
  });

  test("README documents the successor protocol", () => {
    expect(readme).toContain("## successor");
    expect(readme).toContain("marina.memory.successor.v1");
    expect(readme).toContain("time-to-first-correct");
    expect(readme).toContain("shared-pool");
  });
});
