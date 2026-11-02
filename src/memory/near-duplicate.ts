// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Lexical near-duplicate detection for memory writes.
 *
 * Two texts are near-duplicates when their word-shingle sets overlap by at
 * least `NEAR_DUPLICATE_THRESHOLD` (Jaccard). Pure and dependency-free: the
 * write path (`createNote`) uses it to turn a repeated observation into
 * evidence on the existing record instead of a second copy. Exact duplicates
 * are caught earlier by the exact-content lookup; this catches the rewording
 * an agent produces when it restates the same fact a day later.
 *
 * Conservative on purpose: short texts (fewer than `NEAR_DUPLICATE_MIN_WORDS`
 * words) are never judged — a few shared words are not evidence of the same
 * claim — and the threshold is high enough that two notes about the same
 * subject with different claims stay distinct.
 */

/** Jaccard overlap of word shingles at or above which two texts are the same note. */
export const NEAR_DUPLICATE_THRESHOLD = 0.8;
/** Texts with fewer words are never judged near-duplicates. */
export const NEAR_DUPLICATE_MIN_WORDS = 8;
/** Words per shingle. */
export const SHINGLE_WORDS = 3;

export function normalizedWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function wordShingles(text: string, size = SHINGLE_WORDS): Set<string> {
  const words = normalizedWords(text);
  const out = new Set<string>();
  if (words.length === 0) return out;
  if (words.length <= size) {
    out.add(words.join(" "));
    return out;
  }
  for (let i = 0; i + size <= words.length; i++) out.add(words.slice(i, i + size).join(" "));
  return out;
}

/** Jaccard similarity of the two texts' shingle sets, in [0, 1]. */
export function shingleSimilarity(a: string, b: string, size = SHINGLE_WORDS): number {
  const sa = wordShingles(a, size);
  const sb = wordShingles(b, size);
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared++;
  const union = sa.size + sb.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * The best near-duplicate among `candidates`, or undefined. `text` must have
 * at least `NEAR_DUPLICATE_MIN_WORDS` words; a candidate qualifies at or above
 * the threshold. Ties keep the first candidate (callers pass them most
 * relevant first).
 */
export function nearDuplicate<T extends { content: string }>(
  text: string,
  candidates: readonly T[],
  threshold = NEAR_DUPLICATE_THRESHOLD,
): { candidate: T; overlap: number } | undefined {
  if (normalizedWords(text).length < NEAR_DUPLICATE_MIN_WORDS) return undefined;
  let best: { candidate: T; overlap: number } | undefined;
  for (const candidate of candidates) {
    if (candidate.content === text) continue; // exact duplicates are another path's job
    const overlap = shingleSimilarity(text, candidate.content);
    if (overlap >= threshold && (!best || overlap > best.overlap)) best = { candidate, overlap };
  }
  return best;
}
