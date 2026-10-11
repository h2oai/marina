// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { availableInstant } from "../research/measurement";

/** Population scenarios are testable hypotheses anchored in measured strata.
 * They never manufacture respondents, observations or earned forecast accuracy. */
export interface PopulationStratum {
  id: string;
  population: string;
  /** Strata must form one disjoint partition, e.g. party, not party+age+race. */
  partition: string;
  weight: number;
  share: number;
  effectiveSample: number;
  observedAt: string;
  availableAt: string;
  source: string;
}

export interface PopulationScenario {
  id: string;
  /** Percentage point changes posited by the scenario, not source measurements. */
  changes: Record<string, number>;
  knownAt: string;
  rationale: string;
}

export function populationScenario(
  strata: PopulationStratum[],
  scenario: PopulationScenario,
  opts: { asOf: string; priorShare: number; priorStrength: number; commonSd: number },
) {
  if (
    !strata.length ||
    strata.length > 10000 ||
    !Number.isFinite(Date.parse(opts.asOf)) ||
    availableInstant(scenario.knownAt) === undefined ||
    availableInstant(scenario.knownAt)! > Date.parse(opts.asOf) ||
    !scenario.id ||
    !scenario.rationale ||
    !Number.isFinite(opts.priorShare) ||
    opts.priorShare < 0 ||
    opts.priorShare > 100 ||
    !Number.isFinite(opts.priorStrength) ||
    opts.priorStrength < 0 ||
    !Number.isFinite(opts.commonSd) ||
    opts.commonSd <= 0
  )
    throw new Error("invalid population scenario");
  const ids = new Set<string>();
  for (const row of strata) {
    if (
      !row.id ||
      !row.population ||
      !row.partition ||
      ids.has(row.id) ||
      row.partition !== strata[0]!.partition ||
      row.population !== strata[0]!.population ||
      !row.source ||
      ![row.weight, row.share, row.effectiveSample].every(Number.isFinite) ||
      row.weight <= 0 ||
      row.share < 0 ||
      row.share > 100 ||
      row.effectiveSample <= 0 ||
      ![row.observedAt, row.availableAt].every(
        (d) => availableInstant(d) !== undefined && availableInstant(d)! <= Date.parse(opts.asOf),
      ) ||
      Date.parse(row.observedAt) > Date.parse(row.availableAt)
    )
      throw new Error("invalid, overlapping, or unavailable population stratum");
    ids.add(row.id);
  }
  if (
    Object.entries(scenario.changes).some(
      ([id, change]) => !ids.has(id) || !Number.isFinite(change) || Math.abs(change) > 100,
    )
  )
    throw new Error("invalid scenario effect");
  const totalWeight = strata.reduce((sum, row) => sum + row.weight, 0);
  if (Math.abs(totalWeight - 1) > 1e-6) throw new Error("population weights must sum to one");
  const cells = Object.fromEntries(
    strata.map((row) => {
      const n = row.effectiveSample + opts.priorStrength;
      const base = (row.share * row.effectiveSample + opts.priorShare * opts.priorStrength) / n;
      const mean = Math.min(100, Math.max(0, base + (scenario.changes[row.id] ?? 0)));
      const samplingVariance = (10000 * (base / 100) * (1 - base / 100)) / (n + 1);
      return [
        row.id,
        {
          mean,
          sd: Math.sqrt(samplingVariance + opts.commonSd ** 2),
          baseline: base,
          weight: row.weight,
        },
      ];
    }),
  );
  const mean = Object.values(cells).reduce((sum, c) => sum + c.weight * c.mean, 0);
  // Common survey/model error does not vanish as more artificial agents are added.
  const variance =
    opts.commonSd ** 2 +
    Object.values(cells).reduce(
      (sum, c) => sum + c.weight ** 2 * (c.sd ** 2 - opts.commonSd ** 2),
      0,
    );
  return {
    kind: "simulation" as const,
    scenario: scenario.id,
    asOf: opts.asOf,
    population: strata[0]!.population,
    partition: strata[0]!.partition,
    topline: { mean, sd: Math.sqrt(variance) },
    cells,
    assumptions: { ...opts, changes: { ...scenario.changes }, rationale: scenario.rationale },
    qualified: false as const,
  };
}
