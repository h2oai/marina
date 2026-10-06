// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The base rate of a nested reference class from published outcomes — how
 * often questions like this one resolved Yes — for a statistical prior when
 * the asker has a record of past outcomes (a benchmark's published
 * resolutions, a platform's history). Pure functions.
 *
 * Classes are nested from broadest to narrowest (a source, then a question
 * template, then a template and a size bucket). The rate starts at the
 * broadest class's smoothed frequency and is pulled toward each narrower
 * class's own frequency in proportion to its evidence (a pseudo-count of
 * `PSEUDO`), so a thin class barely moves its parent's rate.
 *
 * Only outcomes known before the cutoff count: an outcome whose resolution
 * date is within `SETTLE_DAYS` of the cutoff, or after it, is not visible.
 */

export interface PublishedOutcome {
  /** Broadest first; every outcome lists the same depth of classes. */
  classes: string[];
  /** When the outcome was determined (YYYY-MM-DD). */
  resolvedOn: string;
  /** 1 = yes, 0 = no (fractional values are averaged as given). */
  outcome: number;
}

export interface ClassRate {
  p: number;
  /** Visible outcomes in the narrowest class that had any. */
  n: number;
  /** The narrowest class with visible outcomes. */
  class: string;
}

const PSEUDO = 4;
/** Days after its resolution date before an outcome counts as published. */
export const SETTLE_DAYS = 2;

const DAY_MS = 86_400_000;

/** Index the outcomes visible before `cutoff` by class. */
export function classTotals(
  outcomes: PublishedOutcome[],
  cutoff: Date,
): Map<string, { yes: number; n: number }> {
  const lastVisible = new Date(cutoff.getTime() - SETTLE_DAYS * DAY_MS).toISOString().slice(0, 10);
  const totals = new Map<string, { yes: number; n: number }>();
  for (const o of outcomes) {
    if (!(o.resolvedOn < lastVisible) || !Number.isFinite(o.outcome)) continue;
    for (const c of o.classes) {
      const t = totals.get(c) ?? { yes: 0, n: 0 };
      t.yes += o.outcome;
      t.n++;
      totals.set(c, t);
    }
  }
  return totals;
}

/** The rate for a question in `classes` (broadest first); undefined when no class has outcomes. */
export function classRate(
  totals: Map<string, { yes: number; n: number }>,
  classes: string[],
): ClassRate | undefined {
  let rate: ClassRate | undefined;
  for (const c of classes) {
    const t = totals.get(c);
    if (!t || t.n === 0) continue;
    const parent = rate?.p ?? 0.5;
    const pseudo = rate ? PSEUDO : 2;
    rate = { p: (t.yes + pseudo * parent) / (t.n + pseudo), n: t.n, class: c };
  }
  return rate;
}
