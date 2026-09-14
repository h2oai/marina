// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { MarinaDB } from "../persistence/database";
import {
  expandMemoryQuery,
  type MemoryQueryExpansion,
  type MemoryQueryVocabulary,
  normalizeMemoryExpansion,
} from "../sdk/memory-expansion";
import type { MemoryVocabulary, MemoryVocabularyDefinition } from "../sdk/memory-types";
import { MemoryError } from "./service-types";

export function memoryQueryExpansion(query: string, raw: unknown) {
  try {
    return normalizeMemoryExpansion(query, raw);
  } catch {
    throw new MemoryError(
      400,
      "invalid_expansion",
      "Use a policy label and at most four bounded queries",
    );
  }
}

export type VocabularyRule = MemoryQueryVocabulary["rules"][number];

/** Function words that never count as an alias on their own and disqualify a
 *  parenthetical ("(what you see)" is a gloss, not a synonym). Deliberately
 *  local — the FTS stop list is a retrieval concern, this is an authoring one. */
const GLOSS_WORDS = new Set([
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
  "it",
  "this",
  "that",
  "with",
  "as",
  "at",
  "by",
  "from",
  "what",
  "which",
  "who",
  "how",
  "you",
  "your",
  "we",
  "our",
  "i",
  "my",
  "e",
  "g",
  "eg",
  "ie",
  "etc",
  "see",
  "via",
  "not",
  "no",
  "if",
  "when",
]);

const WORD = "[\\p{L}\\p{N}][\\p{L}\\p{N}_-]*";
const phrase = (max: number) => `${WORD}(?:[ ]${WORD}){0,${max - 1}}`;
const ALIAS_MARKER = "(?:aka|a\\.k\\.a\\.|also called|also known as|also named)";
const COPULA = "(?:(?:is|are|was|were)[ ]+)?";
const AKA_PATTERN = new RegExp(
  `(${phrase(3)}),?[ ]*\\(?[ ]*${COPULA}${ALIAS_MARKER}[ ]+(${phrase(3)})\\)?`,
  "giu",
);
const PARENTHETICAL_PATTERN = new RegExp(`(${phrase(2)})[ ]*\\((${phrase(2)})\\)`, "giu");
const LEADING_ALIAS_PATTERN = new RegExp(`^[ ]*\\(?[ ]*${ALIAS_MARKER}[ ]+(${phrase(3)})`, "iu");

const normalized = (value: string) => value.trim().replace(/\s+/gu, " ").toLowerCase();
const words = (value: string) => normalized(value).split(" ");
function usable(side: string, maxWords: number): string | undefined {
  // Keep only the words after the last function word, so "before the
  // deployment, aka the rollout" yields deployment / rollout.
  let parts = side.trim().replace(/\s+/gu, " ").split(" ");
  const isGloss = (w: string) => GLOSS_WORDS.has(w.toLowerCase());
  while (parts.length && isGloss(parts.at(-1)!)) parts.pop();
  const cut = parts.map(isGloss).lastIndexOf(true);
  if (cut >= 0) parts = parts.slice(cut + 1);
  if (!parts.length || parts.length > maxWords) return undefined;
  if (parts.every((w) => /^[\p{N}_-]+$/u.test(w))) return undefined;
  // Lowercased: alias matching is case-insensitive and mined output should
  // not depend on where in a sentence the phrase happened to appear.
  const value = parts.join(" ").toLowerCase();
  return value.length >= 2 && value.length <= 256 ? value : undefined;
}

/** Deterministic synonym pairs from authored prose. Recognizes
 *  `term (alias)`, `term, aka alias`, `term (also called alias)`,
 *  `term also known as alias`. Both directions are emitted so a query phrased
 *  either way reaches notes phrased the other. Order follows the text. */
