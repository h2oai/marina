// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Earned promotion of defaults — "never worse, structurally".
 *
 * A named slot (`crew:answerer:formation`, `showcase:crew`, …) holds the
 * configuration a world uses by default. Its value changes only when a
 * challenger run from Marina's own benchmark ledger EARNS it over the
 * incumbent run:
 *
 *  - same benchmark, same recorded judge, same item slice;
 *  - paired on the shared items of the slot's HOLDOUT split only — a fixed
 *    per-slot hash of each item id. `benchmark challenge` shows the SELECTION
 *    split (what a proposer may choose on); the holdout is read only by a
 *    promotion attempt, and evidence that touches a selection item is refused;
 *  - the 95 % paired interval on the accuracy difference lies above zero AND
 *    the difference clears `promotionMargin(tried)` — the fishing margin
 *    shared with `evolve replicate` and arena signal discovery, which grows
 *    with every earlier attempt on the slot (each attempt read the holdout);
 *  - optionally, cost per item no worse than `maxCostRatio` × the incumbent's.
 *
 * Every seed, promotion and refused attempt is an append-only history row
 * (`benchmark_promotions`, migration 147). This module is pure except for the
 * thin `challengeSlot` / `promoteSlot` / `getPromotedDefault` wrappers.
 */

import { createHash } from "node:crypto";
import type {
  BenchmarkDefaultRow,
  BenchmarkItemRow,
  BenchmarkRunRow,
} from "../persistence/db-benchmarks";
import type { BenchmarksStore } from "../persistence/interfaces/benchmarks-store";
import { promotionMargin } from "./fishing-margin";

/** Default share of items held out from selection for a new slot. */
export const DEFAULT_HOLDOUT_FRACTION = 0.5;
/** Fewest paired holdout items a promotion may rest on. */
export const MIN_HOLDOUT_ITEMS = 20;

const SLOT_RE = /^[a-z0-9][a-z0-9:._-]{0,95}$/;

export function validSlot(slot: string): boolean {
  return SLOT_RE.test(slot);
}

/**
 * Which split an item belongs to for a slot: a stable hash of slot + item id,
 * so the same item is always holdout (or always selection) for that slot and
 * no one can move it by re-running.
 */
export function itemSplit(
  slot: string,
  itemId: string,
  holdoutFraction: number,
): "holdout" | "selection" {
  const h = createHash("sha256").update(`${slot}\n${itemId}`).digest();
  const u = h.readUInt32BE(0) / 2 ** 32;
  return u < holdoutFraction ? "holdout" : "selection";
}

/**
 * 95 % interval on the paired difference of two proportions (challenger −
 * incumbent) from the discordant counts: Agresti–Min (2005) — add ½ to each
 * of the four cells, then Wald. Well behaved at small n and at 0/100 %.
 */
export function pairedDifferenceInterval(
  challengerOnly: number,
  incumbentOnly: number,
  n: number,
): { delta: number; low: number; high: number } {
  if (n <= 0) return { delta: 0, low: -1, high: 1 };
  const nStar = n + 2;
  const b = challengerOnly + 0.5;
  const c = incumbentOnly + 0.5;
  const d = (b - c) / nStar;
  const variance = (b + c - (b - c) ** 2 / nStar) / nStar ** 2;
  const se = Math.sqrt(Math.max(0, variance));
  return {
    delta: (challengerOnly - incumbentOnly) / n,
    low: Math.max(-1, d - 1.96 * se),
    high: Math.min(1, d + 1.96 * se),
  };
}

export interface SplitStats {
  split: "holdout" | "selection";
  n: number;
  challengerCorrect: number;
  incumbentCorrect: number;
  challengerOnly: number;
  incumbentOnly: number;
  delta: number;
  low: number;
  high: number;
}

export interface ChallengeEvaluation {
  ok: boolean;
  /** Every reason the challenger is not (yet) promotable; empty when ok. */
  reasons: string[];
  /** Stats on the split the caller may see (selection for a dry run, holdout to promote). */
  stats: SplitStats;
  margin: number;
  triedBefore: number;
  costPerItem: { challenger: number | null; incumbent: number | null; ratio: number | null };
}

function perItemCost(run: BenchmarkRunRow, items: readonly BenchmarkItemRow[]): number | null {
  if (items.length > 0 && items.every((i) => typeof i.cost_usd === "number")) {
    return items.reduce((s, i) => s + (i.cost_usd as number), 0) / items.length;
  }
  return typeof run.cost_usd === "number" && items.length > 0 ? run.cost_usd / items.length : null;
}

