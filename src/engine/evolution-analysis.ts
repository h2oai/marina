// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface EvolutionMetricSample {
  arm: string;
  metric_name: string;
  metric_value: number;
}

export interface EvolutionArmEvidence {
  arm: string;
  n: number;
  median: number;
  mad: number;
  mean: number;
}

export interface EvolutionEvidenceSummary {
  metric: string;
  direction: "higher" | "lower";
  arms: EvolutionArmEvidence[];
  leader?: string;
  baseline?: string;
  effect?: number;
  confidence?: number;
  advisory: true;
  limitations: string[];
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export function medianAbsoluteDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

/**
 * Summarize existing experiment samples without interpreting them as truth.
 * The first configured arm is the comparison baseline. Confidence is an
 * effect-to-noise ratio, not a probability or an automatic decision rule.
 */
export function analyzeEvolutionEvidence(input: {
  samples: EvolutionMetricSample[];
  arms: string[];
  metric: string;
  direction: "higher" | "lower";
}): EvolutionEvidenceSummary {
  const evidence = input.arms
    .map((arm) => {
      const values = input.samples
        .filter(
          (sample) =>
            sample.arm.toLowerCase() === arm.toLowerCase() && sample.metric_name === input.metric,
        )
        .map((sample) => sample.metric_value)
        .filter(Number.isFinite);
      if (values.length === 0) return undefined;
      return {
        arm,
        n: values.length,
        median: median(values),
        mad: medianAbsoluteDeviation(values),
        mean: values.reduce((sum, value) => sum + value, 0) / values.length,
      } satisfies EvolutionArmEvidence;
    })
    .filter((arm): arm is EvolutionArmEvidence => arm !== undefined);

  const limitations: string[] = [];
  if (evidence.length < 2) limitations.push("fewer than two arms have samples");
  if (evidence.some((arm) => arm.n < 3))
    limitations.push("one or more arms have fewer than 3 trials");

  const ranked = [...evidence].sort((a, b) =>
    input.direction === "lower" ? a.median - b.median : b.median - a.median,
  );
  const baseline = evidence.find((arm) => arm.arm.toLowerCase() === input.arms[0]?.toLowerCase());
  const leader = ranked[0];
  let effect: number | undefined;
  let confidence: number | undefined;
  if (baseline && leader && baseline.arm !== leader.arm) {
    effect =
      input.direction === "higher"
        ? leader.median - baseline.median
        : baseline.median - leader.median;
    const noise = median(evidence.map((arm) => arm.mad));
    if (noise > 0) confidence = Math.abs(effect) / noise;
    else limitations.push("observed MAD is zero; confidence ratio is undefined");
  }

  return {
    metric: input.metric,
    direction: input.direction,
    arms: evidence,
    leader: leader?.arm,
    baseline: baseline?.arm,
    effect,
    confidence,
    advisory: true,
    limitations,
  };
}
