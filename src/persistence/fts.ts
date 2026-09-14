// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared FTS5 query construction — the single place user text becomes a MATCH
 * expression.
 *
 * History: nine call sites each hand-rolled `query.replace(/['"*()]/g, "")`,
 * they disagreed on term joining (some AND, some OR — the same search string
 * silently meant different things per store), and one site (searchTasks)
 * passed raw text straight into MATCH, so `ask what's this?` crashed the
 * whole command with `fts5: syntax error`. Even the strip-regex sites were
 * crashable: `:` (FTS5 column filter), `^`, and leading `-` all survived the
 * strip.
 *
 * This builder tokenizes to word characters and double-quotes every term,
 * which neutralizes ALL FTS5 syntax by construction. Quoted bare terms match
 * identically to unquoted ones, so ranking behavior is unchanged for normal
 * queries.
 *
 * Stop words (migration 112 companion): natural-language queries such as
 * "what is the deployment runbook" used to spend most of their OR-mode weight
 * on `what`/`is`/`the`, which every note contains. Function words are dropped
 * when at least one content-bearing token remains; a query made only of stop
 * words is passed through unchanged so `recall the` still behaves as before.
 * Identifiers survive intact: `e_42` and `abc-1234` tokenize exactly as their
 * stored content does, and quoting keeps each token a literal.
 */
export const FTS_STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "of",
  "to",
  "in",
  "on",
  "for",
  "and",
  "or",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "with",
  "as",
  "at",
  "by",
  "from",
  "what",
  "which",
  "who",
  "how",
  "do",
  "does",
  "did",
  "my",
  "our",
  "your",
  "their",
  "i",
  "we",
  "you",
  "me",
  "us",
  "about",
  "into",
  "than",
  "then",
  "so",
  "not",
  "no",
  "but",
  "if",
  "when",
  "where",
  "has",
  "have",
  "had",
  "will",
  "would",
  "can",
  "could",
  "should",
  "there",
  "s",
]);

export interface FtsQueryOptions {
  /** Drop English function words when ≥1 content token remains. Default true. */
  stopWords?: boolean;
}

export function isFtsStopWord(term: string): boolean {
  return FTS_STOP_WORDS.has(term.toLowerCase());
}

/** Word tokens of a query, before quoting. Exposed so query expansion and the
 *  paraphrase benchmark can reason about the same token stream MATCH sees. */
export function ftsTerms(raw: string, options: FtsQueryOptions = {}): string[] {
  const terms = raw.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (options.stopWords === false || terms.length === 0) return terms;
  const content = terms.filter((term) => !isFtsStopWord(term));
  return content.length > 0 ? content : terms;
}

export function buildFtsQuery(
  raw: string,
  mode: "and" | "or",
  options: FtsQueryOptions = {},
): string | null {
  const terms = ftsTerms(raw, options);
  if (terms.length === 0) return null;
  const quoted = terms.map((term) => `"${term}"`);
  return quoted.join(mode === "or" ? " OR " : " ");
}

/** Escape a value for use inside a SQL LIKE pattern with `ESCAPE '\'`.
 *  Previously hand-rolled in six modules with three different spellings. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
