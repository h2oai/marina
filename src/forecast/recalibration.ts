// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Recalibration from the forecaster's own resolved history — the arena's
 * per-series spread, generalised: a map is fitted per answer group on resolved
 * forecasts visible at the cutoff and used only when it beats identity on the
 * newer, held-out part of that history by the margin (`adoptOnHoldout`).
 *
 *   binary:<a>|<b>  Platt in log-odds on the first option (a two-option choice
 *                   with the same option ids — yes/no questions share one map)
 *   choice          Platt one-vs-rest on every option, renormalised
 *   multi           Platt on every option's own probability
 *   number          a scale on the stated sd (CRPS), the point untouched
 *
 * Platt: p' = σ(a·logit(p) + b) — a > 1 sharpens, a < 1 tempers, b shifts.
 * The fit minimises log loss with a light ridge toward identity (a = 1, b = 0)
 * and the parameters are bounded, so a small history cannot produce a wild
 * map. A monotone map never changes a choice's most probable option or a
 * number's point; it changes the probabilities a proper score reads, and which
 * options of a multi-select clear one half. Pure functions.
 */

import type { AnswerSpec } from "./answer-types";
import { type Distribution, normalise } from "./distribution";
import {
  type AdoptionResult,
  adoptOnHoldout,
  clampP,
  gridArgmin,
  logit,
  meanLoss,
  type ProperScore,
  round,
  sigmoid,
} from "./fitting";
import { answerGroup, type ForecastNumbers, type ResolvedRecord } from "./history";

export type CalibrationMap =
  | { kind: "identity" }
  | { kind: "platt"; a: number; b: number }
  | { kind: "sd-scale"; s: number };

export const IDENTITY: CalibrationMap = { kind: "identity" };

const A_RANGE: [number, number] = [0.25, 4];
const B_RANGE: [number, number] = [-3, 3];
const RIDGE = 1;
export const SD_SCALES = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3];

const clamp = (x: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, x));

/** The option a binary group calibrates (the first of its ids, case-insensitively sorted). */
export function binaryEvent(ids: string[]): string | undefined {
  return [...ids].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()))[0];
}

/** `f` through `map` (a no-op for identity or a mismatched kind). */
export function applyCalibration(
  group: string,
  map: CalibrationMap,
  f: ForecastNumbers,
): ForecastNumbers {
  if (map.kind === "identity") return f;
  if (map.kind === "sd-scale") {
    return f.sd !== undefined ? { ...f, sd: round(f.sd * map.s, 6) } : f;
  }
  const d = f.distribution;
  if (!d) return f;
  const t = (p: number) => clampP(sigmoid(map.a * logit(p) + map.b));
  if (group.startsWith("binary:")) {
    const ids = Object.keys(d);
    const e = binaryEvent(ids);
    const other = ids.find((k) => k !== e);
    if (e === undefined || other === undefined) return f;
    const p = round(t(d[e] ?? 0.5));
    return { distribution: { [e]: p, [other]: round(1 - p) } };
  }
  const out: Distribution = {};
  for (const [k, p] of Object.entries(d)) out[k] = round(t(p));
  if (group === "multi") return { distribution: out };
  return { distribution: normalise(out) ?? d };
}

/** The (probability, outcome) events a record contributes to a Platt fit. */
function events(
  group: string,
  r: ResolvedRecord,
  f: ForecastNumbers,
): Array<{ z: number; y: number }> {
  const d = f.distribution;
  if (!d) return [];
  const truth = new Set(r.outcome.options ?? []);
  if (group.startsWith("binary:")) {
    const e = binaryEvent(Object.keys(d));
    if (e === undefined || d[e] === undefined || truth.size !== 1) return [];
    return [{ z: logit(d[e]!), y: truth.has(e) ? 1 : 0 }];
  }
  const ids = group === "multi" ? (r.resolvedOptions ?? Object.keys(d)) : Object.keys(d);
  if (group !== "multi" && truth.size !== 1) return [];
  return ids
    .filter((k) => d[k] !== undefined)
    .map((k) => ({ z: logit(d[k]!), y: truth.has(k) ? 1 : 0 }));
}

/** Platt (a, b) by Newton on log loss with a ridge toward (1, 0); undefined with no events. */
export function fitPlatt(
  points: Array<{ z: number; y: number }>,
): { a: number; b: number } | undefined {
  if (points.length === 0) return undefined;
  let a = 1;
  let b = 0;
  for (let it = 0; it < 50; it++) {
    let ga = RIDGE * (a - 1);
    let gb = RIDGE * b;
    let haa = RIDGE;
    let hab = 0;
    let hbb = RIDGE;
    for (const { z, y } of points) {
      const p = sigmoid(a * z + b);
      const r = p - y;
      const w = p * (1 - p);
      ga += r * z;
      gb += r;
      haa += w * z * z;
      hab += w * z;
      hbb += w;
    }
    const det = haa * hbb - hab * hab;
    if (!(Math.abs(det) > 1e-12)) break;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    a = clamp(a - da, A_RANGE);
    b = clamp(b - db, B_RANGE);
    if (Math.abs(da) < 1e-7 && Math.abs(db) < 1e-7) break;
  }
  return { a: round(a, 4), b: round(b, 4) };
}

export interface CalibrationFit extends AdoptionResult<CalibrationMap> {
  group: string;
  score: ProperScore | "crps";
}

/**
 * The map for `spec`'s group, fitted on the visible records of that group.
 * `forecastOf` gives each record's forecast as it would reach calibration
 * (after its prior shrink), so the map is fitted on what it will be applied to.
 */
export function fitCalibration(input: {
  spec: AnswerSpec;
  history: ResolvedRecord[];
  forecastOf: (r: ResolvedRecord) => ForecastNumbers;
  margin: number;
  minRecords: number;
  score: ProperScore;
}): CalibrationFit | undefined {
  const group = answerGroup(input.spec);
  if (input.spec.type === "ranking" || input.spec.type === "text") return undefined;
  const records = input.history.filter((r) => r.group === group);
  const lossWith = (rs: ResolvedRecord[], map: CalibrationMap) =>
    meanLoss(rs, (r) => applyCalibration(group, map, input.forecastOf(r)), input.score);
  const fit = (rs: ResolvedRecord[]): CalibrationMap | undefined => {
    if (input.spec.type === "number") {
      const s = gridArgmin(SD_SCALES, (s) => lossWith(rs, { kind: "sd-scale", s }).loss);
      return s === undefined ? undefined : { kind: "sd-scale", s };
    }
    const points = rs.flatMap((r) => events(group, r, input.forecastOf(r)));
    const p = fitPlatt(points);
    return p ? { kind: "platt", ...p } : undefined;
  };
  const result = adoptOnHoldout<CalibrationMap>(records, {
    fallback: IDENTITY,
    fit,
    loss: lossWith,
    margin: input.margin,
    minRecords: input.minRecords,
  });
  return { ...result, group, score: input.spec.type === "number" ? "crps" : input.score };
}
