// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  applyRouteEvidence,
  collectEvidence,
  type EvidenceItem,
  type EvidenceSource,
  notMeasurablyWorse,
  pickByEvidence,
  pickWithRoleFallback,
  type RouteEvidenceSettings,
  roleLookup,
  routeEvidenceSettingsFromEnv,
} from "../src/engine/benchmark-evidence";

const OPUS = "openrouter/anthropic/claude-opus-5.5";
const SOL = "openrouter/openai/gpt-6.1-sol";
const GEM = "openrouter/google/gemini-3.8-flash";
const CANDIDATES = [
  { route: "opus", model: OPUS },
  { route: "sol", model: SOL },
  { route: "gemini", model: GEM },
];

/** A direct-model run: item q<i> correct when `right(i)`, each costing `cost`. */
function run(
  model: string,
  n: number,
  right: (i: number) => boolean,
  cost: number | null,
  family = "hle",
): EvidenceItem[] {
  return Array.from({ length: n }, (_, i) => ({
    family,
    itemId: `q${i}`,
    correct: right(i),
    costUsd: cost,
    participantsJson: null,
    targetModel: model,
  }));
}

/** A crew run: item q<i> answered by `agent` on `model` (traced). */
function crew(
  agent: string,
  model: string,
  n: number,
  right: (i: number) => boolean,
  cost: number,
): EvidenceItem[] {
  return Array.from({ length: n }, (_, i) => ({
    family: "hle",
    itemId: `c${i}`,
    correct: right(i),
    costUsd: cost,
    participantsJson: JSON.stringify([{ agent, model, via: "trace" }]),
  }));
}

const base = (over: Partial<RouteEvidenceSettings> = {}): RouteEvidenceSettings => ({
  mode: "on",
  minN: 30,
  includeWindow: false,
  families: { "*": ["hle"] },
  ...over,
});

const firstK = (k: number) => (i: number) => i < k;

describe("settings", () => {
  test("objective defaults to lcb; tolerance defaults to 0.05; junk falls back", () => {
    const d = routeEvidenceSettingsFromEnv({});
    expect(d.objective).toBe("lcb");
    expect(d.tolerance).toBe(0.05);
    const v = routeEvidenceSettingsFromEnv({
      MARINA_ROUTE_EVIDENCE_OBJECTIVE: "Value",
      MARINA_ROUTE_EVIDENCE_TOLERANCE: "0.1",
    });
    expect(v.objective).toBe("value");
    expect(v.tolerance).toBe(0.1);
    const junk = routeEvidenceSettingsFromEnv({
      MARINA_ROUTE_EVIDENCE_OBJECTIVE: "cheapest!",
      MARINA_ROUTE_EVIDENCE_TOLERANCE: "7",
    });
    expect(junk.objective).toBe("lcb");
    expect(junk.tolerance).toBe(0.05);
  });
});

// opus 34/40 at $0.04; sol 33/40 at $0.01 (same items mostly); gemini 24/40 at $0.005.
const ledger = [
  ...run(OPUS, 40, firstK(34), 0.04),
  ...run(SOL, 40, firstK(33), 0.01),
  ...run(GEM, 40, firstK(24), 0.005),
];
const entries = collectEvidence(ledger);

describe("objectives", () => {
  test("lcb (default) keeps today's behaviour: best lower bound, cost ignored", () => {
    const p = pickByEvidence(CANDIDATES, entries, base());
    expect(p.objective).toBe("lcb");
    expect(p.pick?.route).toBe("opus");
  });

  test("value: the cheapest candidate not measurably worse than the best", () => {
    const p = pickByEvidence(CANDIDATES, entries, base({ objective: "value", tolerance: 0.05 }));
    expect(p.pick?.route).toBe("sol");
    const gem = p.considered.find((c) => c.route === "gemini")!;
    expect(gem.why).toMatch(/^worse/);
    expect(p.reason).toContain("cheapest not measurably worse than opus");
  });

  test("value with zero tolerance keeps the best unless an equal is cheaper", () => {
    const p = pickByEvidence(CANDIDATES, entries, base({ objective: "value", tolerance: 0 }));
    expect(p.pick?.route).toBe("opus");
    const tie = [...run(OPUS, 40, firstK(34), 0.04), ...run(SOL, 40, firstK(34), 0.01)];
    const q = pickByEvidence(
      CANDIDATES,
      collectEvidence(tie),
      base({ objective: "value", tolerance: 0 }),
    );
    expect(q.pick?.route).toBe("sol");
  });

  test("value: unpriced candidates are not eligible", () => {
    const data = [...run(OPUS, 40, firstK(34), 0.04), ...run(SOL, 40, firstK(34), null)];
    const p = pickByEvidence(CANDIDATES, collectEvidence(data), base({ objective: "value" }));
    expect(p.pick).toBeUndefined();
    expect(p.considered.find((c) => c.route === "sol")!.why).toBe("unpriced");
  });

  test("budget: best lower bound within the per-item budget", () => {
    const p = pickByEvidence(
      CANDIDATES,
      entries,
      base({ objective: "budget", maxCostPerItemUsd: 0.02 }),
    );
    expect(p.pick?.route).toBe("sol");
    expect(p.considered.find((c) => c.route === "opus")!.why).toBe("over budget");
  });

  test("budget without a budget never picks", () => {
    const p = pickByEvidence(CANDIDATES, entries, base({ objective: "budget" }));
    expect(p.pick).toBeUndefined();
    expect(p.reason).toContain("MARINA_ROUTE_EVIDENCE_MAX_COST_USD");
  });
});

