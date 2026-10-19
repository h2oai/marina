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
 *
 * Profile rounds (key `arena:<tracker>:profile|<method>`): the same weight on
 * every cell's Δ (median member proposal for that cell − its start), each cell
 * capped at its own start sds; a share basket is rescaled to its total after,
 * means and sds by one factor. The loss is the arena's energy score as a share
 * of persistence's on the round (1 − per-round skill — the leaderboard's
 * metric), exact and cheap: the sds never change, so the point set is computed
 * once per round. The placebo shuffles the standardized cell moves (Δ / start
 * sd) across every cell of every round. Profile families are few and resolve
 * weekly, so a key with fewer than `MIN_MOVE_RECORDS` visible rounds pools
 * every profile family of the same method (the decision says which).
 */

import { mulberry32 } from "../../benchmarks/stats";
import { getErrorMessage } from "../engine/errors";
import { adoptOnHoldout, gridArgmin } from "../forecast/fitting";
import type { ArenaShadowRow, ArenaSubmissionRow } from "../persistence/db-arena";
import {
  calibrationKey,
  knownAtOf,
  methodOf,
  type SiteRoundLike,
  spreadFamily,
} from "./calibration";
import { CALIBRATION_MARGIN, type RoundForecast } from "./forecast";
import { crpsNormal } from "./score";
import { cellSamples } from "./score-shapes";
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

interface MoveRecordBase {
  /** Round id (+ `#shadow:<forecaster>` for a shadow), unique per record. */
  id: string;
  roundId: string;
  key: string;
  resolvedAt: string;
  /** The trust the formation applied (≈ 0.5 today); undefined when unknown. */
  trust?: number;
}

/** One resolved scalar formation forecast: where it started, how far its members moved, what it filed. */
export interface ScalarMoveRecord extends MoveRecordBase {
  start: number;
  startSd?: number;
  /** Median member proposal − start. */
  delta: number;
  /** What was filed (mean, sd) — the default the weight must beat. */
  filed: Distribution;
  outcome: number;
  profile?: undefined;
}

/** One cell of a resolved profile formation forecast. */
export interface ProfileMoveCell {
  cell: string;
  start: number;
  startSd: number;
  /** Median member proposal for this cell − its start (0 when no member answered it). */
  delta: number;
  filed: Distribution;
  outcome: number;
}

/** A resolved profile formation forecast, scored by the arena's energy score. */
export interface ProfileMove {
  /** In the round's cell order (the point set depends on it). */
  cells: ProfileMoveCell[];
  /** A share basket's total: re-weighted means are rescaled to it. */
  shareTotal?: number;
  /** Persistence's energy score on the round (else the filing's): loss = ES / norm. */
  norm: number;
  /** The point set's deviations at the filed sds (rows = draws) and its pairwise term. */
  dev: number[][];
  t2: number;
}

export interface ProfileMoveRecord extends MoveRecordBase {
  profile: ProfileMove;
}

export type MoveRecord = ScalarMoveRecord | ProfileMoveRecord;

/** The point set and pairwise term of a profile at its filed sds (computed once per round). */
export function profilePointSet(sds: number[]): { dev: number[][]; t2: number } {
  const dev = cellSamples(sds.map((sd) => ({ mean: 0, sd })));
  const n = dev.length;
  const k = sds.length;
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
  return { dev, t2: (2 * acc) / (n * n) };
}

/** Energy score of means + scale · dev against the outcome (the arena's V-statistic). */
function energyAt(p: ProfileMove, means: number[], scale: number): number {
  const k = p.cells.length;
  let t1 = 0;
  for (const row of p.dev) {
    let d2 = 0;
    for (let c = 0; c < k; c++) d2 += (means[c]! - p.cells[c]!.outcome + scale * row[c]!) ** 2;
    t1 += Math.sqrt(d2);
  }
  return t1 / p.dev.length - 0.5 * scale * p.t2;
}

/**
 * The means (and the sd factor) a weight files for a profile: every cell's
 * start + w · Δ capped at its own start sds, then a share basket rescaled to
 * its total (means and sds by the same factor).
 */
export function profileWeightedMeans(
  p: {
    cells: Array<Pick<ProfileMoveCell, "start" | "startSd" | "delta">>;
    shareTotal?: number;
  },
  w: number,
): { means: number[]; factor: number } {
  const means = p.cells.map((c) => {
    const cap = MAX_START_SD_MOVE * c.startSd;
    return c.start + Math.min(Math.max(w * c.delta, -cap), cap);
  });
  const sum = means.reduce((a, b) => a + b, 0);
  const factor = p.shareTotal !== undefined && sum > 0 ? p.shareTotal / sum : 1;
  return { means: means.map((m) => m * factor), factor };
}

