// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import {
  applyRouteEvidence,
  collectEvidence,
  type EvidenceItem,
  type EvidenceSource,
  modelKey,
  parseFamilies,
  pickByEvidence,
  type RouteEvidenceSettings,
  routeEvidenceSettingsFromEnv,
} from "../src/engine/benchmark-evidence";
import { MarinaDB } from "../src/persistence/database";
import type { BenchmarkItemInput } from "../src/persistence/db-benchmarks";

const traced = (model: string, agent = "Answerer") =>
  JSON.stringify([{ agent, model, via: "trace", turns: 1 }]);

/** n items on one family: `correct` of them right, each costing `cost`. */
function items(
  n: number,
  correct: number,
  participants: string | null,
  opts: { family?: string; cost?: number | null; targetModel?: string } = {},
): EvidenceItem[] {
  return Array.from({ length: n }, (_, i) => ({
    family: opts.family ?? "hle",
    correct: i < correct,
    costUsd: opts.cost === undefined ? 0.01 : opts.cost,
    participantsJson: participants,
    ...(opts.targetModel ? { targetModel: opts.targetModel } : {}),
  }));
}

const settings = (over: Partial<RouteEvidenceSettings> = {}): RouteEvidenceSettings => ({
  mode: "on",
  minN: 30,
  includeWindow: false,
  families: { "*": ["hle"] },
  ...over,
});

const CANDIDATES = [
  { route: "fast", model: "openrouter/google/gemini-3.8-flash" },
  { route: "powerful", model: "openrouter/anthropic/claude-opus-5.5" },
];

describe("settings", () => {
  test("off by default; invalid values fall back safely", () => {
    const s = routeEvidenceSettingsFromEnv({});
    expect(s.mode).toBe("off");
    expect(s.minN).toBe(30);
    expect(s.includeWindow).toBe(false);
    expect(s.maxCostPerItemUsd).toBeUndefined();
    expect(s.families).toEqual({});
    const junk = routeEvidenceSettingsFromEnv({
      MARINA_ROUTE_EVIDENCE: "yes please",
      MARINA_ROUTE_EVIDENCE_MIN_N: "-4",
      MARINA_ROUTE_EVIDENCE_MAX_COST_USD: "free",
    });
    expect(junk.mode).toBe("off");
    expect(junk.minN).toBe(30);
    expect(junk.maxCostPerItemUsd).toBeUndefined();
  });

  test("families: a list for every role, or a role map; malformed JSON is none", () => {
    expect(parseFamilies("hle, frames")).toEqual({ "*": ["hle", "frames"] });
    expect(parseFamilies('{"*":["hle"],"coder":"humaneval,mbpp"}')).toEqual({
      "*": ["hle"],
      coder: ["humaneval", "mbpp"],
    });
    expect(parseFamilies("{nope")).toEqual({});
  });

  test("model keys ignore provider prefixes and dot/dash spelling", () => {
    expect(modelKey("openrouter/anthropic/claude-opus-5.5")).toBe("claude-opus-5-5");
    expect(modelKey("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(modelKey("openai/gpt-6.1-sol")).toBe(modelKey("openrouter/openai/gpt-6.1-sol"));
  });
});

describe("collectEvidence", () => {
  test("counts traced participants per agent and per model, never shared, window only on request", () => {
    const evidence = [
      ...items(4, 3, traced("openai/gpt-6.1-sol", "Answerer")),
      ...items(
        2,
        2,
        JSON.stringify([{ agent: "Mathematician", model: "x", via: "window", turns: 1 }]),
      ),
      ...items(
        2,
        0,
        JSON.stringify([{ agent: "Reflector", model: "y", via: "window", shared: true }]),
      ),
    ];
    const plain = collectEvidence(evidence);
    expect(plain.map((e) => `${e.kind}:${e.name}`).sort()).toEqual([
      "agent:Answerer",
      "model:openai/gpt-6.1-sol",
    ]);
    const answerer = plain.find((e) => e.name === "Answerer")!;
    expect([answerer.n, answerer.correct]).toEqual([4, 3]);
    expect(answerer.ciLow).toBeLessThan(0.75);
    expect(answerer.costPerItemUsd).toBeCloseTo(0.01);

    const withWindow = collectEvidence(evidence, { includeWindow: true });
    expect(withWindow.some((e) => e.name === "Mathematician")).toBe(true);
    expect(withWindow.some((e) => e.name === "Reflector")).toBe(false); // shared: never
  });

  test("a direct model run credits its target model", () => {
    const e = collectEvidence(items(5, 4, null, { targetModel: "anthropic/claude-opus-5.5" }));
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: "model", key: "claude-opus-5-5", n: 5, correct: 4 });
    expect(e[0]!.sources.target).toBe(5);
  });
});

