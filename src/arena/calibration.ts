// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One calibrator for filed spreads: the general forecaster's sd-scale map
 * (`src/forecast/recalibration.ts`), keyed per (family, method) and fitted on
 * our OWN resolved arena filings.
 *
 *   key        `arena:<tracker>|<method>` — e.g. `arena:civiqs|formation:delphi`
 *   evidence   the newest accepted filing of every resolved round (the version
 *              the board scored), its forecaster's sd before calibration and
 *              the error floor, and the published value — visible only once
 *              resolved before now, never the round being filed
 *   fit        the minimum-CRPS scale on `SD_SCALES`, shrunk toward 1 in log
 *              space by n / (n + SD_SHRINK)
 *   adoption   the older 60 % fits, the newer 40 % judges: adopted only when
 *              the held-out CRPS improves by `CALIBRATION_MARGIN`; else identity
 *
 * With too little history the map is identity, so this is a no-op until the
 * evidence earns a change. The mean is never moved, and the measured-error
 * floor (`applyErrorFloor`) runs after it. `MARINA_ARENA_CALIBRATION=observe`
 * records the map without applying it; `off` skips it.
 */

import { getErrorMessage } from "../engine/errors";
import { type ForecastNumbers, type ResolvedRecord, visibleRecords } from "../forecast/history";
import { applyCalibration, fitCalibration } from "../forecast/recalibration";
import type { ArenaSubmissionRow } from "../persistence/db-arena";
import { CALIBRATION_MARGIN, type RoundForecast } from "./forecast";
import type { ArenaResolution, ArenaRound } from "./types";

export type CalibrationMode = "off" | "observe" | "on";

/** Fewest resolved filings of one (family, method) before a map is considered. */
export const MIN_CALIBRATION_RECORDS = 8;
/** Pseudo-records shrinking a fitted scale toward 1. */
export const SD_SHRINK = 4;

export function calibrationModeFromEnv(env: NodeJS.ProcessEnv = process.env): CalibrationMode {
  const m = env.MARINA_ARENA_CALIBRATION?.trim().toLowerCase();
  return m === "off" || m === "observe" ? m : "on";
}

/**
 * The method that produced a forecast, from its note, at pattern level: model
 * lists change with every model generation, so they would fragment the record.
 * `route <family> → <spec>` names the routed spec; research is part of the
 * method unless it ran closed-book.
 */
export function methodOf(note: string | undefined): string {
  const text = note ?? "";
  const spec = /route \S+ → ([^;\s]+)/.exec(text)?.[1];
  if (!spec) return /Civiqs daily nowcast/.test(text) ? "nowcast" : "baseline";
  const [head, rest] = [spec.split("+")[0]!, spec.slice(spec.split("+")[0]!.length)];
  const kind = head.split(":")[0]!;
  const base = kind === "formation" ? `formation:${head.split(":")[1] ?? "?"}` : kind;
  const researched = /\+research@/.test(rest) && !/\+research@closed-book/.test(rest);
  return researched ? `${base}+research` : base;
}

export function calibrationKey(family: string, method: string): string {
  return `arena:${family}|${method}`;
}

interface FiledDetail {
  round?: { tracker?: string };
  forecast?: {
    note?: string;
    calibration?: { fromSd?: number };
    errorFloorApplied?: { fromSd?: number };
  };
}

/**
 * One record per resolved round: the newest accepted filing (the one scored),
 * keyed by family and method, with the sd its forecaster produced — what this
 * calibrator is applied to.
 */
