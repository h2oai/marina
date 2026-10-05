// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configFromSlot,
  fileSelectionPromotion,
  forecastConfigSlot,
  liveConfig,
} from "../benchmarks/forecasting/cli";
import type { Ranked } from "../benchmarks/forecasting/select";
import {
  applyRouteEvidence,
  type EvidenceSource,
  routeEvidenceSettingsFromEnv,
} from "../src/engine/benchmark-evidence";
import { BENCHMARK_FAMILIES, benchmarksInFamilies } from "../src/engine/benchmark-families";
import { sliceHash } from "../src/engine/benchmark-ledger";
import { fileSlotPromotion } from "../src/engine/benchmark-promotion";
import { BENCHMARKS } from "../src/engine/benchmark-runner";
import {
  type DefaultResolution,
  familySlotKey,
  onDefaultResolved,
  resolveDefault,
  setUpstreamSeedSource,
} from "../src/engine/default-resolution";
import { forecastDefaultOverrides, resolveForecastDefaults } from "../src/forecast/defaults";
import { parseVerifyModel } from "../src/net/model-api/verify";
import type { BenchmarkItemRow } from "../src/persistence/database";
import { MarinaDB } from "../src/persistence/database";
import { createTestEngine } from "./engine-fixture";

const IDS = Array.from({ length: 120 }, (_, i) => `item-${i}`);
const OPERATOR = { key: "operator", keyOf: (id: string) => id };

/** One configuration as `replicates` ledger runs in one group (`<id>`, `<id>-r2`, …). */
function record(
  db: MarinaDB,
  id: string,
  target: unknown,
  correct: (i: number) => boolean,
  opts: { benchmark?: string; replicates?: number; ids?: string[]; judge?: string } = {},
) {
  const ids = opts.ids ?? IDS;
  for (let r = 1; r <= (opts.replicates ?? 2); r++) {
    const runId = r === 1 ? id : `${id}-r${r}`;
    const outcome = ids.map((item_id, i) => ({
      id: i,
      run_id: runId,
      item_id,
      correct: correct(i),
      score: null,
      latency_ms: null,
      cost_usd: 0.01,
      trace_id: null,
      participants_json: null,
      judge_verdict: null,
    }));
    db.recordBenchmarkLedgerRun(
      {
        id: runId,
        benchmark: opts.benchmark ?? "synthetic",
        config_hash: runId,
        config_json: "{}",
        agent_id: null,
        started_at: 0,
        completed_at: 1,
        duration_ms: 1,
        score: outcome.filter((o) => o.correct).length / outcome.length,
        answered: outcome.length,
        total: outcome.length,
        cost_usd: null,
        n: outcome.length,
        ci_low: 0,
        ci_high: 1,
        seed: 1,
        slice_hash: sliceHash(ids),
        judge: opts.judge ?? "judge/model",
        target_kind: "population",
        target_json: JSON.stringify(target),
        label: runId,
        source: "import",
        content_hash: null,
        replicate_group: id,
      },
      outcome,
    );
  }
}

const weak = (i: number) => i % 5 < 2; // 40 %
const strong = (i: number) => i % 5 < 4; // 80 %

let db: MarinaDB;
let traces: DefaultResolution<unknown>[];
let stopTrace: () => void;

beforeEach(() => {
  db = new MarinaDB(":memory:");
  traces = [];
  stopTrace = onDefaultResolved((r) => traces.push(r));
});

afterEach(() => {
  stopTrace();
  setUpstreamSeedSource(undefined);
  db.close();
});

const readModel = (v: unknown) => {
  const m = (v as { model?: unknown } | null)?.model;
  return typeof m === "string" ? m : undefined;
};

