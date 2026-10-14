// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every measured benchmark run is one durable outcome row (src/outcomes/benchmark.ts):
 * recorded as the run lands (`noteBenchmarkRun`, armed learner or not), swept up
 * hourly for runs written by another process, tagged by family and method,
 * ids and numbers only, and never a second lesson path.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ledgerFromHarnessResult } from "../src/engine/benchmark-ledger";
import { noteBenchmarkRun } from "../src/learning/intake";
import {
  benchmarkMethod,
  benchmarkSubject,
  recordBenchmarkRun,
  settleBenchmarkRuns,
} from "../src/outcomes/benchmark";
import { consumersFor } from "../src/outcomes/record";
import { MarinaDB } from "../src/persistence/database";

const SECRET = "zq-sentinel-question-text";

function harnessFile(dataset: string, n: number, correct: (i: number) => boolean) {
  return {
    config: { dataset, model: "m" },
    items: Array.from({ length: n }, (_, i) => ({
      id: `item-${i}`,
      question: `${SECRET} ${i}`,
      expected: "a",
      actual: correct(i) ? "a" : "b",
      correct: correct(i),
    })),
  };
}

let db: MarinaDB;
beforeEach(() => {
  db = new MarinaDB(":memory:");
});
afterEach(() => {
  db.close();
});

function importRun(
  id: string,
  opts: { dataset?: string; target?: unknown; targetKind?: "model" | "crew" | "population" } = {},
) {
  const f = harnessFile(opts.dataset ?? "gsm8k", 10, (i) => i < 7);
  const { run, items } = ledgerFromHarnessResult(f as never, {
    targetKind: opts.targetKind ?? "model",
    target: (opts.target ?? "anthropic/claude-fable-5-1") as never,
    raw: JSON.stringify(f),
    id,
    now: Date.now(),
  });
  const saved = db.recordBenchmarkLedgerRun(run, items);
  return { run: { ...run, id: saved.id }, id: saved.id };
}

describe("benchmark runs on the outcome path", () => {
  it("records one durable outcome per run, with no learner armed", () => {
    const { run, id } = importRun("r1");
    noteBenchmarkRun(db, run);
    noteBenchmarkRun(db, run);
    const o = db.getOutcomeBySubject(benchmarkSubject(id))!;
    expect(o).toMatchObject({
      kind: "benchmark",
      source: "benchmark:gsm8k",
      basis: "mechanical",
      eval_mode: "measure",
      succeeded: 1,
    });
    expect(o.quality).toBeCloseTo(0.7, 9);
    expect(JSON.parse(o.refs_json!)).toEqual([
      `bench:${id}`,
      "family:gsm8k",
      "method:model:anthropic/claude-fable-5-1",
    ]);
    // Evidence only: its lesson goes through the benchmark learner.
    expect(db.outcomeDeliveries(o.id)).toEqual([]);
    expect(JSON.stringify(o)).not.toContain(SECRET);
  });

  it("records nothing for an invalid run", () => {
    const { run, id } = importRun("r2");
    db.setBenchmarkRunValidity({
      run_id: id,
      action: "invalidate",
      reason: "provider outage",
      actor: null,
      source: "auto",
      created_at: Date.now(),
    });
    noteBenchmarkRun(db, run);
    expect(db.getOutcomeBySubject(benchmarkSubject(id))).toBeUndefined();
    expect(recordBenchmarkRun(db, db.getBenchmarkRun(id)!)).toBeUndefined();
  });

  it("sweeps up runs written without the learner hook, once", () => {
    importRun("a", { dataset: "gsm8k" });
    importRun("b", { dataset: "math" });
    expect(settleBenchmarkRuns(db)).toMatchObject({ recorded: 2, total: 2 });
    expect(settleBenchmarkRuns(db)).toMatchObject({ recorded: 0, total: 2 });
  });

  it("names the measured configuration as the method", () => {
    expect(benchmarkMethod({ target_kind: "model", target_json: '"openai/gpt-6-astra"' })).toBe(
      "model:openai/gpt-6-astra",
    );
    expect(
      benchmarkMethod({
        target_kind: "model",
        target_json: JSON.stringify({ model: "m", stack: "full" }),
      }),
    ).toBe("model:m+full");
    expect(
      benchmarkMethod({
        target_kind: "crew",
        target_json: JSON.stringify({ crew: "answerer", formation: "deliberation" }),
      }),
    ).toBe("crew:deliberation");
    expect(
      benchmarkMethod({
        target_kind: "population",
        target_json: JSON.stringify({ formation: { kind: "lead", researchers: 3 } }),
      }),
    ).toBe("population:lead");
    expect(benchmarkMethod({ target_kind: null, target_json: null, label: "x" })).toBe("model:x");
  });

  it("gives benchmark outcomes no delivery consumers", () => {
    expect(consumersFor("benchmark")).toEqual([]);
    expect(consumersFor("forecast")).toEqual(["lessons", "history"]);
  });
});
