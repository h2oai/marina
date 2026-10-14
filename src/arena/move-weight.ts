// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A learned move weight per (family, method): how much of a formation's move
 * away from its start forecast to file, fitted on outcomes instead of the
 * constant trust (about one half) every formation uses today.
 *
 *   move       Δ = median member proposal − the start forecast's mean
 *   filed      start + w · Δ, w on `MOVE_WEIGHT_GRID` ⊂ [0, 1.5], capped at
 *              `MAX_FINAL_SD_MOVE` start sds like every formation
 *   evidence   our resolved filings (newest accepted per round) and arena
 *              shadows of the same key, each with its start, Δ, filed mean
 *              and sd — visible only once resolved before now, never the
 *              round being filed
 *   fit        the minimum-CRPS w, shrunk toward the records' own mean trust
 *              by n / (n + `MOVE_SHRINK`)
 *   adoption   the general forecaster's held-out rule (`adoptOnHoldout`):
 *              the older 60 % fits, the newer 40 % judges against what was
 *              filed; AND a placebo — the same procedure with the Δs shuffled
 *              across rounds must not reach the same gain (the real gain must
 *              exceed the shuffles' 80th percentile). A gain that survives
 *              shuffling is a gain from shrinkage alone, not from the moves.
 *
 * The literature this follows: EMOS-style post-processing with the model's Δ
 * as a covariate, and the finding that LLM "synthesis" adds less than a plain
 * median (arXiv:2511.07678). With too little history, or no placebo pass, the
 * filing is unchanged. The sd is not touched here (`calibration.ts` and the
 * measured-error floor own it). `MARINA_ARENA_MOVE_WEIGHT=observe` records the
 * decision without applying it; `off` skips it.
 */

import { mulberry32 } from "../../benchmarks/stats";
import { getErrorMessage } from "../engine/errors";
import { adoptOnHoldout, gridArgmin } from "../forecast/fitting";
import type { ArenaShadowRow, ArenaSubmissionRow } from "../persistence/db-arena";
import { calibrationKey, methodOf } from "./calibration";
import { CALIBRATION_MARGIN, type RoundForecast } from "./forecast";
import { crpsNormal } from "./score";
import type { ArenaResolution, ArenaRound, Distribution } from "./types";

export type MoveWeightMode = "off" | "observe" | "on";

export const MOVE_WEIGHT_GRID = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5];
/** Fewest resolved records of one (family, method) before a weight is considered. */
export const MIN_MOVE_RECORDS = 8;
/** Pseudo-records shrinking the fitted weight toward the records' own trust. */
export const MOVE_SHRINK = 4;
/** Shuffles of the Δs across rounds in the placebo. */
export const PLACEBO_SHUFFLES = 50;
/** The real held-out gain must exceed this quantile of the placebo gains. */
export const PLACEBO_QUANTILE = 0.8;
/** Same cap as `MAX_FINAL_SD_MOVE` in formations.ts (kept local: no import cycle). */
const MAX_START_SD_MOVE = 2;

export function moveWeightModeFromEnv(env: NodeJS.ProcessEnv = process.env): MoveWeightMode {
  const m = env.MARINA_ARENA_MOVE_WEIGHT?.trim().toLowerCase();
  return m === "off" || m === "observe" ? m : "on";
}

/** One resolved formation forecast: where it started, how far its members moved, what it filed. */
export interface MoveRecord {
  /** Round id (+ `#shadow:<forecaster>` for a shadow), unique per record. */
  id: string;
  roundId: string;
  key: string;
  resolvedAt: string;
  start: number;
  startSd?: number;
  /** Median member proposal − start. */
  delta: number;
  /** The trust the formation applied (≈ 0.5 today); undefined when unknown. */
  trust?: number;
  /** What was filed (mean, sd) — the default the weight must beat. */
  filed: Distribution;
  outcome: number;
}

interface ProposalLike {
  mean?: unknown;
}

