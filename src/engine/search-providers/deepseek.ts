// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * DeepSeek's Search API as a web search backend (`deepseek`).
 *
 * Requires DEEPSEEK_API_KEY (the same key as DeepSeek's chat models; the API
 * is not on OpenRouter). Docs: https://api-docs.deepseek.com/guides/search
 *
 *   POST https://api.deepseek.com/v1/tools/search
 *   { query (1–128 chars; after:/before:/site:/-site:/lang: operators),
 *     count 1–50, need_content }
 *   → { results: [{ title, url, snippet, summary, content, site_name,
 *                   date (RFC 3339 | null), rerank_score 0–3, authority }] }
 *
 * A search's date window rides in the query as `after:<YYYY-MM-DD>` /
 * `before:<YYYY-MM-DD>` operators, and results dated outside it are dropped
 * again here (undated results stay: this backend is not date-strict). HTTP 429
 * (over 100 QPS) is retried a bounded number of times; any other failure
 * THROWS, so the chain falls through to the next backend and `readiness`
 * shows it. A successful search WITH results is priced at
 * `DEEPSEEK_USD_PER_SEARCH` into the spend ledger (source `search`) once
 * billing starts; an empty result is free. Refused at the daily cap.
 */

import { guardedFetch } from "../../net/url-guard";
import { getErrorMessage } from "../errors";
import { dailyCapRefusal, recordSpend } from "../spend-ledger";
import type { SearchProvider, SearchResult } from "./index";

export const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
/** List price per successful, non-empty search ($0.75 per 1,000). */
export const DEEPSEEK_USD_PER_SEARCH = 0.00075;
/** DeepSeek bills searches from this instant; earlier calls are free. */
export const DEEPSEEK_BILLING_STARTS_AT = Date.parse("2026-10-31T16:00:00.000Z");
/** The API's longest query, operators included. */
export const DEEPSEEK_MAX_QUERY_CHARS = 128;
/** Retries after an HTTP 429 before the call fails. */
const DEEPSEEK_MAX_RETRIES = 2;
/** Backoff after a 429 (doubled per retry), and the most a `Retry-After` may ask. */
const DEEPSEEK_RETRY_BASE_MS = 250;
const DEEPSEEK_RETRY_MAX_MS = 2_000;

export interface DeepSeekSearchOptions {
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxRetries?: number;
}

interface DeepSeekResult {
  title?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  content?: string;
  site_name?: string;
  date?: string | null;
  rerank_score?: number;
  authority?: number;
}

/** `YYYY-MM-DD` (UTC) of an ISO instant, else undefined. */
function utcDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined;
}

/**
 * The API query: the search terms cut (at a word boundary) so that the
 * `after:` / `before:` operators still fit in `DEEPSEEK_MAX_QUERY_CHARS`.
 */
export function deepSeekQuery(query: string, after?: string, before?: string): string {
  const ops = [
    ...(utcDate(after) ? [`after:${utcDate(after)}`] : []),
    ...(utcDate(before) ? [`before:${utcDate(before)}`] : []),
  ].join(" ");
  const room = DEEPSEEK_MAX_QUERY_CHARS - (ops ? ops.length + 1 : 0);
  let terms = query.replace(/\s+/g, " ").trim();
  if (terms.length > room) {
    const cut = terms.lastIndexOf(" ", room);
    terms = terms.slice(0, cut > room / 2 ? cut : room).trim();
  }
  return ops ? `${terms} ${ops}` : terms;
}

function isoInstant(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

export function deepSeekSearchProvider(
  apiKey: string,
  options: DeepSeekSearchOptions = {},
): SearchProvider {
  const fetcher = options.fetcher ?? guardedFetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = options.maxRetries ?? DEEPSEEK_MAX_RETRIES;
  return {
    name: "deepseek",
    engines: ["web", "news"],
    describe: "DeepSeek Search API (DEEPSEEK_API_KEY); dates via after:/before: operators",

    async search(query, opts): Promise<SearchResult[]> {
      const capped = dailyCapRefusal();
      if (capped) throw new Error(`deepseek: ${capped}`);
      const q = deepSeekQuery(query, opts.after, opts.before);
      if (!q) throw new Error("deepseek: empty query");
      const count = Math.min(50, Math.max(1, Math.floor(opts.maxResults ?? 10)));
      const body = JSON.stringify({ query: q, count, need_content: true });
      let status = 0;
      let text = "";
      for (let attempt = 0; ; attempt++) {
        // The key travels in a header, which the shared SearchHttp surface does
        // not carry: a direct call, through the same SSRF guard.
        let res: Response;
        try {
          res = await fetcher(DEEPSEEK_SEARCH_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body,
            signal: AbortSignal.timeout(30_000),
          });
        } catch (err) {
          throw new Error(`deepseek: ${getErrorMessage(err)}`);
        }
        status = res.status;
        text = await res.text();
        if (status !== 429 || attempt >= maxRetries) break;
        const after = Number(res.headers.get("retry-after"));
        const wait =
          Number.isFinite(after) && after > 0
            ? after * 1000
            : DEEPSEEK_RETRY_BASE_MS * 2 ** attempt;
        await sleep(Math.min(DEEPSEEK_RETRY_MAX_MS, wait));
      }
      if (status !== 200) throw new Error(`deepseek HTTP ${status}: ${text.slice(0, 160)}`);
      let data: { results?: DeepSeekResult[] };
      try {
        data = JSON.parse(text) as { results?: DeepSeekResult[] };
      } catch {
        throw new Error("deepseek: unreadable reply");
      }
      const raw = data.results ?? [];
      // Billed per successful search that returned something; an empty one is free.
      if (raw.length > 0 && (options.now?.() ?? Date.now()) >= DEEPSEEK_BILLING_STARTS_AT) {
        recordSpend("search", DEEPSEEK_USD_PER_SEARCH);
        if (opts.spend) opts.spend.usd += DEEPSEEK_USD_PER_SEARCH;
      }
      const beforeMs = opts.before ? Date.parse(opts.before) : Number.NaN;
      const afterMs = opts.after ? Date.parse(opts.after) : Number.NaN;
      return raw.flatMap((r) => {
        if (!r.url || !/^https?:\/\//.test(r.url)) return [];
        const published = isoInstant(r.date);
        const t = published ? Date.parse(published) : Number.NaN;
        // The operators are the server's filter; a dated result outside the window is dropped here too.
        if (Number.isFinite(t) && Number.isFinite(beforeMs) && t > beforeMs) return [];
        if (Number.isFinite(t) && Number.isFinite(afterMs) && t < afterMs) return [];
        const passage = (r.summary?.trim() || r.snippet?.trim() || "").slice(0, 500);
        return [
          {
            title: r.title ?? r.site_name ?? "",
            url: r.url,
            snippet: passage,
            source: "deepseek",
            ...(typeof r.rerank_score === "number" ? { score: r.rerank_score } : {}),
            ...(published ? { published } : {}),
            ...(r.content?.trim() ? { text: r.content } : {}),
          },
        ];
      });
    },
  };
}
