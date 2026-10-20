// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Explicit, testable adjustments from attention features to a projected
 * attention mass (a page's projected weekly views). Each feature moves the
 * projection by a bounded multiplier with a fixed elasticity:
 *
 *   edits.surge      M = clamp(surge, 1/cap, cap) ^ editElasticity
 *   related.growth   M = clamp(growth, 1/cap, cap) ^ relatedElasticity
 *   news.trend       M = clamp(trend, 1/cap, cap) ^ newsElasticity
 *   news.portal_days M = (1 + days) ^ portalElasticity
 *   news.direction   M = directionStep ^ direction (−1, 0, +1)
 *   event.in_window  M = 1 + (eventMultiplier − 1) × confidence
 *   event.ended      M = 1 − (1 − endedMultiplier) × confidence
 *
 * scaled by the record's confidence (an elasticity × confidence). The mass a
 * multiplier adds is counted as transient — the spread widening: the ordering
 * score discounts transient mass (`risk`), so an adjusted page needs more
 * evidence to take a top slot than a steady one of the same projected mass.
 * A multiplier never moves a page by more than `maxFactor` either way.
 */

import type { AttentionEvent } from "../attention";
import type { AttentionFeature } from "./features";
import { featureIndex } from "./features";

export interface AdjustParams {
  editElasticity: number;
  relatedElasticity: number;
  newsElasticity: number;
  /** Elasticity on 1 + the days Portal:Current events linked the page. */
  portalElasticity: number;
  /** Multiplier per step of a model's news direction (−1 fading … +1 rising). */
  directionStep: number;
  /** Bound on a ratio feature before its elasticity applies. */
  ratioCap: number;
  /** Multiplier on a page with a verified event in the forecast window (at confidence 1). */
  eventMultiplier: number;
  /** Multiplier on a page whose verified event ended before the window (at confidence 1). */
  endedMultiplier: number;
  /** Total multiplier bound, either way. */
  maxFactor: number;
  /** Ordering discount on transient mass (as the specialist's `risk`). */
  risk: number;
}

/**
 * Chosen by the walk-forward backtest over 67 weeks (`scripts/arena-wiki-backtest.ts
 * --features … --grid`, docs/guides/arena.md). Only the verified-event channel
 * earned a non-neutral setting (the weekly re-selection picked ×3 for an
 * in-window event and ×0.6 for an ended one); edit surge, related-page growth,
 * news trend, the current-events digest and the news direction did not beat
 * zero, so their records are kept for the audit and move nothing.
 */
export const DEFAULT_ADJUST_PARAMS: AdjustParams = {
  editElasticity: 0,
  relatedElasticity: 0,
  newsElasticity: 0,
  portalElasticity: 0,
  directionStep: 1,
  ratioCap: 8,
  eventMultiplier: 3,
  endedMultiplier: 0.6,
  maxFactor: 3,
  risk: 0.15,
};

export interface Adjustable {
  title: string;
  weekly: number;
  transient: number;
  score: number;
}

export interface Adjustment {
  title: string;
  factor: number;
  /** Each feature's multiplier, for the audit. */
  parts: Record<string, number>;
  before: number;
  after: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** The multiplier the features of one subject imply, and its parts. */
export function adjustmentFactor(
  features: Map<string, AttentionFeature> | undefined,
  p: AdjustParams = DEFAULT_ADJUST_PARAMS,
): { factor: number; parts: Record<string, number> } {
  const parts: Record<string, number> = {};
  if (!features) return { factor: 1, parts };
  const ratio = (name: string, elasticity: number) => {
    const f = features.get(name);
    if (!f || elasticity === 0 || !(f.value > 0)) return;
    const m =
      clamp(f.value, 1 / p.ratioCap, p.ratioCap) ** (elasticity * clamp(f.confidence, 0, 1));
    if (m !== 1) parts[name] = m;
  };
  ratio("edits.surge", p.editElasticity);
  ratio("related.growth", p.relatedElasticity);
  ratio("news.trend", p.newsElasticity);
  const portal = features.get("news.portal_days");
  if (portal && portal.value > 0 && p.portalElasticity !== 0)
    parts["news.portal_days"] =
      (1 + portal.value) ** (p.portalElasticity * clamp(portal.confidence, 0, 1));
  const dir = features.get("news.direction");
  if (dir && dir.value !== 0 && p.directionStep !== 1)
    parts["news.direction"] =
      p.directionStep ** (Math.sign(dir.value) * clamp(dir.confidence, 0, 1));
  const ev = features.get("event.in_window");
  if (ev && ev.value > 0)
    parts["event.in_window"] = 1 + (p.eventMultiplier - 1) * clamp(ev.confidence, 0, 1);
  const ended = features.get("event.ended");
  if (ended && ended.value > 0)
    parts["event.ended"] = 1 - (1 - p.endedMultiplier) * clamp(ended.confidence, 0, 1);
  let factor = 1;
  for (const m of Object.values(parts)) factor *= m;
  return { factor: clamp(factor, 1 / p.maxFactor, p.maxFactor), parts };
}

/**
 * Apply the features to a scored list (best first) and re-order it. Subjects
 * with no features keep their projection; the returned list is a new array.
 */
export function applyAdjustments<T extends Adjustable>(
  scored: T[],
  features: AttentionFeature[],
  p: AdjustParams = DEFAULT_ADJUST_PARAMS,
): { scored: T[]; adjustments: Adjustment[] } {
  const index = featureIndex(features);
  const adjustments: Adjustment[] = [];
  const out = scored.map((s) => {
    const { factor, parts } = adjustmentFactor(index.get(s.title), p);
    if (factor === 1) return s;
    const weekly = s.weekly * factor;
    // Spread widening: added mass is transient; removed mass comes out of the transient share first.
    const transientMass = Math.max(0, s.transient * s.weekly + (weekly - s.weekly));
    const transient = weekly > 0 ? clamp(transientMass / weekly, 0, 1) : 0;
    const score = weekly * Math.max(0, 1 - p.risk * transient);
    adjustments.push({ title: s.title, factor, parts, before: s.score, after: score });
    return { ...s, weekly, transient, score };
  });
  out.sort((a, b) => b.score - a.score || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  return { scored: out, adjustments };
}

/**
 * Verified event records as the arena's scenario effects (`AttentionEvent`,
 * src/arena/attention.ts), so the Trends and Wikipedia challengers can take
 * them too: the multiplier at the record's confidence over the forecast
 * window, known at the record's `asOf`.
 */
export function toAttentionEvents(
  features: AttentionFeature[],
  window: { start: string; end: string },
  p: AdjustParams = DEFAULT_ADJUST_PARAMS,
): AttentionEvent[] {
  const out: AttentionEvent[] = [];
  for (const f of features) {
    const c = clamp(f.confidence, 0, 1);
    const multiplier =
      f.feature === "event.in_window"
        ? 1 + (p.eventMultiplier - 1) * c
        : f.feature === "event.ended"
          ? 1 - (1 - p.endedMultiplier) * c
          : undefined;
    if (multiplier === undefined || f.value <= 0 || multiplier === 1) continue;
    out.push({
      item: f.subject,
      startsAt: `${window.start}T00:00:00Z`,
      endsAt: `${window.end}T23:59:59Z`,
      knownAt: f.asOf,
      source: f.source,
      multiplier: Math.min(4, Math.max(0.25, multiplier)),
    });
  }
  return out;
}
