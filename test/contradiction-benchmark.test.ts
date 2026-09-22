// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Multi-writer contradiction benchmark: fully offline against the real
 * durable service, deterministic per seed. Checks the result schema,
 * run-to-run determinism, the policy properties the harness exists to measure
 * (evidence_weighted + provenance beats Sybil rings; last_writer_wins closes
 * everything but follows write order; keep_both closes nothing by supersession
 * yet marks every peer), the validity-closure invariant (no superseded record
 * served as current), and that the dashboard hygiene ratios agree with the
 * benchmark's own counts. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTRADICTION_ARMS,
  CONTRADICTION_KIND,
  CONTRADICTION_RESULT_SCHEMA,
  type ContradictionReport,
  type ContradictionResult,
  generateScenario,
  runCli,
  runContradictionBenchmark,
  stripVolatile,
  validateContradictionResult,
} from "../benchmarks/memory/contradiction";
import { RateLimiter } from "../src/auth/rate-limiter";

const SCENARIO = {
  writers: 4,
  facts: 16,
  conflict: 0.5,
  sybils: 3,
  sybilShare: 0.5,
  sources: true,
  wrongSources: false,
  order: "random" as const,
  corroboration: 0.3,
};

describe("scenario generator", () => {
  test("is deterministic per seed and shapes conflicts as declared", () => {
    const a = generateScenario(7, SCENARIO);
    const b = generateScenario(7, SCENARIO);
    expect(a).toEqual(b);
    expect(generateScenario(8, SCENARIO)).not.toEqual(a);
    expect(a.facts).toHaveLength(SCENARIO.facts);
    expect(a.sybils).toEqual(["Fresh1", "Fresh2", "Fresh3"]);
    for (const writer of a.writers) expect(writer.standing).toBeGreaterThanOrEqual(5);
    for (const fact of a.facts) {
      const gold = fact.assertions.filter((x) => x.role === "gold");
      const wrong = fact.assertions.filter((x) => x.role === "wrong");
      expect(gold).toHaveLength(1);
      expect(wrong).toHaveLength(fact.conflict ? 1 : 0);
      if (fact.conflict) {
        expect(fact.wrong).not.toBe(fact.gold);
        expect(wrong[0]!.writer).not.toBe(gold[0]!.writer);
        if (fact.sybil) {
          expect(wrong[0]!.writer).toBe("Fresh1");
          // Copies: one text, captured by every OTHER fresh account.
          expect(new Set(wrong[0]!.sources.map((s) => s.text)).size).toBe(1);
          expect(wrong[0]!.sources.map((s) => s.by).sort()).toEqual(["Fresh2", "Fresh3"]);
        } else {
          // An honest mistake is unsourced unless --wrong-sources.
          expect(wrong[0]!.sources).toHaveLength(0);
        }
      }
      // Gold provenance comes from OTHER established writers, never the wrong writer.
      for (const source of gold[0]!.sources) {
        expect(source.by).not.toBe(wrong[0]?.writer);
        expect(source.by.startsWith("Writer")).toBe(true);
      }
      for (const corroboration of fact.assertions.filter((x) => x.role === "corroboration"))
        expect(corroboration.value).toBe(fact.gold);
    }
  });

  test("order knobs place the wrong assertion strictly last / first", () => {
    const goldFirst = generateScenario(3, { ...SCENARIO, order: "gold-first" });
    for (const fact of goldFirst.facts.filter((f) => f.conflict))
      expect(fact.assertions.at(-1)!.role).toBe("wrong");
    const wrongFirst = generateScenario(3, { ...SCENARIO, order: "wrong-first" });
    for (const fact of wrongFirst.facts.filter((f) => f.conflict))
      expect(fact.assertions[0]!.role).toBe("wrong");
  });
});

