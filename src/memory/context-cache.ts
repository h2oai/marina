// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { MarinaDB } from "../persistence/database";
import { contextDeadline, contextRevision } from "../persistence/db-context-revision";
import { canonical } from "../persistence/db-memory-service";
import type { UnifiedContextOptions, UnifiedContextResult } from "../sdk/memory-context";

export const CONTEXT_CACHE_LIMIT = 128;
export const CONTEXT_CACHE_TTL_MS = 5_000;
interface Entry {
  revision: string;
  created: number;
  until: number;
  result: UnifiedContextResult;
}
interface Cache {
  entries: Map<string, Entry>;
  hits: number;
  misses: number;
  invalidations: number;
}
const caches = new WeakMap<MarinaDB, Cache>();

export function contextCacheStats(db: MarinaDB) {
  const cache = caches.get(db);
  return {
    entries: cache?.entries.size ?? 0,
    hits: cache?.hits ?? 0,
    misses: cache?.misses ?? 0,
    invalidations: cache?.invalidations ?? 0,
    limit: CONTEXT_CACHE_LIMIT,
    maxAgeMs: CONTEXT_CACHE_TTL_MS,
  };
}

/** Cache pure retrieval only; callers apply any reflection credit on every delivery.
 * No TTL-only authorization: every hit rechecks the SQLite revision and all temporal
 * bounds. Never share mutable results, degraded results, or uncommitted snapshots. */
export async function cachedContext(
  db: MarinaDB,
  entity: string,
  query: string,
  options: UnifiedContextOptions,
  retrieve: () => Promise<UnifiedContextResult>,
): Promise<UnifiedContextResult> {
  const raw = db.memoryRepository().raw;
  if (raw.inTransaction) return retrieve();
  let cache = caches.get(db);
  if (!cache) {
    cache = { entries: new Map(), hits: 0, misses: 0, invalidations: 0 };
    caches.set(db, cache);
  }
  const { creditReflections: _credit, ...retrievalOptions } = options;
  const key = canonical([entity, query.trim(), retrievalOptions]);
  const revision = contextRevision(raw);
  const now = Date.now();
  const entry = cache.entries.get(key);
  if (entry && entry.revision === revision && now >= entry.created && now < entry.until) {
    cache.hits++;
    cache.entries.delete(key);
    cache.entries.set(key, entry);
    return structuredClone(entry.result);
  }
  cache.misses++;
  if (entry) {
    cache.invalidations++;
    cache.entries.delete(key);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = contextRevision(raw);
    const created = Date.now();
    const until = Math.min(created + CONTEXT_CACHE_TTL_MS, contextDeadline(raw, created));
    const result = await retrieve();
    // Only a write during retrieval invalidates the snapshot (retry it).
    if (before !== contextRevision(raw)) continue;
    const finished = Date.now();
    // Age and temporal deadlines decide CACHEABILITY only: a slow retrieval
    // (an LLM relevance gate) over an unchanged revision is served, never kept.
    // A gate that failed open served the ungated set: retry it on the next read.
    if (
      finished >= created &&
      finished < until &&
      !raw.inTransaction &&
      result.degraded.length === 0 &&
      result.relevance?.outcome !== "fail_open"
    ) {
      // Expired/invalidated entries should not retain private content unnecessarily.
      for (const [id, cached] of cache.entries)
        if (cached.revision !== before || finished >= cached.until) cache.entries.delete(id);
      cache.entries.set(key, { revision: before, created, until, result: structuredClone(result) });
      while (cache.entries.size > CONTEXT_CACHE_LIMIT)
        cache.entries.delete(cache.entries.keys().next().value!);
    }
    return result;
  }
  // Do not deliver an earlier authorized snapshot after a concurrent withdrawal.
  // This is optional context: consumers retain their already-committed tool result.
  throw new Error("Memory changed during retrieval; retry context when writes settle.");
}
