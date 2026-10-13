// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  compareGroup,
  compareRunReport,
  getCompareRun,
  parseArms,
  resetCompareRunsForTests,
  startCompareRun,
} from "../src/engine/benchmark-compare-run";
import {
  BenchmarkRunner,
  type BenchmarkRunOptions,
  benchmarkRunConfig,
  type HarnessResult,
  setSourceRevisionForTests,
} from "../src/engine/benchmark-runner";
import { renderCompareRun } from "../src/engine/commands/benchmark";
import { MarinaDB } from "../src/persistence/database";
import { createTestEngine } from "./engine-fixture";
import { stripAnsi, until } from "./helpers";

const ITEMS = 20;

/** A harness result: item i correct when `right(i)`, $0.01 per item. */
function result(right: (i: number) => boolean): HarnessResult {
  const items = Array.from({ length: ITEMS }, (_, i) => ({
    id: `q${i}`,
    correct: right(i),
    latencyMs: 100 + i,
    usage: { costUsd: 0.01 },
  }));
  return {
    scores: { overall: items.filter((x) => x.correct).length / ITEMS },
    metadata: { total: ITEMS, answered: ITEMS },
    items,
  } as HarnessResult;
}

/** A runner that "runs" synchronously: the run row, then its recorded result. */
function fakeRunner(
  db: MarinaDB,
  outcome: (opts: BenchmarkRunOptions, n: number) => HarnessResult,
) {
  const real = new BenchmarkRunner(db, () => {});
  let n = 0;
  return {
    started: [] as BenchmarkRunOptions[],
    start(opts: BenchmarkRunOptions) {
      this.started.push(opts);
      const id = `br_fake_${++n}`;
      const config = benchmarkRunConfig(opts, {});
      db.insertBenchmarkRun({
        id,
        benchmark: opts.benchmark,
        config_hash: "fake",
        config_json: JSON.stringify(config),
        status: "running",
        started_at: Date.now() + n,
      });
      real.recordHarnessResult(
        id,
        opts,
        Date.now(),
        { result: outcome(opts, n) },
        { costUsd: 0.2 },
      );
      return { id, configHash: "fake" };
    },
    async done() {},
  };
}

describe("compare-run arms", () => {
  it("parses two distinct arms; + joins members inside one arm", () => {
    expect(parseArms("bare,on")).toEqual(["bare", "on"]);
    expect(parseArms("bare,lessons+obligations")).toEqual(["bare", "lessons,obligations"]);
    expect(parseArms("bare")).toHaveProperty("error");
    expect(parseArms("on,on")).toHaveProperty("error");
    expect(parseArms("bare,nonsense")).toHaveProperty("error");
    expect(parseArms(undefined)).toHaveProperty("error");
    expect(compareGroup("cmp_x", "lessons,obligations")).toBe("cmp:cmp_x:lessons+obligations");
  });
});