export function arenaCalibrationHistory(
  rows: ArenaSubmissionRow[],
  resolutions: Record<string, ArenaResolution>,
  /** round id → tracker (the season's rounds); early ledger rows carry no detail. */
  trackers: Record<string, string> = {},
): ResolvedRecord[] {
  const newest = new Map<string, ArenaSubmissionRow>();
  for (const row of rows) {
    if (row.status !== "accepted") continue;
    const prev = newest.get(row.round_id);
    if (!prev || row.id > prev.id) newest.set(row.round_id, row);
  }
  const out: ResolvedRecord[] = [];
  for (const [roundId, row] of newest) {
    const res = resolutions[roundId];
    if (!res || res.voided || typeof res.value !== "number" || !res.resolved_at) continue;
    if (!Number.isFinite(Date.parse(res.resolved_at))) continue;
    let body: { topline?: { mean: number; sd: number }; notes?: string } = {};
    let detail: FiledDetail = {};
    try {
      body = JSON.parse(row.body) as typeof body;
      detail = JSON.parse(row.detail || "{}") as FiledDetail;
    } catch {
      continue; // allow-empty-catch: a malformed ledger row is no evidence
    }
    const topline = body.topline;
    if (!topline || !(topline.sd > 0) || !Number.isFinite(topline.mean)) continue;
    const rawSd =
      detail.forecast?.calibration?.fromSd ?? detail.forecast?.errorFloorApplied?.fromSd;
    const family = detail.round?.tracker ?? trackers[roundId] ?? roundId.split("-")[0]!;
    // The signed body's notes carry the same route line when the detail is empty.
    const note = detail.forecast?.note ?? body.notes;
    out.push({
      id: roundId,
      answerType: "number",
      group: calibrationKey(family, methodOf(note)),
      resolvedAt: res.resolved_at,
      raw: { value: topline.mean, sd: rawSd && rawSd > 0 ? rawSd : topline.sd },
      outcome: { value: res.value },
    });
  }
  return out;
}

export interface CalibrationRecord {
  key: string;
  mode: CalibrationMode;
  adopted: boolean;
  applied: boolean;
  scale?: number;
  fromSd?: number;
  reason: string;
  nFit?: number;
  nHoldout?: number;
  holdout?: { default: number; candidate: number; improvement: number };
}

/**
 * The forecast with its topline sd scaled by the (family, method) map, plus a
 * `calibration` record of what was decided. Profiles and rankings pass
 * through: the board scores them by energy score and RBO, and per-cell CRPS
 * evidence would treat one round's cells as independent records.
 */
export function calibrateFiledForecast(
  round: ArenaRound,
  f: RoundForecast,
  history: ResolvedRecord[],
  opts: { now: number; mode?: CalibrationMode },
): RoundForecast & { calibration?: CalibrationRecord } {
  const mode = opts.mode ?? "on";
  if (mode === "off" || !f.topline) return f;
  const key = calibrationKey(round.tracker, methodOf(f.note));
  try {
    const visible = visibleRecords(history, new Date(opts.now).toISOString(), round.round_id);
    const fit = fitCalibration({
      spec: { type: "number" },
      history: visible,
      forecastOf: (r) => r.raw,
      margin: CALIBRATION_MARGIN,
      minRecords: MIN_CALIBRATION_RECORDS,
      score: "brier",
      key,
      sdShrink: SD_SHRINK,
    });
    if (!fit) return f;
    const scale = fit.params.kind === "sd-scale" ? fit.params.s : undefined;
    const record: CalibrationRecord = {
      key,
      mode,
      adopted: fit.adopted,
      applied: false,
      ...(scale !== undefined ? { scale } : {}),
      fromSd: f.topline.sd,
      reason: fit.reason,
      nFit: fit.nFit,
      nHoldout: fit.nHoldout,
      ...(fit.holdout ? { holdout: fit.holdout } : {}),
    };
    if (!fit.adopted || mode !== "on" || scale === undefined || scale === 1) {
      return { ...f, calibration: record };
    }
    const raw: ForecastNumbers = { value: f.topline.mean, sd: f.topline.sd };
    const sd = applyCalibration("number", fit.params, raw).sd ?? f.topline.sd;
    const scaled = Math.round(sd * 1000) / 1000;
    return {
      ...f,
      topline: { ...f.topline, sd: scaled },
      calibration: { ...record, applied: true },
      note: `${f.note}; sd ×${scale} calibrated on ${key} (held out)`,
    };
  } catch (err) {
    return {
      ...f,
      calibration: {
        key,
        mode,
        adopted: false,
        applied: false,
        fromSd: f.topline.sd,
        reason: `calibration failed: ${getErrorMessage(err)}`,
      },
    };
  }
}
