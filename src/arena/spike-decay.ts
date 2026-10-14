// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Post-spike decay for share baskets (Google Trends). A brand's share that
 * sits far above (or below) its recent level — an event week, such as a
 * product launch — tends to move back toward that level over the next weeks,
 * while an ordinary week is closer to a random walk. So a cell moves part of
 * the way (`lambda`) back toward the median of its previous weeks ONLY when
 * its latest share is further from that median than `threshold` × the robust
 * size of its weekly changes; every other cell keeps its start mean. Shares
 * are renormalised to 100; spreads are the start's.
 *
 * Not a default anywhere: it is a free forecaster spec (`spike-decay`) for
 * shadow challenges, earning a family only through `earned-routes.ts`.
 */

import type { ArenaPoint, Distribution } from "./types";

export interface SpikeDecayOptions {
  /** Weeks before the latest whose median is the level decayed toward. */
  window: number;
  /** Spike when |latest − median| > threshold × 1.4826 × median |weekly change|. */
  threshold: number;
  /** Share of the gap closed for a spiking cell, in [0, 1]. */
  lambda: number;
  /** Floor on the robust change size (share points), so a flat cell is not a spike on noise. */
  minScale: number;
}

export const SPIKE_DECAY_DEFAULTS: SpikeDecayOptions = {
  window: 8,
  threshold: 3,
  lambda: 0.5,
  minScale: 0.5,
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface SpikeDecayResult {
  profile: Record<string, Distribution>;
  /** Cells that were treated as spikes, with the level they moved toward. */
  decayed: Record<string, { from: number; toward: number; mean: number }>;
}

/**
 * Apply spike-conditional decay to a basket's start profile. `history` holds
 * each cell's share series (oldest first) ending at the start's reading.
 * Cells without `window + 1` points keep their start mean.
 */
export function spikeDecay(
  start: Record<string, Distribution>,
  history: Record<string, ArenaPoint[]>,
  opts: SpikeDecayOptions = SPIKE_DECAY_DEFAULTS,
): SpikeDecayResult {
  if (!(opts.lambda >= 0 && opts.lambda <= 1) || !(opts.threshold > 0) || opts.window < 2)
    throw new Error("invalid spike-decay options");
  const raw: Record<string, number> = {};
  const decayed: SpikeDecayResult["decayed"] = {};
  for (const [cell, d] of Object.entries(start)) {
    const values = (history[cell] ?? []).map((p) => p.value).filter((v) => Number.isFinite(v));
    raw[cell] = d.mean;
    if (values.length < opts.window + 1) continue;
    const recent = values.slice(-(opts.window + 1));
    const level = median(recent.slice(0, -1));
    const changes = recent.slice(1).map((x, i) => Math.abs(x - recent[i]!));
    const scale = Math.max(1.4826 * median(changes), opts.minScale);
    const latest = recent.at(-1)!;
    if (Math.abs(latest - level) <= opts.threshold * scale) continue;
    const mean = d.mean + opts.lambda * (level - d.mean);
    raw[cell] = mean;
    decayed[cell] = { from: d.mean, toward: level, mean };
  }
  const total = Object.values(raw).reduce((s, x) => s + x, 0);
  if (!(total > 0)) throw new Error("empty basket after spike decay");
  const profile = Object.fromEntries(
    Object.entries(start).map(([cell, d]) => [
      cell,
      { mean: Math.round(((raw[cell]! * 100) / total) * 1000) / 1000, sd: d.sd },
    ]),
  );
  return { profile, decayed };
}
