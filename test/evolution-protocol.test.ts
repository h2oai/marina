// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  createEvolutionProtocol,
  evolutionBudgetState,
  parseEvolutionProtocol,
} from "../src/engine/evolution-protocol";
import type { EvolutionSessionRow } from "../src/persistence/database";

function session(protocol: object, startedAt: number | null): EvolutionSessionRow {
  return {
    id: 1,
    experiment_id: 1,
    objective: "test",
    protocol: JSON.stringify(protocol),
    status: "active",
    created_by: "Alice",
    created_at: 1,
    started_at: startedAt,
    paused_at: null,
    completed_at: null,
  };
}

describe("native evolution protocol policy", () => {
  it("creates immutable constitutional defaults and parses explicit limits", () => {
    const protocol = createEvolutionProtocol({
      primaryMetric: "accuracy",
      direction: "higher",
      options: [
        "max-runs=5",
        "max-seconds=60",
        "min-trials=4",
        "min-effect=0.02",
        "independent-review=true",
        "guardrail=latency:lower",
      ],
    });
    expect(protocol).toMatchObject({
      voluntary: true,
      metricsAreAdvisory: true,
      automaticContinuation: false,
      automaticPromotion: false,
      primaryMetric: "accuracy",
      maxRuns: 5,
      maxDurationSeconds: 60,
      minTrials: 4,
      minEffect: 0.02,
      independentReview: true,
      guardrails: [{ metric: "latency", direction: "lower" }],
    });
  });

  it("rejects malformed and unknown protocol options", () => {
    expect(() => createEvolutionProtocol({ options: ["max-runs=0"] })).toThrow();
    expect(() => createEvolutionProtocol({ options: ["independent-review=maybe"] })).toThrow();
    expect(() => createEvolutionProtocol({ options: ["mystery=true"] })).toThrow();
  });

  it("fails closed to non-sovereign defaults when persisted JSON is corrupt", () => {
    const protocol = parseEvolutionProtocol("not-json");
    expect(protocol.automaticContinuation).toBe(false);
    expect(protocol.automaticPromotion).toBe(false);
    expect(protocol.independentReview).toBe(false);
  });

  it("reports run and elapsed-time exhaustion without changing session state", () => {
    const protocol = createEvolutionProtocol({ options: ["max-runs=2", "max-seconds=30"] });
    const row = session(protocol, 1_000);
    const state = evolutionBudgetState(row, 2, 32_000);
    expect(state.exhausted).toBe(true);
    expect(state.runsRemaining).toBe(0);
    expect(state.secondsRemaining).toBe(0);
    expect(row.status).toBe("active");
  });
});
