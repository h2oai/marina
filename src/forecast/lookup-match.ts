// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Matching a question to a market or event by its words, and by date when
 * both sides know one. Deliberately conservative: a lookup that shows the
 * wrong market's price is worse than one that shows nothing.
 */

const STOP = new Set(
  "the a an of in on at to for by with will be is are was were and or not than that this which what who whom whose when where how does do did has have had its it as from into over under after before between during win wins won lose top more less most least next first last any each per vs versus game match season week".split(
    " ",
  ),
);

export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOP.has(t)),
  );
}

/** The share of the candidate's words found in the question (0–1), with the shared count. */
export function overlap(
  question: Set<string>,
  candidate: string,
): { score: number; shared: number } {
  const c = tokens(candidate);
  if (c.size === 0) return { score: 0, shared: 0 };
  let shared = 0;
  for (const t of c) if (question.has(t)) shared++;
  return { score: shared / c.size, shared };
}

/** Default bar for showing a matched market: half its words, at least two of them. */
export const MATCH_MIN_SCORE = 0.5;
export const MATCH_MIN_SHARED = 2;

export function isMatch(m: { score: number; shared: number }): boolean {
  return m.score >= MATCH_MIN_SCORE && m.shared >= MATCH_MIN_SHARED;
}

/** How far below the best match's score another candidate may be and still be shown. */
export const MATCH_BEST_MARGIN = 0.15;

/**
 * The candidates that match, keeping only those close to the best match: a
 * question about a rate CUT matches "Next Fed rate cut?" fully and "Next Fed
 * rate hike?" partly — only the first is shown.
 */
export function bestMatches<T>(items: T[], question: Set<string>, text: (t: T) => string): T[] {
  const scored = items
    .map((item, i) => ({ item, i, m: overlap(question, text(item)) }))
    .filter((x) => isMatch(x.m));
  if (scored.length === 0) return [];
  const best = Math.max(...scored.map((x) => x.m.score));
  return scored
    .filter((x) => x.m.score >= best - MATCH_BEST_MARGIN)
    .sort((a, b) => b.m.score - a.m.score || a.i - b.i)
    .map((x) => x.item);
}

/** Whether two dates (ISO) are within `days` of each other; true when either is unknown. */
export function nearDate(a: string | undefined, b: string | undefined, days: number): boolean {
  if (!a || !b) return true;
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
  return Math.abs(x - y) <= days * 86_400_000;
}
