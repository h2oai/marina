// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Earned gate calibration, and the ensemble / auto engines built from the same
// decision backends. Everything here is optional: no file, no earned fit, no
// composite engine configured ⇒ behaviour is exactly as before.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPlatt,
  CALIBRATION_BAR,
  type CalibrationEntry,
  type CalibrationPoint,
  earnedGateCalibration,
  fitGateCalibration,
  fitPlatt,
  gateActionWithFit,
  loadCalibration,
  resetCalibrationCacheForTests,
  scoreProbabilities,
} from "../src/decisions/calibrate";
import { combineAnswers, unsureAnswers } from "../src/decisions/combine";
import { listEngines, resolveEngine } from "../src/decisions/engines";
import { gateToolCall } from "../src/decisions/gate";
import { UNCALIBRATED_GATE_POLICY } from "../src/decisions/policy";
import { type BackendReport, gateCalibrationPoints } from "../src/decisions/qualify";
import { choice, noul, parseQuestions, score } from "../src/decisions/questions";
import type { DecisionAnswer, DecisionProvider, DecisionResult } from "../src/decisions/types";

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Fitting and scoring ─────────────────────────────────────────────────────

describe("Platt fit", () => {
  it("leaves an already-calibrated backend near the identity", () => {
    const r = rng(7);
    const points: CalibrationPoint[] = Array.from({ length: 2000 }, () => {
      const p = r();
      return { p, y: r() < p ? 1 : 0 };
    });
    const map = fitPlatt(points);
    expect(map.a).toBeGreaterThan(0.85);
    expect(map.a).toBeLessThan(1.15);
    expect(Math.abs(map.b)).toBeLessThan(0.15);
  });

  it("tempers a saturated classifier that is sometimes wrong", () => {
    // Says 1.0 for 25 calls, of which 5 were actually fine; 0.0 for 25, 2 of which were holds.
    const points: CalibrationPoint[] = [
      ...Array.from({ length: 20 }, () => ({ p: 1, y: 1 as const })),
      ...Array.from({ length: 5 }, () => ({ p: 1, y: 0 as const })),
      ...Array.from({ length: 23 }, () => ({ p: 0, y: 0 as const })),
      ...Array.from({ length: 2 }, () => ({ p: 0, y: 1 as const })),
    ];
    const map = fitPlatt(points);
    expect(applyPlatt(1, map)).toBeGreaterThan(0.7);
    expect(applyPlatt(1, map)).toBeLessThan(0.9);
    expect(applyPlatt(0, map)).toBeGreaterThan(0.03);
    expect(applyPlatt(0, map)).toBeLessThan(0.2);
  });

  it("is monotone, so the gate's worst risk stays the worst", () => {
    const map = { a: 0.6, b: -0.4 };
    const ps = [0.01, 0.2, 0.5, 0.7, 0.99];
    const mapped = ps.map((p) => applyPlatt(p, map));
    expect([...mapped].sort((x, y) => x - y)).toEqual(mapped);
  });

  it("scores Brier, ECE and log loss", () => {
    const m = scoreProbabilities([0.9, 0.1, 0.8, 0.3], [1, 0, 1, 0]);
    expect(m.brier).toBeCloseTo((0.01 + 0.01 + 0.04 + 0.09) / 4);
    expect(m.ece).toBeCloseTo(0.175);
  });
});