/** Paired stats for two runs on one split of a slot. */
export function splitStats(
  slot: string,
  holdoutFraction: number,
  split: "holdout" | "selection",
  challengerItems: readonly BenchmarkItemRow[],
  incumbentItems: readonly BenchmarkItemRow[],
): SplitStats & { itemIds: string[] } {
  const inc = new Map(incumbentItems.map((i) => [i.item_id, i]));
  let n = 0;
  let cc = 0;
  let ic = 0;
  let cOnly = 0;
  let iOnly = 0;
  const itemIds: string[] = [];
  for (const c of challengerItems) {
    const i = inc.get(c.item_id);
    if (!i || itemSplit(slot, c.item_id, holdoutFraction) !== split) continue;
    n++;
    itemIds.push(c.item_id);
    if (c.correct) cc++;
    if (i.correct) ic++;
    if (c.correct && !i.correct) cOnly++;
    else if (!c.correct && i.correct) iOnly++;
  }
  const ci = pairedDifferenceInterval(cOnly, iOnly, n);
  return {
    split,
    n,
    challengerCorrect: cc,
    incumbentCorrect: ic,
    challengerOnly: cOnly,
    incumbentOnly: iOnly,
    delta: ci.delta,
    low: ci.low,
    high: ci.high,
    itemIds,
  };
}

/**
 * Evidence used for a promotion must lie entirely in the holdout split: items
 * in the selection split are what a proposer was allowed to look at.
 */
export function selectionOverlap(
  slot: string,
  holdoutFraction: number,
  evidenceItemIds: readonly string[],
): string[] {
  return evidenceItemIds.filter((id) => itemSplit(slot, id, holdoutFraction) === "selection");
}

/**
 * Evaluate a challenger against the incumbent. Pure: the caller supplies the
 * runs, their items, the slot's holdout fraction and how many earlier
 * challengers were tried. `split: "selection"` is the dry run (never
 * promotable); `split: "holdout"` is the promotion test.
 */
export function evaluateChallenge(input: {
  slot: string;
  holdoutFraction: number;
  split: "holdout" | "selection";
  challenger: BenchmarkRunRow;
  challengerItems: readonly BenchmarkItemRow[];
  incumbent: BenchmarkRunRow;
  incumbentItems: readonly BenchmarkItemRow[];
  triedBefore: number;
  maxCostRatio?: number;
  /** Item ids the promotion rests on — defaults to the holdout pairing. */
  evidenceItemIds?: readonly string[];
}): ChallengeEvaluation {
  const { slot, holdoutFraction, challenger, incumbent } = input;
  const reasons: string[] = [];
  if (challenger.id === incumbent.id) reasons.push("the challenger is the incumbent");
  if (challenger.benchmark !== incumbent.benchmark) {
    reasons.push(`different benchmarks (${challenger.benchmark} vs ${incumbent.benchmark})`);
  }
  if (!challenger.judge || !incumbent.judge) {
    reasons.push("a run has no recorded judge — promotion needs the same judge on both");
  } else if (challenger.judge !== incumbent.judge) {
    reasons.push(`different judges (${challenger.judge} vs ${incumbent.judge})`);
  }
  if (
    challenger.slice_hash &&
    incumbent.slice_hash &&
    challenger.slice_hash !== incumbent.slice_hash
  ) {
    reasons.push("different item slices — promotion needs the same items on both runs");
  }
  const full = splitStats(
    slot,
    holdoutFraction,
    input.split,
    input.challengerItems,
    input.incumbentItems,
  );
  const { itemIds, ...stats } = full;
  const triedBefore = Math.max(0, input.triedBefore);
  const margin = promotionMargin(triedBefore);
  if (input.split === "selection") {
    reasons.push("selection split — a dry run never promotes; the holdout decides");
  } else {
    const overlap = selectionOverlap(slot, holdoutFraction, input.evidenceItemIds ?? itemIds);
    if (overlap.length > 0) {
      reasons.push(
        `evidence overlaps the selection split (${overlap.length} item(s)) — only holdout items may decide`,
      );
    }
    if (stats.n < MIN_HOLDOUT_ITEMS) {
      reasons.push(`only ${stats.n} paired holdout item(s); needs at least ${MIN_HOLDOUT_ITEMS}`);
    }
    if (stats.low <= 0) {
      reasons.push(
        `the 95% paired interval starts at ${(stats.low * 100).toFixed(1)} points — not distinguishable from noise`,
      );
    }
    if (stats.delta < margin) {
      reasons.push(
        `+${(stats.delta * 100).toFixed(1)} points is below the margin ${(margin * 100).toFixed(1)} (${triedBefore} earlier attempt(s) on this slot — every try raises the bar)`,
      );
    }
  }
  const cc = perItemCost(challenger, input.challengerItems);
  const ic = perItemCost(incumbent, input.incumbentItems);
  const ratio = cc !== null && ic !== null && ic > 0 ? cc / ic : null;
  if (input.maxCostRatio !== undefined) {
    if (ratio === null)
      reasons.push("cost per item is unknown on a run — max-cost-ratio cannot be checked");
    else if (ratio > input.maxCostRatio) {
      reasons.push(`costs ${ratio.toFixed(2)}× the incumbent per item (max ${input.maxCostRatio})`);
    }
  }
  return {
    ok: reasons.length === 0,
    reasons,
    stats,
    margin,
    triedBefore,
    costPerItem: { challenger: cc, incumbent: ic, ratio },
  };
}

