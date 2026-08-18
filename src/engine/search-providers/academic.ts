// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Academic search provider — arXiv + Semantic Scholar.
 *
 * Free, no API keys needed. Auto-triggered when queries contain academic signals.
 *
 * - arXiv API: preprints in CS, physics, math, biology, etc.
 * - Semantic Scholar API: 200M+ papers, citation graphs, abstracts
 *
 * PubMed can be added later via the same pattern (NCBI E-utilities API, also free).
 */

import type { ConnectorRuntime } from "../connector-runtime";
import type { SearchOpts, SearchProvider, SearchResult } from "./index";

export function academicProvider(): SearchProvider {
  return {
    name: "academic",
    engines: ["academic"],

    async search(
      query: string,
      opts: SearchOpts,
      runtime: ConnectorRuntime,
      entityId?: string,
    ): Promise<SearchResult[]> {
      const max = opts.maxResults ?? 10;
      const perSource = Math.ceil(max / 2);

      // Search both in parallel
      const [arxivResults, scholarResults] = await Promise.all([
        searchArxiv(query, perSource, runtime, entityId).catch(() => [] as SearchResult[]),
        searchSemanticScholar(query, perSource, runtime, entityId).catch(
          () => [] as SearchResult[],
        ),
      ]);

      // Interleave results for diversity
      const results: SearchResult[] = [];
      const maxLen = Math.max(arxivResults.length, scholarResults.length);
      for (let i = 0; i < maxLen && results.length < max; i++) {
        const arxiv = arxivResults[i];
        const scholar = scholarResults[i];
        if (i < arxivResults.length && arxiv) results.push(arxiv);
        if (i < scholarResults.length && scholar && results.length < max) results.push(scholar);
      }

      return results;
    },
  };
}

// ─── arXiv ──────────────────────────────────────────────────────────────────

async function searchArxiv(
  query: string,
  maxResults: number,
  runtime: ConnectorRuntime,
  entityId?: string,
): Promise<SearchResult[]> {
  const searchTerms = query.replace(/[^\w\s]/g, " ").trim();
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(searchTerms)}&start=0&max_results=${maxResults}&sortBy=relevance`;

  const result = await runtime.httpGet(url, entityId);
  if ("error" in result || result.status !== 200) return [];

  return parseArxivXml(result.body, maxResults);
}

/** Parse arXiv Atom XML response into search results. */
function parseArxivXml(xml: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;

  while ((match = entryPattern.exec(xml)) !== null) {
    if (results.length >= maxResults) break;
    const entry = match[1] ?? "";

    const title = extractTag(entry, "title")?.replace(/\s+/g, " ").trim() ?? "";
    const summary = extractTag(entry, "summary")?.replace(/\s+/g, " ").trim() ?? "";
    const id = extractTag(entry, "id") ?? "";

    if (title && id) {
      const arxivUrl = id.replace("/api/", "/abs/").replace("http://", "https://");
      results.push({
        title: `[arXiv] ${title}`,
        url: arxivUrl,
        snippet: summary.slice(0, 400),
        source: "arxiv",
      });
    }
  }

  return results;
}

// ─── Semantic Scholar ───────────────────────────────────────────────────────

interface S2Paper {
  paperId?: string;
  title?: string;
  abstract?: string;
  url?: string;
  year?: number;
  citationCount?: number;
}

interface S2Response {
  data?: S2Paper[];
}

async function searchSemanticScholar(
  query: string,
  maxResults: number,
  runtime: ConnectorRuntime,
  entityId?: string,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    query,
    limit: String(maxResults),
    fields: "title,abstract,url,year,citationCount",
  });

  const url = `https://api.semanticscholar.org/graph/v1/paper/search?${params.toString()}`;
  const result = await runtime.httpGet(url, entityId);

  if ("error" in result || result.status !== 200) return [];

  let data: S2Response;
  try {
    data = JSON.parse(result.body) as S2Response;
  } catch {
    return [];
  }

  return (data.data ?? []).slice(0, maxResults).map((paper) => {
    const citations = paper.citationCount ? ` (${paper.citationCount} citations)` : "";
    const year = paper.year ? ` (${paper.year})` : "";
    return {
      title: `[Scholar] ${paper.title ?? "Untitled"}${year}`,
      url: paper.url ?? `https://api.semanticscholar.org/paper/${paper.paperId}`,
      snippet: paper.abstract ? `${paper.abstract.slice(0, 400)}${citations}` : citations,
      source: "semantic-scholar",
    };
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractTag(xml: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const match = pattern.exec(xml);
  return match ? match[1] : undefined;
}
