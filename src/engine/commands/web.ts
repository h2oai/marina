// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bold, dim, header, separator } from "../../net/ansi";
import type { CommandDef, Entity, EntityId, RoomContext } from "../../types";
import type { ConnectorRuntime } from "../connector-runtime";
import { extractReadableText } from "../html-text";
import { type ModifierSpec, parseModifiers } from "../parse-input";
import {
  initProvidersSync,
  search as providerSearch,
  type SearchResult,
} from "../search-providers/index";

/** `web search` modifiers: `engines:web,academic limit:5` (also `--engines web`). */
const WEB_SEARCH_SPEC: ModifierSpec = {
  engines: { type: "string", aliases: ["engine"] },
  limit: { type: "int", aliases: ["max"] },
};

export interface WebSearchArgs {
  query: string;
  engines?: string[];
  maxResults: number;
}

/**
 * Parse `web search` arguments. Only LEADING modifiers are consumed so a
 * query containing `engines:` or `limit:` as text survives; `--` ends
 * modifier parsing explicitly. Returns an error string for a bad modifier.
 */
export function parseWebSearchArgs(tokens: readonly string[]): WebSearchArgs | { error: string } {
  const mods = parseModifiers(tokens, WEB_SEARCH_SPEC, { leading: true });
  if (mods.errors.length > 0) return { error: mods.errors.join("; ") };
  const query = mods.rest.join(" ").trim();
  const engines =
    typeof mods.values.engines === "string"
      ? mods.values.engines
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean)
      : undefined;
  const limit = typeof mods.values.limit === "number" ? mods.values.limit : 10;
  return {
    query,
    ...(engines && engines.length > 0 ? { engines } : {}),
    maxResults: Math.min(Math.max(limit, 1), 25),
  };
}

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
  web search <query>                        — search the web (auto-detects academic/news/code)
  web search engines:web,academic <query>   — search specific engines only (also --engines web)
  web search limit:5 <query>                — cap results (default 10)
  web fetch <url>                           — fetch and extract text from a URL
  web multisearch <q1> | <q2>               — parallel multi-query search`,
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
  // `engines:web,academic` / `--engines web` (agent explicit control), `limit:N`.
  const parsed = parseWebSearchArgs(tokens);
  if ("error" in parsed) {
    ctx.send(eid, `${parsed.error}. Usage: web search [engines:<a,b>] [limit:N] <query>`);
    return;
  }
  const { query, engines, maxResults } = parsed;
  if (!query) {
    ctx.send(eid, "Usage: web search [engines:<a,b>] [limit:N] <query>");
    return;
  }

  const results = await providerSearch(query, { engines, maxResults }, runtime, eid);

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