describe("notMeasurablyWorse", () => {
  test("a gap within tolerance that the paired test resolves is still worse", () => {
    // 200 shared items: best right on all, candidate wrong on 9 of them (4.5 pts).
    const data = [...run(OPUS, 200, () => true, 0.04), ...run(SOL, 200, (i) => i >= 9, 0.01)];
    const es = collectEvidence(data);
    const best = es.find((e) => e.kind === "model" && e.key === "claude-opus-5-5")!;
    const cand = es.find((e) => e.kind === "model" && e.key === "gpt-6-1-sol")!;
    const v = notMeasurablyWorse(cand, best, 0.05, 30);
    expect(v.ok).toBe(false);
    expect(v.why).toContain("paired n=200 9–0");
  });

  test("without paired items the intervals must overlap", () => {
    const best = collectEvidence(run(OPUS, 40, firstK(34), 0.04)).find((e) => e.kind === "model")!;
    const disjoint = collectEvidence(
      run(SOL, 40, firstK(34), 0.01).map((i) => ({ ...i, itemId: `other-${i.itemId}` })),
    ).find((e) => e.kind === "model")!;
    const v = notMeasurablyWorse(disjoint, best, 0.05, 30);
    expect(v.ok).toBe(true);
    expect(v.why).toContain("overlaps");
  });

  test("a gap above the tolerance is worse regardless of sample size", () => {
    const best = collectEvidence(run(OPUS, 40, firstK(34), 0.04)).find((e) => e.kind === "model")!;
    const cand = collectEvidence(run(SOL, 40, firstK(30), 0.01)).find((e) => e.kind === "model")!;
    expect(notMeasurablyWorse(cand, best, 0.05, 30).ok).toBe(false);
  });
});

describe("role-level evidence", () => {
  const roles: Record<string, string> = { Answerer: "answerer", Mathematician: "mathematician" };
  const roleOf = (a: string) => roles[a];
  const data = [
    // As the answerer, sol beats opus; model-level (direct runs) says the opposite.
    ...crew("Answerer", SOL, 40, firstK(36), 0.01),
    ...crew("Answerer", OPUS, 40, firstK(30), 0.04).map((i) => ({ ...i, itemId: `o${i.itemId}` })),
    ...run(OPUS, 40, firstK(38), 0.04),
    ...run(SOL, 40, firstK(25), 0.01),
  ];

  test("prefers the role's own evidence when two candidates have enough", () => {
    const p = pickWithRoleFallback(CANDIDATES, data, base(), "answerer", roleOf);
    expect(p.level).toBe("role");
    expect(p.pick?.route).toBe("sol");
    expect(p.reason).toContain("role answerer");
  });

  test("falls back to model-level evidence when the role has too little", () => {
    const p = pickWithRoleFallback(CANDIDATES, data, base(), "mathematician", roleOf);
    expect(p.level).toBe("model");
    // Model level pools crew and direct items: opus 68/80 vs sol 61/80.
    expect(p.pick?.route).toBe("opus");
  });

  test("role lookup caches and tolerates a throwing store", () => {
    let calls = 0;
    const src: EvidenceSource = {
      getBenchmarkItemsForBenchmark: () => [],
      queryBenchmarkRuns: () => [],
      getAgentConfig: (name) => {
        calls++;
        if (name === "Boom") throw new Error("no");
        return { role: "answerer" };
      },
    };
    const look = roleLookup(src)!;
    expect(look("Answerer")).toBe("answerer");
    expect(look("Answerer")).toBe("answerer");
    expect(calls).toBe(1);
    expect(look("Boom")).toBeUndefined();
    expect(
      roleLookup({ getBenchmarkItemsForBenchmark: () => [], queryBenchmarkRuns: () => [] }),
    ).toBeUndefined();
  });
});

describe("applyRouteEvidence", () => {
  const source = (all: EvidenceItem[]): EvidenceSource => ({
    queryBenchmarkRuns: () =>
      [...new Set(all.map((i) => i.targetModel!))].map((m) => ({
        id: m,
        target_kind: "model",
        target_json: JSON.stringify({ model: m }),
      })) as never,
    getBenchmarkItemsForBenchmark: () =>
      all.map((i, n) => ({
        id: n,
        run_id: i.targetModel!,
        item_id: i.itemId!,
        correct: i.correct ? 1 : 0,
        score: null,
        latency_ms: null,
        cost_usd: i.costUsd,
        trace_id: null,
        participants_json: i.participantsJson,
        judge_verdict: null,
      })),
  });

  test("value objective applies the cheaper equivalent and records why", () => {
    const r = applyRouteEvidence(
      { route: "opus", model: OPUS },
      CANDIDATES,
      undefined,
      base({ objective: "value", tolerance: 0.05 }),
      source(ledger),
    );
    expect(r).toMatchObject({ route: "sol", model: SOL, applied: true });
    expect(r.signals).toMatchObject({
      evidence_objective: "value",
      evidence_level: "model",
      evidence_tolerance: 0.05,
      evidence_pick: "sol",
    });
    expect(r.signals.evidence_cost_sol).toBe(0.01);
  });

  test("fails open on a ledger error under every objective", () => {
    const broken: EvidenceSource = {
      queryBenchmarkRuns: () => {
        throw new Error("disk on fire");
      },
      getBenchmarkItemsForBenchmark: () => [],
    };
    for (const objective of ["lcb", "value", "budget"] as const) {
      const r = applyRouteEvidence(
        { route: "opus", model: OPUS },
        CANDIDATES,
        undefined,
        base({ objective, maxCostPerItemUsd: 0.02 }),
        broken,
      );
      expect(r).toMatchObject({ route: "opus", model: OPUS, applied: false });
      expect(r.signals.evidence).toBe("error");
    }
  });
});
