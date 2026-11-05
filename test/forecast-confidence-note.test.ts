// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A typed forecast's `confidence` is several different numbers. The reply must
 * name which one it shows: three runs all answering "no" gave "confidence 1.00"
 * next to reasons calling the question a coin flip.
 */

import { describe, expect, it } from "bun:test";
import { confidenceNote } from "../src/engine/commands/forecast";
import type { TypedForecastAnswer } from "../src/forecast/typed";

const ok = (n: number) => Array.from({ length: n }, (_, i) => ({ run: i + 1, status: "ok" }));
const answer = (fields: Record<string, unknown>) => fields as unknown as TypedForecastAnswer;

describe("confidenceNote", () => {
  it("says a choice answer's agreement is agreement, not a probability", () => {
    const a = answer({
      formatted: "no",
      prediction: "no",
      confidence: 1,
      combined: { value: "no", agreement: 1, method: "vote" },
      runs: ok(3),
    });
    expect(confidenceNote(a)).toBe(" · 3 of 3 runs agree (agreement, not a probability)");
  });

  it("shows a probability when the answer carries a distribution", () => {
    const a = answer({
      formatted: "no",
      prediction: "no",
      confidence: 0.56,
      distribution: { yes: 0.44, no: 0.56 },
      runs: ok(3),
    });
    expect(confidenceNote(a)).toBe(" · probability 56%");
  });

  it("shows a number's ± instead of its agreement", () => {
    const a = answer({
      formatted: "3.9",
      prediction: 3.9,
      confidence: 0.58,
      uncertainty: { sd: 0.550363 },
      combined: { value: 3.9, agreement: 0.58, method: "median" },
      runs: ok(4),
    });
    expect(confidenceNote(a)).toBe(" · ± 0.55");
  });

  it("names the critic's confidence and stays silent with nothing to say", () => {
    const critic = answer({
      formatted: "yes",
      prediction: "yes",
      confidence: 0.7,
      combined: { value: "no", agreement: 0.67, method: "vote" },
      runs: ok(3),
    });
    expect(confidenceNote(critic)).toBe(" · critic confidence 0.70");
    expect(confidenceNote(answer({ formatted: "yes", runs: ok(3) }))).toBe("");
    const single = answer({
      formatted: "yes",
      confidence: 1,
      combined: { value: "yes", agreement: 1, method: "vote" },
      runs: ok(1),
    });
    expect(confidenceNote(single)).toBe("");
  });
});