describe("resolveDefault precedence", () => {
  const spec = (env?: string) => ({
    slot: "crew:test",
    board: "board-a",
    families: ["reasoning"],
    env: { name: "MARINA_TEST_MODEL", value: env },
    read: readModel,
    builtIn: "built-in-model",
    db,
  });

  it("nothing promoted: the built-in answers, traced with every layer it passed", () => {
    const r = resolveDefault(spec());
    expect(r.value).toBe("built-in-model");
    expect(r.source).toBe("builtin");
    expect(r.consulted.map((c) => `${c.layer}:${c.outcome}`)).toEqual([
      "env:unset",
      "slot:unset",
      "family:unset",
      "builtin:answered",
    ]);
    expect(traces).toHaveLength(1);
    expect(traces[0]?.reason).toContain("crew:test:board-a unset");
  });

  it("env > local slot > family slot > upstream seed > built-in", () => {
    // Upstream seed only: it answers below every local layer.
    setUpstreamSeedSource((key) =>
      key === familySlotKey("crew:test", "reasoning")
        ? { value: { model: "upstream-model" }, version: "v1" }
        : undefined,
    );
    expect(resolveDefault(spec()).source).toBe("upstream");
    expect(resolveDefault(spec()).value).toBe("upstream-model");

    // A family slot (filled directly: the per-board path refuses family slots).
    record(db, "fam", { model: "family-model" }, weak);
    db.recordBenchmarkPromotion({
      slot: familySlotKey("crew:test", "reasoning"),
      outcome: "seeded",
      challenger_run_id: "fam",
      incumbent_run_id: null,
      value_json: JSON.stringify({ model: "family-model" }),
      actor: "operator",
      stats_json: null,
      reason: "test",
      created_at: 1,
    });
    expect(resolveDefault(spec())).toMatchObject({ source: "family", value: "family-model" });

    // The board's own earned slot beats the family slot.
    record(db, "base", { model: "board-model" }, weak);
    expect(
      fileSlotPromotion(db, { slot: "crew:test:board-a", runId: "base", actor: OPERATOR }).kind,
    ).toBe("seeded");
    const local = resolveDefault(spec());
    expect(local).toMatchObject({
      source: "slot",
      key: "crew:test:board-a",
      value: "board-model",
      incumbentRunId: "base",
    });

    // The operator's env var always wins.
    expect(resolveDefault(spec("env-model"))).toMatchObject({
      source: "env",
      key: "MARINA_TEST_MODEL",
      value: "env-model",
    });
  });

  it("skips an invalidated incumbent and an unreadable value", () => {
    record(db, "base", { model: "board-model" }, weak);
    fileSlotPromotion(db, { slot: "crew:test:board-a", runId: "base", actor: OPERATOR });
    db.setBenchmarkRunValidity({
      run_id: "base",
      action: "invalidate",
      reason: "infra",
      actor: "operator",
      source: "operator",
      created_at: 2,
    });
    const r = resolveDefault(spec());
    expect(r.source).toBe("builtin");
    expect(r.consulted[1]).toMatchObject({ layer: "slot", outcome: "invalidated" });

    record(db, "odd", { crew: "no model here" }, weak);
    fileSlotPromotion(db, { slot: "crew:other", runId: "odd", actor: OPERATOR });
    const odd = resolveDefault({ ...spec(), slot: "crew:other", board: undefined });
    expect(odd.source).toBe("builtin");
    expect(odd.consulted[1]).toMatchObject({ key: "crew:other", outcome: "unreadable" });
  });

  it("the per-board path never fills a family slot", () => {
    record(db, "base", { model: "m" }, weak);
    const r = fileSlotPromotion(db, {
      slot: familySlotKey("crew:test", "reasoning"),
      runId: "base",
      actor: OPERATOR,
    });
    expect(r.kind).toBe("error");
    expect(db.listBenchmarkPromotions(familySlotKey("crew:test", "reasoning"))).toHaveLength(0);
  });
});

