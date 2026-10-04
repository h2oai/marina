// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tavily search provider — AI-native, highest quality.
 *
 * Requires TAVILY_API_KEY. Purpose-built for LLM applications:
 * - Returns LLM-optimized snippets
 * - 20 sites per call
 * - Prompt injection protection
 * - 1000 free searches/month
 *
 * Docs: https://docs.tavily.com
 *
 * A failed call (no credit left — HTTP 432 —, a bad key, an outage) THROWS, so
 * the orchestrator falls through to the next provider for the engine and the
 * failure is visible in `readiness`; it never turns into "No results found".
 * Each call is priced into the daily spend ledger (source `search`) and refused
 * once the daily cap is reached (the next provider then answers for free).
 */

import type { ConnectorRuntime } from "../connector-runtime";
import { dailyCapRefusal, recordSpend } from "../spend-ledger";
import type { SearchOpts, SearchProvider, SearchResult } from "./index";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
/**
 * Tavily's pay-as-you-go list price per API credit (basic search = 1 credit,
 * advanced = 2; https://docs.tavily.com/documentation/api-credits). An
 * estimate — plans with bundled credits cost less per credit.
 */
export const TAVILY_USD_PER_CREDIT = 0.008;

export function tavilyProvider(apiKey: string): SearchProvider {
  return {
    name: "tavily",
    engines: ["web", "news"],

    async search(
      query: string,
      opts: SearchOpts,
      runtime: ConnectorRuntime,
      entityId?: string,
    ): Promise<SearchResult[]> {
      const max = opts.maxResults ?? 10;
      const includeNews = opts.engines?.includes("news") ?? false;

      const body = JSON.stringify({
        api_key: apiKey,
        query,
        max_results: max,
        search_depth: "basic",
        include_answer: false,
        topic: includeNews ? "news" : "general",
        include_usage: true,
      });

      const capped = dailyCapRefusal();
      if (capped) throw new Error(`tavily: ${capped}`);
      const result = await runtime.httpPost(TAVILY_SEARCH_URL, body, entityId);

      if ("error" in result) throw new Error(`tavily: ${result.error}`);
      if (result.status !== 200) {
        throw new Error(`tavily HTTP ${result.status}: ${result.body.slice(0, 160)}`);
      }

      let data: TavilyResponse;
      try {
        data = JSON.parse(result.body) as TavilyResponse;
      } catch {
        throw new Error("tavily: unreadable reply");
      }
      const usd = (data.usage?.credits ?? 1) * TAVILY_USD_PER_CREDIT;
      recordSpend("search", usd);
      if (opts.spend) opts.spend.usd += usd;

      return (data.results ?? []).slice(0, max).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: (r.content ?? "").slice(0, 500),
        source: "tavily",
        score: r.score,
        ...(isoInstant(r.published_date) ? { published: isoInstant(r.published_date) } : {}),
      }));
    },
  };
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  published_date?: string;
}

/** An ISO instant from Tavily's `published_date` (RFC 1123 or ISO), else undefined. */
function isoInstant(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

interface TavilyResponse {
  results?: TavilyResult[];
  usage?: { credits?: number };
}
