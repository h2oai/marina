// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  analyzeEvolutionEvidence,
  median,
  medianAbsoluteDeviation,
} from "../src/engine/evolution-analysis";

describe("native evolution evidence analysis", () => {
  it("computes median and robust absolute deviation", () => {
    expect(median([9, 1, 3, 2])).toBe(2.5);
    expect(medianAbsoluteDeviation([1, 2, 3, 100])).toBe(1);
  });

  it("ranks arms by median and reports effect relative to the first arm", () => {
    const summary = analyzeEvolutionEvidence({
      arms: ["baseline", "candidate"],
      metric: "accuracy",
      direction: "higher",
      samples: [
        { arm: "baseline", metric_name: "accuracy", metric_value: 0.7 },
        { arm: "baseline", metric_name: "accuracy", metric_value: 0.71 },
        { arm: "baseline", metric_name: "accuracy", metric_value: 0.69 },
        { arm: "candidate", metric_name: "accuracy", metric_value: 0.8 },
        { arm: "candidate", metric_name: "accuracy", metric_value: 0.81 },
        { arm: "candidate", metric_name: "accuracy", metric_value: 0.79 },
      ],
    });

    expect(summary.advisory).toBe(true);
    expect(summary.leader).toBe("candidate");
    expect(summary.baseline).toBe("baseline");
    expect(summary.effect).toBeCloseTo(0.1);
    expect(summary.confidence).toBeCloseTo(10);
    expect(summary.limitations).toEqual([]);
  });

  it("surfaces insufficient evidence instead of manufacturing certainty", () => {
    const summary = analyzeEvolutionEvidence({
      arms: ["A", "B"],
      metric: "latency",
      direction: "lower",
      samples: [
        { arm: "A", metric_name: "latency", metric_value: 10 },
        { arm: "B", metric_name: "latency", metric_value: 9 },
      ],
    });
    expect(summary.leader).toBe("B");
    expect(summary.confidence).toBeUndefined();
    expect(summary.limitations.join(" ")).toContain("fewer than 3 trials");
    expect(summary.limitations.join(" ")).toContain("MAD is zero");
  });
});
