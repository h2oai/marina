// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Retrieval for the research agent. A `Retriever` turns a brief into a dated,
 * cited research report — facts only, no forecast. The first backend is
 * OpenRouter's web plugin (server-side search with URL citations), called over
 * the SSRF guard; others (Marina's Tavily / SearXNG search, a hosted research
 * API) plug in behind the same interface.
 */

import { guardedFetch } from "../../net/url-guard";
import type { ResearchBrief } from "./briefs";

export interface Source {
  url: string;
  title?: string;
}

export interface ResearchReport {
  report: string;
  sources: Source[];
  costUsd: number;
  searches: number;
  retriever: string;
}

export type Retriever = (brief: ResearchBrief) => Promise<ResearchReport>;

const SYSTEM =
  "You are a research assistant for a forecaster. Search the web and report only dated, sourced facts that answer the request. Cite every fact. Never forecast.";

export interface OpenRouterWebOptions {
  model: string;
  apiKey: string;
  maxResults?: number;
  maxTokens?: number;
  timeoutMs?: number;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}

/** Research through OpenRouter's `web` plugin with a search-grounded model. */
export function openRouterWebRetriever(opts: OpenRouterWebOptions): Retriever {
  const fetcher =
    opts.fetcher ??
    ((url: string, init: RequestInit) =>
      guardedFetch(
        url,
        { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 240_000) },
        { maxHops: 0 },
      ));
  return async (brief) => {
    const res = await fetcher("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: brief.request },
        ],
        plugins: [{ id: "web", max_results: opts.maxResults ?? 8 }],
        // Reasoning models otherwise spend the whole budget thinking and return nothing.
        reasoning: { effort: "low" },
        max_completion_tokens: opts.maxTokens ?? 5_000,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`research retrieval HTTP ${res.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text) as {
      choices?: Array<{
        message?: {
          content?: string;
          annotations?: Array<{ url_citation?: { url?: string; title?: string } }>;
        };
      }>;
      usage?: { cost?: number; server_tool_use_details?: { web_search_requests?: number } };
    };
    const message = data.choices?.[0]?.message;
    const report = (message?.content ?? "").trim();
    if (!report) throw new Error("research retrieval returned an empty report");
    const seen = new Set<string>();
    const sources: Source[] = [];
    for (const a of message?.annotations ?? []) {
      const url = a.url_citation?.url;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      sources.push({ url, ...(a.url_citation?.title ? { title: a.url_citation.title } : {}) });
    }
    return {
      report,
      sources,
      costUsd: data.usage?.cost ?? 0,
      searches: data.usage?.server_tool_use_details?.web_search_requests ?? 0,
      retriever: `openrouter-web:${opts.model}`,
    };
  };
}
