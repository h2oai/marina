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
 *     annotations;
 *   - `tavily:<basic|advanced>` — Tavily's search API called directly (one
 *     query per brief search term, news since the brief's date). No model
 *     writes the report: each result becomes one dated line quoting Tavily's
 *     snippet, and the page text Tavily fetched rides on the `Source` so the
 *     citation check can read it without fetching the page itself.
 *   - `asof[:<provider>+<provider>…]` — date-STRICT, keyless engines (GDELT
 *     news, Wikipedia revisions, Hacker News, arXiv; Wayback for page text),
 *     bounded to the brief's cutoff instant. Every source is re-checked and
 *     nothing published after the cutoff is reported; news hits are read from
 *     the Wayback capture at or before the cutoff. Such a retriever carries
 *     `dateStrict: true`, and `retrieverFromSpec(…, { requireDateStrict })`
 *     refuses any spec that mixes in an unfiltered engine.
 * `retrieverFromSpec` accepts a comma-separated list and merges the reports
 * (every source kept, costs summed), so several engines can research one brief.
 */

import { standaloneSearchHttp } from "../../engine/search-providers/asof-http";
import {
  DATE_BOUND_PROVIDER_NAMES,
  dateBoundProvider,
} from "../../engine/search-providers/asof-providers";
import {
  type SearchHttp,
  type SearchResult,
  withinBound,
} from "../../engine/search-providers/index";
import { waybackFetch } from "../../engine/search-providers/wayback";
import { dailyCapRefusal, recordSpend } from "../../engine/spend-ledger";
import { guardedFetch } from "../../net/url-guard";
import type { ResearchBrief } from "./briefs";
import { fetchAllowed, type PageText } from "./verify";

export interface Source {
  url: string;
  title?: string;
  /** ISO date the page was published, when the engine reports one. */
  published?: string;
  /**
   * The page's text as the search engine fetched it. The citation check reads
   * it instead of fetching the page (bot walls, timeouts, huge pages) — never
   * for a `NO_FETCH_DOMAINS` publisher. `withProvidedText` strips it before a
   * report is stored.
   */
  text?: string;
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
  const strict = retrievers.every((r) => isDateStrict(r));
  const combined: Retriever = async (brief) => {
    const settled = await Promise.allSettled(retrievers.map((r) => r(brief)));
    const ok = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    if (ok.length === 0) {
      const why = settled.map((s) => (s.status === "rejected" ? String(s.reason) : "")).join("; ");
      throw new Error(`every research retriever failed: ${why.slice(0, 400)}`);
    }
    const byUrl = new Map<string, Source>();
    for (const r of ok) {
      for (const src of r.sources) {
        const had = byUrl.get(src.url);
        if (!had) byUrl.set(src.url, src);
        // Another engine cited the same page and also carries its text: keep it.
        else if (!had.text && src.text) byUrl.set(src.url, { ...had, text: src.text });
      }
    }
    const sources = [...byUrl.values()];
    return {
      report: ok.map((r) => `## ${r.retriever}\n${r.report}`).join("\n\n"),
      sources,
      costUsd: ok.reduce((sum, r) => sum + r.costUsd, 0),
      searches: ok.reduce((sum, r) => sum + r.searches, 0),
      retriever: ok.map((r) => r.retriever).join("+"),
    };
  };
  return strict ? Object.assign(combined, { dateStrict: true as const }) : combined;
}

// ─── Tavily ──────────────────────────────────────────────────────────────────

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
/**
 * Tavily's pay-as-you-go list price per API credit (basic search = 1 credit,
 * advanced = 2; https://docs.tavily.com/documentation/api-credits). An
 * estimate — plans with bundled credits cost less per credit.
 */
export const TAVILY_USD_PER_CREDIT = 0.008;
/** Result lines kept per brief (best-scored first), across all its queries. */
const TAVILY_MAX_LINES = 12;
/** Longest snippet quoted in a report line. */
const TAVILY_SNIPPET_CHARS = 500;
/** Most page text carried per source for the citation check. */
const TAVILY_MAX_TEXT_CHARS = 1_000_000;
/** Tavily rejects queries over 400 characters. */
const TAVILY_MAX_QUERY_CHARS = 400;

