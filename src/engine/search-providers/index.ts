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
 * Date-bounded ("as of") providers — GDELT news, Wikipedia revisions, Hacker
 * News, arXiv by submission date — are also always registered (free, no keys)
 * but only answer searches that carry a `before` bound (or name them
 * explicitly). A bounded search uses ONLY providers that declare
 * `dateBound: "strict"` and drops every result that is undated or published
 * after the bound, so a backtest never sees an unfiltered engine.
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
  /** ISO timestamp the item was published (or archived/revised) — set by date-aware providers. */
  published?: string;
  /** Page text the provider already holds (as of the bound), so callers need not fetch it. */
  text?: string;
}

export interface SearchOpts {
  /** Target engines: "web" | "academic" | "news" | "social" | "code". Default: auto-detect. */
  engines?: string[];
  /** Max results per engine. Default: 10 */
  maxResults?: number;
  /**
   * Latest instant allowed (ISO). A bounded search uses only `dateBound: "strict"`
   * providers and drops anything undated or published after it.
   */
  before?: string;
  /** Earliest instant wanted (ISO) — a relevance hint strict providers apply where it fits. */
  after?: string;
  /** Restrict to these provider names (e.g. `gdelt`, `wikipedia`). */
  providers?: string[];
}

/** The HTTP surface a provider needs — a `ConnectorRuntime`, or `standaloneSearchHttp()`. */
export type SearchHttp = Pick<ConnectorRuntime, "httpGet" | "httpPost">;