/** A profile's loss (ES / norm) as filed, or at weight `w`. */
function profileLoss(p: ProfileMove, w?: number): number {
  if (w === undefined) {
    return (
      energyAt(
        p,
        p.cells.map((c) => c.filed.mean),
        1,
      ) / p.norm
    );
  }
  const { means, factor } = profileWeightedMeans(p, w);
  return energyAt(p, means, factor) / p.norm;
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
    moveWeight?: { applied?: boolean; fromMean?: number; fromProfile?: Record<string, number> };
    profileProposals?: Record<string, { profile?: Record<string, ProposalLike> }>;
    formationStartProfile?: Record<string, Distribution>;
    protocol?: {
      cells?: Record<string, { n?: number; trust?: number }>;
      shares?: { total?: number; factor?: number };
    };
    judge?: { status?: string };
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
 * Each cell's start, Δ (median member proposal − start) and trust of one
 * profile formation forecast. The start is the recorded
 * `formationStartProfile` (else the cell's origin start), else recovered per
 * cell from the median rule
 * (filed / share factor = start + trust · (median − start)) — only where that
 * rule made the filing (no applied judge or move weight).
 */
export function profileMoveOf(
  f: NonNullable<FormationDetail["forecast"]>,
  filed: Record<string, Distribution>,
  cells: string[],
):
  | {
      cells: Array<{ cell: string; start: number; startSd: number; delta: number }>;
      trust?: number;
    }
  | undefined {
  const proposals = Object.values(f.profileProposals ?? {});
  if (!proposals.length) return undefined;
  const recorded = f.formationStartProfile;
  const factor =
    finite(f.protocol?.shares?.factor) && f.protocol!.shares!.factor! > 0
      ? f.protocol!.shares!.factor!
      : 1;
  const recoverable = !recorded && f.judge?.status !== "applied" && !f.moveWeight?.applied;
  const out: Array<{ cell: string; start: number; startSd: number; delta: number }> = [];
  for (const c of cells) {
    const means = proposals.map((p) => p?.profile?.[c]?.mean).filter(finite);
    const d = filed[c];
    if (!d || !finite(d.mean) || !(d.sd > 0)) return undefined;
    let start: number | undefined;
    let startSd: number | undefined;
    // The recorded start, else the cell's dated origin (a nowcast start records one).
    const rec = recorded?.[c] ?? f.origins?.[c]?.start;
    if (rec && finite(rec.mean) && rec.sd > 0) {
      start = rec.mean;
      startSd = rec.sd;
    } else if (recoverable) {
      const audit = f.protocol?.cells?.[c];
      const t = finite(audit?.trust) ? audit!.trust! : undefined;
      const pre = d.mean / factor;
      if (!means.length || t === 0) start = pre;
      else if (t !== undefined && t < 0.999) start = (pre - t * medianOf(means)) / (1 - t);
      // The start sd is unknown on a legacy filing: the filed sd stands in for the cap.
      startSd = d.sd;
    }
    if (start === undefined || !Number.isFinite(start) || startSd === undefined) return undefined;
    out.push({ cell: c, start, startSd, delta: means.length ? medianOf(means) - start : 0 });
  }
  return { cells: out, ...(finite(f.trust) ? { trust: f.trust } : {}) };
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
  /** The arena's site data: profile outcomes, persistence's energy score, cell order. */
  site: SiteRoundLike[] = [],
): MoveRecord[] {
  const out: MoveRecord[] = [];
  const siteById = new Map(site.map((r) => [r.round_id, r]));
  const pushProfile = (
    roundId: string,
    note: string | undefined,
    detail: FormationDetail,
    profile: Record<string, Distribution>,
  ) => {
    const s = siteById.get(roundId);
    const res = s?.resolution;
    if (s?.status !== "resolved" || s.scoreable === false || !res || res.voided) return;
    const outcome = res.outcome as Record<string, unknown> | undefined;
    const knownAt = knownAtOf(res);
    if (!outcome || !Number.isFinite(knownAt) || !detail.forecast) return;
    const method = methodOf(note);
    if (!method.startsWith("formation:")) return;
    const order = s.cells ?? Object.keys(profile);
    if (order.length < 2 || !order.every((c) => finite(outcome[c]))) return;
    const m = profileMoveOf(detail.forecast, profile, order);
    if (!m) return;
    const cells = m.cells.map((c) => ({
      ...c,
      filed: { mean: profile[c.cell]!.mean, sd: profile[c.cell]!.sd },
      outcome: outcome[c.cell] as number,
    }));
    const { dev, t2 } = profilePointSet(cells.map((c) => c.filed.sd));
    const total = detail.forecast.protocol?.shares?.total;
    const move: ProfileMove = {
      cells,
      ...(finite(total) ? { shareTotal: total } : {}),
      norm: 1,
      dev,
      t2,
    };
    const pers = s.scores?.persistence?.energy;
    move.norm =
      finite(pers) && pers > 0
        ? pers
        : energyAt(
            move,
            cells.map((c) => c.filed.mean),
            1,
          );
    if (!(move.norm > 0)) return;
    out.push({
      id: roundId,
      roundId,
      key: calibrationKey(
        spreadFamily({
          tracker: s.tracker ?? detail.round?.tracker ?? roundId.split("-")[0]!,
          target_type: "profile_energy",
        }),
        method,
      ),
      resolvedAt: new Date(knownAt).toISOString(),
      ...(m.trust !== undefined ? { trust: m.trust } : {}),
      profile: move,
    });
  };
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
      const body = JSON.parse(row.body) as {
        topline?: Distribution;
        profile?: Record<string, Distribution>;
        notes?: string;
      };
      const detail = JSON.parse(row.detail || "{}") as FormationDetail;
      if (body.profile)
        pushProfile(roundId, detail.forecast?.note ?? body.notes, detail, body.profile);
      else push(roundId, roundId, detail.forecast?.note ?? body.notes, detail, body.topline);
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
function weightedMean(r: Pick<ScalarMoveRecord, "start" | "startSd" | "delta">, w: number): number {
  const move = w * r.delta;
  const cap = r.startSd !== undefined ? MAX_START_SD_MOVE * r.startSd : Number.POSITIVE_INFINITY;
  return r.start + Math.min(Math.max(move, -cap), cap);
}

type WeightParams = { kind: "filed" } | { kind: "weight"; w: number };

function lossOf(rs: MoveRecord[], p: WeightParams): { loss: number; n: number } {
  let sum = 0;
  for (const r of rs) {
    if (r.profile) {
      sum += profileLoss(r.profile, p.kind === "filed" ? undefined : p.w);
      continue;
    }
    const mean = p.kind === "filed" ? r.filed.mean : weightedMean(r, p.w);
    sum += crpsNormal(mean, r.filed.sd, r.outcome);
  }
  return { loss: rs.length ? sum / rs.length : Number.NaN, n: rs.length };
}

/**
 * The minimum-loss weight on the grid (CRPS for scalars, ES / persistence ES
 * for profiles), shrunk toward the records' own mean trust.
 */
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

/** Fisher–Yates, in place. */
function shuffle<T>(xs: T[], rand: () => number): T[] {
  for (let j = xs.length - 1; j > 0; j--) {
    const k = Math.floor(rand() * (j + 1));
    [xs[j], xs[k]] = [xs[k]!, xs[j]!];
  }
  return xs;
}

/**
 * The placebo's records: scalar Δs permuted across rounds; profile cells'
 * standardized moves (Δ / start sd) permuted across every cell of every round.
 */
function shuffleMoves(rs: MoveRecord[], rand: () => number): MoveRecord[] {
  if (!rs.some((r) => r.profile)) {
    const deltas = shuffle(
      rs.map((r) => (r as ScalarMoveRecord).delta),
      rand,
    );
    return rs.map((r, j) => ({ ...(r as ScalarMoveRecord), delta: deltas[j]! }));
  }
  const z = shuffle(
    rs.flatMap((r) => (r.profile ? r.profile.cells.map((c) => c.delta / c.startSd) : [])),
    rand,
  );
  let at = 0;
  return rs.map((r) =>
    r.profile
      ? {
          ...r,
          profile: {
            ...r.profile,
            cells: r.profile.cells.map((c) => ({ ...c, delta: z[at++]! * c.startSd })),
          },
        }
      : r,
  );
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
    const shuffled = heldOut(shuffleMoves(rs, rand));
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
  /** Profiles: the filed means before the weight, per cell. */
  fromProfile?: Record<string, number>;
  /** Profiles: Δ per cell. */
  deltas?: Record<string, number>;
  /** Profiles: the evidence the decision used — this key, or every profile family of the method. */
  scope?: "key" | "profile-families";
  /** The records' key (or pattern) the decision was made on. */
  evidenceKey?: string;
}

interface WithFormation {
  proposals?: Record<string, ProposalLike>;
  formationStart?: Distribution;
  trust?: number;
  profileProposals?: Record<string, { profile?: Record<string, ProposalLike> }>;
  formationStartProfile?: Record<string, Distribution>;
  protocol?: { shares?: { total?: number; factor?: number } };
}

/**
 * The visible profile records for a key: its own when there are at least
 * `MIN_MOVE_RECORDS`, else every profile family's records of the same method
 * (cross-family pooling, as the spread calibration pools).
 */
function profileEvidence(
  history: MoveRecord[],
  key: string,
  method: string,
  roundId: string,
  now: number,
): { records: MoveRecord[]; scope: "key" | "profile-families"; evidenceKey: string } {
  const visible = history.filter(
    (r) => r.profile && r.roundId !== roundId && Date.parse(r.resolvedAt) <= now,
  );
  const own = visible.filter((r) => r.key === key);
  if (own.length >= MIN_MOVE_RECORDS) return { records: own, scope: "key", evidenceKey: key };
  const suffix = `:profile|${method}`;
  return {
    records: visible.filter((r) => r.key.endsWith(suffix)),
    scope: "profile-families",
    evidenceKey: `arena:*${suffix}`,
  };
}

/** `applyMoveWeight` on a profile formation forecast: one weight on every cell's Δ. */
function applyProfileMoveWeight(
  round: ArenaRound,
  f: RoundForecast,
  history: MoveRecord[],
  opts: { now: number; mode: MoveWeightMode },
): RoundForecast & { moveWeight?: MoveWeightRecord } {
  const g = f as RoundForecast & WithFormation;
  const method = methodOf(f.note);
  const key = calibrationKey(spreadFamily(round), method);
  try {
    const cells = (round.cells ?? Object.keys(f.profile!)).filter((c) => f.profile![c]);
    const m = profileMoveOf(g, f.profile!, cells);
    if (!m) return f;
    const ev = profileEvidence(history, key, method, round.round_id, opts.now);
    const d = decideMoveWeight(ev.records);
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    const record: MoveWeightRecord = {
      key,
      mode: opts.mode,
      applied: false,
      ...d,
      scope: ev.scope,
      evidenceKey: ev.evidenceKey,
      fromProfile: Object.fromEntries(cells.map((c) => [c, f.profile![c]!.mean])),
      deltas: Object.fromEntries(m.cells.map((c) => [c.cell, r3(c.delta)])),
    };
    if (!d.adopted || d.w === undefined || opts.mode !== "on") return { ...f, moveWeight: record };
    const total = g.protocol?.shares?.total;
    const filedFactor =
      finite(g.protocol?.shares?.factor) && g.protocol!.shares!.factor! > 0
        ? g.protocol!.shares!.factor!
        : 1;
    const { means, factor } = profileWeightedMeans(
      { cells: m.cells, ...(finite(total) ? { shareTotal: total } : {}) },
      d.w,
    );
    const profile = { ...f.profile! };
    m.cells.forEach((c, i) => {
      const was = f.profile![c.cell]!;
      // The sd before the filing's own share rescale, at the new factor.
      profile[c.cell] = {
        mean: r3(means[i]!),
        sd: Math.max(0.001, r3((was.sd / filedFactor) * factor)),
      };
    });
    return {
      ...f,
      profile,
      moveWeight: { ...record, applied: true },
      note: `${f.note}; move weight ${d.w} learned on ${ev.evidenceKey} (held out, placebo passed)`,
    };
  } catch (err) {
    return {
      ...f,
      moveWeight: {
        key,
        mode: opts.mode,
        applied: false,
        adopted: false,
        nFit: 0,
        nHoldout: 0,
        reason: `move weight failed: ${getErrorMessage(err)}`,
      },
    };
  }
}

/**
 * The forecast with its topline mean — or every profile cell's mean — re-
 * weighted along the formation's move when (family, method) has earned it,
 * plus a `moveWeight` record of the decision. Non-formation forecasts pass
 * through untouched.
 */
export function applyMoveWeight(
  round: ArenaRound,
  f: RoundForecast,
  history: MoveRecord[],
  opts: { now: number; mode?: MoveWeightMode },
): RoundForecast & { moveWeight?: MoveWeightRecord } {
  const mode = opts.mode ?? "on";
  const g = f as RoundForecast & WithFormation;
  if (mode === "off") return f;
  if (f.profile && g.profileProposals && g.formationStartProfile)
    return applyProfileMoveWeight(round, f, history, { now: opts.now, mode });
  if (!f.topline || !g.proposals || !g.formationStart) return f;
  const key = calibrationKey(round.tracker, methodOf(f.note));
  try {
    const m = moveOf({ ...g, topline: f.topline }, f.topline.mean, round.series);
    if (!m) return f;
    const visible = history.filter(
      (r) =>
        !r.profile &&
        r.key === key &&
        r.roundId !== round.round_id &&
        Date.parse(r.resolvedAt) <= opts.now,
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
