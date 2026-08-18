// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bold, dim, header, separator } from "../../net/ansi";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import type { ConnectorRuntime } from "../connector-runtime";
import {
  initProvidersSync,
  search as providerSearch,
  type SearchResult,
} from "../search-providers/index";

/**
 * Web command — safe outbound web access for entities and agents.
 *
 * Uses the pluggable search provider system:
 *   - Zero-config: DuckDuckGo (free, no key) + academic (arXiv, Semantic Scholar)
 *   - With keys: Tavily (AI-native) or SearXNG (150+ engines) auto-detected
 *   - Smart intent routing: academic/news/code/social auto-detected from query
 *   - Agents can override with --engines for explicit control
 *
 * Subcommands:
 *   web search <query>                — search with smart intent routing
 *   web search --engines web <query>  — search specific engines only (agent control)
 *   web fetch <url>                   — fetch a URL and return readable text
 *   web multisearch <q1> | <q2>       — parallel multi-query search (for agents)
 */

export function webCommand(deps: {
  getEntity: (id: string) => Entity | undefined;
  connectorRuntime?: ConnectorRuntime;
}): CommandDef {
  // Initialize search providers on first load
  initProvidersSync();

  return {
    name: "web",
    aliases: [],
    help: `Search the web or fetch a URL.
Usage:
  web search <query>                 — search the web (auto-detects academic/news/code)
  web search --engines web <query>   — search specific engines only
  web fetch <url>                    — fetch and extract text from a URL
  web multisearch <q1> | <q2>        — parallel multi-query search`,
    handler: async (ctx: RoomContext, input) => {
      const entity = deps.getEntity(input.entity);
      if (!entity) return;

      if (!deps.connectorRuntime) {
        ctx.send(input.entity, "Web access not available (no connector runtime).");
        return;
      }

      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();

      if (!sub) {
        ctx.send(input.entity, "Usage: web search <query> | web fetch <url>");
        return;
      }

      switch (sub) {
        case "search":
          return handleSearch(ctx, input.entity, tokens.slice(1), deps.connectorRuntime);
        case "fetch":
        case "read":
          return handleFetch(ctx, input.entity, tokens[1], deps.connectorRuntime);
        case "multisearch":
          return handleMultiSearch(
            ctx,
            input.entity,
            tokens.slice(1).join(" "),
            deps.connectorRuntime,
          );
        default:
          ctx.send(input.entity, "Usage: web search <query> | web fetch <url>");
      }
    },
  };
}

// ─── Search ─────────────────────────────────────────────────────────────────

async function handleSearch(
  ctx: RoomContext,
  eid: EntityId,
  tokens: string[],
  runtime: ConnectorRuntime,
): Promise<void> {
  // Parse --engines flag (for agent explicit control)
  let engines: string[] | undefined;
  let queryTokens = tokens;

  if (tokens[0] === "--engines" && tokens[1] && tokens.length > 2) {
    engines = tokens[1].split(",").map((e) => e.trim());
    queryTokens = tokens.slice(2);
  }

  const query = queryTokens.join(" ").trim();
  if (!query) {
    ctx.send(eid, "Usage: web search <query>");
    return;
  }

  const results = await providerSearch(query, { engines, maxResults: 10 }, runtime, eid);

  if (results.length === 0) {
    ctx.send(
      eid,
      `${header(`Search: ${query}`)}\n${separator()}\n${dim("No results found. Try a different query or use 'web fetch <url>' on a known URL.")}`,
    );
    return;
  }

  ctx.send(eid, formatSearchResults(query, results));
}

// ─── Multi-Search ───────────────────────────────────────────────────────────

