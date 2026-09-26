// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type GateResult,
  parseDecisionCases,
  percentile,
  qualifyBackend,
  scoreBackend,
} from "../src/decisions/qualify";
import type { DecisionProvider } from "../src/decisions/types";

const CASES = join(import.meta.dir, "../src/decisions/decision-cases.json");

describe("decision qualification", () => {
  it("ships a valid, balanced labeled case set", () => {
    const cases = parseDecisionCases(JSON.parse(readFileSync(CASES, "utf8")));
    const holds = cases.gate.filter((c) => c.expect === "hold").length;
    expect(holds).toBeGreaterThanOrEqual(8);
    expect(cases.gate.length - holds).toBeGreaterThanOrEqual(8);
    expect(cases.route.cases.length).toBeGreaterThanOrEqual(9);
    expect(() => parseDecisionCases({ version: 2 })).toThrow(/version/);
  });

  it("scores recall, false holds and accuracy from results", () => {
    const g = (id: string, expect: "allow" | "hold", action: GateResult["action"]): GateResult => ({
      id,
      expect,
      action,
      correct: expect === "allow" ? action === "allow" : action !== "allow",
      signals: {},
      latencyMs: 100,
    });
    const report = scoreBackend(
      { kind: "k", model: "m" },
      [
        g("a", "hold", "block"),
        g("b", "hold", "ask"),
        g("c", "hold", "allow"),
        g("d", "allow", "allow"),
        g("e", "allow", "ask"),
      ],
      [],
    );
    expect(report.gate.holdRecall).toBeCloseTo(2 / 3);
    expect(report.gate.falseHoldRate).toBeCloseTo(1 / 2);
    expect(report.gate.accuracy).toBeCloseTo(3 / 5);
    expect(percentile([5, 1, 9, 3], 50)).toBe(3);
    expect(percentile([], 95)).toBe(0);
  });

  it("runs every case through the real gate and router against a backend", async () => {
    const cases = parseDecisionCases(JSON.parse(readFileSync(CASES, "utf8")));
    // A stub that holds exactly the dangerous commands and routes by keyword.
    // Keyed by the first two words: the gate masks secrets inside arguments.
    const verb = (command: string) => command.split(" ").slice(0, 2).join(" ");
    const dangerous = new Set(
      cases.gate.filter((c) => c.expect === "hold").map((c) => verb(c.command)),
    );
    const stub: DecisionProvider = {
      kind: "stub",
      model: "oracle",
      async ask(req) {
        const state = req.state as { arguments?: { command?: string }; goal?: string };
        if (req.questions.route) {
          const goal = state.goal ?? "";
          const pick = /README|CHANGELOG|typo/.test(goal)
            ? "cheap"
            : /test|Refactor|Review/.test(goal)
              ? "coder"
              : "powerful";
          return {
            answers: { route: { type: "choice", choice: pick, confidence: 0.9 } },
            model: "oracle",
            provider: "stub",
            latencyMs: 2,
          };
        }
        const p = dangerous.has(verb(state.arguments?.command ?? "")) ? 0.95 : 0.05;
        const answers = Object.fromEntries(
          Object.keys(req.questions).map((id) => [id, { type: "noul" as const, noul: p }]),
        );
        return { answers, model: "oracle", provider: "stub", latencyMs: 2 };
      },
    };
    const report = await qualifyBackend(stub, cases);
    expect(report.gate.accuracy).toBe(1);
    expect(report.gate.holdRecall).toBe(1);
    expect(report.gate.falseHoldRate).toBe(0);
    expect(report.route.accuracy).toBe(1);
  });
});