describe("contradiction benchmark (offline)", () => {
  let dir: string;
  let report: ContradictionReport;
  let result: ContradictionResult;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "contradiction-bench-"));
    report = await runContradictionBenchmark({
      seeds: 2,
      ...SCENARIO,
      resultsDir: dir,
      quiet: true,
    });
    result = report.result;
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("writes a schema-valid JSON and a markdown summary, offline, and restores the rate limiter", () => {
    expect(validateContradictionResult(result)).toEqual([]);
    expect(result.schema).toBe(CONTRADICTION_RESULT_SCHEMA);
    expect(result.config.kind).toBe(CONTRADICTION_KIND);
    expect(result.config.offline).toBe(true);
    expect(result.config.networkAttempts).toBe(0);
    expect(result.config.seeds).toEqual([1, 2]);
    expect(result.config.arms).toEqual([...CONTRADICTION_ARMS]);
    expect(report.file && existsSync(report.file)).toBe(true);
    expect(report.summaryPath && existsSync(report.summaryPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(report.file!, "utf8"));
    expect(validateContradictionResult(onDisk)).toEqual([]);
    expect(readFileSync(report.summaryPath!, "utf8")).toContain(
      "# contradiction — multi-writer contradiction benchmark",
    );
    expect(RateLimiter.bypass).toBe(false);
    // Every conflicted fact was actually a contradiction before the loop.
    for (const seed of result.perSeed) {
      expect(seed.conflictFacts).toBeGreaterThan(0);
      expect(seed.competingBefore).toBeGreaterThanOrEqual(2 * seed.conflictFacts);
      expect(seed.sybilFacts).toBeGreaterThan(0);
    }
  });

  test("evidence_weighted with independent gold provenance beats Sybil rings and honest mistakes", () => {
    const m = result.arms.evidence_weighted!;
    expect(m.unresolvedRate.pooled).toBe(0);
    expect(m.winnerAccuracy.denominator).toBeGreaterThan(0);
    expect(m.winnerAccuracy.pooled!).toBeGreaterThanOrEqual(0.95);
    expect(m.sybilGoldWinRate.denominator).toBeGreaterThan(0);
    expect(m.sybilGoldWinRate.pooled).toBe(1);
    expect(m.servedWrong.pooled).toBe(0);
    expect(m.unsafeServed.pooled).toBe(0);
  });

  test("last_writer_wins closes every contradiction but only follows write order", () => {
    const m = result.arms.last_writer_wins!;
    expect(m.unresolvedRate.pooled).toBe(0);
    expect(m.contradictions.after).toBe(0);
    expect(m.winnerAccuracy.pooled!).toBeLessThan(
      result.arms.evidence_weighted!.winnerAccuracy.pooled!,
    );
    expect(m.unsafeServed.pooled).toBe(0);
  });

  test("await_confirmation: confirmation alone settles nothing in the review index; the settle does", () => {
    const m = result.arms.await_confirmation!;
    expect(m.contradictions.afterConfirm).toBe(m.contradictions.before);
    expect(m.contradictions.after).toBe(0);
    expect(m.winnerAccuracy.pooled).toBe(1);
    expect(m.unsafeServed.pooled).toBe(0);
  });

  test("keep_both leaves nothing competing, marks every peer, and serves both values", () => {
    const m = result.arms.keep_both!;
    expect(m.unresolvedRate.pooled).toBe(0);
    expect(m.peersMarked.denominator).toBe(m.contradictions.before);
    expect(m.peersMarked.pooled).toBe(1);
    expect(m.winnerAccuracy.denominator).toBe(0);
    expect(m.servedAmbiguous.numerator).toBe(m.conflictFacts);
    expect(m.unsafeServed.pooled).toBe(0);
    expect(m.searchServesSuperseded.pooled).toBe(0);
  });

  test("no arm ever serves a superseded record as current; lexical search still lists them", () => {
    for (const arm of CONTRADICTION_ARMS) {
      const m = result.arms[arm]!;
      expect(m.unsafeServed.numerator).toBe(0);
      expect(m.servedAmbiguous.numerator).toBe(arm === "keep_both" ? m.conflictFacts : 0);
    }
    // search is not validity-filtered: every superseding policy leaves the
    // loser reachable by lexical search for its fact.
    for (const arm of ["last_writer_wins", "evidence_weighted", "await_confirmation"] as const)
      expect(result.arms[arm]!.searchServesSuperseded.numerator).toBe(
        result.arms[arm]!.conflictFacts,
      );
  });

  test("hygiene ratios agree with the benchmark's own counts", () => {
    for (const arm of CONTRADICTION_ARMS) expect(result.arms[arm]!.hygiene.agrees).toBe(true);
    for (const seed of result.perSeed) {
      const before = seed.hygiene.before;
      const after = seed.hygiene.after;
      expect(before.unresolvedContradictionRate.value).toBe(1);
      expect(before.contradictionRate.numerator).toBe(seed.competingBefore);
      expect(before.contradictionRate.denominator).toBe(seed.records);
      expect(after.unresolvedContradictionRate.numerator).toBe(seed.competingAfter);
      expect(after.unresolvedContradictionRate.value).toBe(seed.unresolvedRate);
      // Settled members (winner/superseded/peer) replace the open contradictions one-for-one.
      expect(after.contradictionRate.numerator).toBe(seed.competingBefore);
    }
  });
});