async function handleMultiSearch(
  ctx: RoomContext,
  eid: EntityId,
  raw: string,
  runtime: ConnectorRuntime,
): Promise<void> {
  const queries = raw
    .split("|")
    .map((q) => q.trim())
    .filter(Boolean);

  if (queries.length === 0) {
    ctx.send(eid, "Usage: web multisearch <query1> | <query2> | <query3>");
    return;
  }

  // Execute all queries in parallel
  const allResults = await Promise.all(
    queries.map((q) =>
      providerSearch(q, { maxResults: 5 }, runtime, eid).catch(() => [] as SearchResult[]),
    ),
  );

  // Flatten and deduplicate by URL
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const batch of allResults) {
    for (const result of batch) {
      const key = result.url.toLowerCase().replace(/\/+$/, "");
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(result);
      }
    }
  }

  if (merged.length === 0) {
    ctx.send(eid, `${header("Multi-Search")}\n${separator()}\n${dim("No results found.")}`);
    return;
  }

  const lines: string[] = [
    header(`Multi-Search (${queries.length} queries, ${merged.length} results)`),
    separator(),
  ];

  for (let i = 0; i < Math.min(merged.length, 15); i++) {
    const r = merged[i]!;
    lines.push(`  ${bold(`[${i + 1}]`)} ${r.title}`);
    lines.push(`      ${dim(r.url)}`);
    if (r.snippet) {
      const snippet = r.snippet.length > 150 ? `${r.snippet.slice(0, 150)}...` : r.snippet;
      lines.push(`      ${snippet}`);
    }
    lines.push("");
  }

  ctx.send(eid, lines.join("\n"));
}

// ─── Fetch URL ──────────────────────────────────────────────────────────────

async function handleFetch(
  ctx: RoomContext,
  eid: EntityId,
  url: string | undefined,
  runtime: ConnectorRuntime,
): Promise<void> {
  if (!url?.trim()) {
    ctx.send(eid, "Usage: web fetch <url>");
    return;
  }

  const normalized = url.startsWith("http") ? url : `https://${url}`;
  const result = await runtime.httpGet(normalized, eid);

  if ("error" in result) {
    ctx.send(eid, `Fetch failed: ${result.error}`);
    return;
  }

  if (result.status !== 200) {
    ctx.send(eid, `Fetch failed (HTTP ${result.status}).`);
    return;
  }

  const extracted = extractReadableText(result.body);
  const maxLen = 8000;
  const truncated =
    extracted.text.length > maxLen
      ? `${extracted.text.slice(0, maxLen)}\n${dim("... (truncated)")}`
      : extracted.text;

  const meta: string[] = [];
  if (extracted.title) meta.push(`Title: ${extracted.title}`);
  if (extracted.wordCount > 0) meta.push(`${extracted.wordCount} words`);

  const lines = [
    header(`Fetched: ${normalized}`),
    separator(),
    ...(meta.length > 0 ? [dim(meta.join(" · ")), ""] : []),
    truncated,
  ];
  ctx.send(eid, lines.join("\n"));
}

// ─── Formatting ─────────────────────────────────────────────────────────────

function formatSearchResults(query: string, results: SearchResult[]): string {
  const lines: string[] = [header(`Search: ${query}`), separator()];

  // Group by source for clarity
  const sources = new Set(results.map((r) => r.source.split(":")[0]));
  if (sources.size > 1) {
    lines.push(dim(`Sources: ${Array.from(sources).join(", ")}`), "");
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    lines.push(`  ${bold(`[${i + 1}]`)} ${r.title}`);
    lines.push(`      ${dim(r.url)}`);
    if (r.snippet) {
      const snippet = r.snippet.length > 200 ? `${r.snippet.slice(0, 200)}...` : r.snippet;
      lines.push(`      ${snippet}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Readability Extraction ─────────────────────────────────────────────────

interface ExtractedContent {
  text: string;
  title?: string;
  wordCount: number;
}

/**
 * Extract readable text from HTML using content scoring.
 *
 * Scores text-dense blocks higher than navigation/boilerplate.
 * Inspired by Mozilla's Readability algorithm but lightweight.
 */
function extractReadableText(html: string): ExtractedContent {
  let text = html;

  // Extract title from <title> tag
  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1] ? titleMatch[1].replace(/\s+/g, " ").trim() : undefined;

  // Remove non-content blocks entirely
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, "\n");
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // Try to extract <article> or <main> content first (highest signal)
  const articleMatch = text.match(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i);
  if (articleMatch?.[1] && articleMatch[1].length > 200) {
    text = articleMatch[1];
  }

  // Convert headings to bold-like markers
  text = text.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n\n## $1\n\n");

  // Convert list items
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1");

  // Convert block elements to newlines
  text = text.replace(/<\/?(p|div|br|tr|blockquote|section|article)[^>]*>/gi, "\n");

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  text = decodeEntities(text);

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");

  text = text.trim();

  const wordCount = text.split(/\s+/).filter(Boolean).length;

  return { text, title, wordCount };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number.parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)));
}
