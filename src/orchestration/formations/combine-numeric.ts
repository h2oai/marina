// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The pure numeric combiners of the arena formations (one (mean, sd) answer
 * per member; `src/arena/formations.ts`): the shared clamps every arena
 * formation settles with, and the combiners of the catalogue entries the arena
 * runs from their template (`ensemble`, `delphi`). No model calls, no I/O.
 *
 *   ensemble   the median move and median sd of the proposals, trust =
 *              DEFAULT_TRUST × their agreement, then `settle`
 *   delphi     the same over the revisions (a failed revision keeps its
 *              round-1 forecast); round two reads `delphiSummary`
 *
 * Moved here verbatim from `src/arena/formations.ts` (which re-exports them);
 * `test/arena-formations-legacy.test.ts` holds the arena formations still on
 * their own code byte-identical to the frozen pre-catalogue implementation;
 * the catalogue's are held by behaviour (`test/formation-behaviour.test.ts`).
 */

/** A member's forecast or the start forecast: a normal. */
export interface NumericDistribution {
  mean: number;
  sd: number;
  /**
   * The scale a MOVE from this start is judged against (the blowup bound, the
   * final cap, agreement) when it is not the sd: the series' own change scale
   * (`seriesMoveScale`). A start sd says how uncertain the start is, not how
   * far the series moves in a step — after a spike the nowcast sd is tiny while
   * the plausible reversion is many sds, and a cap on the sd throws away the
   * panel's one correct call. Unset ⇒ the sd, as before.
   */
  moveScale?: number;
}

export interface NumericProposal extends NumericDistribution {
  reason?: string;
}

/** A proposal further than this many move scales from the start is a blowup and dropped. */
export const MAX_PROPOSAL_SD_MOVE = 4;
/** No formation moves the mean further than this many move scales. */
export const MAX_FINAL_SD_MOVE = 2;
/** Share of the aggregated move taken when no judge or skeptic sets the trust. */
export const DEFAULT_TRUST = 0.5;

export const round3 = (x: number) => Math.round(x * 1000) / 1000;
const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

/** The scale a move from `base` is measured in: its `moveScale`, else its sd. */
export const moveScaleOf = (base: NumericDistribution): number =>
  base.moveScale !== undefined && Number.isFinite(base.moveScale) && base.moveScale > 0
    ? base.moveScale
    : base.sd;

/** `seriesMoveScale`: this quantile of |one-step change| over the last `MOVE_SCALE_POINTS` values … */
export const MOVE_SCALE_QUANTILE = 0.9;
export const MOVE_SCALE_POINTS = 30;
/** … and with fewer points than this the series says nothing: the sd stands. */
export const MOVE_SCALE_MIN_POINTS = 3;

/**
 * A start's move scale from the series' own history: the larger of the
 * typical large one-step change (the `MOVE_SCALE_QUANTILE` quantile of |Δ|
 * over the last `MOVE_SCALE_POINTS` published values — the verification
 * band's scale, `verificationScales`) and the LATEST change — a series that
 * just jumped can plausibly jump back by as much, and one spike among thirty
 * steps never reaches the quantile. Never below the start sd. Pure.
 */