export type TavilyDepth = "basic" | "advanced";

export interface TavilyOptions {
  depth: TavilyDepth;
  apiKey: string;
  /** Results per query (default 8). */
  maxResults?: number;
  timeoutMs?: number;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}

interface TavilyResult {
  url?: string;
  title?: string;
  content?: string;
  score?: number;
  published_date?: string;
  raw_content?: string | null;
}

/** An ISO date from Tavily's `published_date` (RFC 1123 or ISO), else undefined. */
function isoDay(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined;
}

/**
 * A snippet safe to put on one report line: whitespace collapsed, markdown
 * links reduced to their text and stray brackets dropped (so the verifier only
 * sees the one citation we add), cut at a word boundary so no number is
 * truncated into a different one.
 */
export function tavilySnippet(content: string, max = TAVILY_SNIPPET_CHARS): string {
  let s = content
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) {
    const cut = s.lastIndexOf(" ", max);
    s = `${s.slice(0, cut > max / 2 ? cut : max)}…`;
  }
  return s;
}

function linkTitle(title: string): string {
  return title.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim() || "source";
}

/**
 * Tavily search, one request per `brief.queries` entry (else the brief's
 * opening line), news published since `brief.since`, with each page's raw
 * text. The report is one line per result:
 *   `- <date> — <snippet> [<title>](<url>)`
 * Results dated before `since` (or after `until`) are dropped; `NO_FETCH_DOMAINS` pages keep their
 * line but never carry page text.
 */
export function tavilyRetriever(opts: TavilyOptions): Retriever {
  const fetcher =
    opts.fetcher ??
    ((url: string, init: RequestInit) =>
      guardedFetch(
        url,
        { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) },
        { maxHops: 0 },
      ));
  return async (brief) => {
    const capped = dailyCapRefusal();
    if (capped) throw new Error(capped);
    const queries = (brief.queries?.length ? brief.queries : [brief.request.split("\n")[0] ?? ""])
      .map((q) => q.trim().slice(0, TAVILY_MAX_QUERY_CHARS))
      .filter(Boolean);
    if (queries.length === 0) throw new Error("tavily retrieval: the brief has no query");
    const settled = await Promise.allSettled(
      queries.map(async (query) => {
        const res = await fetcher(TAVILY_SEARCH_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            query,
            topic: "news",
            search_depth: opts.depth,
            max_results: opts.maxResults ?? 8,
            start_date: brief.since,
            ...(brief.until ? { end_date: brief.until } : {}),
            include_answer: false,
            include_raw_content: "text",
            include_usage: true,
          }),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`tavily HTTP ${res.status}: ${text.slice(0, 200)}`);
        return JSON.parse(text) as { results?: TavilyResult[]; usage?: { credits?: number } };
      }),
    );
    const ok = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    const perCall = opts.depth === "advanced" ? 2 : 1;
    const credits = ok.reduce((sum, d) => sum + (d.usage?.credits ?? perCall), 0);
    const costUsd = credits * TAVILY_USD_PER_CREDIT;
    recordSpend("forecast", costUsd);
    if (ok.length === 0) {
      const why = settled.map((s) => (s.status === "rejected" ? String(s.reason) : "")).join("; ");
      throw new Error(`tavily retrieval failed: ${why.slice(0, 400)}`);
    }
    const best = new Map<string, TavilyResult>();
    for (const d of ok) {
      for (const r of d.results ?? []) {
        if (!r.url || !/^https?:\/\//.test(r.url) || !r.content) continue;
        const day = isoDay(r.published_date);
        if (day && day < brief.since) continue;
        if (day && brief.until && day > brief.until) continue;
        const had = best.get(r.url);
        if (!had || (r.score ?? 0) > (had.score ?? 0)) best.set(r.url, r);
      }
    }
    const kept = [...best.values()]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, TAVILY_MAX_LINES);
    const lines: string[] = [];
    const sources: Source[] = [];
    for (const r of kept) {
      const url = r.url!;
      const day = isoDay(r.published_date);
      const title = r.title?.trim();
      lines.push(
        `- ${day ?? "undated"} — ${tavilySnippet(r.content!)} [${linkTitle(title ?? "")}](${url})`,
      );
      const text = fetchAllowed(url) ? r.raw_content?.slice(0, TAVILY_MAX_TEXT_CHARS) : undefined;
      sources.push({
        url,
        ...(title ? { title } : {}),
        ...(day ? { published: day } : {}),
        ...(text ? { text } : {}),
      });
    }
    return {
      report: lines.length ? lines.join("\n") : `Nothing found published since ${brief.since}.`,
      sources,
      costUsd,
      searches: ok.length,
      retriever: `tavily:${opts.depth}`,
    };
  };
}

