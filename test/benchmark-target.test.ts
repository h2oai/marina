// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * In-world `benchmark run` measures RESIDENTS: an explicit crew, or the
 * world's serving crew; a bare model only as an explicitly named, labelled
 * control. Crew runs get a run key and file to the ledger as `crew` runs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  BenchmarkRunner,
  benchmarkRunConfig,
  crewOfTarget,
  harnessInvocation,
  inWorldTarget,
  runKeyGrant,
} from "../src/engine/benchmark-runner";
import { resolveRunTarget } from "../src/engine/benchmark-target";
import { canonicalModifierArgs } from "../src/engine/commands/benchmark";
import { extractModifiers } from "../src/engine/parse-input";
import { MarinaDB } from "../src/persistence/database";

const live = ["marina:answerer", "marina:scouts"];

describe("resolveRunTarget", () => {
  test("crew:<name> measures that crew's residents", () => {
    expect(
      resolveRunTarget({
        crew: "answerer",
        orchestrations: live,
        crews: [{ name: "answerer", formation: "verification" }],
      }),
    ).toEqual({
      kind: "crew",
      model: "marina:answerer",
      crew: "answerer",
      formation: "verification",
      defaulted: false,
    });
  });

  test("a crew that is not serving is refused, never silently replaced by the bare model", () => {
    const r = resolveRunTarget({ crew: "ghost", orchestrations: live, crews: [] });
    expect("error" in r && r.error).toContain("crew ghost is not serving");
  });

  test("model:<id> is a labelled control; model:marina:<name> is still the crew", () => {
    expect(resolveRunTarget({ model: "marina", orchestrations: live, crews: [] })).toEqual({
      kind: "model",
      model: "marina",
      control: true,
    });
    expect(
      resolveRunTarget({ model: "openrouter/a/b", orchestrations: [], crews: [] }),
    ).toMatchObject({ kind: "model", control: true });
    expect(resolveRunTarget({ model: "marina:scouts", orchestrations: live, crews: [] })).toEqual({
      kind: "crew",
      model: "marina:scouts",
      crew: "scouts",
      defaulted: false,
    });
    expect(
      "error" in
        resolveRunTarget({ crew: "answerer", model: "marina", orchestrations: live, crews: [] }),
    ).toBe(true);
  });

  test("no target: the world's one serving crew", () => {
    expect(
      resolveRunTarget({
        orchestrations: live,
        crews: [{ name: "answerer", formation: "delphi" }],
      }),
    ).toEqual({
      kind: "crew",
      model: "marina:answerer",
      crew: "answerer",
      formation: "delphi",
      defaulted: true,
    });
    // A world with no crew records but one live endpoint: its residents.
    expect(resolveRunTarget({ orchestrations: ["marina:solo"], crews: [] })).toMatchObject({
      kind: "crew",
      crew: "solo",
      defaulted: true,
    });
  });

  test("no target and no residents, or several crews: refused with what to pass", () => {
    const none = resolveRunTarget({ orchestrations: [], crews: [] });
    expect("error" in none && none.error).toContain("No serving crew");
    expect("error" in none && none.error).toContain("model:<id>");
    const many = resolveRunTarget({
      orchestrations: live,
      crews: [{ name: "answerer" }, { name: "scouts" }],
    });
    expect("error" in many && many.error).toContain("crew:answerer, crew:scouts");
  });
});

describe("in-world run labelling", () => {
  test("crew target vs bare-model control", () => {
    expect(crewOfTarget("marina:answerer")).toBe("answerer");
    for (const m of ["marina", "marina/default", "marina/verify:a+b", "openai/gpt-x"])
      expect(crewOfTarget(m)).toBeUndefined();

    const crew = benchmarkRunConfig(
      { benchmark: "smoke", model: "marina:answerer", formation: "verification" },
      {},
    );
    expect(crew).toMatchObject({ targetKind: "crew", formation: "verification" });
    expect(crew).not.toHaveProperty("control");
    const control = benchmarkRunConfig({ benchmark: "smoke", model: "marina" }, {});
    expect(control).toMatchObject({ targetKind: "model", control: true });

    expect(inWorldTarget({ model: "marina:answerer", formation: "delphi" })).toEqual({
      crew: "answerer",
      formation: "delphi",
      model: "marina:answerer",
    });
    expect(inWorldTarget({ model: "marina", formation: "delphi" })).toEqual({ model: "marina" });
  });

  test("a crew run always gets a run key; a plain control keeps the internal token", () => {
    expect(runKeyGrant("r1", { benchmark: "smoke" }, { targetKind: "crew" })).toEqual({
      runId: "r1",
      evalTag: "benchmark=smoke; mode=measure",
    });
    expect(runKeyGrant("r2", { benchmark: "smoke" }, { targetKind: "model" })).toBeUndefined();
    expect(
      runKeyGrant("r3", { benchmark: "smoke", capUsd: 2 }, { targetKind: "model" }),
    ).toMatchObject({ capUsd: 2 });
  });

  test("the resolved judge and the self-judge opt-in reach the harness", () => {
    const { args } = harnessInvocation(
      "frames",
      {
        limit: 5,
        seed: 1,
        model: "marina",
        judgeModel: "marina/default",
        selfJudge: true,
        concurrency: 1,
      },
      { endpoint: "http://127.0.0.1:1" },
    );
    expect(args[args.indexOf("--judge-model") + 1]).toBe("marina/default");
    expect(args).toContain("--self-judge");
  });
});