describe("a promotion flows through to the default", () => {
  it("verify checker: env > earned slot > the proposer; an explicit checker in the id wins", () => {
    expect(parseVerifyModel("marina/verify:p/x", {}, undefined, db)?.checker).toBe("p/x");
    record(db, "base", { model: "marina/verify:p/x+c/weak" }, weak);
    record(db, "strong", { model: "marina/verify:p/x+c/strong" }, strong);
    expect(
      fileSlotPromotion(db, { slot: "verify:checker", runId: "base", actor: OPERATOR }).kind,
    ).toBe("seeded");
    expect(parseVerifyModel("marina/verify:p/x", {}, undefined, db)?.checker).toBe("c/weak");
    const won = fileSlotPromotion(db, { slot: "verify:checker", runId: "strong", actor: OPERATOR });
    expect(won.kind).toBe("promoted");
    expect(parseVerifyModel("marina/verify:p/x", {}, undefined, db)?.checker).toBe("c/strong");
    expect(
      parseVerifyModel("marina/verify:p/x", { MARINA_VERIFY_CHECKER_MODEL: "c/env" }, undefined, db)
        ?.checker,
    ).toBe("c/env");
    expect(parseVerifyModel("marina/verify:p/x+c/mine", {}, undefined, db)?.checker).toBe("c/mine");
    // An earned checker this installation cannot reach is skipped (fails open).
    expect(parseVerifyModel("marina/verify:p/x", {}, undefined, db, () => false)?.checker).toBe(
      "p/x",
    );
    // No ledger (as before this change): the proposer checks itself.
    expect(parseVerifyModel("marina/verify:p/x", {})?.checker).toBe("p/x");
  });

  it("forecast surface: an earned configuration sets formation and analysts; env still wins", () => {
    const none = resolveForecastDefaults({ env: {}, db });
    expect(none.formation).toBe("ensemble");
    expect(forecastDefaultOverrides(none, {})).toEqual({});

    const config = {
      label: "delphi-trio",
      formation: "delphi",
      analysts: ["a/one", "b/two"],
      planner: "a/one",
      verify: true,
      verifier: "c/check",
    };
    record(db, "fc", { configuration: config }, weak);
    fileSlotPromotion(db, { slot: "forecast-config", runId: "fc", actor: OPERATOR });
    const earned = resolveForecastDefaults({ env: {}, db });
    expect(earned.formation).toBe("delphi");
    expect(forecastDefaultOverrides(earned, {})).toEqual({
      analysts: ["a/one", "b/two"],
      planner: "a/one",
      verifier: "c/check",
      verify: true,
    });
    expect(earned.resolutions.map((r) => r.source)).toEqual(["slot", "slot", "slot", "builtin"]);

    const env = {
      MARINA_FORECAST_FORMATION: "tournament",
      MARINA_FORECAST_ANALYSTS: "x/env",
      MARINA_FORECAST_VERIFIER: "x/check",
    };
    const operator = resolveForecastDefaults({ env, db });
    expect(operator.formation).toBe("tournament");
    expect(forecastDefaultOverrides(operator, env)).toEqual({});
  });

  it("forecast selection files a promotion that the live run then uses", () => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-default-"));
    try {
      const selectionPath = join(dir, "selection.json");
      const cheap = { label: "cheap", formation: "ensemble", analysts: ["openrouter/a/cheap"] };
      const better = { label: "better", formation: "delphi", analysts: ["openrouter/b/better"] };
      // Nothing promoted: exactly today's fallback, disclosed as not chosen.
      const before = liveConfig({ selectionPath, board: "board-x", db });
      expect(before.selected).toBe(false);
      expect(before.config.label).toBe("default (not selected)");

      const bench = "board-x-backtest";
      record(db, "sel-cheap", { configuration: cheap }, weak, { benchmark: bench });
      const ranking = (labels: Array<[string, string]>): Ranked[] =>
        labels.map(([label, run]) => ({
          label,
          config: label,
          status: "ranked",
          replicates: 2,
          mean: 0.5,
          ledgerRuns: [run, `${run}-r2`],
        }));
      const first = fileSelectionPromotion(db, {
        benchmark: "board-x",
        ranking: ranking([["cheap", "sel-cheap"]]),
      });
      expect(first).toMatchObject({ outcome: "seeded", slot: "forecast-config:board-x" });
      expect(liveConfig({ selectionPath, board: "board-x", db })).toMatchObject({
        config: { label: "cheap" },
        selected: true,
        source: "slot",
      });

      // A later selection on the same items: the stronger configuration earns it.
      record(db, "sel-better", { configuration: better }, strong, { benchmark: bench });
      const second = fileSelectionPromotion(db, {
        benchmark: "board-x",
        ranking: ranking([
          ["better", "sel-better"],
          ["cheap", "sel-cheap"],
        ]),
      });
      expect(second.outcome).toBe("promoted");
      expect(
        db.listBenchmarkPromotions(forecastConfigSlot("board-x")).map((r) => r.outcome),
      ).toEqual(["seeded", "promoted"]);
      const live = liveConfig({ selectionPath, board: "board-x", db });
      expect(live.config.label).toBe("better");
      expect(live.description).toContain("earned default forecast-config:board-x");

      // Re-filing the same winner is a no-op that never reads the holdout again.
      const again = fileSelectionPromotion(db, {
        benchmark: "board-x",
        ranking: ranking([["better", "sel-better"]]),
      });
      expect(again.outcome).toBe("skipped");
      expect(db.listBenchmarkPromotions(forecastConfigSlot("board-x"))).toHaveLength(2);

      // The operator's explicit --config still wins over the earned slot.
      const configsFile = join(dir, "configs.json");
      writeFileSync(configsFile, JSON.stringify([cheap]));
      const explicit = liveConfig({
        selectionPath,
        board: "board-x",
        db,
        label: "cheap",
        configsFile,
      });
      expect(explicit.config.label).toBe("cheap");
      expect(traces.at(-1)).toMatchObject({ source: "env", key: "--config" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a weaker selection winner is refused, recorded, and the slot keeps its incumbent", () => {
    const bench = "board-y-backtest";
    const good = { label: "good", formation: "ensemble", analysts: ["openrouter/a/good"] };
    const worse = { label: "worse", formation: "ensemble", analysts: ["openrouter/a/worse"] };
    record(db, "y-good", { configuration: good }, strong, { benchmark: bench });
    record(db, "y-worse", { configuration: worse }, weak, { benchmark: bench });
    const rank = (label: string, run: string): Ranked => ({
      label,
      config: label,
      status: "ranked",
      replicates: 2,
      mean: 0.5,
      ledgerRuns: [run, `${run}-r2`],
    });
    expect(
      fileSelectionPromotion(db, { benchmark: "board-y", ranking: [rank("good", "y-good")] })
        .outcome,
    ).toBe("seeded");
    const r = fileSelectionPromotion(db, {
      benchmark: "board-y",
      ranking: [rank("worse", "y-worse")],
    });
    expect(r.outcome).toBe("refused");
    expect(
      configFromSlot(JSON.parse(db.getBenchmarkDefault("forecast-config:board-y")!.value_json)),
    ).toMatchObject({ label: "good" });
  });

  it("a selection on a different item slice never reads the holdout", () => {
    const bench = "board-z-backtest";
    const a = { label: "a", formation: "ensemble", analysts: ["openrouter/a/a"] };
    const b = { label: "b", formation: "ensemble", analysts: ["openrouter/b/b"] };
    record(db, "z-a", { configuration: a }, weak, { benchmark: bench });
    record(db, "z-b", { configuration: b }, strong, {
      benchmark: bench,
      ids: IDS.map((id) => `${id}-new`),
    });
    const rank = (label: string, run: string): Ranked => ({
      label,
      config: label,
      status: "ranked",
      replicates: 2,
      mean: 0.5,
      ledgerRuns: [run, `${run}-r2`],
    });
    fileSelectionPromotion(db, { benchmark: "board-z", ranking: [rank("a", "z-a")] });
    const r = fileSelectionPromotion(db, { benchmark: "board-z", ranking: [rank("b", "z-b")] });
    expect(r.outcome).toBe("skipped");
    expect(r.reason).toContain("item slice");
    expect(db.listBenchmarkPromotions("forecast-config:board-z")).toHaveLength(1);
  });
});

describe("route evidence: observe by default, families from the role", () => {
  it("every family tag names a registered benchmark", () => {
    for (const name of Object.keys(BENCHMARK_FAMILIES)) expect(BENCHMARKS[name]).toBeDefined();
    expect(benchmarksInFamilies(["math"])).toEqual(["gsm8k", "math", "aime"]);
  });

  it("records the evidence pick from the role's declared families and never applies it", () => {
    const candidates = [
      { route: "fast", model: "openrouter/a/fast" },
      { route: "powerful", model: "openrouter/b/strong" },
    ];
    const rows: BenchmarkItemRow[] = [];
    const runs = [
      { id: "r-fast", model: "openrouter/a/fast", right: 15 },
      { id: "r-strong", model: "openrouter/b/strong", right: 36 },
    ];
    for (const run of runs) {
      for (let i = 0; i < 40; i++) {
        rows.push({
          id: rows.length,
          run_id: run.id,
          item_id: `q${i}`,
          correct: i < run.right ? 1 : 0,
          score: null,
          latency_ms: null,
          cost_usd: 0.01,
          trace_id: null,
          participants_json: null,
          judge_verdict: null,
        } as BenchmarkItemRow);
      }
    }
    const source: EvidenceSource = {
      queryBenchmarkRuns: (q) =>
        q.benchmark === "gsm8k"
          ? (runs.map((r) => ({
              id: r.id,
              target_kind: "model",
              target_json: JSON.stringify({ model: r.model }),
            })) as never)
          : [],
      getBenchmarkItemsForBenchmark: (b) => (b === "gsm8k" ? rows : []),
      getRole: (name) => (name === "solver" ? { traits: JSON.stringify(["numerate"]) } : undefined),
      getTrait: (name) =>
        name === "numerate" ? { capabilities: JSON.stringify({ families: ["math"] }) } : undefined,
    };
    const settings = routeEvidenceSettingsFromEnv({});
    expect(settings.mode).toBe("observe");
    const r = applyRouteEvidence(
      { route: "fast", model: "openrouter/a/fast" },
      candidates,
      "solver",
      settings,
      source,
    );
    expect(r).toMatchObject({ route: "fast", model: "openrouter/a/fast", applied: false });
    expect(r.signals).toMatchObject({
      evidence_mode: "observe",
      evidence_family_source: "role",
      evidence_pick: "powerful",
      evidence: "observed",
    });
    expect(String(r.signals.evidence_families)).toContain("gsm8k");

    // A role that declares nothing: no family, evidence never applies.
    const plain = applyRouteEvidence(
      { route: "fast", model: "openrouter/a/fast" },
      candidates,
      "writer",
      settings,
      source,
    );
    expect(plain.signals).toMatchObject({ evidence: "no_family" });
  });
});

describe("every resolution is traced as an engine event", () => {
  it("emits default_resolved naming the layer, until the engine shuts down", async () => {
    const fixture = createTestEngine();
    try {
      resolveDefault({
        slot: "crew:traced",
        env: { name: "MARINA_TRACED", value: undefined },
        read: readModel,
        builtIn: "m",
        db: fixture.db,
        surface: "test",
      });
      const event = fixture.engine.eventLog.find((e) => e.type === "default_resolved");
      expect(event).toMatchObject({
        type: "default_resolved",
        slot: "crew:traced",
        surface: "test",
        source: "builtin",
        value: "m",
      });
    } finally {
      await fixture.dispose();
    }
    const before = fixture.engine.eventLog.length;
    resolveDefault({ slot: "crew:after", read: readModel, builtIn: "m" });
    expect(fixture.engine.eventLog.length).toBe(before);
  });
});