export interface SearchProvider {
  name: string;
  /** Which engine categories this provider supports */
  engines: string[];
  /**
   * `strict`: every result is published at or before `opts.before` and carries
   * `published` (the provider queries by date and re-checks). Absent: the
   * provider cannot honour a bound and is never used for a bounded search.
   */
  dateBound?: "strict";
  /** Only answers bounded searches or searches that name it in `opts.providers`. */
  boundOnly?: boolean;
  /** One line for `sources` listings: what it searches and how the bound is enforced. */
  describe?: string;
  search(
    query: string,
    opts: SearchOpts,
    runtime: SearchHttp,
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

/**
 * Find the best provider for a given engine category.
 * Returns the first registered provider that supports the engine.
 */
function providerForEngine(engine: string): SearchProvider | undefined {
  return providers.find((p) => !p.boundOnly && p.engines.includes(engine));
}

/** Every registered provider (for `sources` listings). */
export function listProviders(): readonly SearchProvider[] {
  return providers;
}

/**
 * Split an `engines:` list into engine categories and provider names. A name
 * that is also a category (`academic`) stays a category.
 */
export function splitEnginesAndProviders(
  list: readonly string[],
  extraProviderNames: readonly string[] = [],
): { engines: string[]; providers: string[] } {
  const categories = new Set(providers.flatMap((p) => p.engines));
  const names = new Set([...providers.map((p) => p.name), ...extraProviderNames]);
  const engines: string[] = [];
  const named: string[] = [];
  for (const raw of list) {
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    // `corpus:<name>` always names a local corpus provider (it may be built after startup).
    if (e.startsWith("corpus:")) named.push(e);
    else if (names.has(e) && !categories.has(e)) named.push(e);
    else engines.push(e);
  }
  return { engines, providers: named };
}

/** An ISO instant from `before:`/`asof:` input; a bare `YYYY-MM-DD` is the START of that UTC day. */
export function parseBound(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00:00.000Z`;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** True when `published` is a parseable instant at or before `before` (and after `after`). */
export function withinBound(
  published: string | undefined,
  before: string,
  after?: string,
): boolean {
  if (!published) return false;
  const t = Date.parse(published);
  if (!Number.isFinite(t)) return false;
  if (t > Date.parse(before)) return false;
  if (after && t < Date.parse(after)) return false;
  return true;
}

/**
 * A bounded search: every strict provider serving one of `engines` (or named in
 * `opts.providers`), results re-checked against the bound.
 */
async function boundedSearch(
  query: string,
  opts: SearchOpts & { before: string },
  engines: string[],
  runtime: SearchHttp,
  entityId?: string,
): Promise<SearchResult[]> {
  const named = opts.providers?.map((n) => n.toLowerCase());
  const chosen = providers.filter(
    (p) =>
      p.dateBound === "strict" &&
      (named ? named.includes(p.name) : p.engines.some((e) => engines.includes(e))),
  );
  const maxResults = opts.maxResults ?? 10;
  // Only the first provider call spends the caller's per-entity HTTP token; the
  // rest run unattributed so one bounded search is not throttled into nothing.
  const batches = await Promise.all(
    chosen.map((p, i) =>
      p
        .search(query, { ...opts, maxResults }, runtime, i === 0 ? entityId : undefined)
        .catch((): SearchResult[] => []),
    ),
  );
  // `before` is the hard guarantee (re-checked here); `after` is a relevance
  // hint each provider applies itself (an article revised long ago is still the
  // article as of the bound).
  return mergeResults(
    batches.map((b) => b.filter((r) => withinBound(r.published, opts.before))),
    maxResults,
  );
}

/** Interleave provider batches (one from each in turn), de-duplicated by URL. */
function mergeResults(batches: SearchResult[][], maxResults: number): SearchResult[] {
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  const longest = Math.max(0, ...batches.map((b) => b.length));
  for (let i = 0; i < longest; i++) {
    for (const batch of batches) {
      const result = batch[i];
      if (!result) continue;
      const key = result.url.toLowerCase().replace(/\/+$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(result);
    }
  }
  return results.slice(0, maxResults);
}

// ─── Search Orchestrator ────────────────────────────────────────────────────

/**
 * Execute a search across the best available providers for each detected engine.
 * Deduplicates results by URL. Returns merged results.
 */
export async function search(
  query: string,
  opts: SearchOpts,
  runtime: SearchHttp,
  entityId?: string,
): Promise<SearchResult[]> {
  const engines = opts.engines ?? detectIntent(query);
  const maxResults = opts.maxResults ?? 10;
  if (opts.before) {
    return boundedSearch(query, { ...opts, before: opts.before }, engines, runtime, entityId);
  }
  if (opts.providers?.length) {
    const named = opts.providers.map((n) => n.toLowerCase());
    ensureCorpusProviders(named);
    const batches = await Promise.all(
      providers
        .filter((p) => named.includes(p.name))
        .map((p, i) =>
          p
            .search(query, { engines, maxResults }, runtime, i === 0 ? entityId : undefined)
            .catch((): SearchResult[] => []),
        ),
    );
    return mergeResults(batches, maxResults);
  }

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

  // Date-bounded providers: always available, free, no keys; bounded searches only.
  import("./asof-providers").then((m) => {
    for (const p of m.dateBoundProviders()) registerProvider(p);
  });

  // Local corpora (offline BM25), named searches only.
  import("./corpus").then((m) => {
    for (const p of m.corpusProviders()) registerProvider(p);
  });
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

  const { dateBoundProviders } = require("./asof-providers");
  for (const p of dateBoundProviders() as SearchProvider[]) registerProvider(p);

  const { corpusProviders } = require("./corpus");
  for (const p of corpusProviders() as SearchProvider[]) registerProvider(p);
}

/**
 * Register `corpus:<name>` providers named in a search that were built after
 * startup (or never registered). Unknown names are left for the caller to
 * report as "no results".
 */
export function ensureCorpusProviders(names: readonly string[]): void {
  const missing = names.filter(
    (n) => n.startsWith("corpus:") && !providers.some((p) => p.name === n),
  );
  if (missing.length === 0) return;
  const { corpusProvider, isCorpusName, listCorpora } =
    require("./corpus") as typeof import("./corpus");
  const present = new Set(listCorpora().map((c) => c.name));
  for (const n of missing) {
    const name = n.slice("corpus:".length);
    if (isCorpusName(name) && present.has(name)) registerProvider(corpusProvider(name));
  }
}
