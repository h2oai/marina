// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Search-backend health, observed from real calls (never probed: a probe of a
 * paid API costs a credit). Every search backend — the `web search` providers
 * and the research retrievers — reports each call here, so `readiness` can say
 * which backend is failing and why (an exhausted Tavily plan answers HTTP 432)
 * instead of the caller seeing a silent zero. Per process, in memory.
 */

export interface SearchBackendHealth {
  name: string;
  calls: number;
  failures: number;
  /** Failures in a row since the last success. */
  consecutiveFailures: number;
  lastOkAt?: number;
  lastErrorAt?: number;
  lastError?: string;
}

const health = new Map<string, SearchBackendHealth>();

/** Record one call's outcome. `error` set = the call failed. */
export function recordSearchOutcome(name: string, error?: string, now = Date.now()): void {
  const h = health.get(name) ?? { name, calls: 0, failures: 0, consecutiveFailures: 0 };
  h.calls++;
  if (error === undefined) {
    h.lastOkAt = now;
    h.consecutiveFailures = 0;
  } else {
    h.failures++;
    h.consecutiveFailures++;
    h.lastErrorAt = now;
    h.lastError = error.replace(/\s+/g, " ").slice(0, 160);
  }
  health.set(name, h);
}

/** Every backend that has been called in this process, by name. */
export function searchBackendHealth(): SearchBackendHealth[] {
  return [...health.values()].map((h) => ({ ...h })).sort((a, b) => a.name.localeCompare(b.name));
}

/** How long a backend that keeps failing is skipped before it is tried again. */
export const SEARCH_BACKOFF_MS = 10 * 60_000;

/**
 * True while a backend is failing: its last call failed recently and either
 * failed twice in a row or said its quota, credit or key is the problem.
 * Such a backend is skipped (the next in the chain answers) until the backoff
 * passes; then one call tries it again.
 */
export function searchBackendDown(name: string, now = Date.now()): boolean {
  const h = health.get(name);
  if (!h || h.consecutiveFailures === 0 || h.lastErrorAt === undefined) return false;
  if (now - h.lastErrorAt >= SEARCH_BACKOFF_MS) return false;
  return h.consecutiveFailures >= 2 || isQuotaOrAuthError(h.lastError ?? "");
}

/** A plan/credit exhaustion or auth failure — retrying soon will not help. */
export function isQuotaOrAuthError(message: string): boolean {
  return /\b(401|402|403|429|432|433)\b|usage limit|quota|credit|insufficient|rate.?limit/i.test(
    message,
  );
}

export function resetSearchHealthForTests(): void {
  health.clear();
}
