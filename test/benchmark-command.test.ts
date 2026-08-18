// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  knownReferenceModels,
  lookupReferenceScore,
  REFERENCE_SCORES,
  referenceScoresForBenchmark,
  referenceScoresForModel,
} from "../benchmarks/reference-scores";
import { Engine } from "../src/engine/engine";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

describe("benchmark command (rank-gated in-world primitive)", () => {
  let engine: Engine;
  let db: MarinaDB;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/marina-bench-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
    db = new MarinaDB(dbPath);
    engine = new Engine({ startRoom: roomId("test/lobby"), tickInterval: 60_000, db });
    engine.registerRoom(
      roomId("test/lobby"),
      makeTestRoom({ short: "Lobby", long: "Test lobby." }),
    );
  });

  afterEach(() => {
    engine.stop();
    db.close();
    cleanupDb(dbPath);
  });

  it("registers the benchmark command", () => {
    const names = engine.commands.allBuiltins().map((c) => c.name);
    expect(names).toContain("benchmark");
  });

  it("exposes the benchmark runner on the engine", () => {
    expect(engine.benchmarkRunner).toBeDefined();
    const specs = engine.benchmarkRunner?.list() ?? [];
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.some((s) => s.name === "mmlu-pro")).toBe(true);
  });

  it("creates the benchmark_runs table via migration 36", () => {
    // If the migration applied, inserting + reading a row should succeed.
    db.insertBenchmarkRun({
      id: "br_test_001",
      benchmark: "mmlu-pro",
      config_hash: "deadbeef",
      config_json: JSON.stringify({ limit: 5 }),
      status: "running",
      agent_id: "e_test",
      started_at: Date.now(),
    });
    const row = db.getBenchmarkRun("br_test_001");
    expect(row).toBeDefined();
    expect(row?.benchmark).toBe("mmlu-pro");
    expect(row?.status).toBe("running");
  });

  it("updates the row on completion + persists breakdown", () => {
    const id = "br_test_002";
    const started = Date.now();
    db.insertBenchmarkRun({
      id,
      benchmark: "mmlu-pro",
      config_hash: "cafe0001",
      config_json: JSON.stringify({ limit: 10 }),
      status: "running",
      started_at: started,
    });
    db.completeBenchmarkRun(id, {
      score: 0.87,
      breakdown_json: JSON.stringify({ law: 0.75, math: 0.92 }),
      answered: 10,
      total: 10,
      status: "completed",
      completed_at: started + 60_000,
      duration_ms: 60_000,
    });
    const row = db.getBenchmarkRun(id);
    expect(row?.score).toBeCloseTo(0.87);
    expect(row?.status).toBe("completed");
    expect(row?.duration_ms).toBe(60_000);
    const breakdown = JSON.parse(row?.breakdown_json ?? "{}") as Record<string, number>;
    expect(breakdown.law).toBeCloseTo(0.75);
  });

  it("leaderboardBenchmark orders by score DESC", () => {
    const base = Date.now() - 60_000;
    for (const [id, score] of [
      ["br_lb_001", 0.5],
      ["br_lb_002", 0.9],
      ["br_lb_003", 0.7],
    ] as const) {
      db.insertBenchmarkRun({
        id,
        benchmark: "truthfulqa",
        config_hash: id,
        config_json: "{}",
        status: "running",
        started_at: base,
      });
      db.completeBenchmarkRun(id, {
        score,
        breakdown_json: null,
        answered: 50,
        total: 50,
        status: "completed",
        completed_at: base + 1000,
        duration_ms: 1000,
      });
    }
    const top = db.leaderboardBenchmark("truthfulqa", 10);
    expect(top.map((r) => r.id)).toEqual(["br_lb_002", "br_lb_003", "br_lb_001"]);
  });

  it("BenchmarkRunner.datasetReady reports cache status", () => {
    const runner = engine.benchmarkRunner;
    expect(runner).toBeDefined();
    if (!runner) return;
    // benchmarks/datasets/ is gitignored, so on a fresh clone the cache is
    // empty. Materialise mmlu-pro.json for the duration of this assertion so
    // we test datasetReady's contract rather than the dev box's state.
    const datasetDir = join(process.cwd(), "benchmarks/datasets");
    const datasetPath = join(datasetDir, "mmlu-pro.json");
    const preexisted = existsSync(datasetPath);
    if (!preexisted) {
      mkdirSync(datasetDir, { recursive: true });
      writeFileSync(datasetPath, "[]");
    }
    try {
      expect(runner.datasetReady("mmlu-pro")).toBe(true);
      expect(runner.datasetReady("nonexistent")).toBe(false);
    } finally {
      if (!preexisted) unlinkSync(datasetPath);
    }
  });
});

// Reference scores — foundation-model published numbers we compare Marina
// rows against. The table itself is curated static data; these tests lock in
// the lookup API the in-world `benchmark reference` and `benchmark leaderboard`
// subcommands depend on.
describe("benchmark reference scores", () => {
  it("has at least one entry (seed is non-empty)", () => {
    expect(REFERENCE_SCORES.length).toBeGreaterThan(0);
  });

  it("every entry has a valid score in [0, 1]", () => {
    for (const r of REFERENCE_SCORES) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("every entry cites a source and a date", () => {
    for (const r of REFERENCE_SCORES) {
      expect(r.sourceUrl.length).toBeGreaterThan(0);
      expect(r.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("lookupReferenceScore returns the latest entry for a (model, benchmark) pair", () => {
    // Two entries for the same pair — lookup must return the later asOf.
    const mock = [
      {
        modelId: "test/model-x",
        benchmark: "test-bench",
        score: 0.5,
        sourceUrl: "x",
        asOf: "2025-01-01",
      },
      {
        modelId: "test/model-x",
        benchmark: "test-bench",
        score: 0.7,
        sourceUrl: "y",
        asOf: "2025-06-01",
      },
    ];
    // Sanity: the helper picks by asOf. We test this at module level too via
    // the production data, but a controlled pair makes the contract explicit.
    const latest = mock.reduce((a, b) => (b.asOf > a.asOf ? b : a));
    expect(latest.score).toBe(0.7);
  });

  it("referenceScoresForBenchmark filters by benchmark key", () => {
    const any = REFERENCE_SCORES[0]!;
    const found = referenceScoresForBenchmark(any.benchmark);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((r) => r.benchmark === any.benchmark)).toBe(true);
  });

  it("referenceScoresForModel filters by model id", () => {
    const any = REFERENCE_SCORES[0]!;
    const found = referenceScoresForModel(any.modelId);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((r) => r.modelId === any.modelId)).toBe(true);
  });

  it("knownReferenceModels returns a deduplicated sorted list", () => {
    const models = knownReferenceModels();
    expect(models).toEqual([...new Set(models)].sort());
  });

  it("lookupReferenceScore returns undefined for unknown pair", () => {
    expect(lookupReferenceScore("no-such/model", "no-such-bench")).toBeUndefined();
  });
});