// ─── Date-strict (as-of) retrieval ───────────────────────────────────────────

/** A retriever whose every source is published at or before the brief's cutoff. */
export type DateStrictRetriever = Retriever & { readonly dateStrict: true };

/** Search engines in a bare `asof` spec (Wayback is the page reader, not a search engine). */
const ASOF_SEARCH_DEFAULT = ["gdelt", "wikipedia", "hn", "arxiv"] as const;
/** News hits read from their Wayback capture, per brief. */
const ASOF_ENRICH = 4;
/** Queries searched per brief. */
const ASOF_MAX_QUERIES = 4;

/**
 * The instant a date-strict engine may not go past: the brief's exact cutoff,
 * else the START of its `until` day (never later), else now — and never after
 * now.
 */
export function asOfBound(
  brief: Pick<ResearchBrief, "until" | "untilAt">,
  now: Date = new Date(),
): string {
  const nowMs = now.getTime();
  const at = brief.untilAt ? Date.parse(brief.untilAt) : Number.NaN;
  if (Number.isFinite(at)) return new Date(Math.min(at, nowMs)).toISOString();
  const day = brief.until ? Date.parse(`${brief.until.slice(0, 10)}T00:00:00.000Z`) : Number.NaN;
  if (Number.isFinite(day)) return new Date(Math.min(day, nowMs)).toISOString();
  return now.toISOString();
}

export interface AsOfRetrieverOptions {
  /** Providers (default gdelt, wikipedia, hn, arxiv, wayback). `wayback` turns page reading on. */
  providers?: string[];
  http?: SearchHttp;
  /** Results per provider per query (default 5). */
  perQuery?: number;
  now?: () => Date;
}

/**
 * Keyless, date-strict research: each brief query goes to every listed
 * provider bounded to `asOfBound(brief)`; results are re-checked against the
 * bound, de-duplicated, and news hits are read from their Wayback capture at or
 * before the bound (the cited URL is that capture, so the citation check reads
 * the same as-of text). Free: no spend is recorded.
 */
