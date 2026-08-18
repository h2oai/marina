// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * DuckDuckGo search provider — zero-config default.
 *
 * Uses DDG's HTML lite endpoint for actual web search results (titles, URLs, snippets),
 * not just the instant answers API which only returns Wikipedia summaries.
 *
 * Falls back to the instant answers API if HTML parsing fails.
 *
 * Free, no API key needed.
 */

import type { ConnectorRuntime } from "../connector-runtime";
import type { SearchOpts, SearchProvider, SearchResult } from "./index";

export function duckDuckGoProvider(): SearchProvider {
  return {
    name: "duckduckgo",
    engines: ["web", "news"],

    async search(
      query: string,
      opts: SearchOpts,
      runtime: ConnectorRuntime,
      entityId?: string,
    ): Promise<SearchResult[]> {
      const max = opts.maxResults ?? 10;
      const results = await ddgHtmlSearch(query, max, runtime, entityId);
      if (results.length > 0) return results;

      // Fallback: instant answers API (less useful but very reliable)
      return ddgInstantAnswers(query, max, runtime, entityId);
    },
  };
}

// ─── HTML Search (primary) ──────────────────────────────────────────────────

/**
 * Search DDG via the lite HTML endpoint.
 * Parses result titles, URLs, and snippets from the HTML response.
 */
async function ddgHtmlSearch(
  query: string,
  maxResults: number,
  runtime: ConnectorRuntime,
  entityId?: string,
): Promise<SearchResult[]> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const result = await runtime.httpGet(url, entityId);

  if ("error" in result || result.status !== 200) return [];

  return parseHtmlResults(result.body, maxResults);
}

/**
 * Parse search results from DDG lite HTML.
 *
 * The lite page has a table structure with result rows containing:
 * - Link cell: <a rel="nofollow" href="URL" class="result-link">Title</a>
 * - Snippet cell: <td class="result-snippet">...</td>
 */
function parseHtmlResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // DDG lite mixes `class='result-link'` (single quotes) with `href="..."`
  // (double quotes), and the attribute ORDER varies: sometimes href comes
  // before class, sometimes after. Match any <a> tag containing
  // class=(['"])result-link\1 anywhere, then pull href from the whole tag.
  const anchorPattern = /<a([^>]+)>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;

  const links: Array<{ url: string; title: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = anchorPattern.exec(html)) !== null) {
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    // Only anchors marked as result-link (quote style tolerant)
    if (!/class=['"]result-link['"]/i.test(attrs)) continue;
    const hrefMatch = attrs.match(/href=['"]([^'"]+)['"]/i);
    if (!hrefMatch?.[1]) continue;
    const rawUrl = hrefMatch[1];
    const title = stripTags(inner).trim();
    if (!title) continue;
    const actualUrl = extractDdgUrl(rawUrl);
    if (actualUrl && !actualUrl.includes("duckduckgo.com")) {
      links.push({ url: actualUrl, title });
    }
  }

  const snippets: string[] = [];
  while ((match = snippetPattern.exec(html)) !== null) {
    snippets.push(stripTags(match[1] ?? "").trim());
  }

  for (let i = 0; i < Math.min(links.length, maxResults); i++) {
    const link = links[i];
    if (!link) continue;
    results.push({
      title: link.title,
      url: link.url,
      snippet: snippets[i] ?? "",
      source: "duckduckgo",
    });
  }

  return results;
}

/** Extract actual URL from DDG redirect URL or return as-is if already direct. */
function extractDdgUrl(href: string): string | undefined {
  // DDG lite uses //duckduckgo.com/l/?uddg=<encoded_url>
  if (href.includes("uddg=")) {
    const match = href.match(/uddg=([^&]+)/);
    if (match?.[1]) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return undefined;
      }
    }
  }
  // Direct URL
  if (href.startsWith("http")) return href;
  if (href.startsWith("//")) return `https:${href}`;
  return undefined;
}

// ─── Instant Answers (fallback) ─────────────────────────────────────────────

interface DdgInstantResult {
  Abstract?: string;
  AbstractText?: string;
  AbstractSource?: string;
  AbstractURL?: string;
  Answer?: string;
  RelatedTopics?: Array<{
    Text?: string;
    FirstURL?: string;
    Topics?: Array<{ Text?: string; FirstURL?: string }>;
  }>;
}

async function ddgInstantAnswers(
  query: string,
  maxResults: number,
  runtime: ConnectorRuntime,
  entityId?: string,
): Promise<SearchResult[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const result = await runtime.httpGet(url, entityId);

  if ("error" in result || result.status !== 200) return [];

  let data: DdgInstantResult;
  try {
    data = JSON.parse(result.body) as DdgInstantResult;
  } catch {
    return [];
  }

  const results: SearchResult[] = [];

  if (data.AbstractText && data.AbstractURL) {
    results.push({
      title: data.AbstractSource ?? "Wikipedia",
      url: data.AbstractURL,
      snippet: data.AbstractText.slice(0, 300),
      source: "duckduckgo",
    });
  }

  if (data.RelatedTopics) {
    for (const topic of data.RelatedTopics) {
      if (results.length >= maxResults) break;
      if (topic.Text && topic.FirstURL) {
        results.push({
          title: topic.Text.slice(0, 100),
          url: topic.FirstURL,
          snippet: topic.Text.slice(0, 300),
          source: "duckduckgo",
        });
      }
      if (topic.Topics) {
        for (const sub of topic.Topics) {
          if (results.length >= maxResults) break;
          if (sub.Text && sub.FirstURL) {
            results.push({
              title: sub.Text.slice(0, 100),
              url: sub.FirstURL,
              snippet: sub.Text.slice(0, 300),
              source: "duckduckgo",
            });
          }
        }
      }
    }
  }

  return results.slice(0, maxResults);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