interface FormationDetail {
  round?: { tracker?: string; series?: string };
  forecast?: {
    note?: string;
    formationStart?: Distribution;
    origins?: Record<string, { start?: Distribution }>;
    proposals?: Record<string, ProposalLike>;
    trust?: number;
    topline?: Distribution;
    moveWeight?: { applied?: boolean; fromMean?: number };
  };
}

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Start, Δ and trust of one formation forecast, from its recorded detail. The
 * start is the recorded `formationStart`, else the series' origin start, else
 * recovered from the median rule (filed = start + trust · (median − start)).
 */
export function moveOf(
  f: NonNullable<FormationDetail["forecast"]>,
  filedMean: number,
  series?: string,
  /** Recover an unrecorded start from the median rule — formations only (others weight proposals). */
  recover = true,
): { start: number; startSd?: number; delta: number; trust?: number } | undefined {
  const means = Object.values(f.proposals ?? {})
    .map((p) => p?.mean)
    .filter(finite);
  if (!means.length) return undefined;
  const med = medianOf(means);
  const trust = finite(f.trust) ? f.trust : undefined;
  const origin = series ? f.origins?.[series]?.start : Object.values(f.origins ?? {})[0]?.start;
  const recorded = f.formationStart ?? origin;
  // A weight applied at filing moved the mean; the formation's own filed mean is fromMean.
  const own =
    f.moveWeight?.applied && finite(f.moveWeight.fromMean) ? f.moveWeight.fromMean : filedMean;
  let start = recorded && finite(recorded.mean) ? recorded.mean : undefined;
  if (start === undefined && recover && trust !== undefined && trust < 0.999)
    start = (own - trust * med) / (1 - trust);
  if (start === undefined || !Number.isFinite(start)) return undefined;
  return {
    start,
    ...(recorded && finite(recorded.sd) && recorded.sd > 0 ? { startSd: recorded.sd } : {}),
    delta: med - start,
    ...(trust !== undefined ? { trust } : {}),
  };
}

/**
 * One record per resolved round per source: the newest accepted filing (the
 * one the board scored) and, optionally, each shadow forecaster's latest
 * pre-lock record — keyed by (family, method), formation forecasts only.
 */
export function moveWeightHistory(
  rows: ArenaSubmissionRow[],
  resolutions: Record<string, ArenaResolution>,
  rounds: Record<string, { tracker: string; lock_at?: string; series?: string }> = {},
  shadows: ArenaShadowRow[] = [],
): MoveRecord[] {
  const out: MoveRecord[] = [];
  const resolvedOf = (roundId: string) => {
    const res = resolutions[roundId];
    if (!res || res.voided || !finite(res.value) || !res.resolved_at) return undefined;
    return Number.isFinite(Date.parse(res.resolved_at)) ? res : undefined;
  };
  const push = (
    id: string,
    roundId: string,
    note: string | undefined,
    detail: FormationDetail,
    topline: Distribution | undefined,
  ) => {
    const res = resolvedOf(roundId);
    if (!res || !topline || !finite(topline.mean) || !(topline.sd > 0) || !detail.forecast) return;
    const info = rounds[roundId];
    const family = detail.round?.tracker ?? info?.tracker ?? roundId.split("-")[0]!;
    const method = methodOf(note);
    const m = moveOf(
      detail.forecast,
      topline.mean,
      detail.round?.series ?? info?.series,
      method.startsWith("formation:"),
    );
    if (!m) return;
    out.push({
      id,
      roundId,
      key: calibrationKey(family, method),
      resolvedAt: res.resolved_at!,
      start: m.start,
      ...(m.startSd !== undefined ? { startSd: m.startSd } : {}),
      delta: m.delta,
      ...(m.trust !== undefined ? { trust: m.trust } : {}),
      filed: { mean: topline.mean, sd: topline.sd },
      outcome: res.value as number,
    });
  };
  const newest = new Map<string, ArenaSubmissionRow>();
  for (const row of rows) {
    if (row.status !== "accepted") continue;
    const prev = newest.get(row.round_id);
    if (!prev || row.id > prev.id) newest.set(row.round_id, row);
  }
  for (const [roundId, row] of newest) {
    try {
      const body = JSON.parse(row.body) as { topline?: Distribution; notes?: string };
      const detail = JSON.parse(row.detail || "{}") as FormationDetail;
      push(roundId, roundId, detail.forecast?.note ?? body.notes, detail, body.topline);
    } catch {
      // allow-empty-catch: a malformed ledger row is no evidence
    }
  }
  const latest = new Map<string, ArenaShadowRow>();
  for (const s of shadows) {
    const lock = Date.parse(rounds[s.round_id]?.lock_at ?? "");
    if (Number.isFinite(lock) && s.created_at > lock) continue;
    const k = `${s.round_id}\u0000${s.forecaster}`;
    const prev = latest.get(k);
    if (
      !prev ||
      s.created_at > prev.created_at ||
      (s.created_at === prev.created_at && s.id > prev.id)
    )
      latest.set(k, s);
  }
  for (const s of latest.values()) {
    try {
      const forecast = JSON.parse(s.forecast) as { topline?: Distribution };
      const raw = JSON.parse(s.detail || "{}") as FormationDetail & FormationDetail["forecast"];
      // Shadows record the forecaster's working either nested (`forecast`) or flat.
      const detail: FormationDetail = raw.forecast ? raw : { forecast: raw };
      const family = rounds[s.round_id]?.tracker ?? s.round_id.split("-")[0]!;
      push(
        `${s.round_id}#shadow:${s.forecaster}`,
        s.round_id,
        `route ${family} → ${s.forecaster.split("#")[0]}`,
        detail,
        forecast.topline,
      );
    } catch {
      // allow-empty-catch: a malformed shadow row is no evidence
    }
  }
  return out.sort((a, b) => a.resolvedAt.localeCompare(b.resolvedAt) || a.id.localeCompare(b.id));
}

