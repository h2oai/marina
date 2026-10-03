// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Horizon-aware Civiqs nowcast. The plain nowcast carries the freshest daily
 * reading forward with the baseline's spread, which is right for a flat series
 * and wrong for one that is drifting: a round resolves on the reading dated the
 * Friday release day, and at a Wednesday lock the archive's newest reading is
 * often several days older than that (h = Friday − last reading date). Two
 * independent corrections, each a pure function of what existed at the lock:
 *
 *   drift  — a damped local trend (least-squares slope over the last few
 *            readings, projected h days with damping φ), applied only when the
 *            series' own walk-forward history at that horizon says a trend
 *            projection beats carrying the last value forward;
 *   spread — sd(h) from the same walk-forward h-step errors, plus the revision
 *            variance Civiqs's nightly re-estimation adds (earlier snapshots'
 *            newest readings against the lock snapshot's value for the same
 *            day). A round's outcome is itself a first-published reading, so
 *            revision noise counts at both ends.
 *
 * Every input comes from snapshots FETCHED at or before the lock (the same
 * rule as `civiqsNowcast`); nothing here reads a later file.
 */

import type { ArenaData } from "../data";
import type { ArenaRound } from "../types";
import { CIVIQS_SERIES, civiqsDailySeries, type LiveCiviqs } from "./civiqs-nowcast";

export type HorizonMode = "off" | "drift" | "sd" | "both";

export interface HorizonOptions {
  mode: HorizonMode;
  phi?: number;
  /** Unset applies to every series; an explicit list scopes an experiment. */
  series?: string[];
}

/** Readings the slope is fitted on. */
export const DRIFT_WINDOW = 7;
/** Default damping: each further day adds φ× the previous day's drift. */
export const DEFAULT_DAMPING = 0.8;
/** Walk-forward samples needed before either correction is trusted. */
export const MIN_SAMPLES = 10;
/** sd(h) bounds (points): never sharper than revision noise allows, never absurd. */
export const SD_FLOOR = 0.3;
export const SD_CAP = 5;
/** Days of earlier snapshots read for revision variance. */
export const REVISION_LOOKBACK_DAYS = 28;

const DAY = 86_400_000;

/** Whole days from `fromDate` to `toDate` (YYYY-MM-DD), never negative. */
export function horizonDays(fromDate: string, toDate: string): number {
  const d = Math.round((Date.parse(toDate.slice(0, 10)) - Date.parse(fromDate.slice(0, 10))) / DAY);
  return Math.max(0, d);
}

/** Least-squares slope per step of a short series (0 for fewer than two points). */
export function olsSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2;
  const ym = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  values.forEach((y, i) => {
    num += (i - xm) * (y - ym);
    den += (i - xm) ** 2;
  });
  return den ? num / den : 0;
}

/** Σ φ^i for i = 1..h: the damped number of drift steps over h days. */
export function dampedSteps(h: number, phi: number): number {
  if (h <= 0) return 0;
  if (phi >= 1) return h;
  if (phi <= 0) return 0;
  return (phi * (1 - phi ** h)) / (1 - phi);
}

/** Last value plus the damped drift of the last `window` readings, h days ahead. */
export function driftCentre(values: number[], h: number, phi: number, window = DRIFT_WINDOW) {
  const last = values.at(-1)!;
  return last + olsSlope(values.slice(-window)) * dampedSteps(h, phi);
}

/**
 * Walk-forward h-step errors inside one daily series: at each point t with
 * enough past, forecast y[t+h] from y[..t] (carry-forward or damped drift)
 * and record the error. Pure; reads only the given (pre-lock) values.
 */
export function hStepErrors(
  values: number[],
  h: number,
  mode: "last" | "drift",
  phi: number,
  window = DRIFT_WINDOW,
): number[] {
  const out: number[] = [];
  if (h <= 0) return out;
  for (let t = window - 1; t + h < values.length; t++) {
    const past = values.slice(0, t + 1);
    const f = mode === "drift" ? driftCentre(past, h, phi, window) : past.at(-1)!;
    out.push(values[t + h]! - f);
  }
  return out;
}

const rms = (xs: number[]) => Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length);

/** Does a damped trend projection beat carry-forward at this horizon on the series' own history? */
export function driftPersists(values: number[], h: number, phi: number, window = DRIFT_WINDOW) {
  const d = hStepErrors(values, h, "drift", phi, window);
  const l = hStepErrors(values, h, "last", phi, window);
  return d.length >= MIN_SAMPLES && rms(d) < rms(l);
}

/**
 * sd(h): walk-forward h-step RMS for the centre in use, combined with revision
 * noise at both ends (base reading and outcome), floored and capped. Undefined
 * when the series is too short to say.
 */
