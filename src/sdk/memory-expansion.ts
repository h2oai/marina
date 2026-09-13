// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Caller-selected alternatives are retrieval hints, never new assertions. */
export interface MemoryQueryExpansion {
  policy: string;
  queries: string[];
}
export interface MemoryQueryVocabulary {
  policy: string;
  rules: { term: string; alternatives: string[] }[];
}
export interface MemoryExpansionCoverage extends MemoryQueryExpansion {
  candidates: number[];
  candidate_limit: number;
  fusion: "mean-alternatives-rrf:k=60";
}

const normalized = (value: string) => value.trim().replace(/\s+/gu, " ").toLowerCase();
function bounded(value: unknown, max: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new RangeError(`Expected a nonempty string of at most ${max} characters`);
}

/** Validate even ignored duplicates, then deduplicate without changing authored text. */
export function normalizeMemoryExpansion(
  query: string,
  raw: unknown,
): MemoryQueryExpansion | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new RangeError("expansion must be an object");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "policy" && key !== "queries"))
    throw new RangeError("Unknown expansion field");
  bounded(value.policy, 256);
  if (!Array.isArray(value.queries) || value.queries.length > 4)
    throw new RangeError("Use at most four explicit alternative queries");
  const seen = new Set([normalized(query)]);
  const queries: string[] = [];
  for (const alternative of value.queries) {
    bounded(alternative, 8192);
    const key = normalized(alternative);
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(alternative);
  }
  return { policy: value.policy, queries };
}

/** Literal, nonrecursive substitutions against the original query only.
 * Rule order determines which four alternatives fit; inspect `truncated`.
 * Supply/persist this JSON vocabulary yourself; no model or global registry. */
export function expandMemoryQuery(query: string, vocabulary: MemoryQueryVocabulary) {
  bounded(query, 8192);
  bounded(vocabulary.policy, 256);
  if (!Array.isArray(vocabulary.rules) || vocabulary.rules.length > 128)
    throw new RangeError("Use at most 128 vocabulary rules");
  const queries: string[] = [];
  const applied: { term: string; alternative: string; query: string }[] = [];
  const seen = new Set([normalized(query)]);
  let truncated = false;
  for (const rule of vocabulary.rules) {
    if (!rule || typeof rule !== "object") throw new RangeError("Invalid vocabulary rule");
    bounded(rule.term, 256);
    if (!Array.isArray(rule.alternatives) || rule.alternatives.length > 8)
      throw new RangeError("Use at most eight alternatives per rule");
    const escaped = rule.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu");
    for (const alternative of rule.alternatives) {
      bounded(alternative, 256);
      const expanded = query.replace(pattern, () => alternative);
      const key = normalized(expanded);
      if (seen.has(key)) continue;
      seen.add(key);
      if (queries.length === 4 || expanded.length > 8192) {
        truncated = true;
        continue;
      }
      queries.push(expanded);
      applied.push({ term: rule.term, alternative, query: expanded });
    }
  }
  return { query, expansion: { policy: vocabulary.policy, queries }, applied, truncated };
}