describe("compare-run", () => {
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(":memory:");
    resetCompareRunsForTests();
    setSourceRevisionForTests("abc123def456");
  });
  afterEach(() => {
    db.close();
    setSourceRevisionForTests(undefined);
  });

  it("records an in-world run's items, cost and target (model, stack, source)", () => {
    const runner = fakeRunner(db, () => result((i) => i % 2 === 0));
    const { id } = runner.start({ benchmark: "smoke", arm: "on", model: "m1" });
    const run = db.getBenchmarkRun(id)!;
    expect(db.getBenchmarkItems(id)).toHaveLength(ITEMS);
    expect(run.cost_usd).toBeCloseTo(0.2);
    expect(run.n).toBe(ITEMS);
    const target = JSON.parse(run.target_json!);
    expect(target).toMatchObject({ model: "m1", source: "abc123def456" });
    expect(target.stack).toBeTruthy();
    // A bare arm records no stack: it stays plain model evidence.
    const bare = runner.start({ benchmark: "smoke", arm: "bare", model: "m1" });
    expect(JSON.parse(db.getBenchmarkRun(bare.id)!.target_json!).stack).toBeUndefined();
  });

  it("runs both arms per replicate under one group each and reports the paired result", async () => {
    // Arm "on" answers 16/20, "bare" 10/20, on the same items.
    const runner = fakeRunner(db, (o) =>
      result((i) => (o.arm === "bare" ? i % 2 === 0 : i % 5 !== 0)),
    );
    const job = startCompareRun(runner, {
      benchmark: "smoke",
      arms: ["on", "bare"],
      replicates: 2,
      capUsd: 4,
      model: "m1",
      owner: "e_1",
    });
    await until(() => getCompareRun(job.id)?.status === "completed");
    expect(runner.started).toHaveLength(4);
    // Each run gets an equal share of the cap and its arm's group.
    expect(runner.started.every((o) => o.capUsd === 1)).toBe(true);
    expect(runner.started.map((o) => o.replicateGroup)).toEqual([
      compareGroup(job.id, "on"),
      compareGroup(job.id, "bare"),
      compareGroup(job.id, "on"),
      compareGroup(job.id, "bare"),
    ]);

    const report = compareRunReport(db, job.id, job.spec.arms)!;
    expect(report.a.valid).toHaveLength(2);
    expect(report.a.successes).toBe(32);
    expect(report.a.attempts).toBe(40);
    expect(report.a.wilsonLow).toBeGreaterThan(0.6);
    expect(report.a.wilsonHigh).toBeLessThan(0.92);
    expect(report.a.costPerSuccessUsd).toBeCloseTo(0.4 / 32);
    expect(report.b.costPerSuccessUsd).toBeCloseTo(0.4 / 20);
    expect(report.a.measured).toEqual(["m1@abc123def456"]);
    expect(report.warnings).toEqual([]);
    expect(report.paired?.delta).toBeCloseTo(0.3);
    expect(report.paired?.replicated).toBe(true);
    // The report is rebuilt from the ledger alone (after a restart, too).
    resetCompareRunsForTests();
    const fromLedger = compareRunReport(db, job.id)!;
    expect(new Set([fromLedger.a.arm, fromLedger.b.arm])).toEqual(new Set(["on", "bare"]));
    const text = stripAnsi(renderCompareRun(job.id, undefined, fromLedger));
    expect(text).toContain("Wilson 95%");
    expect(text).toContain("per success");
    expect(text).toContain("m1@abc123def456");
    expect(text).toContain("paired");
  });

  it("flags arms that ran different code as unpaired", async () => {
    const runner = fakeRunner(db, () => result((i) => i % 2 === 0));
    // The bare arm's runs come from a different source revision.
    const wrapped = {
      ...runner,
      start(o: BenchmarkRunOptions) {
        setSourceRevisionForTests(o.arm === "bare" ? "ffffffffffff" : "abc123def456");
        return runner.start.call(runner, o);
      },
    };
    const job = startCompareRun(wrapped, {
      benchmark: "smoke",
      arms: ["on", "bare"],
      replicates: 1,
      capUsd: 1,
      owner: "e_1",
    });
    await until(() => getCompareRun(job.id)?.status === "completed");
    const report = compareRunReport(db, job.id, job.spec.arms)!;
    expect(report.warnings.join(" ")).toContain("not paired on model@source");
  });

  it("stops when no run of a replicate can start", async () => {
    const runner = {
      start(): never {
        throw new Error("dataset not cached");
      },
      async done() {},
    };
    const job = startCompareRun(runner, {
      benchmark: "smoke",
      arms: ["on", "bare"],
      replicates: 3,
      capUsd: 1,
      owner: "e_1",
    });
    await until(() => getCompareRun(job.id)?.status !== "running");
    expect(job.status).toBe("failed");
    expect(job.slots.filter((s) => s.error)).toHaveLength(2);
    expect(stripAnsi(renderCompareRun(job.id, job, null))).toContain("dataset not cached");
  });
});

describe("benchmark compare-run command", () => {
  let fx: ReturnType<typeof createTestEngine>;
  beforeEach(() => {
    resetCompareRunsForTests();
    fx = createTestEngine();
  });
  afterEach(() => fx.dispose());
  const text = (c: { messages: { data?: { text?: unknown } }[] }) =>
    stripAnsi(c.messages.map((m) => String(m.data?.text ?? "")).join("\n"));

  it("needs a cap and two arms, and lists no comparisons on a fresh server", async () => {
    const { connection, entityId } = fx.login("Ada");
    fx.engine.entities.get(entityId)!.properties.rank = 4;
    await fx.engine.processCommand(entityId, "benchmark compare-run smoke arms:bare,on");
    expect(text(connection)).toContain("cap:<usd> is required");
    await fx.engine.processCommand(entityId, "benchmark compare-run smoke arms:bare cap:1");
    expect(text(connection)).toContain("exactly two arms");
    await fx.engine.processCommand(
      entityId,
      "benchmark compare-run smoke arms:bare,on cap:1 replicates:99",
    );
    expect(text(connection)).toContain("replicates: a whole number from 1 to 10");
    await fx.engine.processCommand(entityId, "benchmark compare-run status");
    expect(text(connection)).toContain("No comparisons in this server");
    await fx.engine.processCommand(entityId, "benchmark compare-run status cmp_nope");
    expect(text(connection)).toContain("No comparison");
  });
});