/** The mean a weight files for a record (capped like every formation). */
function weightedMean(r: Pick<MoveRecord, "start" | "startSd" | "delta">, w: number): number {
  const move = w * r.delta;
  const cap = r.startSd !== undefined ? MAX_START_SD_MOVE * r.startSd : Number.POSITIVE_INFINITY;
  return r.start + Math.min(Math.max(move, -cap), cap);
}

type WeightParams = { kind: "filed" } | { kind: "weight"; w: number };

function lossOf(rs: MoveRecord[], p: WeightParams): { loss: number; n: number } {
  let sum = 0;
  for (const r of rs) {
    const mean = p.kind === "filed" ? r.filed.mean : weightedMean(r, p.w);
    sum += crpsNormal(mean, r.filed.sd, r.outcome);
  }
  return { loss: rs.length ? sum / rs.length : Number.NaN, n: rs.length };
}

/** The minimum-CRPS weight on the grid, shrunk toward the records' own mean trust. */
export function fitMoveWeight(rs: MoveRecord[]): number | undefined {
  if (!rs.length) return undefined;
  const best = gridArgmin(MOVE_WEIGHT_GRID, (w) => lossOf(rs, { kind: "weight", w }).loss);
  if (best === undefined) return undefined;
  const trusts = rs.map((r) => r.trust).filter(finite);
  const prior = trusts.length ? trusts.reduce((a, b) => a + b, 0) / trusts.length : 0.5;
  const n = rs.length;
  return Math.round(((n * best + MOVE_SHRINK * prior) / (n + MOVE_SHRINK)) * 1000) / 1000;
}

function heldOut(rs: MoveRecord[]) {
  return adoptOnHoldout<WeightParams, MoveRecord>(rs, {
    fallback: { kind: "filed" },
    fit: (older) => {
      const w = fitMoveWeight(older);
      return w === undefined ? undefined : { kind: "weight", w };
    },
    loss: lossOf,
    margin: CALIBRATION_MARGIN,
    minRecords: MIN_MOVE_RECORDS,
  });
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i]!;
}

export interface MoveWeightDecision {
  adopted: boolean;
  w?: number;
  nFit: number;
  nHoldout: number;
  holdout?: { default: number; candidate: number; improvement: number };
  placebo?: { shuffles: number; median: number; p80: number; pass: boolean };
  reason: string;
}

/**
 * The held-out decision for one key's visible records (oldest first), with
 * the placebo: the same fit and holdout with the Δs permuted across rounds
 * (deterministic seed). Adopted only on a held-out gain past the margin that
 * the shuffled moves do not reproduce.
 */