describe("earning a calibration", () => {
  const informative = (n: number, seed = 3): CalibrationPoint[] => {
    const r = rng(seed);
    return Array.from({ length: n }, (_, i) => {
      const y = (i % 2) as 0 | 1;
      // Holds mostly score high, allows mostly low, with overlap.
      const p = y ? 0.55 + r() * 0.45 : r() * 0.45;
      return { p, y };
    });
  };

  it("is earned by a backend that discriminates, on enough cases", () => {
    const fit = fitGateCalibration(informative(60), { classifierMethod: "logprobs" });
    expect(fit.reasons).toEqual([]);
    expect(fit.earned).toBe(true);
    expect(fit.classifierMethod).toBe("logprobs");
    // Decisions are compared out of sample, not just probabilities.
    expect(fit.decisions?.fitted.missedHolds).toBeLessThanOrEqual(fit.decisions!.today.missedHolds);
  });

  it("is not earned when the fitted gate would decide worse than today's", () => {
    // A native decision model whose graded cut (0.65) separates holds at 0.66 from
    // allows at 0.64 perfectly; a fit toward P(hold) cannot, and would flip half.
    const points: CalibrationPoint[] = [
      ...Array.from({ length: 25 }, () => ({ p: 0.66, y: 1 as const })),
      ...Array.from({ length: 25 }, () => ({ p: 0.64, y: 0 as const })),
    ];
    const fit = fitGateCalibration(points, { nativelyCalibrated: true });
    expect(fit.decisions!.today.accuracy).toBe(1);
    expect(fit.decisions!.fitted.accuracy).toBe(0.5);
    expect(fit.earned).toBe(false);
    expect(fit.reasons).toContain("the fitted gate decides worse (100% → 50%)");
  });

  it("a fit decides allow vs hold; only a native model blocks, on its own number", () => {
    expect(gateActionWithFit(0.99, 0.3, false)).toBe("allow");
    expect(gateActionWithFit(0.99, 0.9, false)).toBe("ask"); // a chat classifier never blocks
    expect(gateActionWithFit(0.95, 0.9, true)).toBe("block");
    expect(gateActionWithFit(0.7, 0.9, true)).toBe("ask");
  });

  it("is not earned on too few cases, however good they look", () => {
    const fit = fitGateCalibration(informative(20));
    expect(fit.earned).toBe(false);
    expect(fit.reasons.join(" ")).toContain(`< ${CALIBRATION_BAR.minCases}`);
  });

  it("is never earned by a backend that only knows the base rate", () => {
    const points: CalibrationPoint[] = Array.from({ length: 60 }, (_, i) => ({
      p: 0.5,
      y: (i % 2) as 0 | 1,
    }));
    const fit = fitGateCalibration(points);
    expect(fit.raw.ece).toBeLessThan(0.05); // perfectly "calibrated"…
    expect(fit.earned).toBe(false); // …and useless
    expect(fit.reasons.join(" ")).toContain("does not discriminate");
  });

  it("reads the gate's worst risk per case from a raw report, skipping errors", () => {
    const report = {
      gate: {
        results: [
          { id: "a", expect: "hold", signals: { destructive: 0.2, irreversible: 0.9 } },
          { id: "b", expect: "allow", signals: { destructive: 0.1 } },
          { id: "c", expect: "hold", signals: {}, error: "timeout" },
        ],
      },
    } as unknown as BackendReport;
    expect(gateCalibrationPoints(report)).toEqual([
      { p: 0.9, y: 1 },
      { p: 0.1, y: 0 },
    ]);
  });
});

// ─── The file and the gate ───────────────────────────────────────────────────

const earned = (a: number, b: number): CalibrationEntry => ({
  method: "platt",
  stage: "gate",
  a,
  b,
  cases: 60,
  holds: 30,
  raw: { brier: 0.1, ece: 0.1, logLoss: 0.4 },
  fitted: { brier: 0.08, ece: 0.04, logLoss: 0.3 },
  earned: true,
  reasons: [],
});

function stub(p: number, calibrated: boolean, model = "z-ai/glm-5.3-flash"): DecisionProvider {
  return {
    kind: "chat-classifier",
    model,
    calibrated,
    async ask(req) {
      const answers = Object.fromEntries(
        Object.keys(req.questions).map((id) => [id, { type: "noul" as const, noul: p }]),
      );
      return { answers, model, provider: "stub", latencyMs: 1 };
    },
  };
}