describe("BenchmarkRunner judge and ledger target", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
  });
  afterEach(() => db.close());

  class ReadyRunner extends BenchmarkRunner {
    override datasetReady(): boolean {
      return true;
    }
  }

  test("a judged control that would grade itself is refused before it starts", () => {
    const runner = new ReadyRunner(db, () => {});
    expect(() => runner.start({ benchmark: "frames", model: "marina" })).toThrow(
      /must not grade itself/,
    );
    // Nothing was recorded.
    expect(db.queryBenchmarkRuns({ benchmark: "frames", limit: 5 })).toEqual([]);
    // The concrete default model counts as the default judge.
    const named = new ReadyRunner(
      db,
      () => {},
      () => ({ endpoint: "http://127.0.0.1:1" }),
      () => "openai/gpt-x",
    );
    expect(() => named.start({ benchmark: "frames", model: "openai/gpt-x" })).toThrow(
      /must not grade itself/,
    );
  });

  test("a crew run files as a crew target with its formation", () => {
    const runner = new BenchmarkRunner(db, () => {});
    const config = benchmarkRunConfig(
      { benchmark: "smoke", model: "marina:answerer", formation: "verification" },
      {},
    );
    db.insertBenchmarkRun({
      id: "br_crew",
      benchmark: "smoke",
      config_hash: "h",
      config_json: JSON.stringify(config),
      status: "running",
      started_at: Date.now(),
    });
    runner.recordHarnessResult("br_crew", { benchmark: "smoke" }, Date.now(), {
      result: {
        scores: { overall: 1 },
        metadata: { total: 1, answered: 1 },
        items: [{ id: "s1", correct: true, traceId: "t-unknown" } as never],
      },
    });
    const row = db.getBenchmarkRun("br_crew");
    expect(row?.target_kind).toBe("crew");
    expect(JSON.parse(row?.target_json ?? "{}")).toMatchObject({
      crew: "answerer",
      formation: "verification",
    });
  });

  test("a control run files as a model target", () => {
    const runner = new BenchmarkRunner(db, () => {});
    db.insertBenchmarkRun({
      id: "br_ctl",
      benchmark: "smoke",
      config_hash: "h",
      config_json: JSON.stringify(benchmarkRunConfig({ benchmark: "smoke", model: "marina" }, {})),
      status: "running",
      started_at: Date.now(),
    });
    runner.recordHarnessResult("br_ctl", { benchmark: "smoke" }, Date.now(), {
      result: {
        scores: { overall: 1 },
        metadata: { total: 1, answered: 1 },
        items: [{ id: "s1", correct: true }],
      },
    });
    const row = db.getBenchmarkRun("br_ctl");
    expect(row?.target_kind).toBe("model");
    expect(JSON.parse(row?.config_json ?? "{}")).toMatchObject({ control: true });
  });
});

describe("benchmark run modifier grammar", () => {
  test("key:value and key=value parse like --key value; the first colon splits", () => {
    const known = ["crew", "model", "cap", "arm", "self-judge", "limit"];
    const raw = canonicalModifierArgs(
      ["model:marina:answerer", "cap=5", "arm:bare", "self-judge:on", "--limit", "3"],
      known,
    );
    expect(extractModifiers(raw, known).modifiers).toEqual({
      model: "marina:answerer",
      cap: "5",
      arm: "bare",
      "self-judge": "on",
      limit: "3",
    });
    // Unknown keys pass through untouched.
    expect(canonicalModifierArgs(["x:y"], known)).toBe("x:y");
  });
});