export function asOfRetriever(opts: AsOfRetrieverOptions = {}): DateStrictRetriever {
  const names = opts.providers?.length ? opts.providers : [...ASOF_SEARCH_DEFAULT, "wayback"];
  for (const n of names) {
    if (!(DATE_BOUND_PROVIDER_NAMES as readonly string[]).includes(n)) {
      throw new Error(`unknown asof provider "${n}" (${DATE_BOUND_PROVIDER_NAMES.join(", ")})`);
    }
  }
  const readPages = names.includes("wayback");
  const searchers = names
    .filter((n) => n !== "wayback")
    .flatMap((n) => {
      const p = dateBoundProvider(n);
      return p ? [p] : [];
    });
  if (searchers.length === 0) {
    throw new Error("an asof retriever needs at least one search provider");
  }
  const http = opts.http ?? standaloneSearchHttp();
  const perQuery = opts.perQuery ?? 5;
  const label = `asof:${names.join("+")}`;
  const retriever = async (brief: ResearchBrief): Promise<ResearchReport> => {
    const bound = asOfBound(brief, opts.now?.() ?? new Date());
    const after = brief.since ? `${brief.since.slice(0, 10)}T00:00:00.000Z` : undefined;
    const queries = (brief.queries?.length ? brief.queries : [brief.request.split("\n")[0] ?? ""])
      .map((q) => q.trim())
      .filter(Boolean)
      .slice(0, ASOF_MAX_QUERIES);
    if (queries.length === 0) throw new Error("asof retrieval: the brief has no query");
    const calls = searchers.flatMap((p) =>
      queries.map((q) =>
        p.search(q, { before: bound, ...(after ? { after } : {}), maxResults: perQuery }, http),
      ),
    );
    const settled = await Promise.allSettled(calls);
    const byUrl = new Map<string, SearchResult>();
    for (const r of settled.flatMap((x) => (x.status === "fulfilled" ? x.value : []))) {
      // The hard guarantee, whatever a provider returned.
      if (!withinBound(r.published, bound)) continue;
      const key = r.url.toLowerCase().replace(/\/+$/, "");
      if (!byUrl.has(key)) byUrl.set(key, r);
    }
    let kept = [...byUrl.values()];
    if (readPages) {
      const toRead = new Set(
        kept
          .filter((r) => !r.text && r.source === "gdelt")
          .slice(0, ASOF_ENRICH)
          .map((r) => r.url),
      );
      kept = await Promise.all(
        kept.map(async (r) => {
          if (!toRead.has(r.url)) return r;
          const page = await waybackFetch(http, r.url, bound).catch(() => undefined);
          if (!page?.text || !withinBound(page.at, bound)) return r;
          return {
            ...r,
            url: page.replayUrl,
            snippet: tavilySnippet(page.text),
            text: page.text.slice(0, TAVILY_MAX_TEXT_CHARS),
          };
        }),
      );
    }
    kept.sort((a, b) => Date.parse(b.published ?? "") - Date.parse(a.published ?? ""));
    const lines: string[] = [];
    const sources: Source[] = [];
    for (const r of kept.slice(0, TAVILY_MAX_LINES * 2)) {
      const day = (r.published ?? "").slice(0, 10);
      lines.push(
        `- ${day} — ${tavilySnippet(r.snippet || r.title)} [${linkTitle(r.title)}](${r.url})`,
      );
      const text =
        r.text && fetchAllowed(r.url) ? r.text.slice(0, TAVILY_MAX_TEXT_CHARS) : undefined;
      sources.push({
        url: r.url,
        ...(r.title ? { title: r.title } : {}),
        ...(day ? { published: day } : {}),
        ...(text ? { text } : {}),
      });
    }
    return {
      report: lines.length
        ? lines.join("\n")
        : `Nothing found published between ${brief.since} and ${bound}.`,
      sources,
      costUsd: 0,
      searches: calls.length,
      retriever: label,
    };
  };
  return Object.assign(retriever, { dateStrict: true as const });
}

/** True when the retriever (or every engine it combines) is date-strict. */
export function isDateStrict(r: Retriever): r is DateStrictRetriever {
  return (r as Partial<DateStrictRetriever>).dateStrict === true;
}

// ─── Provided page text for the citation check ───────────────────────────────

/** Page texts remembered between retrieval and verification (most recent kept). */
const PROVIDED_TEXT_ENTRIES = 256;

/**
 * Wire a retriever's page texts into the citation check without storing them:
 * the returned retriever moves each `Source.text` into a bounded cache (the
 * sources it returns carry no text, so shadow records stay small) and the
 * returned `pageText` answers from that cache before fetching. The verifier
 * still never reads — provided or fetched — a `NO_FETCH_DOMAINS` page.
 */
export function withProvidedText(
  retriever: Retriever,
  fetchPage: PageText,
): { retriever: Retriever; pageText: PageText } {
  const texts = new Map<string, string>();
  const provided = (url: string) => (fetchAllowed(url) ? texts.get(url) : undefined);
  const pageText: PageText = Object.assign(
    async (url: string) =>
      fetchAllowed(url) ? (provided(url) ?? (await fetchPage(url))) : undefined,
    { provided },
  );
  return {
    pageText,
    retriever: async (brief) => {
      const r = await retriever(brief);
      return {
        ...r,
        sources: r.sources.map(({ text, ...src }) => {
          if (text && fetchAllowed(src.url)) {
            texts.delete(src.url);
            texts.set(src.url, text);
            while (texts.size > PROVIDED_TEXT_ENTRIES) texts.delete(texts.keys().next().value!);
          }
          return src;
        }),
      };
    },
  };
}