export function aliasRulesFromText(text: string): VocabularyRule[] {
  const pairs: [string, string][] = [];
  const seen = new Set<string>();
  const add = (left: string | undefined, right: string | undefined) => {
    if (!left || !right) return;
    const a = normalized(left);
    const b = normalized(right);
    if (a === b || words(a).includes(b) || words(b).includes(a)) return;
    for (const [x, y] of [
      [left, right],
      [right, left],
    ] as const) {
      const key = `${normalized(x)} ${normalized(y)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([x, y]);
    }
  };
  for (const match of text.matchAll(AKA_PATTERN)) add(usable(match[1]!, 3), usable(match[2]!, 3));
  // Parentheticals that are themselves alias markers were consumed above.
  const withoutAka = text.replace(AKA_PATTERN, " ");
  for (const match of withoutAka.matchAll(PARENTHETICAL_PATTERN))
    add(usable(match[1]!, 2), usable(match[2]!, 2));
  return mergeRules(pairs);
}

function mergeRules(pairs: [string, string][], maxPairs = Number.POSITIVE_INFINITY) {
  const rules = new Map<string, VocabularyRule>();
  let count = 0;
  for (const [term, alternative] of pairs) {
    if (count >= maxPairs) break;
    const key = normalized(term);
    const rule = rules.get(key) ?? { term, alternatives: [] };
    if (rule.alternatives.some((a) => normalized(a) === normalized(alternative))) continue;
    if (rule.alternatives.length >= 8) continue;
    rule.alternatives.push(alternative);
    rules.set(key, rule);
    count++;
  }
  return [...rules.values()];
}

export const AUTO_VOCABULARY_MAX_PAIRS = 50;

/** At most 50 synonym pairs mined from the platform `guide` pool's own phrasing.
 *  Returns [] when there is no guide pool or the guide uses no alias phrasing;
 *  never invents synonyms. Deterministic for a given pool state. */
export function autoVocabularySeed(db: MarinaDB): VocabularyRule[] {
  const pool = db.getMemoryPool("guide");
  if (!pool) return [];
  const notes = db.getPoolNotes(pool.id, 500);
  const pairs: [string, string][] = [];
  for (const note of notes)
    for (const rule of aliasRulesFromText(note.content))
      for (const alternative of rule.alternatives) pairs.push([rule.term, alternative]);
  return mergeRules(pairs, AUTO_VOCABULARY_MAX_PAIRS);
}

/** Retrieval hints from a caller-authored durable vocabulary: predicate names
 *  become terms; `deploy_target` also answers to "deploy target", and any
 *  alias phrasing inside a predicate `description` is honored. */
export function vocabularyRulesFromDefinition(
  definition: MemoryVocabularyDefinition,
): VocabularyRule[] {
  const pairs: [string, string][] = [];
  for (const [name, predicate] of Object.entries(definition.predicates ?? {})) {
    const spaced = name.replace(/[_-]+/g, " ").trim();
    if (spaced && normalized(spaced) !== normalized(name)) {
      pairs.push([name, spaced], [spaced, name]);
    }
    if (!predicate.description) continue;
    // "aka X" / "also called X" at the very start names the predicate itself.
    const leading = predicate.description.match(LEADING_ALIAS_PATTERN);
    const alias = leading ? usable(leading[1]!, 3) : undefined;
    if (alias && normalized(alias) !== normalized(spaced) && normalized(alias) !== normalized(name))
      pairs.push([name, alias], [spaced, alias], [alias, spaced]);
    for (const rule of aliasRulesFromText(predicate.description))
      for (const alternative of rule.alternatives) pairs.push([rule.term, alternative]);
  }
  return mergeRules(pairs).slice(0, 128);
}

/** Expansion for a legacy-recall query, derived from the entity's resident
 *  durable vocabulary. Undefined when the entity has no durable world account
 *  (`world_identity_required`), the service errors, the space still uses the
 *  open version-0 vocabulary, or no rule applies to this query. Never throws. */
export async function expansionForEntity(
  db: MarinaDB,
  entityName: string,
  query: string,
): Promise<MemoryQueryExpansion | undefined> {
  let vocabulary: MemoryVocabulary | undefined;
  try {
    // Loaded lazily: resident-service -> world-service -> service -> this module.
    const { residentMemoryOperation } = await import("./resident-service");
    const response = await residentMemoryOperation(db, entityName, { operation: "vocabulary" });
    vocabulary = response.result as MemoryVocabulary;
  } catch {
    return undefined;
  }
  if (!vocabulary?.version || !vocabulary.definition) return undefined;
  return expansionFromVocabulary(query, vocabulary);
}

/**
 * Synchronous variant for hot paths (plain `recall`): serves the expansion from
 * a per-entity vocabulary cache and refreshes that cache in the background.
 * The first call for an entity returns `undefined` (no expansion yet) and
 * schedules the fetch; later calls within the TTL expand from the cached
 * vocabulary. This keeps `recall` replies in the same tick — the SDK's reply
 * window and the engine's quest tracker both depend on that.
 */
const VOCABULARY_CACHE_TTL_MS = 60_000;
interface VocabularyCacheEntry {
  vocabulary?: MemoryVocabulary;
  fetchedAt: number;
  refreshing?: Promise<void>;
}
const vocabularyCache = new Map<string, VocabularyCacheEntry>();

export function expansionForEntityCached(
  db: MarinaDB,
  entityName: string,
  query: string,
  now = Date.now(),
): MemoryQueryExpansion | undefined {
  let entry = vocabularyCache.get(entityName);
  const stale = !entry || now - entry.fetchedAt > VOCABULARY_CACHE_TTL_MS;
  if (stale && !entry?.refreshing) {
    const refreshing = (async () => {
      let vocabulary: MemoryVocabulary | undefined;
      try {
        const { residentMemoryOperation } = await import("./resident-service");
        const response = await residentMemoryOperation(db, entityName, { operation: "vocabulary" });
        const v = response.result as MemoryVocabulary;
        vocabulary = v?.version && v.definition ? v : undefined;
      } catch {
        vocabulary = undefined;
      }
      vocabularyCache.set(entityName, { vocabulary, fetchedAt: Date.now() });
    })();
    entry = { vocabulary: entry?.vocabulary, fetchedAt: entry?.fetchedAt ?? 0, refreshing };
    vocabularyCache.set(entityName, entry);
    refreshing.finally(() => {
      const current = vocabularyCache.get(entityName);
      if (current?.refreshing === refreshing) current.refreshing = undefined;
    });
  }
  if (!entry?.vocabulary) return undefined;
  return expansionFromVocabulary(query, entry.vocabulary);
}

/** Await any in-flight vocabulary refreshes (tests) and optionally clear the cache. */
export async function settleVocabularyCache(clear = false): Promise<void> {
  await Promise.allSettled([...vocabularyCache.values()].map((e) => e.refreshing));
  if (clear) vocabularyCache.clear();
}

export function expansionFromVocabulary(
  query: string,
  vocabulary: MemoryVocabulary,
): MemoryQueryExpansion | undefined {
  const rules = vocabularyRulesFromDefinition(vocabulary.definition);
  if (!rules.length) return undefined;
  try {
    const expanded = expandMemoryQuery(query, {
      policy: `vocabulary:v${vocabulary.version}`,
      rules,
    });
    if (!expanded.expansion.queries.length) return undefined;
    return normalizeMemoryExpansion(query, expanded.expansion);
  } catch {
    return undefined;
  }
}

/** The query list a legacy recall should run — original first, then the
 *  at-most-four alternatives, deduplicated. Callers run each through
 *  `db.recallNotes` (or any FTS-backed recall) and fuse with `fuseRecallResults`. */
export function expandedFtsQueries(query: string, expansion?: MemoryQueryExpansion): string[] {
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const candidate of [query, ...(expansion?.queries ?? [])]) {
    const key = normalized(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    queries.push(candidate);
    if (queries.length === 5) break;
  }
  return queries;
}

/** Reciprocal-rank fusion (k=60) matching the durable service: the original
 *  query's list carries full weight, alternatives share one unit between them.
 *  Deterministic: ties break on first-seen order. */
export function fuseRecallResults<T>(
  lists: T[][],
  key: (item: T) => string | number,
  limit: number,
): T[] {
  const [primary = [], ...alternatives] = lists;
  const scores = new Map<string | number, { item: T; score: number; order: number }>();
  let order = 0;
  const credit = (list: T[], weight: number) => {
    for (const [i, item] of list.entries()) {
      const id = key(item);
      const entry = scores.get(id) ?? { item, score: 0, order: order++ };
      entry.score += weight / (60 + i + 1);
      scores.set(id, entry);
    }
  };
  credit(primary, 1);
  for (const list of alternatives) credit(list, 1 / alternatives.length);
  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((entry) => entry.item);
}
