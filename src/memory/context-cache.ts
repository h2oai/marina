// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { MarinaDB } from "../persistence/database";
import { contextDeadline, contextRevision } from "../persistence/db-context-revision";
import { canonical } from "../persistence/db-memory-service";
import type { UnifiedContextOptions, UnifiedContextResult } from "../sdk/memory-context";

export const CONTEXT_CACHE_LIMIT = 128;
export const CONTEXT_CACHE_TTL_MS = 5_000;
/**
 * Sleep-time precompute (the dreaming plan §4.8, Letta's predictable case):
 * an idle agent with a standing focus pre-builds its prompt context once per
 * idle stretch and the entry lives this long — served by the next prompt
 * build while the memory revision is unchanged (every hit still rechecks the
 * revision and the temporal bounds; a write to memory invalidates it as any
 * entry). Measured by `contextCacheStats().precomputedHits`.
 */
export const CONTEXT_PRECOMPUTE_TTL_MS = 6 * 60 * 60 * 1000;
interface Entry {
  revision: string;
  created: number;
  until: number;
  result: UnifiedContextResult;
  precomputed?: true;
}
interface Cache {
  entries: Map<string, Entry>;
  hits: number;
  misses: number;
  invalidations: number;
  precomputed: number;
  precomputedHits: number;
}
const caches = new WeakMap<MarinaDB, Cache>();

export function contextCacheStats(db: MarinaDB) {
  const cache = caches.get(db);
  return {
    entries: cache?.entries.size ?? 0,
    hits: cache?.hits ?? 0,
    misses: cache?.misses ?? 0,
    invalidations: cache?.invalidations ?? 0,
    /** Entries stored by a sleep-time precompute, and prompt builds they served. */
    precomputed: cache?.precomputed ?? 0,
    precomputedHits: cache?.precomputedHits ?? 0,
    limit: CONTEXT_CACHE_LIMIT,
    maxAgeMs: CONTEXT_CACHE_TTL_MS,
    precomputeMaxAgeMs: CONTEXT_PRECOMPUTE_TTL_MS,
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
  /** `precompute`: store the result for CONTEXT_PRECOMPUTE_TTL_MS (an idle agent's sleep-time build). */
  opts: { precompute?: boolean } = {},
): Promise<UnifiedContextResult> {
  const raw = db.memoryRepository().raw;
  if (raw.inTransaction) return retrieve();
  let cache = caches.get(db);
  if (!cache) {
    cache = {
      entries: new Map(),
      hits: 0,
      misses: 0,
      invalidations: 0,
      precomputed: 0,
      precomputedHits: 0,
    };
    caches.set(db, cache);
  }
  const { creditReflections: _credit, ...retrievalOptions } = options;
  const key = canonical([entity, query.trim(), retrievalOptions]);
  const revision = contextRevision(raw);
  const now = Date.now();
  const entry = cache.entries.get(key);
  if (entry && entry.revision === revision && now >= entry.created && now < entry.until) {
    cache.hits++;
    if (entry.precomputed && !opts.precompute) cache.precomputedHits++;
    // A warm over a fresh ordinary entry keeps it for the precompute's lifetime.
    if (opts.precompute && !entry.precomputed) {
      entry.precomputed = true;
      entry.until = Math.min(
        entry.created + CONTEXT_PRECOMPUTE_TTL_MS,
        contextDeadline(raw, entry.created),
      );
      cache.precomputed++;
    }
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
    const ttl = opts.precompute ? CONTEXT_PRECOMPUTE_TTL_MS : CONTEXT_CACHE_TTL_MS;
    const until = Math.min(created + ttl, contextDeadline(raw, created));
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
      result.relevance?.outcome !== "fail_open" &&
      result.valueDecision?.status !== "unavailable"
    ) {
      // Expired/invalidated entries should not retain private content unnecessarily.
      for (const [id, cached] of cache.entries)
        if (cached.revision !== before || finished >= cached.until) cache.entries.delete(id);
      cache.entries.set(key, {
        revision: before,
        created,
        until,
        result: structuredClone(result),
        ...(opts.precompute ? { precomputed: true as const } : {}),
      });
      if (opts.precompute) cache.precomputed++;
      while (cache.entries.size > CONTEXT_CACHE_LIMIT)
        cache.entries.delete(cache.entries.keys().next().value!);
    }
    return result;
  }
  // Do not deliver an earlier authorized snapshot after a concurrent withdrawal.
  // This is optional context: consumers retain their already-committed tool result.
  throw new Error("Memory changed during retrieval; retry context when writes settle.");
}