describe("calibration file", () => {
  let dir: string;
  const saved = process.env.MARINA_DECISION_CALIBRATION;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marina-calib-"));
    resetCalibrationCacheForTests();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.MARINA_DECISION_CALIBRATION;
    else process.env.MARINA_DECISION_CALIBRATION = saved;
    resetCalibrationCacheForTests();
  });
  const write = (engines: Record<string, unknown>, mode = 0o644) => {
    const path = join(dir, "calibration.json");
    writeFileSync(path, JSON.stringify({ version: 1, generatedAt: "x", cases: "c", engines }));
    chmodSync(path, mode);
    return path;
  };

  it("serves only earned, well-formed entries", () => {
    const path = write({
      "z-ai/glm-5.3-flash": earned(0.5, -1),
      "openai/gpt-6-luna": { ...earned(1, 0), earned: false, reasons: ["too few"] },
      broken: { method: "isotonic" },
    });
    const env = { MARINA_DECISION_CALIBRATION: path };
    expect(Object.keys(loadCalibration(env)!.engines).sort()).toEqual([
      "openai/gpt-6-luna",
      "z-ai/glm-5.3-flash",
    ]);
    expect(earnedGateCalibration("z-ai/glm-5.3-flash", env)?.a).toBe(0.5);
    expect(earnedGateCalibration("openai/gpt-6-luna", env)).toBeUndefined();
    expect(earnedGateCalibration("unknown", env)).toBeUndefined();
  });

  it("refuses a file anyone but its owner can change, and survives a missing one", () => {
    if (process.platform === "win32") return;
    const path = write({ "z-ai/glm-5.3-flash": earned(0.5, -1) }, 0o666);
    expect(loadCalibration({ MARINA_DECISION_CALIBRATION: path })).toBeUndefined();
    expect(
      loadCalibration({ MARINA_DECISION_CALIBRATION: join(dir, "nope.json") }),
    ).toBeUndefined();
    expect(loadCalibration({})).toBeUndefined();
  });

  it("an earned fit gives an uncalibrated backend the graded gate", async () => {
    // A classifier that says 0.7 for a benign call: the one-cut policy asks a person.
    const raw = await gateToolCall(stub(0.7, false), "marina_command", { command: "note add x" });
    expect(raw.action).toBe("ask");
    expect(raw.calibrated).toBe(false);
    // Its measured 0.7 means ~0.29 once fitted: the graded gate allows it.
    process.env.MARINA_DECISION_CALIBRATION = write({ "z-ai/glm-5.3-flash": earned(1, -1.75) });
    const fitted = await gateToolCall(stub(0.7, false), "marina_command", {
      command: "note add x",
    });
    expect(fitted.action).toBe("allow");
    expect(fitted.calibration).toBe("fitted");
    expect(fitted.calibrated).toBeUndefined();
    expect(fitted.reason).toContain("fitted calibration");
    expect(fitted.signals.destructive).toBeCloseTo(applyPlatt(0.7, { a: 1, b: -1.75 }));
    // `null` scores the raw probabilities (what fitting needs).
    const again = await gateToolCall(
      stub(0.7, false),
      "marina_command",
      { command: "note add x" },
      undefined,
      undefined,
      undefined,
      { calibration: null },
    );
    expect(again.action).toBe("ask");
  });

  it("an earned fit still holds a dangerous call, and never loosens an explicit policy", async () => {
    process.env.MARINA_DECISION_CALIBRATION = write({ "z-ai/glm-5.3-flash": earned(1, -1.75) });
    // Held — but a chat classifier's hold goes to a person, fit or not.
    const danger = await gateToolCall(stub(0.999, false), "marina_command", { command: "x" });
    expect(danger.action).toBe("ask");
    expect(danger.calibration).toBe("fitted");
    // A native decision model with a fit still blocks on its own raw number…
    process.env.MARINA_DECISION_CALIBRATION = write({
      "z-ai/glm-5.3-flash": earned(1, -1.75),
      "typesafe/jev-1.13": earned(1, -1.75),
    });
    const native = await gateToolCall(stub(0.95, true, "typesafe/jev-1.13"), "marina_command", {
      command: "x",
    });
    expect(native.action).toBe("block");
    // …and its fitted P(hold) decides the allow side (0.7 → 0.29: allowed).
    const nativeAllow = await gateToolCall(stub(0.7, true, "typesafe/jev-1.13"), "marina_command", {
      command: "x",
    });
    expect(nativeAllow.action).toBe("allow");
    const explicit = await gateToolCall(
      stub(0.7, false),
      "marina_command",
      { command: "x" },
      UNCALIBRATED_GATE_POLICY,
    );
    expect(explicit.action).toBe("allow"); // mapped 0.29 < 0.5
    const other = await gateToolCall(stub(0.7, false, "other/model"), "marina_command", {
      command: "x",
    });
    expect(other.action).toBe("ask"); // no entry for this model: unchanged
  });
});

// ─── Combining ───────────────────────────────────────────────────────────────

const Q = parseQuestions({
  urgent: { type: "noul", instructions: "Urgent?" },
  team: { type: "choice", instructions: "Team?", criteria: { billing: null, tech: null } },
  sev: { type: "score", instructions: "Severity?", criteria: ["low", "mid", "high"] },
});

