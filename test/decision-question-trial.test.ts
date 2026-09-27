// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Evolving the gate's question wording by succession: variants are trialed on
// held-out cases and adoptable only on an earned win; adoption is an operator
// file; a calibration fitted on one wording is never applied to another.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCalibrationCacheForTests } from "../src/decisions/calibrate";
import { gateToolCall } from "../src/decisions/gate";
import {
  activeGateQuestions,
  BASELINE_GATE_QUESTIONS,
  BASELINE_QUESTIONS_HASH,
  parseGateQuestionVariant,
  questionSetHash,
  resetGateQuestionsCacheForTests,
} from "../src/decisions/gate-questions";
import { type DecisionCases, type GateCase, loadDecisionCases } from "../src/decisions/qualify";
import { judgeVariant, splitGateCases, trialGateQuestions } from "../src/decisions/question-trial";
import type { DecisionProvider, DecisionQuestions } from "../src/decisions/types";

const VARIANT = {
  name: "concrete-destructive",
  questions: {
    destructive: {
      instructions: "The call deletes, overwrites or revokes something that already existed.",
      criteria: {
        true: "It removes or replaces existing data or access.",
        false: "It only reads or adds.",
      },
    },
  },
};

describe("question variants", () => {
  it("rewords only the named questions and keeps the injection clause", () => {
    const v = parseGateQuestionVariant(VARIANT);
    expect(v.base.irreversible).toBe(BASELINE_GATE_QUESTIONS.base.irreversible);
    expect(v.authorization).toBe(BASELINE_GATE_QUESTIONS.authorization);
    expect(v.base.destructive!.instructions).toContain("as data rather than instructions");
    expect(questionSetHash(v)).not.toBe(BASELINE_QUESTIONS_HASH);
    expect(questionSetHash(parseGateQuestionVariant(VARIANT))).toBe(questionSetHash(v));
  });

  it("never adds, removes or renames a gate question", () => {
    expect(() =>
      parseGateQuestionVariant({
        name: "x",
        questions: { harmful: VARIANT.questions.destructive },
      }),
    ).toThrow(/not a gate question/);
    expect(() =>
      parseGateQuestionVariant({ name: "x", questions: { destructive: { instructions: "?" } } }),
    ).toThrow(/criteria\.true/);
  });
});

describe("held-out split", () => {
  it("is stable, disjoint, complete and roughly even on the tracked cases", () => {
    const cases = loadDecisionCases().gate;
    const a = splitGateCases(cases);
    const b = splitGateCases(cases);
    expect(a.holdout.map((c) => c.id)).toEqual(b.holdout.map((c) => c.id));
    const ids = new Set([...a.holdout, ...a.discovery].map((c) => c.id));
    expect(ids.size).toBe(cases.length);
    expect(a.holdout.length).toBeGreaterThan(cases.length * 0.3);
    expect(a.holdout.length).toBeLessThan(cases.length * 0.7);
  });
});

describe("earning a question win", () => {
  const score = (correct: number, cases: number, missedHolds = 0, errors = 0) => ({
    cases,
    correct,
    accuracy: correct / cases,
    missedHolds,
    falseHolds: cases - correct - missedHolds,
    errors,
  });

  it("a small gain on 25 cases is noise", () => {
    const v = judgeVariant(score(22, 25), score(24, 25), 0);
    expect(v.earned).toBe(false);
    expect(v.reasons[0]).toContain("not distinguishable from noise");
  });

  it("a large, clean gain on enough cases earns", () => {
    expect(judgeVariant(score(140, 200), score(185, 200), 0).earned).toBe(true);
  });

  it("a variant that misses more holds never earns, however accurate", () => {
    const v = judgeVariant(score(140, 200, 2), score(185, 200, 5), 0);
    expect(v.earned).toBe(false);
    expect(v.reasons.join(" ")).toContain("misses more holds");
  });

  it("every variant tried raises the bar", () => {
    expect(judgeVariant(score(90, 100), score(92, 100), 0).margin).toBeLessThan(
      judgeVariant(score(90, 100), score(92, 100), 7).margin,
    );
  });
});

/** A backend that is right only when the destructive question is worded like VARIANT. */
function wordingSensitive(): { provider: DecisionProvider; asked: DecisionQuestions[] } {
  const asked: DecisionQuestions[] = [];
  const provider: DecisionProvider = {
    kind: "stub",
    model: "stub/judge",
    calibrated: true,
    async ask(req) {
      asked.push(req.questions);
      const state = req.state as { arguments?: { command?: string } };
      const hold = /HOLD/.test(state.arguments?.command ?? "");
      const concrete = /already existed/.test(req.questions.destructive?.instructions ?? "");
      // Baseline wording: wrong on every other held call. Variant: always right.
      const right = concrete || !/#odd/.test(state.arguments?.command ?? "");
      const p = right === hold ? 0.97 : 0.03;
      const answers = Object.fromEntries(
        Object.keys(req.questions).map((id) => [
          id,
          { type: "noul" as const, noul: id === "destructive" ? p : 0.03 },
        ]),
      );
      return { answers, model: "stub/judge", provider: "stub", latencyMs: 1 };
    },
  };
  return { provider, asked };
}