export function horizonSd(
  values: number[],
  h: number,
  mode: "last" | "drift",
  phi: number,
  revisionSd = 0,
): number | undefined {
  const errs = hStepErrors(values, Math.max(1, h), mode, phi);
  if (errs.length < MIN_SAMPLES) return undefined;
  const sd = Math.sqrt(rms(errs) ** 2 + 2 * revisionSd ** 2);
  return Math.min(SD_CAP, Math.max(SD_FLOOR, sd));
}

/**
 * Revision noise of a series' newest reading: for each earlier snapshot fetched
 * at least two days before `lockFetch`, its newest reading against the lock
 * snapshot's value for the same day. RMS; undefined with fewer than 3 pairs.
 */
export async function revisionSd(
  data: ArenaData,
  round: ArenaRound,
  lockPoints: Array<{ date: string; value: number }>,
  asOf: string,
): Promise<number | undefined> {
  const series = round.series ? CIVIQS_SERIES[round.series] : undefined;
  if (!series) return undefined;
  const byDate = new Map(lockPoints.map((p) => [p.date, p.value]));
  const start = Date.parse(asOf.slice(0, 10));
  const diffs: number[] = [];
  const seen = new Set<string>();
  for (let back = 2; back <= REVISION_LOOKBACK_DAYS; back++) {
    const day = new Date(start - back * DAY).toISOString().slice(0, 10);
    const earlier = await civiqsDailySeries(data, round, {
      days: 1,
      asOf: `${day}T23:59:59Z`,
      maxLookbackDays: 0,
    }).catch(() => undefined);
    const p = earlier?.points.at(-1);
    if (!p || seen.has(p.date)) continue;
    seen.add(p.date);
    const revised = byDate.get(p.date);
    if (revised !== undefined) diffs.push(revised - p.value);
  }
  return diffs.length >= 3 ? rms(diffs) : undefined;
}

export interface HorizonNowcast {
  mean: number;
  sd?: number;
  h: number;
  drift: boolean;
  lastDate: string;
  detail: Record<string, unknown>;
}

/**
 * The horizon-aware nowcast for one Civiqs series of a round (a topline, or a
 * profile cell via `{ ...round, series: cell }`). `mode` picks the corrections;
 * the target day is the round's release day. Undefined when no snapshot
 * fetched by the lock exists.
 */
export async function horizonNowcast(
  data: ArenaData,
  round: ArenaRound,
  mode: Exclude<HorizonMode, "off">,
  phi = DEFAULT_DAMPING,
  asOf: string = round.lock_at,
  live?: LiveCiviqs,
): Promise<HorizonNowcast | undefined> {
  // The same snapshot the nowcast reads (archive fetched by the lock; an open
  // round may use the live dashboard when it is at least as fresh).
  const daily = await civiqsDailySeries(data, round, { days: 120, asOf, live }).catch(
    () => undefined,
  );
  const pts = daily?.points ?? [];
  if (pts.length === 0) return undefined;
  const values = pts.map((p) => p.value);
  const last = pts.at(-1)!;
  const target = (round.release_at ?? round.lock_at).slice(0, 10);
  const h = horizonDays(last.date, target);
  const wantDrift = mode === "drift" || mode === "both";
  const wantSd = mode === "sd" || mode === "both";
  const drift = wantDrift && h > 0 && driftPersists(values, h, phi);
  const mean = drift ? driftCentre(values, h, phi) : last.value;
  let sd: number | undefined;
  let rev: number | undefined;
  if (wantSd) {
    rev = await revisionSd(data, round, pts, asOf);
    sd = horizonSd(values, h, drift ? "drift" : "last", phi, rev ?? 0);
  }
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    mean: r(mean),
    ...(sd !== undefined ? { sd: r(sd) } : {}),
    h,
    drift,
    lastDate: last.date,
    detail: {
      h,
      drift,
      slope: r(olsSlope(values.slice(-DRIFT_WINDOW))),
      phi,
      ...(rev !== undefined ? { revisionSd: r(rev) } : {}),
      source: daily?.source,
      points: pts,
    },
  };
}

/** `MARINA_ARENA_NOWCAST_HORIZON=off|drift|sd|both` (default off). */
export function horizonModeFromEnv(env: NodeJS.ProcessEnv = process.env): HorizonMode {
  const v = env.MARINA_ARENA_NOWCAST_HORIZON?.trim().toLowerCase();
  return v === "drift" || v === "sd" || v === "both" ? v : "off";
}

/** `MARINA_ARENA_NOWCAST_DAMPING` — φ in (0, 1]; anything else is the default. */
export function dampingFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.MARINA_ARENA_NOWCAST_DAMPING);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_DAMPING;
}

/** Read the complete policy from the caller's environment, not process globals. */
export function horizonOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): HorizonOptions {
  const raw = env.MARINA_ARENA_NOWCAST_SERIES;
  return {
    mode: horizonModeFromEnv(env),
    phi: dampingFromEnv(env),
    ...(raw === undefined
      ? {}
      : {
          series: raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }),
  };
}