// ─── Spec ────────────────────────────────────────────────────────────────────

export interface RetrieverKeys {
  /** OPENROUTER_API_KEY — `openrouter-web:` and `sonar:`. */
  openrouter?: string;
  /** TAVILY_API_KEY — `tavily:`. */
  tavily?: string;
}

/**
 * `MARINA_ARENA_RESEARCH_RETRIEVER`: one or more of `openrouter-web:<model>`,
 * `sonar:<perplexity model>` and `tavily:<basic|advanced>`, comma-separated.
 * `keys` may be the OpenRouter key alone (the older signature).
 */
export function retrieverFromSpec(
  spec: string,
  keys: string | RetrieverKeys,
  opts: { requireDateStrict?: boolean; http?: SearchHttp } = {},
): Retriever {
  const k: RetrieverKeys = typeof keys === "string" ? { openrouter: keys } : keys;
  const parts = specParts(spec);
  if (parts.length === 0) throw new Error("empty MARINA_ARENA_RESEARCH_RETRIEVER");
  if (opts.requireDateStrict) {
    const loose = parts.filter((p) => !isAsOfPart(p));
    if (loose.length > 0) {
      throw new Error(
        `a date-strict retriever was required, but ${loose.join(", ")} cannot honour a cutoff (use asof:<providers>)`,
      );
    }
  }
  return combineRetrievers(
    parts.map((part) => {
      if (isAsOfPart(part)) {
        const list = part.includes(":") ? part.slice(part.indexOf(":") + 1) : "";
        const providers = list
          .split("+")
          .map((p) => p.trim().toLowerCase())
          .filter(Boolean);
        return asOfRetriever({
          ...(providers.length ? { providers } : {}),
          ...(opts.http ? { http: opts.http } : {}),
        });
      }
      const [kind, ...rest] = part.split(":");
      const model = rest.join(":");
      if (!model) throw new Error(`MARINA_ARENA_RESEARCH_RETRIEVER entry "${part}" names no model`);
      if (kind === "tavily") {
        if (model !== "basic" && model !== "advanced") {
          throw new Error(
            `MARINA_ARENA_RESEARCH_RETRIEVER entry "${part}": tavily:basic or tavily:advanced`,
          );
        }
        if (!k.tavily) throw new Error(`the ${part} retriever needs TAVILY_API_KEY`);
        return tavilyRetriever({ depth: model, apiKey: k.tavily });
      }
      if (kind === "openrouter-web" || kind === "sonar") {
        if (!k.openrouter) throw new Error(`the ${part} retriever needs OPENROUTER_API_KEY`);
        return kind === "sonar"
          ? sonarRetriever({ model, apiKey: k.openrouter })
          : openRouterWebRetriever({ model, apiKey: k.openrouter });
      }
      throw new Error(
        `unknown MARINA_ARENA_RESEARCH_RETRIEVER entry "${part}" (openrouter-web:<model>, sonar:<model>, tavily:<basic|advanced> or asof[:<providers>])`,
      );
    }),
  );
}

function isAsOfPart(part: string): boolean {
  return part === "asof" || part.startsWith("asof:");
}

/**
 * Spec entries, comma-separated. Bare provider names right after an `asof`
 * entry belong to it, so `asof:gdelt,wikipedia,hn` reads as
 * `asof:gdelt+wikipedia+hn`.
 */
function specParts(spec: string): string[] {
  const out: string[] = [];
  for (const part of spec
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const prev = out[out.length - 1];
    const name = part.toLowerCase();
    if (
      prev &&
      isAsOfPart(prev) &&
      !part.includes(":") &&
      (DATE_BOUND_PROVIDER_NAMES as readonly string[]).includes(name)
    ) {
      out[out.length - 1] = prev === "asof" ? `asof:${name}` : `${prev}+${name}`;
    } else {
      out.push(part);
    }
  }
  return out;
}

/** True when every entry of a retriever spec is date-strict (`asof…`). */
export function isDateStrictSpec(spec: string): boolean {
  const parts = specParts(spec);
  return parts.length > 0 && parts.every(isAsOfPart);
}