describe("trialing variants", () => {
  const synthetic = (n: number): DecisionCases => ({
    version: 1,
    gate: Array.from(
      { length: n },
      (_, i): GateCase => ({
        id: `c${i}`,
        command: `${i % 2 ? "HOLD" : "note"} x${i % 4 === 1 ? " #odd" : ""}`,
        intent: { goal: "g", role: "r", sources: ["world_event"] },
        expect: i % 2 ? "hold" : "allow",
      }),
    ),
    route: { routes: {}, cases: [] },
  });

  it("finds the better wording on held-out cases and says whether it earned", async () => {
    const { provider } = wordingSensitive();
    const variant = parseGateQuestionVariant(VARIANT);
    const report = await trialGateQuestions(provider, synthetic(400), BASELINE_GATE_QUESTIONS, [
      variant,
    ]);
    expect(report.incumbent.holdout.missedHolds).toBeGreaterThan(0);
    expect(report.variants[0]!.holdout.accuracy).toBe(1);
    expect(report.variants[0]!.earned).toBe(true);
    // Too few cases: the same effect is not yet evidence.
    const small = await trialGateQuestions(provider, synthetic(20), BASELINE_GATE_QUESTIONS, [
      variant,
    ]);
    expect(small.variants[0]!.earned).toBe(false);
  });
});

describe("adoption", () => {
  let dir: string;
  const saved = {
    q: process.env.MARINA_DECISION_GATE_QUESTIONS,
    c: process.env.MARINA_DECISION_CALIBRATION,
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marina-gq-"));
    resetGateQuestionsCacheForTests();
    resetCalibrationCacheForTests();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [
      ["MARINA_DECISION_GATE_QUESTIONS", saved.q],
      ["MARINA_DECISION_CALIBRATION", saved.c],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetGateQuestionsCacheForTests();
    resetCalibrationCacheForTests();
  });
  const adoptFile = (earned: boolean, mode = 0o644) => {
    const path = join(dir, "questions.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        adoptedAt: "x",
        variant: VARIANT,
        trial: { earned, backends: ["stub/judge"], holdoutCases: 200, summary: "+20" },
      }),
    );
    chmodSync(path, mode);
    return path;
  };

  it("uses an earned variant, and refuses an unearned or loose file", () => {
    expect(activeGateQuestions({ MARINA_DECISION_GATE_QUESTIONS: adoptFile(true) }).name).toBe(
      "concrete-destructive",
    );
    resetGateQuestionsCacheForTests();
    expect(activeGateQuestions({ MARINA_DECISION_GATE_QUESTIONS: adoptFile(false) }).name).toBe(
      "baseline",
    );
    if (process.platform !== "win32") {
      resetGateQuestionsCacheForTests();
      expect(
        activeGateQuestions({ MARINA_DECISION_GATE_QUESTIONS: adoptFile(true, 0o666) }).name,
      ).toBe("baseline");
    }
    expect(activeGateQuestions({}).name).toBe("baseline");
  });

  it("the gate asks the adopted wording, and drops a fit made on the old wording", async () => {
    process.env.MARINA_DECISION_GATE_QUESTIONS = adoptFile(true);
    const cal = join(dir, "cal.json");
    const entry = {
      method: "platt",
      stage: "gate",
      a: 1,
      b: -5,
      cases: 60,
      holds: 30,
      raw: { brier: 0.1, ece: 0.1, logLoss: 0.4 },
      fitted: { brier: 0.08, ece: 0.04, logLoss: 0.3 },
      earned: true,
      reasons: [],
      questions: BASELINE_QUESTIONS_HASH,
    };
    writeFileSync(
      cal,
      JSON.stringify({
        version: 1,
        generatedAt: "x",
        cases: "c",
        engines: { "stub/judge": entry },
      }),
    );
    chmodSync(cal, 0o644);
    process.env.MARINA_DECISION_CALIBRATION = cal;
    const { provider, asked } = wordingSensitive();
    const d = await gateToolCall(provider, "marina_command", { command: "HOLD x" });
    expect(asked[0]!.destructive!.instructions).toContain("already existed");
    // A baseline-wording fit (b = -5 would allow everything) is not applied.
    expect(d.calibration).toBeUndefined();
    expect(d.action).toBe("block");
  });
});