export function seriesMoveScale(sd: number, values: ReadonlyArray<number>): number {
  const vals = values.slice(-MOVE_SCALE_POINTS).filter((v) => Number.isFinite(v));
  if (vals.length < MOVE_SCALE_MIN_POINTS) return sd;
  const deltas = vals.slice(1).map((v, i) => Math.abs(v - vals[i]!));
  const abs = [...deltas].sort((a, b) => a - b);
  const q = abs[Math.min(abs.length - 1, Math.floor(MOVE_SCALE_QUANTILE * abs.length))]!;
  return round3(Math.max(sd, q, deltas.at(-1)!));
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** 1 when proposals agree; → 0 as their moves spread wider than the start's move scale. */
export function agreement(base: NumericDistribution, proposals: NumericProposal[]): number {
  if (proposals.length < 2) return 1;
  const moves = proposals.map((p) => p.mean - base.mean);
  const mu = moves.reduce((a, b) => a + b, 0) / moves.length;
  const sd = Math.sqrt(moves.reduce((a, b) => a + (b - mu) ** 2, 0) / moves.length);
  return 1 / (1 + (sd / moveScaleOf(base)) ** 2);
}

/**
 * The shared shrink-toward-start step: take `trust` of `move`, cap it at
 * MAX_FINAL_SD_MOVE move scales, and blend the sd the same way (floored at half
 * the start sd, then scaled by `sdScale` ∈ [0.5, 2]).
 */
export function settle(
  base: NumericDistribution,
  move: number,
  proposedSd: number,
  trust: number,
  sdScale = 1,
): NumericDistribution {
  const t = clamp(trust, 0, 1);
  const cap = MAX_FINAL_SD_MOVE * moveScaleOf(base);
  const scale = clamp(sdScale, 0.5, 2);
  return {
    mean: round3(base.mean + clamp(t * move, -cap, cap)),
    sd: round3(Math.max(base.sd * 0.5, ((1 - t) * base.sd + t * proposedSd) * scale)),
  };
}

/** Median move and median sd of a set of proposals. */
export function centre(base: NumericDistribution, proposals: NumericProposal[]) {
  return {
    move: median(proposals.map((p) => p.mean - base.mean)),
    sd: median(proposals.map((p) => p.sd)),
  };
}

/** The ensemble combine: median of the proposals, trust = DEFAULT_TRUST × their agreement. */
export function medianOutcome<P extends NumericProposal>(
  base: NumericDistribution,
  proposals: Record<string, P>,
):
  | { proposals: Record<string, P>; topline: NumericDistribution; trust: number; agreement: number }
  | undefined {
  const list = Object.values(proposals);
  if (list.length === 0) return undefined;
  const agree = agreement(base, list);
  const trust = DEFAULT_TRUST * agree;
  const c = centre(base, list);
  return {
    proposals,
    topline: settle(base, c.move, c.sd, trust),
    trust: round3(trust),
    agreement: round3(agree),
  };
}

// ─── Delphi ──────────────────────────────────────────────────────────────────

export const DELPHI_SNIPPET_CHARS = 160;

/** Replace any member's name (full id or short name) in a snippet with "a panelist". */
export function anonymize(text: string, members: ReadonlyArray<{ name: string }>): string {
  let out = text;
  for (const m of members) {
    for (const name of new Set([m.name, m.name.split("/").at(-1) ?? m.name])) {
      if (name.length >= 3) out = out.split(name).join("a panelist");
    }
  }
  return out;
}

/**
 * The anonymized panel summary Delphi's second round sees: count, median and
 * range of the means and sds, and short reason snippets — sorted, so their
 * order says nothing about who wrote them, and scrubbed of member names.
 */
export function delphiSummary(
  base: NumericDistribution,
  proposals: NumericProposal[],
  members: ReadonlyArray<{ name: string }>,
): { text: string; record: Record<string, unknown> } {
  const means = proposals.map((p) => p.mean);
  const sds = proposals.map((p) => p.sd);
  const snippets = proposals
    .map((p) => anonymize((p.reason ?? "").trim(), members).slice(0, DELPHI_SNIPPET_CHARS))
    .filter(Boolean)
    .sort();
  const medianMean = round3(median(means));
  const meanRange = [round3(Math.min(...means)), round3(Math.max(...means))];
  const medianSd = round3(median(sds));
  const sdRange = [round3(Math.min(...sds)), round3(Math.max(...sds))];
  const medianMove = round3(median(means) - base.mean);
  const text = [
    `PANEL SUMMARY (round 1, ${proposals.length} independent forecasts, anonymized):`,
    `- mean: median ${medianMean} (a move of ${medianMove} from the start), range ${meanRange[0]} to ${meanRange[1]}`,
    `- sd: median ${medianSd}, range ${sdRange[0]} to ${sdRange[1]}`,
    ...(snippets.length
      ? ["- reasons given (unordered):", ...snippets.map((s) => `  • ${s}`)]
      : []),
  ].join("\n");
  return {
    text,
    record: { n: proposals.length, medianMean, meanRange, medianSd, sdRange, medianMove, snippets },
  };
}

/** How many members' revisions moved off their round-1 forecast. */
export function movedCount(
  revised: ReadonlyArray<NumericProposal | undefined>,
  first: ReadonlyArray<NumericProposal | undefined>,
): number {
  return revised.filter(
    (p, i) => p && first[i] && (p.mean !== first[i]!.mean || p.sd !== first[i]!.sd),
  ).length;
}