// ─── Store-backed operations ────────────────────────────────────────────────

type PromotionStore = Pick<
  BenchmarksStore,
  | "getBenchmarkRun"
  | "getBenchmarkItems"
  | "getBenchmarkDefault"
  | "listBenchmarkDefaults"
  | "listBenchmarkPromotions"
  | "recordBenchmarkPromotion"
>;

/** Earlier promotion attempts on a slot that read its holdout: distinct challenger runs. */
export function attemptsBefore(db: PromotionStore, slot: string, challengerRunId: string): number {
  const ids = new Set(
    db
      .listBenchmarkPromotions(slot)
      .filter(
        (r) =>
          r.outcome !== "seeded" && r.challenger_run_id && r.challenger_run_id !== challengerRunId,
      )
      .map((r) => r.challenger_run_id as string),
  );
  return ids.size;
}

/** The parsed value of a slot's promoted default, or undefined when none / unreadable. */
export function getPromotedDefault<T = unknown>(
  db: Pick<BenchmarksStore, "getBenchmarkDefault">,
  slot: string,
): T | undefined {
  let row: BenchmarkDefaultRow | undefined;
  try {
    row = db.getBenchmarkDefault(slot);
  } catch {
    // allow-empty-catch: a database without migration 147 has no promoted defaults
    return undefined;
  }
  if (!row) return undefined;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    // allow-empty-catch: a malformed value reads as no default (env and built-ins still apply)
    return undefined;
  }
}

export type ChallengeLookup =
  | { kind: "error"; message: string }
  | {
      kind: "seed";
      challenger: BenchmarkRunRow;
      items: BenchmarkItemRow[];
      holdoutFraction: number;
    }
  | {
      kind: "contest";
      challenger: BenchmarkRunRow;
      incumbent: BenchmarkRunRow;
      def: BenchmarkDefaultRow;
      evaluation: ChallengeEvaluation;
    };

/** Load and evaluate a challenger for a slot on the given split. */
export function lookupChallenge(
  db: PromotionStore,
  slot: string,
  runId: string,
  split: "holdout" | "selection",
  opts: { maxCostRatio?: number } = {},
): ChallengeLookup {
  if (!validSlot(slot)) {
    return {
      kind: "error",
      message: `Invalid slot "${slot}" — lower-case letters, digits and : . _ -`,
    };
  }
  const challenger = db.getBenchmarkRun(runId);
  if (!challenger) return { kind: "error", message: `No run ${runId}.` };
  if (challenger.status !== "completed") {
    return { kind: "error", message: `Run ${runId} is ${challenger.status}, not completed.` };
  }
  const items = db.getBenchmarkItems(runId);
  if (items.length === 0) {
    return {
      kind: "error",
      message: `Run ${runId} has no per-item outcomes — promotion needs paired items.`,
    };
  }
  const def = db.getBenchmarkDefault(slot);
  if (!def?.incumbent_run_id) {
    return {
      kind: "seed",
      challenger,
      items,
      holdoutFraction: def?.holdout_fraction ?? DEFAULT_HOLDOUT_FRACTION,
    };
  }
  const incumbent = db.getBenchmarkRun(def.incumbent_run_id);
  if (!incumbent) {
    return {
      kind: "error",
      message: `The incumbent run ${def.incumbent_run_id} no longer resolves.`,
    };
  }
  const evaluation = evaluateChallenge({
    slot,
    holdoutFraction: def.holdout_fraction,
    split,
    challenger,
    challengerItems: items,
    incumbent,
    incumbentItems: db.getBenchmarkItems(incumbent.id),
    triedBefore: attemptsBefore(db, slot, runId),
    ...(opts.maxCostRatio !== undefined ? { maxCostRatio: opts.maxCostRatio } : {}),
  });
  return { kind: "contest", challenger, incumbent, def, evaluation };
}
