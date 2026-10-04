// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * SearXNG search provider — self-hosted meta-search engine.
 *
 * Requires SEARXNG_URL. Aggregates 150+ search engines (Google, Bing, DuckDuckGo,
 * arXiv, PubMed, Reddit, YouTube, etc.) with no API keys needed on the SearXNG side.
 *
 * Supports engine category selection for targeted search:
 *   web     → default engines
 *   academic → scholar, arxiv, pubmed
 *   news    → news engines (Google News, Bing News)
 *   social  → reddit
 *   code    → github
 */

import type { ConnectorRuntime } from "../connector-runtime";
import type { SearchOpts, SearchProvider, SearchResult } from "./index";

const ENGINE_MAP: Record<string, string> = {
  web: "",
  academic: "google scholar,arxiv,pubmed",
  news: "google news,bing news",
  social: "reddit",
  code: "github",
};

export function searxngProvider(baseUrl: string): SearchProvider {
  const url = baseUrl.replace(/\/+$/, "");

  return {
    name: "searxng",
    engines: ["web", "academic", "news", "social", "code"],

    async search(
      query: string,
      opts: SearchOpts,
      runtime: ConnectorRuntime,
      entityId?: string,
    ): Promise<SearchResult[]> {
      const max = opts.maxResults ?? 10;

      // Collect SearXNG engine names from requested engine categories
      const engineNames: string[] = [];
      for (const engine of opts.engines ?? ["web"]) {
        const mapped = ENGINE_MAP[engine];
        if (mapped !== undefined && mapped !== "") {
          engineNames.push(mapped);
        }
      }

      const params = new URLSearchParams({
        q: query,
        format: "json",
        pageno: "1",
      });

      if (engineNames.length > 0) {
        params.set("engines", engineNames.join(","));
      }

      const searchUrl = `${url}/search?${params.toString()}`;
      const result = await runtime.httpGet(searchUrl, entityId);

      // A failure throws so the orchestrator falls through to the next provider.
      if ("error" in result) throw new Error(`searxng: ${result.error}`);
      if (result.status !== 200) throw new Error(`searxng HTTP ${result.status}`);

      let data: SearxngResponse;
      try {
        data = JSON.parse(result.body) as SearxngResponse;
      } catch {
        throw new Error("searxng: unreadable reply");
      }

      return (data.results ?? []).slice(0, max).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: (r.content ?? "").slice(0, 500),
        source: `searxng:${r.engine ?? "unknown"}`,
        score: r.score,
        ...(isoInstant(r.publishedDate) ? { published: isoInstant(r.publishedDate) } : {}),
      }));
    },
  };
}

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  score?: number;
  publishedDate?: string | null;
}

/** An ISO instant from an engine's date, else undefined. */
function isoInstant(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

interface SearxngResponse {
  results?: SearxngResult[];
}
