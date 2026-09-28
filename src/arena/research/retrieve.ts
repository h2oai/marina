// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Retrieval for the research agent. A `Retriever` turns a brief into a dated,
 * cited research report — facts only, no forecast. Backends, all called over
 * the SSRF guard through OpenRouter:
 *   - `openrouter-web:<model>` — any model with OpenRouter's `web` plugin;
 *   - `sonar:<perplexity model>` — Perplexity Sonar, which searches natively
 *     (sonar, sonar-pro, sonar-pro-search, sonar-reasoning-pro,
 *     sonar-deep-research); citations arrive as the same `url_citation`
 *     annotations.
 * `retrieverFromSpec` accepts a comma-separated list and merges the reports
 * (every source kept, costs summed), so several engines can research one brief.
 */

import { dailyCapRefusal, recordSpend } from "../../engine/spend-ledger";
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
  /** The model searches by itself (Perplexity Sonar): no `web` plugin, no reasoning knob. */
  nativeSearch?: boolean;
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
    const capped = dailyCapRefusal();
    if (capped) throw new Error(capped);
    const res = await fetcher("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: brief.request },
        ],
        ...(opts.nativeSearch
          ? {}
          : {
              plugins: [{ id: "web", max_results: opts.maxResults ?? 8 }],
              // Reasoning models otherwise spend the whole budget thinking and return nothing.
              reasoning: { effort: "low" },
            }),
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
    const raw = (message?.content ?? "").trim();
    // Sonar cites with numbered footnotes ("…35%.[11]"), the n-th url_citation.
    // Inline them as markdown links so the verifier can fetch and check each line.
    const report = opts.nativeSearch ? inlineFootnotes(raw, message?.annotations ?? []) : raw;
    if (!report) throw new Error("research retrieval returned an empty report");
    const seen = new Set<string>();
    const sources: Source[] = [];
    for (const a of message?.annotations ?? []) {
      const url = a.url_citation?.url;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      sources.push({ url, ...(a.url_citation?.title ? { title: a.url_citation.title } : {}) });
    }
    recordSpend("forecast", data.usage?.cost);
    return {
      report,
      sources,
      costUsd: data.usage?.cost ?? 0,
      searches: data.usage?.server_tool_use_details?.web_search_requests ?? 0,
      retriever: `${opts.nativeSearch ? "sonar" : "openrouter-web"}:${opts.model}`,
    };
  };
}

/**
 * `[n]` footnote markers → `[n](url)`, where url is the n-th (1-based) citation.
 * Markers with no matching citation, and markers already followed by a link,
 * are left alone.
 */
export function inlineFootnotes(
  text: string,
  annotations: Array<{ url_citation?: { url?: string } }>,
): string {
  const urls = annotations.map((a) => a.url_citation?.url);
  return text.replace(/\[(\d{1,3})\](?!\()/g, (marker, n: string) => {
    const url = urls[Number(n) - 1];
    return url && /^https?:\/\//.test(url) ? `[${n}](${url})` : marker;
  });
}

/** Perplexity Sonar through OpenRouter (native search, url_citation annotations). */
export function sonarRetriever(opts: Omit<OpenRouterWebOptions, "nativeSearch">): Retriever {
  const model = opts.model.includes("/") ? opts.model : `perplexity/${opts.model}`;
  // Deep research runs many searches; give it room to finish.
  const slow = /deep-research/.test(model);
  return openRouterWebRetriever({
    ...opts,
    model,
    nativeSearch: true,
    ...(slow ? { timeoutMs: opts.timeoutMs ?? 600_000, maxTokens: opts.maxTokens ?? 8_000 } : {}),
  });
}

/**
 * Several retrievers on one brief, in parallel. Each engine's report is kept
 * under its own heading (so the verifier and analysts can see which engine
 * said what); sources are the de-duplicated union; costs and searches add up.
 * One engine failing does not sink the others; all failing throws.
 */
export function combineRetrievers(retrievers: Retriever[]): Retriever {
  if (retrievers.length === 1) return retrievers[0]!;
  return async (brief) => {
    const settled = await Promise.allSettled(retrievers.map((r) => r(brief)));
    const ok = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    if (ok.length === 0) {
      const why = settled.map((s) => (s.status === "rejected" ? String(s.reason) : "")).join("; ");
      throw new Error(`every research retriever failed: ${why.slice(0, 400)}`);
    }
    const seen = new Set<string>();
    const sources: Source[] = [];
    for (const r of ok) {
      for (const src of r.sources) {
        if (seen.has(src.url)) continue;
        seen.add(src.url);
        sources.push(src);
      }
    }
    return {
      report: ok.map((r) => `## ${r.retriever}\n${r.report}`).join("\n\n"),
      sources,
      costUsd: ok.reduce((sum, r) => sum + r.costUsd, 0),
      searches: ok.reduce((sum, r) => sum + r.searches, 0),
      retriever: ok.map((r) => r.retriever).join("+"),
    };
  };
}

/**
 * `MARINA_ARENA_RESEARCH_RETRIEVER`: one or more of `openrouter-web:<model>`
 * and `sonar:<perplexity model>`, comma-separated.
 */
export function retrieverFromSpec(spec: string, apiKey: string): Retriever {
  const parts = spec
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error("empty MARINA_ARENA_RESEARCH_RETRIEVER");
  return combineRetrievers(
    parts.map((part) => {
      const [kind, ...rest] = part.split(":");
      const model = rest.join(":");
      if (!model) throw new Error(`MARINA_ARENA_RESEARCH_RETRIEVER entry "${part}" names no model`);
      if (kind === "openrouter-web") return openRouterWebRetriever({ model, apiKey });
      if (kind === "sonar") return sonarRetriever({ model, apiKey });
      throw new Error(
        `unknown MARINA_ARENA_RESEARCH_RETRIEVER entry "${part}" (openrouter-web:<model> or sonar:<model>)`,
      );
    }),
  );
}