describe("contradiction benchmark knobs", () => {
  test("same seeds → identical results apart from timestamps and runtimes", async () => {
    const opts = {
      seeds: 1,
      seedStart: 3,
      ...SCENARIO,
      facts: 10,
      arms: ["last_writer_wins", "evidence_weighted"] as const,
      resultsDir: "",
      quiet: true,
    };
    const a = await runContradictionBenchmark(opts);
    const b = await runContradictionBenchmark(opts);
    expect(a.file).toBeNull();
    expect(stripVolatile(a.result)).toEqual(stripVolatile(b.result));
    expect(a.result.config.startedAt).not.toBe(b.result.config.startedAt);
  }, 30_000);

  test("last_writer_wins follows write order: 0 % when the wrong value is written last, 100 % when first", async () => {
    const base = {
      seeds: 1,
      ...SCENARIO,
      facts: 12,
      arms: ["last_writer_wins"] as const,
      resultsDir: "",
      quiet: true,
    };
    const goldFirst = await runContradictionBenchmark({ ...base, order: "gold-first" });
    const wrongFirst = await runContradictionBenchmark({ ...base, order: "wrong-first" });
    const late = goldFirst.result.arms.last_writer_wins!;
    const early = wrongFirst.result.arms.last_writer_wins!;
    expect(late.unresolvedRate.pooled).toBe(0);
    expect(late.winnerAccuracy.denominator).toBeGreaterThan(0);
    expect(late.winnerAccuracy.pooled).toBe(0);
    expect(late.servedWrong.numerator).toBe(late.conflictFacts);
    expect(early.winnerAccuracy.pooled).toBe(1);
  }, 30_000);

  test("without independent provenance evidence_weighted loses the Sybil facts", async () => {
    const run = await runContradictionBenchmark({
      seeds: 1,
      ...SCENARIO,
      facts: 12,
      sources: false,
      arms: ["evidence_weighted"] as const,
      resultsDir: "",
      quiet: true,
    });
    const m = run.result.arms.evidence_weighted!;
    expect(m.sybilGoldWinRate.denominator).toBeGreaterThan(0);
    expect(m.sybilGoldWinRate.pooled).toBe(0);
    expect(m.unresolvedRate.pooled).toBe(0);
  }, 30_000);

  test("--help exits 0", async () => {
    const log = console.log;
    const lines: string[] = [];
    console.log = (line: string) => void lines.push(line);
    try {
      expect(await runCli(["--help"])).toBe(0);
    } finally {
      console.log = log;
    }
    expect(lines.join("\n")).toContain("--sybils");
  });
});