describe("combining answers", () => {
  it("averages nouls in log-odds and distributions per option / level", () => {
    const a: Record<string, DecisionAnswer> = {
      urgent: { type: "noul", noul: 0.9 },
      team: {
        type: "choice",
        choice: "tech",
        confidence: 0.8,
        probabilities: { billing: 0.2, tech: 0.8 },
      },
      sev: { type: "score", score: 2, confidence: 1, probabilities: { "0": 0, "1": 0, "2": 1 } },
    };
    const b: Record<string, DecisionAnswer> = {
      urgent: { type: "noul", noul: 0.5 },
      team: { type: "choice", choice: "billing", confidence: 0.6 },
      sev: { type: "score", score: 1, confidence: 1, probabilities: { "0": 0, "1": 1, "2": 0 } },
    };
    const c = combineAnswers(Q, [a, b]);
    // mean logit(0.9), logit(0.5) = ln(9)/2 → 0.75
    expect((c.urgent as { noul: number }).noul).toBeCloseTo(0.75);
    // b's pick-and-confidence is completed to billing 0.6 / tech 0.4.
    expect(c.team).toMatchObject({ choice: "tech" });
    const team = (c.team as { probabilities: Record<string, number> }).probabilities;
    expect(team.billing).toBeCloseTo(0.4);
    expect(team.tech).toBeCloseTo(0.6);
    expect(c.sev).toMatchObject({ score: 1.5, probabilities: { "0": 0, "1": 0.5, "2": 0.5 } });
  });

  it("one saturated vote cannot veto the rest", () => {
    const c = combineAnswers({ x: noul("?") }, [
      { x: { type: "noul", noul: 0 } },
      { x: { type: "noul", noul: 0.95 } },
      { x: { type: "noul", noul: 0.95 } },
    ]);
    expect((c.x as { noul: number }).noul).toBeGreaterThan(0.5);
  });

  it("flags answers too unsure to stand alone", () => {
    expect(
      unsureAnswers(
        { a: noul("?"), b: choice("?", { x: null, y: null }), c: score("?", ["l", "h"]) },
        {
          a: { type: "noul", noul: 0.55 },
          b: { type: "choice", choice: "x", confidence: 0.9 },
          c: { type: "score", score: 0.5, confidence: 0.5 },
        },
      ),
    ).toEqual(["a", "c"]);
  });
});

// ─── Ensemble and auto ───────────────────────────────────────────────────────

/** A fake Marina `/v1` answering every classifier engine with a fixed noul per model. */
function selfProxy(nouls: Record<string, number | "down">) {
  const calls: string[] = [];
  const fetch = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      model: string;
      response_format?: {
        json_schema: {
          schema: { properties: { answers: { properties: Record<string, unknown> } } };
        };
      };
    };
    calls.push(body.model);
    const p = nouls[body.model];
    if (p === "down" || p === undefined) return new Response("{}", { status: 500 });
    const ids = Object.keys(body.response_format!.json_schema.schema.properties.answers.properties);
    const answers = Object.fromEntries(ids.map((id) => [id, { noul: p }]));
    return new Response(
      JSON.stringify({
        model: body.model,
        choices: [{ message: { content: JSON.stringify({ answers }) } }],
      }),
      { status: 200 },
    );
  };
  return { fetch, calls };
}

const JEV_ENV = {
  MARINA_DECISIONS: "jev",
  OPENROUTER_API_KEY: "k",
  MARINA_DECISION_ENGINES: "a/one,b/two,c/three",
  MARINA_DECISION_METHOD: "verbalized",
};

