// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CalibrationObservation } from "./uncertainty";

function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("calibration timestamps must include a valid timezone");
  return new Date(value).toISOString();
}

function observation(input: unknown): CalibrationObservation {
  if (!input || typeof input !== "object") throw new Error("invalid calibration observation");
  const r = input as CalibrationObservation;
  if (
    [r.roundId, r.variant, r.family, r.unit].some((s) => typeof s !== "string" || !s.trim()) ||
    !Number.isFinite(r.horizon) ||
    r.horizon < 0 ||
    !Number.isFinite(r.sourceAge) ||
    r.sourceAge < 0 ||
    !Number.isFinite(r.forecast?.mean) ||
    !Number.isFinite(r.forecast?.sd) ||
    r.forecast.sd <= 0 ||
    !Number.isFinite(r.outcome) ||
    !Number.isFinite(r.persistenceCrps) ||
    r.persistenceCrps <= 0
  )
    throw new Error("invalid calibration observation");
  const asOf = timestamp(r.asOf);
  const lockAt = timestamp(r.lockAt);
  const availableAt = timestamp(r.availableAt);
  if (asOf >= lockAt || lockAt >= availableAt)
    throw new Error("calibration requires prediction < lock < outcome availability");
  // Copy only the public contract, in canonical order, so replays and timezone
  // spellings compare identically. Imported object properties are not trusted.
  return {
    roundId: r.roundId,
    variant: r.variant,
    family: r.family,
    unit: r.unit,
    asOf,
    horizon: r.horizon,
    sourceAge: r.sourceAge,
    lockAt,
    availableAt,
    forecast: { mean: r.forecast.mean, sd: r.forecast.sd },
    outcome: r.outcome,
    persistenceCrps: r.persistenceCrps,
  };
}

/** Merge trusted scorer exports, not arbitrary claims of prospective accuracy.
 * Duplicate scoring runs never create extra rounds. Conflicting records require
 * operator review; they cannot silently replace an earlier outcome or forecast.
 * This inventories evidence only: calibrateUncertainty still owns the time split
 * and held-out gate for each real future forecast. It cannot promote a policy.
 */
export function mergeCalibrationHistory(sources: unknown[], asOf: string) {
  const cutoff = timestamp(asOf);
  const unique = new Map<string, CalibrationObservation>();
  let imported = 0;
  let duplicates = 0;
  for (const source of sources) {
    if (!Array.isArray(source)) throw new Error("calibration source must be an array");
    for (const input of source) {
      if (++imported > 100_000) throw new Error("calibration import exceeds 100000 observations");
      const row = observation(input);
      const key = JSON.stringify([row.variant, row.family, row.unit, row.roundId, row.asOf]);
      const previous = unique.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(row))
        throw new Error(`conflicting calibration observation for ${row.roundId}`);
      if (previous) duplicates++;
      else unique.set(key, row);
    }
  }
  const latest = new Map<string, CalibrationObservation>();
  let unavailable = 0;
  let superseded = 0;
  for (const row of unique.values()) {
    if (row.availableAt >= cutoff) {
      unavailable++;
      continue;
    }
    const key = JSON.stringify([row.variant, row.family, row.unit, row.roundId]);
    const previous = latest.get(key);
    if (previous) {
      if (
        previous.lockAt !== row.lockAt ||
        previous.outcome !== row.outcome ||
        previous.persistenceCrps !== row.persistenceCrps ||
        previous.availableAt !== row.availableAt
      )
        throw new Error(`conflicting calibration outcome for ${row.roundId}`);
      superseded++;
    }
    // Same rule as calibrateUncertainty: latest prospective forecast per round.
    if (!previous || previous.asOf < row.asOf) latest.set(key, row);
  }
  const observations = [...latest.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, row]) => row);
  const groups = new Map<
    string,
    { variant: string; family: string; unit: string; rounds: number; waves: Set<string> }
  >();
  for (const row of observations) {
    const key = JSON.stringify([row.variant, row.family, row.unit]);
    const group = groups.get(key) ?? {
      variant: row.variant,
      family: row.family,
      unit: row.unit,
      rounds: 0,
      waves: new Set<string>(),
    };
    group.rounds++;
    group.waves.add(row.lockAt);
    groups.set(key, group);
  }
  return {
    schema: "marina.arena.calibration-history.v1" as const,
    asOf: cutoff,
    imported,
    duplicates,
    superseded,
    unavailable,
    observations,
    groups: [...groups.values()].map(({ waves, ...group }) => ({
      ...group,
      waves: waves.size,
      status:
        group.rounds < 12
          ? "insufficient-rounds"
          : waves.size < 2
            ? "insufficient-waves"
            : "requires-target-validation",
    })),
    promotion: "none" as const,
  };
}
