// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Search provider system — pluggable, cascading, zero-config by default.
 *
 * Provider resolution order:
 *   1. Tavily (if TAVILY_API_KEY set) — AI-native, highest quality
 *   2. SearXNG (if SEARXNG_URL set) — self-hosted meta-search, 150+ engines
 *   3. DuckDuckGo (always available) — free, no key needed
 *
 * Academic providers (arXiv, PubMed, Semantic Scholar) are always available
 * alongside the primary web provider — free, no keys.
 *
 * Intent detection auto-routes queries to the right engines based on keywords.
 * Agents can override with --engines flag for explicit control.
 */

import type { ConnectorRuntime } from "../connector-runtime";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  score?: number;
}

export interface SearchOpts {
  /** Target engines: "web" | "academic" | "news" | "social" | "code". Default: auto-detect. */
  engines?: string[];
  /** Max results per engine. Default: 10 */
  maxResults?: number;
}

export interface SearchProvider {
  name: string;
  /** Which engine categories this provider supports */
  engines: string[];
  search(
    query: string,
    opts: SearchOpts,
    runtime: ConnectorRuntime,
    entityId?: string,
  ): Promise<SearchResult[]>;
}

// ─── Intent Detection ───────────────────────────────────────────────────────

const ACADEMIC_PATTERN =
  /\b(paper|papers|study|studies|research|journal|peer.?review|arxiv|pubmed|clinical.?trial|meta.?analysis|systematic.?review|preprint)\b/i;
const NEWS_PATTERN =
  /\b(today|yesterday|latest|breaking|announce|announced|launch|launched|release|released|update|news|recent)\b/i;
const CODE_PATTERN =
  /\b(github|repo|repository|library|npm|crate|package|api|sdk|implementation|code|stackoverflow|programming)\b/i;
const SOCIAL_PATTERN =
  /\b(reddit|forum|opinion|opinions|review|reviews|experience|recommend|best|worst|discussion|thread)\b/i;

/**
 * Detect which engines a query should target based on keywords.
 * Always includes "web". Adds academic/news/code/social when signals are present.
 * This is a convenience default — agents can override with --engines.
 */
export function detectIntent(query: string): string[] {
  const engines: string[] = ["web"];
  if (ACADEMIC_PATTERN.test(query)) engines.push("academic");
  if (NEWS_PATTERN.test(query)) engines.push("news");
  if (CODE_PATTERN.test(query)) engines.push("code");
  if (SOCIAL_PATTERN.test(query)) engines.push("social");
  return engines;
}

// ─── Provider Registry ──────────────────────────────────────────────────────

const providers: SearchProvider[] = [];

export function registerProvider(provider: SearchProvider): void {
  providers.push(provider);
}

export function getProviders(): readonly SearchProvider[] {
  return providers;
}

/**
 * Find the best provider for a given engine category.
 * Returns the first registered provider that supports the engine.
 */
function providerForEngine(engine: string): SearchProvider | undefined {
  return providers.find((p) => p.engines.includes(engine));
}

// ─── Search Orchestrator ────────────────────────────────────────────────────

/**
 * Execute a search across the best available providers for each detected engine.
 * Deduplicates results by URL. Returns merged results.
 */
export async function search(
  query: string,
  opts: SearchOpts,
  runtime: ConnectorRuntime,
  entityId?: string,
): Promise<SearchResult[]> {
  const engines = opts.engines ?? detectIntent(query);
  const maxResults = opts.maxResults ?? 10;

  // Group engines by their provider to avoid duplicate calls
  const providerEngines = new Map<SearchProvider, string[]>();
  for (const engine of engines) {
    const provider = providerForEngine(engine);
    if (provider) {
      const existing = providerEngines.get(provider) ?? [];
      existing.push(engine);
      providerEngines.set(provider, existing);
    }
  }

  // Execute all provider searches in parallel
  const allResults = await Promise.all(
    Array.from(providerEngines.entries()).map(([provider, engineList]) =>
      provider
        .search(query, { engines: engineList, maxResults }, runtime, entityId)
        .catch((): SearchResult[] => []),
    ),
  );

  // Flatten and deduplicate by URL
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const batch of allResults) {
    for (const result of batch) {
      const key = result.url.toLowerCase().replace(/\/+$/, "");
      if (!seen.has(key)) {
        seen.add(key);
        results.push(result);
      }
    }
  }

  return results.slice(0, maxResults);
}

// ─── Provider Initialization ────────────────────────────────────────────────

let initialized = false;

/**
 * Initialize providers based on available environment variables.
 * Call once at startup. Safe to call multiple times (idempotent).
 */
export function initProviders(): void {
  if (initialized) return;
  initialized = true;

  // Tier 1: key-gated providers (highest quality)
  if (process.env.TAVILY_API_KEY) {
    // Lazy import to avoid loading when not configured
    import("./tavily").then((m) => registerProvider(m.tavilyProvider(process.env.TAVILY_API_KEY!)));
  }
  if (process.env.SEARXNG_URL) {
    import("./searxng").then((m) => registerProvider(m.searxngProvider(process.env.SEARXNG_URL!)));
  }

  // Tier 2: always-available free providers
  import("./duckduckgo").then((m) => registerProvider(m.duckDuckGoProvider()));

  // Academic: always available, free, no keys
  import("./academic").then((m) => registerProvider(m.academicProvider()));
}

/**
 * Synchronous initialization for providers that don't need async setup.
 * Prefer this over initProviders() when you need providers available immediately.
 */
export function initProvidersSync(): void {
  if (initialized) return;
  initialized = true;

  const { duckDuckGoProvider } = require("./duckduckgo");
  const { academicProvider } = require("./academic");

  if (process.env.TAVILY_API_KEY) {
    const { tavilyProvider } = require("./tavily");
    registerProvider(tavilyProvider(process.env.TAVILY_API_KEY));
  }
  if (process.env.SEARXNG_URL) {
    const { searxngProvider } = require("./searxng");
    registerProvider(searxngProvider(process.env.SEARXNG_URL));
  }

  registerProvider(duckDuckGoProvider());
  registerProvider(academicProvider());
}
