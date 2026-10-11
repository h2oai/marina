// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { availableInstant } from "../research/measurement";

/** Numeric features retain both observation and information time. No forward-fill
 * from a release that was not yet public at the training origin. */
export interface CovariateVintage {
  name: string;
  observedAt: string;
  availableAt: string;
  value: number;
}

export function covariatesAt(
  rows: readonly CovariateVintage[],
  asOf: string,
): Record<string, number | null> {
  const cutoff = availableInstant(asOf) ?? Number.NaN;
  if (!Number.isFinite(cutoff)) throw new Error("invalid covariate cutoff");
  const selected = new Map<string, CovariateVintage>();
  const out: Record<string, number | null> = {};
  for (const row of rows) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(row.name) ||
      !Number.isFinite(row.value) ||
      availableInstant(row.availableAt) === undefined ||
      availableInstant(row.observedAt) === undefined ||
      Date.parse(row.observedAt) > availableInstant(row.availableAt)!
    )
      throw new Error("invalid covariate vintage");
    const key = `cov_${row.name}`;
    out[key] = null;
    const available = availableInstant(row.availableAt)!;
    if (available > cutoff || Date.parse(row.observedAt) > cutoff) continue;
    const prior = selected.get(key);
    if (
      !prior ||
      Date.parse(row.observedAt) > Date.parse(prior.observedAt) ||
      (row.observedAt === prior.observedAt &&
        Date.parse(row.availableAt) > Date.parse(prior.availableAt))
    )
      selected.set(key, row);
    else if (
      row.observedAt === prior.observedAt &&
      row.availableAt === prior.availableAt &&
      row.value !== prior.value
    )
      throw new Error("conflicting covariate vintage");
  }
  for (const [key, row] of selected) out[key] = row.value;
  return out;
}

/** Fixed local-level challenger; residuals are horizon-matched rolling predictions,
 * not in-sample fit errors. Configuration is chosen before prospective evaluation. */
export function localLevel(
  points: readonly { date: string; value: number }[],
  steps: number,
  fallbackSd: number,
  alpha = 0.5,
) {
  if (
    !points.length ||
    !Number.isSafeInteger(steps) ||
    steps < 1 ||
    !(fallbackSd > 0) ||
    !Number.isFinite(fallbackSd) ||
    !(alpha > 0 && alpha <= 1)
  )
    throw new Error("invalid local-level inputs");
  let level = points[0]!.value;
  const levels: number[] = [];
  const errors: number[] = [];
  points.forEach((p, i) => {
    if (
      !Number.isFinite(p.value) ||
      !Number.isFinite(Date.parse(p.date)) ||
      (i > 0 && Date.parse(p.date) <= Date.parse(points[i - 1]!.date))
    )
      throw new Error("invalid local-level history");
    if (i >= steps + 3) errors.push(p.value - levels[i - steps]!);
    level = alpha * p.value + (1 - alpha) * level;
    levels.push(level);
  });
  const recent = errors.slice(-26);
  const rms =
    recent.length >= 6
      ? Math.sqrt(recent.reduce((s, e) => s + e * e, 0) / recent.length)
      : fallbackSd;
  return {
    mean: level,
    sd: Math.max(rms, fallbackSd * 0.1),
    detail: {
      alpha,
      steps,
      residuals: recent.length,
      uncertainty: recent.length >= 6 ? "rolling-origin" : "baseline",
    },
  };
}