describe("marina/ensemble", () => {
  it("asks every member and combines; needs a strict majority", async () => {
    const env = {
      ...JEV_ENV,
      MARINA_DECISION_ENSEMBLE:
        "marina/classifier:a/one,marina/classifier:b/two,marina/classifier:c/three",
    };
    const up = selfProxy({ "a/one": 0.9, "b/two": 0.9, "c/three": "down" });
    const r = resolveEngine("marina/ensemble", env, { token: async () => "t", fetch: up.fetch });
    if (!("provider" in r)) throw new Error(JSON.stringify(r));
    const result = await r.provider.ask({ state: "s", questions: { x: noul("?") } });
    expect(result.method).toBe("ensemble");
    expect(result.members).toEqual(["marina/classifier:a/one", "marina/classifier:b/two"]);
    expect((result.answers.x as { noul: number }).noul).toBeCloseTo(0.9);
    expect(result.calibrated).toBe(false);
    const minority = selfProxy({ "a/one": 0.9, "b/two": "down", "c/three": "down" });
    const r2 = resolveEngine("marina/ensemble", env, {
      token: async () => "t",
      fetch: minority.fetch,
    });
    if (!("provider" in r2)) throw new Error("no engine");
    await expect(r2.provider.ask({ state: "s", questions: { x: noul("?") } })).rejects.toThrow();
  });

  it("is not offered unless configured, and refuses members it cannot serve", () => {
    expect(resolveEngine("marina/ensemble", JEV_ENV)).toMatchObject({ error: { status: 400 } });
    expect(
      resolveEngine("marina/ensemble", {
        ...JEV_ENV,
        MARINA_DECISION_ENSEMBLE: "marina/classifier:a/one,x/nope",
      }),
    ).toMatchObject({ error: { status: 400, message: expect.stringContaining("x/nope") } });
    expect(
      listEngines({
        ...JEV_ENV,
        MARINA_DECISION_ENSEMBLE: "typesafe/jev-1.13,marina/classifier:a/one",
      }).map((e) => e.id),
    ).toContain("marina/ensemble");
  });
});

describe("marina/auto", () => {
  // The configured backend (Jev) is the primary; stub it through its fetch-free seam.
  function autoWith(primaryNoul: number | "down", fallback: Record<string, number | "down">) {
    const up = selfProxy(fallback);
    const r = resolveEngine("marina/auto", JEV_ENV, { token: async () => "t", fetch: up.fetch });
    if (!("provider" in r)) throw new Error(JSON.stringify(r));
    return { provider: r.provider, up, primaryNoul };
  }

  // Jev itself is reached over the real network in production; here the global
  // fetch answers for OpenRouter's Decisions API.
  let orig: typeof fetch;
  let primary: number | "down" = 0.1;
  let primaryCalls = 0;
  beforeEach(() => {
    orig = globalThis.fetch;
    primaryCalls = 0;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      primaryCalls++;
      if (primary === "down") return new Response("{}", { status: 500 });
      const { questions } = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      const answers = Object.fromEntries(
        Object.keys(questions).map((id) => [id, { noul: primary }]),
      );
      return new Response(JSON.stringify({ answers, model: "typesafe/jev-1.13" }), { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = orig;
  });

  it("a confident primary answers alone: one call, Jev's calibration", async () => {
    primary = 0.05;
    const { provider, up } = autoWith(0.05, { "a/one": 0.9 });
    const result: DecisionResult = await provider.ask({ state: "s", questions: { x: noul("?") } });
    expect(primaryCalls).toBe(1);
    expect(up.calls).toEqual([]);
    expect(result.members).toEqual(["typesafe/jev-1.13"]);
    expect(result.calibrated).toBe(true);
    expect((result.answers.x as { noul: number }).noul).toBeCloseTo(0.05);
  });

  it("an unsure primary gets a second opinion, combined", async () => {
    primary = 0.55;
    const { provider, up } = autoWith(0.55, { "a/one": 0.9 });
    const result = await provider.ask({ state: "s", questions: { x: noul("?") } });
    expect(up.calls).toEqual(["a/one"]);
    expect(result.members).toEqual(["typesafe/jev-1.13", "marina/classifier:a/one"]);
    expect(result.calibrated).toBe(false);
    expect((result.answers.x as { noul: number }).noul).toBeGreaterThan(0.55);
  });

  it("a down primary is answered by the fallback; both down rethrows the primary's error", async () => {
    primary = "down";
    const ok = autoWith("down", { "a/one": 0.2 });
    const result = await ok.provider.ask({ state: "s", questions: { x: noul("?") } });
    expect(result.members).toEqual(["marina/classifier:a/one"]);
    const bad = autoWith("down", { "a/one": "down" });
    await expect(bad.provider.ask({ state: "s", questions: { x: noul("?") } })).rejects.toThrow(
      /decision backend 500/,
    );
  });

  it("needs a configured backend and a second opinion to exist", () => {
    expect(resolveEngine("marina/auto", { MARINA_DECISION_ENGINES: "a/one" })).toMatchObject({
      error: { status: 400 },
    });
    expect(
      resolveEngine("marina/auto", { MARINA_DECISIONS: "jev", OPENROUTER_API_KEY: "k" }),
    ).toMatchObject({
      error: { status: 400 },
    });
  });
});
