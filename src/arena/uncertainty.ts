// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { crpsNormal } from "./score";
import type { Distribution } from "./types";

export interface CalibrationContext {
  roundId: string;
  /** Exact estimator/configuration identity, never just a model name. */
  variant: string;
  family: string;
  unit: string;
  asOf: string;
  horizon: number;
  sourceAge: number;
}

export interface CalibrationObservation extends CalibrationContext {
  lockAt: string;
  availableAt: string;
  forecast: Distribution;
  outcome: number;
  persistenceCrps: number;
}

export interface CalibrationResult {
  forecast: Distribution;
  applied: boolean;
  scale: number;
  reason: string;
  eligible: number;
  training: string[];
  validation: string[];
  metrics?: {
    originalLoss: number;
    calibratedLoss: number;
    coverage80Before: number;
    coverage80After: number;
  };
}

const validDistribution = (d: Distribution) =>
  Number.isFinite(d.mean) && Number.isFinite(d.sd) && d.sd > 0;
const finiteTime = (s: string) => Number.isFinite(Date.parse(s));
const weight = (a: CalibrationContext, b: CalibrationContext) =>
  1 / (1 + Math.abs(a.horizon - b.horizon) / 7 + Math.abs(a.sourceAge - b.sourceAge) / 7);

/**
 * Shadow-only spread calibration of COMPLETE forecasts. Fit a small scale grid
 * on earlier rounds and require an improvement on a later, untouched time
 * block. Each wave stays in one block. Outcomes must have been available before
 * the validation block began; final estimates never train on their own answer.
 * Neighbouring horizons/source ages borrow strength, within one family/unit
 * and exact estimator. Means remain unchanged. Insufficient evidence is a no-op.
 */
export function calibrateUncertainty(
  forecast: Distribution,
  context: CalibrationContext,
  observations: CalibrationObservation[],
): CalibrationResult {
  const latest = new Map<string, CalibrationObservation>();
  for (const o of observations) {
    if (
      o.roundId === context.roundId ||
      o.variant !== context.variant ||
      o.family !== context.family ||
      o.unit !== context.unit ||
      !validDistribution(o.forecast) ||
      !Number.isFinite(o.outcome) ||
      !Number.isFinite(o.persistenceCrps) ||
      o.persistenceCrps <= 0 ||
      !Number.isFinite(o.horizon) ||
      o.horizon < 0 ||
      !Number.isFinite(o.sourceAge) ||
      o.sourceAge < 0 ||
      ![o.asOf, o.lockAt, o.availableAt, context.asOf].every(finiteTime) ||
      Date.parse(o.asOf) >= Date.parse(o.lockAt) ||
      Date.parse(o.lockAt) >= Date.parse(o.availableAt) ||
      Date.parse(o.availableAt) >= Date.parse(context.asOf)
    )
      continue;
    const prior = latest.get(o.roundId);
    if (!prior || Date.parse(prior.asOf) < Date.parse(o.asOf)) latest.set(o.roundId, o);
  }
  const rows = [...latest.values()].sort((a, b) => Date.parse(a.lockAt) - Date.parse(b.lockAt));
  const unchanged = (reason: string) => ({
    forecast: { ...forecast },
    applied: false,
    scale: 1,
    reason,
    eligible: rows.length,
    training: [] as string[],
    validation: [] as string[],
  });
  if (
    !validDistribution(forecast) ||
    !finiteTime(context.asOf) ||
    !Number.isFinite(context.horizon) ||
    context.horizon < 0 ||
    !Number.isFinite(context.sourceAge) ||
    context.sourceAge < 0
  )
    return unchanged("invalid target");
  if (rows.length < 12)
    return unchanged("insufficient matched final-forecast history (need 12 rounds)");
  const cut = rows[Math.floor((rows.length * 2) / 3)]!.lockAt;
  const validation = rows.filter((r) => Date.parse(r.lockAt) >= Date.parse(cut));
  const validationStart = Math.min(...validation.map((r) => Date.parse(r.asOf)));
  const training = rows.filter(
    (r) => Date.parse(r.lockAt) < Date.parse(cut) && Date.parse(r.availableAt) < validationStart,
  );
  if (training.length < 8 || validation.length < 4)
    return unchanged("insufficient chronological training/validation split (need 8/4)");
  const loss = (samples: CalibrationObservation[], scale: number) => {
    const weights = samples.map((s) => weight(context, s));
    return (
      samples.reduce(
        (sum, s, i) =>
          sum +
          (weights[i]! * crpsNormal(s.forecast.mean, s.forecast.sd * scale, s.outcome)) /
            s.persistenceCrps,
        0,
      ) / weights.reduce((a, b) => a + b, 0)
    );
  };
  // Conservative bounded changes; include identity and prefer it on ties.
  let scale = 1;
  for (const candidate of [0.65, 0.8, 1.25, 1.5])
    if (loss(training, candidate) < loss(training, scale)) scale = candidate;
  const originalLoss = loss(validation, 1);
  const calibratedLoss = loss(validation, scale);
  const applied = scale !== 1 && calibratedLoss < originalLoss * 0.95;
  const coverage = (s: number) =>
    validation.filter((o) => Math.abs(o.outcome - o.forecast.mean) <= 1.281552 * o.forecast.sd * s)
      .length / validation.length;
  return {
    forecast: { mean: forecast.mean, sd: forecast.sd * (applied ? scale : 1) },
    applied,
    scale: applied ? scale : 1,
    reason: applied
      ? "validated on later final-forecast errors; shadow only"
      : "held-out improvement below five percent",
    eligible: rows.length,
    training: training.map((r) => r.roundId),
    validation: validation.map((r) => r.roundId),
    metrics: {
      originalLoss,
      calibratedLoss,
      coverage80Before: coverage(1),
      coverage80After: coverage(applied ? scale : 1),
    },
  };
}
