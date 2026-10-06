// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Query-term matching shared by the unified context's overlap filter
 * (`relevantToQuery`) and the relevance gate's mechanical floor. Matching is
 * case-insensitive on word prefixes so porter-stemmed forms ("deploys" /
 * "deploy") still count. Pure: no database, no model.
 */

import { ftsTerms } from "../persistence/fts";

const stem = (word: string) =>
  word.length > 5 ? word.slice(0, Math.max(4, word.length - 2)) : word;

/** Distinct lower-cased content terms of a query (FTS stop words dropped). */
export function queryTerms(query: string): string[] {
  return [...new Set(ftsTerms(query).map((t) => t.toLowerCase()))];
}

/** A predicate: does `content` contain a word matching the query term? */
export function termMatcher(content: string): (term: string) => boolean {
  const words = new Set(
    content
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(Boolean),
  );
  const prefixes = [...words].map(stem);
  return (term: string) => {
    const st = stem(term);
    return words.has(term) || prefixes.some((w) => w.startsWith(st) || st.startsWith(w));
  };
}

/** Share of `terms` that `content` matches (1 for an empty term list). */
export function termCoverage(content: string, terms: readonly string[]): number {
  if (terms.length === 0) return 1;
  const matches = termMatcher(content);
  let n = 0;
  for (const term of terms) if (matches(term)) n++;
  return n / terms.length;
}