describe("pickByEvidence", () => {
  const strong = items(40, 34, null, { targetModel: "anthropic/claude-opus-5.5", cost: 0.04 });
  const weak = items(40, 24, null, { targetModel: "google/gemini-3.8-flash", cost: 0.01 });

  test("best lower bound wins when both candidates have enough items", () => {
    const r = pickByEvidence(CANDIDATES, collectEvidence([...strong, ...weak]), settings());
    expect(r.pick?.route).toBe("powerful");
    expect(r.considered.every((c) => c.eligible)).toBe(true);
  });

  test("insufficient n ⇒ no pick", () => {
    const r = pickByEvidence(
      CANDIDATES,
      collectEvidence([...strong.slice(0, 10), ...weak]),
      settings(),
    );
    expect(r.pick).toBeUndefined();
    expect(r.reason).toContain("insufficient");
  });

  test("the cost budget removes candidates above it (or unpriced)", () => {
    const r = pickByEvidence(
      CANDIDATES,
      collectEvidence([...strong, ...weak]),
      settings({ maxCostPerItemUsd: 0.02 }),
    );
    // Only the cheap candidate is within budget: one eligible is not a comparison.
    expect(r.pick).toBeUndefined();
    expect(r.considered.find((c) => c.route === "powerful")?.why).toBe("over budget");
  });
});

describe("applyRouteEvidence", () => {
  const ledger = (all: EvidenceItem[]): EvidenceSource => ({
    // One synthetic run per target model; items carry it by run id.
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
        item_id: `i${n}`,
        correct: i.correct ? 1 : 0,
        score: null,
        latency_ms: null,
        cost_usd: i.costUsd,
        trace_id: null,
        participants_json: i.participantsJson,
        judge_verdict: null,
      })),
  });
  const data = [
    ...items(40, 34, null, { targetModel: "anthropic/claude-opus-5.5" }),
    ...items(40, 20, null, { targetModel: "google/gemini-3.8-flash" }),
  ];
  const routerPick = { route: "fast", model: CANDIDATES[0]!.model };

  test("off: the router's choice, untouched, with no signals", () => {
    const r = applyRouteEvidence(
      routerPick,
      CANDIDATES,
      undefined,
      settings({ mode: "off" }),
      ledger(data),
    );
    expect(r).toEqual({ route: "fast", model: CANDIDATES[0]!.model, applied: false, signals: {} });
  });

  test("observe: records the evidence pick without acting", () => {
    const r = applyRouteEvidence(
      routerPick,
      CANDIDATES,
      undefined,
      settings({ mode: "observe" }),
      ledger(data),
    );
    expect(r.applied).toBe(false);
    expect(r.model).toBe(CANDIDATES[0]!.model);
    expect(r.signals).toMatchObject({ evidence: "observed", evidence_pick: "powerful" });
  });

  test("on: applies the pick within the router's own candidates", () => {
    const r = applyRouteEvidence(routerPick, CANDIDATES, undefined, settings(), ledger(data));
    expect(r).toMatchObject({ route: "powerful", model: CANDIDATES[1]!.model, applied: true });
    expect(r.signals.evidence).toBe("applied");
  });

  test("no family for the role ⇒ unchanged", () => {
    const r = applyRouteEvidence(
      routerPick,
      CANDIDATES,
      "coder",
      settings({ families: { reviewer: ["hle"] } }),
      ledger(data),
    );
    expect(r.applied).toBe(false);
    expect(r.signals.evidence).toBe("no_family");
  });

  test("fails open on a ledger error", () => {
    const broken: EvidenceSource = {
      queryBenchmarkRuns: () => {
        throw new Error("disk on fire");
      },
      getBenchmarkItemsForBenchmark: () => [],
    };
    const r = applyRouteEvidence(routerPick, CANDIDATES, undefined, settings(), broken);
    expect(r).toMatchObject({ route: "fast", model: CANDIDATES[0]!.model, applied: false });
    expect(r.signals.evidence).toBe("error");
  });
});

describe("against the real ledger", () => {
  let db: MarinaDB | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  test("ledger runs feed the pick", () => {
    db = new MarinaDB(":memory:");
    const now = Date.now();
    const record = (id: string, model: string, correct: number, total: number) => {
      const its: BenchmarkItemInput[] = Array.from({ length: total }, (_, i) => ({
        item_id: `q${i}`,
        correct: i < correct,
        score: null,
        latency_ms: 10,
        cost_usd: 0.01,
        trace_id: null,
        participants_json: null,
        judge_verdict: "exact",
      }));
      db!.recordBenchmarkLedgerRun(
        {
          id,
          benchmark: "hle",
          config_hash: id,
          config_json: "{}",
          started_at: now,
          completed_at: now,
          duration_ms: 1,
          score: correct / total,
          answered: total,
          total,
          cost_usd: 0.01 * total,
          n: total,
          ci_low: 0,
          ci_high: 1,
          seed: 42,
          slice_hash: "s",
          judge: "j",
          target_kind: "model",
          target_json: JSON.stringify({ model }),
          label: null,
          source: "import",
          content_hash: id,
        },
        its,
      );
    };
    record("r1", "anthropic/claude-opus-5.5", 36, 40);
    record("r2", "google/gemini-3.8-flash", 22, 40);
    const r = applyRouteEvidence(
      { route: "fast", model: CANDIDATES[0]!.model },
      CANDIDATES,
      undefined,
      settings(),
      db,
    );
    expect(r).toMatchObject({ route: "powerful", applied: true });
  });
});
