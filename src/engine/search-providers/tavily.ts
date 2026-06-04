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
 */

import type { ConnectorRuntime } from "../connector-runtime";
import type { SearchOpts, SearchProvider, SearchResult } from "./index";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

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
      });

      const result = await runtime.httpPost(TAVILY_SEARCH_URL, body, entityId);

      if ("error" in result) return [];
      if (result.status !== 200) return [];

      let data: TavilyResponse;
      try {
        data = JSON.parse(result.body) as TavilyResponse;
      } catch {
        return [];
      }

      return (data.results ?? []).slice(0, max).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: (r.content ?? "").slice(0, 500),
        source: "tavily",
        score: r.score,
      }));
    },
  };
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

interface TavilyResponse {
  results?: TavilyResult[];
}
