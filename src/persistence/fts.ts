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
 */
export function buildFtsQuery(raw: string, mode: "and" | "or"): string | null {
  const terms = raw.match(/[\p{L}\p{N}_]+/gu);
  if (!terms || terms.length === 0) return null;
  const quoted = terms.map((term) => `"${term}"`);
  return quoted.join(mode === "or" ? " OR " : " ");
}

/** Escape a value for use inside a SQL LIKE pattern with `ESCAPE '\'`.
 *  Previously hand-rolled in six modules with three different spellings. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
