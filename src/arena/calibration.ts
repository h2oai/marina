// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One calibrator for filed spreads: a multiplier on every filed sd — the
 * topline of a scalar round, every cell of a profile round — learned from
 * resolved rounds and partially pooled, so it is active from the first
 * resolved round instead of waiting for a per-key quorum.
 *
 *   family     the tracker, plus `:profile` for a profile round (a profile's
 *              cells and a scalar topline get their sds from different paths)
 *   key        `arena:<family>|<method>` — e.g. `arena:civiqs|formation:delphi`
 *   evidence   one record per resolved round we filed: the sd as it stood
 *              before this calibrator (the forecaster's, after the measured
 *              error floor), the published outcome, and persistence's loss on
 *              the round. Our ledger supplies the filing; the arena's public
 *              site data supplies the outcome, persistence's loss and — for a
 *              round missing from the ledger — our filed forecast. A record is
 *              visible only when its outcome was published at or before
 *              min(now, the round's lock), and never for the round itself.
 *   fit        ŝ = the multiplier on `SPREAD_GRID` that maximises the
 *              leaderboard's metric over the records — the mean of per-round
 *              skill 1 − loss(s) / persistence loss, loss = CRPS for a scalar
 *              and the arena's energy score for a profile (exact: the point
 *              set is linear in s)
 *   pooling    log-space: (series, method) toward its series, w = n/(n+k);
 *              series toward its family, w = n/(n+k); family toward the
 *              global multiplier, w = n/(n+k); the global
 *              multiplier is the geometric mean of the families' ŝ (each
 *              family once) shrunk toward 1 by F/(F+k); k = `SPREAD_POOL_K`.
 *              Then clamped to [`MIN_SPREAD_SCALE`, `MAX_SPREAD_SCALE`].
 *              The series level exists because one tracker's series can be
 *              miscalibrated in opposite directions (Civiqs net approval too
 *              wide, angry-share too narrow): a tracker-wide multiplier fixed
 *              one by breaking the other. A record without a series counts
 *              only from the family level up.
 *
 * It runs LAST, after the measured-error floor: the floor is one estimate of
 * how wide a filing should be, the resolved rounds are the measurement, and on
 * Civiqs the floor was what kept filings ~2.7× wider than their misses. The
 * mean is never moved. The decision and its evidence (n, ŝ, w per level) are
 * kept under `spreadCalibration` in the filing's detail. A scalar filing made
 * from a stale anchor is no evidence about spread (its miss was the old reading,
 * not the forecaster): see `staleLegacyFiling`.
 * `MARINA_ARENA_SPREAD_CALIBRATION=observe` records without applying; `off`
 * skips it (the retired `MARINA_ARENA_CALIBRATION` is read as a fallback).
 */

import { getErrorMessage } from "../engine/errors";
import type { ArenaSubmissionRow } from "../persistence/db-arena";
import { sameReading } from "./anchor";
import type { RoundForecast } from "./forecast";
import { RESEARCH_FALLBACK_NOTE } from "./research-fallback";
import { crpsNormal } from "./score";
import { cellSamples } from "./score-shapes";
import type { ArenaResolution, ArenaRound, Distribution } from "./types";

export type CalibrationMode = "off" | "observe" | "on";

/** Candidate multipliers of the filed sd: 0.30, 0.35, …, 3.00. */
export const SPREAD_GRID: readonly number[] = Array.from(
  { length: 55 },
  (_, i) => Math.round((0.3 + 0.05 * i) * 100) / 100,
);
/** Pseudo-rounds pulling each level toward the one above it (global → 1). */
export const SPREAD_POOL_K = 4;
export const MIN_SPREAD_SCALE = 0.35;
export const MAX_SPREAD_SCALE = 3;
const DAY_MS = 86_400_000;

export function spreadCalibrationModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CalibrationMode {
  const raw = env.MARINA_ARENA_SPREAD_CALIBRATION?.trim() || env.MARINA_ARENA_CALIBRATION?.trim();
  const m = raw?.toLowerCase();
  return m === "off" || m === "observe" ? m : "on";
}

