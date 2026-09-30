// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Profile rounds (`profile_energy`) as model roles read and answer them, in one
 * place, so the formations and the research agent treat a profile the same
 * way the single-model forecaster does (`model-forecaster.ts`):
 *
 *   - the prompt shows each cell's dated recent values and its start forecast
 *     (the Civiqs nowcast's reading, with its date, where the start carries one);
 *   - a model answers the WHOLE profile in one reply, one `{mean, sd}` per cell;
 *   - every cell is validated on its own: a malformed or missing cell, or one
 *     further than the blowup guard from its start, is left out of that reply
 *     (the rest of the profile still counts), and a cell nobody answered
 *     validly keeps its start.
 *
 * A profile is either a composition — shares of one basket that add to 100
 * (a Google Trends basket) — or a set of independent cells (Civiqs or YouGov
 * subgroups). Only a round whose own definition says its cells add to 100,
 * AND whose last published values do, is treated as a share basket
 * ({@link shareBasketTotal}); its aggregated means are then rescaled
 * proportionally to the total ({@link renormaliseShares}). Independent cells
 * are never rescaled.
 *
 * Pure: no I/O, no model.
 */

import type { RoundForecast } from "./forecast";
import { freshestReading, rulesLines } from "./prompt-context";
import type { ArenaLock, ArenaPoint, ArenaRound, Distribution } from "./types";

/** The total a share basket's cells add to. */
export const SHARE_TOTAL = 100;
/** The last published cells must add to the total within this many points to count as shares. */
export const SHARE_SUM_TOLERANCE = 2;

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** The round definition says its cells are shares that add to 100. */
export function declaresShares(round: ArenaRound): boolean {
  const text = `${round.unit ?? ""} ${round.question}`;
  return (
    /\b(?:add|adds|sum|sums|total|totals)\s+(?:up\s+)?to\s+100\b/i.test(text) ||
    /\bshares?\b/i.test(round.unit ?? "")
  );
}

/** Each cell's history as the lock froze it (empty when the lock carries none). */
export function cellHistories(round: ArenaRound, lock: ArenaLock): Record<string, ArenaPoint[]> {
  return Object.fromEntries(
    (round.cells ?? []).map((c) => [c, lock.answer_history_by_cell?.[c] ?? []]),
  );
}

/**
 * The total a SHARE BASKET's cells add to, or undefined for independent cells.
 * Both must hold: the round's unit or question says the cells add to 100 (or
 * the unit names a share), and the last published value of every cell — the
 * start's mean where a cell has no history — adds to 100 within
 * {@link SHARE_SUM_TOLERANCE}. Deterministic, from the round data only.
 */
export function shareBasketTotal(
  round: ArenaRound,
  lock: ArenaLock,
  start: RoundForecast,
): number | undefined {
  const cells = round.cells ?? [];
  if (cells.length < 2 || !declaresShares(round)) return undefined;
  let sum = 0;
  for (const c of cells) {
    const v = lock.answer_history_by_cell?.[c]?.at(-1)?.value ?? start.profile?.[c]?.mean;
    if (v === undefined || !Number.isFinite(v) || v < 0) return undefined;
    sum += v;
  }
  return Math.abs(sum - SHARE_TOTAL) <= SHARE_SUM_TOLERANCE ? SHARE_TOTAL : undefined;
}

export interface ShareAudit {
  total: number;
  /** The aggregated means' sum before the rescale. */
  sumBefore: number;
  /** total / sumBefore (1 when nothing changed). */
  factor: number;
}

/**
 * The share basket's closure, applied AFTER aggregation: every cell's mean is
 * multiplied by the same factor, total / Σ means, so the filed means add to
 * the total and each cell keeps its share of the basket; sds are unchanged.
 * Proportional, one step, no iteration; a non-positive sum leaves the profile
 * as it is.
 */
export function renormaliseShares(
  profile: Record<string, Distribution>,
  cells: string[],
  total = SHARE_TOTAL,
): { profile: Record<string, Distribution>; audit: ShareAudit } {
  const sum = cells.reduce((s, c) => s + (profile[c]?.mean ?? 0), 0);
  if (!(sum > 0)) return { profile, audit: { total, sumBefore: round3(sum), factor: 1 } };
  const factor = total / sum;
  const out: Record<string, Distribution> = { ...profile };
  for (const c of cells) {
    const d = profile[c];
    if (d) out[c] = { mean: round3(d.mean * factor), sd: d.sd };
  }
  return { profile: out, audit: { total, sumBefore: round3(sum), factor: round3(factor) } };
}

function asDist(v: unknown): Distribution | undefined {
  const d = v as { mean?: unknown; sd?: unknown } | null;
  const mean = Number(d?.mean);
  const sd = Number(d?.sd);
  return Number.isFinite(mean) && Number.isFinite(sd) && sd > 0 ? { mean, sd } : undefined;
}

/**
 * One reply's profile, validated cell by cell against the start: a cell that
 * is missing, malformed (no finite mean, sd ≤ 0) or further than `maxSdMove`
 * start-sds from its start is left out, and `issues` says why. Unknown keys
 * are ignored.
 */
export function parseProfile(
  raw: unknown,
  cells: string[],
  base: Record<string, Distribution>,
  maxSdMove: number,
): { profile: Record<string, Distribution>; issues: string[] } {
  const got = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const profile: Record<string, Distribution> = {};
  const issues: string[] = [];
  for (const c of cells) {
    const b = base[c];
    if (!b) continue;
    const v = Object.hasOwn(got, c) ? (got as Record<string, unknown>)[c] : undefined;
    const d = asDist(v);
    if (!d) {
      issues.push(`${c} ${v === undefined ? "missing" : "invalid"}`);
      continue;
    }
    if (Math.abs(d.mean - b.mean) > maxSdMove * b.sd) {
      issues.push(
        `${c} move ${Math.round((d.mean - b.mean) * 100) / 100} beyond ${maxSdMove} start sd`,
      );
      continue;
    }
    profile[c] = d;
  }
  return { profile, issues };
}

/** A profile as compact JSON, in cell order (what a model is shown and asked to write). */
export function formatProfile(profile: Record<string, Distribution>, cells: string[]): string {
  const parts = cells
    .filter((c) => profile[c])
    .map((c) => `"${c}": {"mean": ${profile[c]!.mean}, "sd": ${profile[c]!.sd}}`);
  return `{${parts.join(", ")}}`;
}

/**
 * Short item names for a profile's cells: the cells' common `_`-separated
 * prefix removed and `_` read as a space (`trends_share_iphone` → `iphone`).
 */
export function cellLabels(cells: string[]): Record<string, string> {
  const split = cells.map((c) => c.split("_"));
  let k = 0;
  if (cells.length > 1) {
    const shortest = Math.min(...split.map((s) => s.length));
    while (k < shortest - 1 && split.every((s) => s[k] === split[0]![k])) k++;
  }
  return Object.fromEntries(cells.map((c, i) => [c, split[i]!.slice(k).join(" ") || c]));
}

/**
 * Each cell's last `n` published values (date value) and its start forecast,
 * with the nowcast's dated reading where the start used one — one line per
 * cell, in round order. The same shape `model-forecaster.ts` shows.
 */
export function cellBlock(
  round: ArenaRound,
  histories: Record<string, ArenaPoint[]>,
  start: RoundForecast,
  n: number,
): string {
  const cells = round.cells ?? [];
  const lines = cells.map((c) => {
    const h = (histories[c] ?? []).slice(-n);
    const fresh = freshestReading(start, c);
    const s = start.profile?.[c];
    return `${c}: ${h.map((p) => `${p.date} ${p.value}`).join(", ") || "(no history)"} | start ${
      s ? `{"mean": ${s.mean}, "sd": ${s.sd}}` : "(none)"
    }${fresh ? ` (nowcast: daily reading ${fresh.value} on ${fresh.date})` : ""}`;
  });
  return [
    `Each cell's last ${n} published values (date value), oldest first, then its start forecast (the nowcast where one is noted, else the persistence baseline):`,
    ...lines,
  ].join("\n");
}

/** How a profile round resolves and is scored, stated plainly. */
export function profileRulesLines(round: ArenaRound, shareTotal?: number): string[] {
  return [
    round.resolve ? `Resolution: ${round.resolve}.` : rulesLines(round)[0]!,
    "Scoring: the energy score of the whole profile — every cell's normal {mean, sd} together — against the published values; skill = 1 − energy / energy(persistence), where persistence is each cell's last published value with sd 1.5. Moving a cell on weak evidence loses skill; a too-narrow sd is punished hard, a too-wide one wastes skill.",
    ...(shareTotal !== undefined
      ? [
          `The cells are shares of one basket that add to ${shareTotal}: a rise in one cell is a fall elsewhere. The filed means are rescaled proportionally to add to ${shareTotal}.`,
        ]
      : []),
  ];
}

/** One line naming what the profile's start forecast is. */
export function profileStartLine(start: RoundForecast, cells: string[]): string {
  const fresh = cells.filter((c) => freshestReading(start, c));
  return fresh.length
    ? `Start forecast, per cell below: the NOWCAST — the freshest daily Civiqs reading, dated — for ${fresh.length} of ${cells.length} cells, with the baseline's spread; the persistence baseline for any other cell.`
    : "Start forecast, per cell below: the persistence baseline — each cell's last published value with a spread sized to how that cell moves.";
}
