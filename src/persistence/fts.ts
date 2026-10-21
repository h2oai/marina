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

// Materialize lexical hits once, then map each hit to the numeric handles
// that show it: the row itself (a legacy note with its own body — never a
// record version, which the view excludes), a handle on the record whose
// current version it is, or a handle pinned to that version. The three are
// disjoint, so no pair repeats.
// Joining the projected numeric view to FTS directly makes SQLite read every
// owned note through the view (and can rerun the MATCH per note), so a search
// grew with history. `CROSS JOIN` fixes the order (hits first, then each
// handle by id) so the planner cannot fall back to that scan, and
// `n.content_id = fts.rowid` keeps exactly the pairs the direct join matched.
// Retain every hit and its original rank: weighted top-N ranking and ACLs
// must stay exact (a lexical LIMIT before scoring would change results).
export const MATCHED_NOTES_CTE = `WITH matched_notes AS MATERIALIZED (
  SELECT rowid, rank FROM notes_fts WHERE notes_fts MATCH ?
),
matched_handles(handle_id, rowid, rank) AS (
  SELECT m.rowid, m.rowid, m.rank FROM matched_notes m
  WHERE NOT EXISTS (SELECT 1 FROM memory_record_versions rv WHERE rv.note_id = m.rowid)
  UNION ALL
  SELECT p.note_id, m.rowid, m.rank FROM matched_notes m
    CROSS JOIN memory_records r INDEXED BY idx_memory_records_note ON r.current_note_id = m.rowid
    CROSS JOIN memory_note_projections p ON p.record_id = r.id AND p.version IS NULL
  UNION ALL
  SELECT p.note_id, m.rowid, m.rank FROM matched_notes m
    CROSS JOIN memory_record_versions v ON v.note_id = m.rowid
    CROSS JOIN memory_note_projections p ON p.record_id = v.record_id AND p.version = v.version
)`;

/** Numeric handles joined to their lexical hits (alias `fts`, as before),
 *  reading each hit's handles by id: cost follows the number of hits. */
export const MATCHED_FROM = `FROM matched_handles fts
      CROSS JOIN numeric_notes n ON n.id = fts.handle_id AND n.content_id = fts.rowid`;

/** The same pairs, reading the scoped notes and probing the materialized
 *  hits: cost follows the number of scoped notes. */
export const MATCHED_FROM_SCOPE = `FROM numeric_notes n
      JOIN matched_notes fts ON n.content_id = fts.rowid`;