/**
 * The method that produced a forecast, from its note, at pattern level: model
 * lists change with every model generation, so they would fragment the record.
 * `route <family> → <spec>` names the routed spec; research is part of the
 * method unless it ran closed-book (by spec, or as a research fallback).
 */
export function methodOf(note: string | undefined): string {
  const text = note ?? "";
  const spec = /route \S+ → ([^;\s]+)/.exec(text)?.[1];
  if (!spec) return /Civiqs daily nowcast/.test(text) ? "nowcast" : "baseline";
  const [head, rest] = [spec.split("+")[0]!, spec.slice(spec.split("+")[0]!.length)];
  const kind = head.split(":")[0]!;
  const base = kind === "formation" ? `formation:${head.split(":")[1] ?? "?"}` : kind;
  const researched =
    /\+research@/.test(rest) &&
    !/\+research@closed-book/.test(rest) &&
    !RESEARCH_FALLBACK_NOTE.test(text);
  return researched ? `${base}+research` : base;
}

export function calibrationKey(family: string, method: string): string {
  return `arena:${family}|${method}`;
}

/** The spread family of a round: its tracker, separated by answer shape. */
export function spreadFamily(round: Pick<ArenaRound, "tracker" | "target_type">): string {
  return round.target_type === "profile_energy" ? `${round.tracker}:profile` : round.tracker;
}

/** One resolved round as spread evidence. */
export interface SpreadRecord {
  roundId: string;
  family: string;
  /** The round's series (`civiqs_net_approval`), when known. */
  series?: string;
  method: string;
  /** When its outcome was public (ms): visible to a lock at or after it. */
  knownAt: number;
  /** The board's loss on this round with every filed sd multiplied by `s`. */
  loss: (s: number) => number;
  /** Persistence's loss on the round (else ours at s = 1): the skill denominator. */
  norm: number;
}

/** CRPS of a scalar filing at sd × s. */
export function scalarSpreadLoss(f: Distribution, outcome: number): (s: number) => number {
  return (s) => crpsNormal(f.mean, f.sd * s, outcome);
}

/**
 * The arena's energy score of a profile filing at every cell sd × s, exactly.
 * Its point set is mean + s · D (D the point set at mean 0, sd as filed), so
 * the pairwise term is s · T2 — computed once — and only the outcome term is
 * recomputed per s. Cells in the round's order (the point set depends on it).
 */
export function profileSpreadLoss(
  cells: Array<Distribution & { outcome: number }>,
): (s: number) => number {
  const dev = cellSamples(cells.map((c) => ({ mean: 0, sd: c.sd })));
  const n = dev.length;
  const k = cells.length;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const a = dev[i]!;
    for (let j = i + 1; j < n; j++) {
      const b = dev[j]!;
      let d2 = 0;
      for (let c = 0; c < k; c++) d2 += (a[c]! - b[c]!) ** 2;
      acc += Math.sqrt(d2);
    }
  }
  const t2 = (2 * acc) / (n * n);
  const gap = cells.map((c) => c.mean - c.outcome);
  return (s) => {
    let t1 = 0;
    for (const row of dev) {
      let d2 = 0;
      for (let c = 0; c < k; c++) d2 += (gap[c]! + s * row[c]!) ** 2;
      t1 += Math.sqrt(d2);
    }
    return t1 / n - 0.5 * s * t2;
  };
}

/**
 * The multiplier on `SPREAD_GRID` with the highest mean per-round skill
 * (equivalently the lowest mean loss ÷ persistence loss); undefined with no
 * records. Ties keep the multiplier nearest 1.
 */
export function bestSpreadScale(records: SpreadRecord[]): number | undefined {
  if (!records.length) return undefined;
  let best: number | undefined;
  let bestLoss = Number.POSITIVE_INFINITY;
  for (const s of SPREAD_GRID) {
    let total = 0;
    for (const r of records) total += r.loss(s) / r.norm;
    const better =
      total < bestLoss - 1e-12 ||
      (Math.abs(total - bestLoss) <= 1e-12 &&
        best !== undefined &&
        Math.abs(Math.log(s)) < Math.abs(Math.log(best)));
    if (better) {
      best = s;
      bestLoss = Math.min(bestLoss, total);
    }
  }
  return best;
}