export function decideMoveWeight(rs: MoveRecord[], seed = 20261014): MoveWeightDecision {
  const real = heldOut(rs);
  const base = { nFit: real.nFit, nHoldout: real.nHoldout };
  if (!real.holdout) return { adopted: false, ...base, reason: real.reason };
  const rand = mulberry32(seed);
  const gains: number[] = [];
  for (let i = 0; i < PLACEBO_SHUFFLES; i++) {
    const deltas = rs.map((r) => r.delta);
    for (let j = deltas.length - 1; j > 0; j--) {
      const k = Math.floor(rand() * (j + 1));
      [deltas[j], deltas[k]] = [deltas[k]!, deltas[j]!];
    }
    const shuffled = heldOut(rs.map((r, j) => ({ ...r, delta: deltas[j]! })));
    gains.push(shuffled.holdout?.improvement ?? 0);
  }
  const p80 = quantile(gains, PLACEBO_QUANTILE);
  const placebo = {
    shuffles: PLACEBO_SHUFFLES,
    median: Math.round(quantile(gains, 0.5) * 10_000) / 10_000,
    p80: Math.round(p80 * 10_000) / 10_000,
    pass: real.holdout.improvement > p80,
  };
  const w = real.params.kind === "weight" ? real.params.w : undefined;
  const adopted = real.adopted && placebo.pass && w !== undefined;
  return {
    adopted,
    ...(w !== undefined ? { w } : {}),
    ...base,
    holdout: real.holdout,
    placebo,
    reason: !real.adopted
      ? real.reason
      : !placebo.pass
        ? `${real.reason}, but shuffled moves gain as much (placebo p80 ${(p80 * 100).toFixed(1)}%)`
        : `${real.reason}; placebo p80 ${(p80 * 100).toFixed(1)}%`,
  };
}

export interface MoveWeightRecord extends MoveWeightDecision {
  key: string;
  mode: MoveWeightMode;
  applied: boolean;
  fromMean?: number;
  start?: number;
  delta?: number;
}

interface WithFormation {
  proposals?: Record<string, ProposalLike>;
  formationStart?: Distribution;
  trust?: number;
}

/**
 * The forecast with its topline mean re-weighted along the formation's move
 * when (family, method) has earned it, plus a `moveWeight` record of the
 * decision. Non-formation forecasts and profiles pass through untouched.
 */
export function applyMoveWeight(
  round: ArenaRound,
  f: RoundForecast,
  history: MoveRecord[],
  opts: { now: number; mode?: MoveWeightMode },
): RoundForecast & { moveWeight?: MoveWeightRecord } {
  const mode = opts.mode ?? "on";
  const g = f as RoundForecast & WithFormation;
  if (mode === "off" || !f.topline || !g.proposals || !g.formationStart) return f;
  const key = calibrationKey(round.tracker, methodOf(f.note));
  try {
    const m = moveOf({ ...g, topline: f.topline }, f.topline.mean, round.series);
    if (!m) return f;
    const visible = history.filter(
      (r) => r.key === key && r.roundId !== round.round_id && Date.parse(r.resolvedAt) <= opts.now,
    );
    const d = decideMoveWeight(visible);
    const record: MoveWeightRecord = {
      key,
      mode,
      applied: false,
      ...d,
      fromMean: f.topline.mean,
      start: m.start,
      delta: Math.round(m.delta * 1000) / 1000,
    };
    if (!d.adopted || d.w === undefined || mode !== "on") return { ...f, moveWeight: record };
    const mean =
      Math.round(weightedMean({ start: m.start, startSd: m.startSd, delta: m.delta }, d.w) * 1000) /
      1000;
    if (mean === f.topline.mean) return { ...f, moveWeight: record };
    return {
      ...f,
      topline: { ...f.topline, mean },
      moveWeight: { ...record, applied: true },
      note: `${f.note}; move weight ${d.w} learned on ${key} (held out, placebo passed)`,
    };
  } catch (err) {
    return {
      ...f,
      moveWeight: {
        key,
        mode,
        applied: false,
        adopted: false,
        nFit: 0,
        nHoldout: 0,
        reason: `move weight failed: ${getErrorMessage(err)}`,
      },
    };
  }
}