export interface SpreadLevel {
  /** Resolved rounds at this level. */
  n: number;
  /** Global level only: families behind it (its weight is families / (families + k)). */
  families?: number;
  /** The level's own best multiplier (absent with no records). */
  sHat?: number;
  /** Weight on `sHat`: n / (n + k). */
  w: number;
  /** The level's pooled multiplier. */
  s: number;
}

export interface SpreadPool {
  global: SpreadLevel;
  family: SpreadLevel;
  /** Present when a series was named: the series' level between family and method. */
  series?: SpreadLevel;
  method: SpreadLevel;
  /** `method.s` clamped to [MIN_SPREAD_SCALE, MAX_SPREAD_SCALE]. */
  scale: number;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

function level(records: SpreadRecord[], parent: number, k: number): SpreadLevel {
  const sHat = bestSpreadScale(records);
  const n = records.length;
  if (sHat === undefined) return { n: 0, w: 0, s: parent };
  const w = n / (n + k);
  return { n, sHat, w: r3(w), s: Math.exp(w * Math.log(sHat) + (1 - w) * Math.log(parent)) };
}

/**
 * The cross-family level: the geometric mean of every family's own ŝ (each
 * family counts once, so one busy family cannot export its miscalibration to
 * the rest), shrunk toward 1 by families / (families + k).
 */
function globalLevel(records: SpreadRecord[], k: number): SpreadLevel {
  const byFamily = new Map<string, SpreadRecord[]>();
  for (const r of records) byFamily.set(r.family, [...(byFamily.get(r.family) ?? []), r]);
  const logs = [...byFamily.values()].map((rs) => Math.log(bestSpreadScale(rs)!));
  if (!logs.length) return { n: 0, families: 0, w: 0, s: 1 };
  const sHat = Math.exp(logs.reduce((a, b) => a + b, 0) / logs.length);
  const w = logs.length / (logs.length + k);
  return {
    n: records.length,
    families: logs.length,
    sHat: r3(sHat),
    w: r3(w),
    s: Math.exp(w * Math.log(sHat)),
  };
}

/**
 * Partial pooling in log space, w = n / (n + k) at each level: the method's ŝ
 * toward its series' pooled multiplier (its family's, when no series is
 * named), the series' toward its family's, the family's toward the global one,
 * the global one (`globalLevel`) toward 1. `records` must already be the
 * visible ones.
 */
export function pooledSpreadScale(
  records: SpreadRecord[],
  family: string,
  method: string,
  k = SPREAD_POOL_K,
  series?: string,
): SpreadPool {
  const global = globalLevel(records, k);
  const fam = records.filter((r) => r.family === family);
  const familyLevel = level(fam, global.s, k);
  const ser = series ? fam.filter((r) => r.series === series) : undefined;
  const seriesLevel = ser ? level(ser, familyLevel.s, k) : undefined;
  const methodLevel = level(
    (ser ?? fam).filter((r) => r.method === method),
    (seriesLevel ?? familyLevel).s,
    k,
  );
  const round = (l: SpreadLevel): SpreadLevel => ({ ...l, s: r3(l.s) });
  return {
    global: round(global),
    family: round(familyLevel),
    ...(seriesLevel ? { series: round(seriesLevel) } : {}),
    method: round(methodLevel),
    scale: r3(Math.min(MAX_SPREAD_SCALE, Math.max(MIN_SPREAD_SCALE, methodLevel.s))),
  };
}

/** Records whose outcome was public by `cutoff` (ms), excluding the round itself. */
export function visibleSpreadRecords(
  records: SpreadRecord[],
  cutoff: number,
  roundId: string,
): SpreadRecord[] {
  return records.filter((r) => r.roundId !== roundId && r.knownAt <= cutoff);
}

/** The arena's published site data for one round, as far as this calibrator reads it. */
export interface SiteRoundLike {
  round_id: string;
  tracker?: string;
  /** The round's series (`civiqs_net_approval`). */
  series?: string;
  target_type: string;
  status: string;
  lock_at?: string;
  cells?: string[];
  scoreable?: boolean;
  persistence_crps?: number | null;
  resolution?: {
    value?: unknown;
    resolved_at?: unknown;
    release_date?: unknown;
    outcome?: unknown;
    corrected?: unknown;
    voided?: unknown;
  };
  baselines?: { persistence?: { mean?: unknown } } | null;
  scores?: Record<string, { crps?: number; energy?: number }>;
  forecasts?: Record<string, { mean?: number; sd?: number; cells?: Record<string, Distribution> }>;
}

interface FiledDetail {
  round?: { tracker?: string; series?: string; target_type?: string; cells?: string[] };
  lock?: unknown;
  forecast?: {
    note?: string;
    origins?: unknown;
    pollLevel?: unknown;
    spreadCalibration?: { applied?: boolean; scale?: number };
  };
}

/** A filing this far ahead of the lock cannot have seen the last weekly release before it. */
export const STALE_FILING_LEAD_MS = 7 * DAY_MS;

/** Method suffix for filings whose start was the poll-level rule (`poll-level.ts`). */
export const POLL_LEVEL_METHOD = "+poll-level";
/** Resolved poll-level filings needed before their spread is calibrated. */
export const MIN_POLL_LEVEL_RECORDS = 4;

/**
 * A scalar filing that recorded no anchor (filed before the anchor guard), was
 * made at least `STALE_FILING_LEAD_MS` before the lock, and whose mean differs
 * from the arena's persistence value at the lock: it was scored against a
 * release it never saw (for example, filed days before a newer weekly poll
 * moved the arena's persistence value). Its miss measures the stale anchor,
 * which the anchor guard now prevents, not the forecaster's spread.
 */
export function staleLegacyFiling(
  row: Pick<ArenaSubmissionRow, "created_at">,
  detail: FiledDetail,
  filedMean: number,
  site: Pick<SiteRoundLike, "lock_at" | "baselines"> | undefined,
): boolean {
  if (detail.lock || detail.forecast?.origins) return false;
  const lock = time(site?.lock_at);
  const persistence = site?.baselines?.persistence?.mean;
  if (!Number.isFinite(lock) || !finite(persistence)) return false;
  return lock - row.created_at >= STALE_FILING_LEAD_MS && !sameReading(filedMean, persistence);
}

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const time = (x: unknown) => (typeof x === "string" ? Date.parse(x) : Number.NaN);

/**
 * When an outcome was public: a scalar's `resolved_at` (or its correction's
 * time, if later); a profile carries only its release date, so the end of
 * that day — never earlier than the value could have been seen.
 */
export function knownAtOf(res: NonNullable<SiteRoundLike["resolution"]> | ArenaResolution): number {
  const at = time(res.resolved_at);
  const corrected = res.corrected as { at?: unknown } | undefined;
  const fix = time(corrected?.at);
  const release = time(res.release_date);
  const known = [at, fix].filter(Number.isFinite);
  if (known.length) return Math.max(...known);
  return Number.isFinite(release) ? release + DAY_MS : Number.NaN;
}

/**
 * One record per resolved, scoreable round we filed. The filing is the newest
 * accepted ledger row (its sd divided back by any spread multiplier applied
 * then), else our forecast as the site lists it.
 */
export function spreadCalibrationHistory(input: {
  rows: ArenaSubmissionRow[];
  site: SiteRoundLike[];
  /** Scalar outcomes (`resolutions/resolved.json`) for rounds the site data lacks. */
  resolutions?: Record<string, ArenaResolution>;
  entrant: string;
  /** round id → round definition, for rounds known to neither the ledger detail nor the site. */
  rounds?: Record<string, Pick<ArenaRound, "tracker" | "target_type" | "cells" | "series">>;
}): SpreadRecord[] {
  const newest = new Map<string, ArenaSubmissionRow>();
  for (const row of input.rows) {
    if (row.status !== "accepted") continue;
    const prev = newest.get(row.round_id);
    if (!prev || row.id > prev.id) newest.set(row.round_id, row);
  }
  const site = new Map(input.site.map((r) => [r.round_id, r]));
  const ids = new Set([...newest.keys(), ...site.keys()]);
  const out: SpreadRecord[] = [];
  for (const id of ids) {
    try {
      const rec = recordOf(id, newest.get(id), site.get(id), input);
      if (rec) out.push(rec);
    } catch {
      // allow-empty-catch: a malformed ledger row or site round is no evidence
    }
  }
  return out;
}

function recordOf(
  id: string,
  row: ArenaSubmissionRow | undefined,
  s: SiteRoundLike | undefined,
  input: Parameters<typeof spreadCalibrationHistory>[0],
): SpreadRecord | undefined {
  if (s && (s.status !== "resolved" || s.scoreable === false)) return undefined;
  let body: { topline?: Distribution; profile?: Record<string, Distribution>; notes?: string } = {};
  let detail: FiledDetail = {};
  if (row) {
    body = JSON.parse(row.body) as typeof body;
    detail = JSON.parse(row.detail || "{}") as FiledDetail;
  } else {
    const ours = s?.forecasts?.[input.entrant];
    if (!ours) return undefined;
    body = ours.cells
      ? { profile: ours.cells }
      : finite(ours.mean) && finite(ours.sd)
        ? { topline: { mean: ours.mean, sd: ours.sd } }
        : {};
  }
  const def = input.rounds?.[id];
  const tracker = detail.round?.tracker ?? s?.tracker ?? def?.tracker ?? id.split("-")[0]!;
  const targetType =
    detail.round?.target_type ??
    s?.target_type ??
    def?.target_type ??
    (body.profile ? "profile_energy" : "continuous_normal");
  const applied = detail.forecast?.spreadCalibration;
  const undo = applied?.applied && finite(applied.scale) && applied.scale > 0 ? applied.scale : 1;
  const method =
    methodOf(detail.forecast?.note ?? body.notes) +
    (detail.forecast?.pollLevel ? POLL_LEVEL_METHOD : "");
  const family = spreadFamily({ tracker, target_type: targetType as ArenaRound["target_type"] });
  const series = detail.round?.series ?? s?.series ?? def?.series;
  const tag = series ? { series } : {};

  if (targetType === "continuous_normal") {
    const t = body.topline;
    if (!t || !finite(t.mean) || !finite(t.sd) || !(t.sd > 0)) return undefined;
    if (row && staleLegacyFiling(row, detail, t.mean, s)) return undefined;
    const res = s?.resolution ?? input.resolutions?.[id];
    if (!res || res.voided || !finite(res.value)) return undefined;
    const knownAt = knownAtOf(res);
    if (!Number.isFinite(knownAt)) return undefined;
    const loss = scalarSpreadLoss({ mean: t.mean, sd: t.sd / undo }, res.value);
    const pers = s?.persistence_crps ?? s?.scores?.persistence?.crps;
    const norm = finite(pers) && pers > 0 ? pers : loss(1);
    return norm > 0 ? { roundId: id, family, ...tag, method, knownAt, loss, norm } : undefined;
  }
  if (targetType !== "profile_energy" || !body.profile || !s?.resolution) return undefined;
  const res = s.resolution;
  const outcome = res.outcome as Record<string, unknown> | undefined;
  if (res.voided || !outcome) return undefined;
  const order = s.cells ?? detail.round?.cells ?? def?.cells ?? Object.keys(body.profile);
  const cells = order.map((c) => {
    const d = body.profile![c];
    const y = outcome[c];
    if (!d || !finite(d.mean) || !finite(d.sd) || !(d.sd > 0) || !finite(y)) {
      throw new Error(`cell ${c} incomplete`);
    }
    return { mean: d.mean, sd: d.sd / undo, outcome: y };
  });
  if (cells.length < 2) return undefined;
  const knownAt = knownAtOf(res);
  if (!Number.isFinite(knownAt)) return undefined;
  const loss = profileSpreadLoss(cells);
  const pers = s.scores?.persistence?.energy;
  const norm = finite(pers) && pers > 0 ? pers : loss(1);
  return norm > 0 ? { roundId: id, family, ...tag, method, knownAt, loss, norm } : undefined;
}

export interface SpreadCalibrationRecord {
  key: string;
  mode: CalibrationMode;
  applied: boolean;
  /** The pooled, clamped multiplier (applied in `on`, recorded in `observe`). */
  scale: number;
  global: SpreadLevel;
  family: SpreadLevel;
  /** The series' level, when the round names a series. */
  series?: SpreadLevel;
  method: SpreadLevel;
  /** Outcomes published at or before this instant were evidence. */
  cutoff: string;
  /** The topline sd before the multiplier. */
  fromSd?: number;
  /** Profile cells the multiplier covers. */
  cells?: number;
  reason: string;
}

const scaled = (d: Distribution, s: number): Distribution => ({
  ...d,
  sd: Math.max(0.001, Math.round(d.sd * s * 1000) / 1000),
});

/**
 * The forecast with every filed sd (topline, or each profile cell) multiplied
 * by the pooled spread scale of its (family, method), plus a
 * `spreadCalibration` record of the decision and its evidence. Rankings pass
 * through. Evidence is cut at min(now, the round's lock).
 */
export function applySpreadCalibration(
  round: ArenaRound,
  f: RoundForecast,
  history: SpreadRecord[],
  opts: { now: number; mode?: CalibrationMode },
): RoundForecast & { spreadCalibration?: SpreadCalibrationRecord } {
  const mode = opts.mode ?? "on";
  if (mode === "off" || (!f.topline && !f.profile)) return f;
  const family = spreadFamily(round);
  const method = methodOf(f.note) + (f.pollLevel ? POLL_LEVEL_METHOD : "");
  const key = calibrationKey(family, method);
  const lock = Date.parse(round.lock_at);
  const cutoff = Number.isFinite(lock) ? Math.min(opts.now, lock) : opts.now;
  try {
    const visible = visibleSpreadRecords(history, cutoff, round.round_id);
    const pool = pooledSpreadScale(visible, family, method, SPREAD_POOL_K, round.series);
    const record: SpreadCalibrationRecord = {
      key,
      mode,
      applied: false,
      scale: pool.scale,
      global: pool.global,
      family: pool.family,
      ...(pool.series ? { series: pool.series } : {}),
      method: pool.method,
      cutoff: new Date(cutoff).toISOString(),
      ...(f.topline ? { fromSd: f.topline.sd } : {}),
      ...(f.profile ? { cells: Object.keys(f.profile).length } : {}),
      reason: visible.length
        ? `sd ×${pool.scale} from ${visible.length} resolved round(s) (family n=${pool.family.n}${pool.series ? `, series n=${pool.series.n}` : ""}, method n=${pool.method.n})`
        : "no resolved rounds yet: identity",
    };
    // A poll-level start already sizes its sd from the rule's own backtested
    // errors; a multiplier learned on filings made from the old start would be
    // applied to a different basis. Wait for the poll-level filings' own record.
    if (f.pollLevel && pool.method.n < MIN_POLL_LEVEL_RECORDS) {
      return {
        ...f,
        spreadCalibration: {
          ...record,
          reason: `poll-level start: its own backtested sd stands until ${MIN_POLL_LEVEL_RECORDS} resolved poll-level filings (have ${pool.method.n})`,
        },
      };
    }
    if (mode !== "on" || pool.scale === 1) return { ...f, spreadCalibration: record };
    const s = pool.scale;
    const profile = f.profile
      ? Object.fromEntries(Object.entries(f.profile).map(([c, d]) => [c, scaled(d, s)]))
      : undefined;
    return {
      ...f,
      ...(f.topline ? { topline: scaled(f.topline, s) } : {}),
      ...(profile ? { profile } : {}),
      spreadCalibration: { ...record, applied: true },
      note: `${f.note}; sd ×${s} spread-calibrated on ${key} (n=${visible.length})`,
    };
  } catch (err) {
    return {
      ...f,
      spreadCalibration: {
        key,
        mode,
        applied: false,
        scale: 1,
        global: { n: 0, families: 0, w: 0, s: 1 },
        family: { n: 0, w: 0, s: 1 },
        method: { n: 0, w: 0, s: 1 },
        cutoff: new Date(cutoff).toISOString(),
        reason: `spread calibration failed: ${getErrorMessage(err)}`,
      },
    };
  }
}
