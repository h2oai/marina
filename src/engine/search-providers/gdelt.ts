// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * GDELT DOC 2.0 — worldwide news article search with exact time bounds.
 *
 * Free, no key. `startdatetime` / `enddatetime` (YYYYMMDDHHMMSS, UTC) bound the
 * query server-side, and every article's `seendate` (when GDELT first saw it)
 * is re-checked against the bound here, so nothing first seen after the bound
 * is returned. GDELT asks callers to keep to about one request every few
 * seconds; requests are spaced per host. The DOC API's full-text window is the
 * recent past (about three months), so an older bound simply returns nothing.
 * Results carry title, URL and date only — no article text.
 */

import { compactStamp, fromCompactStamp, parseJson, plainQuery, politeGet } from "./asof-http";
import type { SearchHttp, SearchOpts, SearchProvider, SearchResult } from "./index";

export const GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
/** GDELT's guidance: about one query per five seconds. */
export const GDELT_MIN_INTERVAL_MS = 5_000;
/** How far back a bounded query reaches when no `after` is given. */
const DEFAULT_LOOKBACK_DAYS = 30;

interface GdeltArticle {
  url?: string;
  title?: string;
  seendate?: string;
  domain?: string;
  language?: string;
}

export function gdeltProvider(opts: { minIntervalMs?: number } = {}): SearchProvider {
  const minInterval = opts.minIntervalMs ?? GDELT_MIN_INTERVAL_MS;
  return {
    name: "gdelt",
    engines: ["news", "web"],
    dateBound: "strict",
    boundOnly: true,
    describe:
      "GDELT DOC 2.0 news search; startdatetime/enddatetime server-side, seendate re-checked (recent ~3 months)",
    async search(
      query: string,
      o: SearchOpts,
      http: SearchHttp,
      entityId?: string,
    ): Promise<SearchResult[]> {
      const q = plainQuery(query);
      if (!q) return [];
      const end = o.before ?? new Date().toISOString();
      const start =
        o.after ?? new Date(Date.parse(end) - DEFAULT_LOOKBACK_DAYS * 86_400_000).toISOString();
      const max = Math.min(Math.max(o.maxResults ?? 10, 1), 75);
      const url =
        `${GDELT_DOC_URL}?query=${encodeURIComponent(q)}&mode=artlist&format=json` +
        `&maxrecords=${max}&sort=hybridrel` +
        `&startdatetime=${compactStamp(start)}&enddatetime=${compactStamp(end)}`;
      const reply = await politeGet(http, url, minInterval, entityId);
      if ("error" in reply || reply.status !== 200) return [];
      // GDELT answers query errors with plain text, not JSON.
      const data = parseJson<{ articles?: GdeltArticle[] }>(reply.body);
      const out: SearchResult[] = [];
      for (const a of data?.articles ?? []) {
        if (!a.url || !/^https?:\/\//.test(a.url)) continue;
        const published = fromCompactStamp(a.seendate?.replace(/[TZ]/g, ""));
        if (!published || Date.parse(published) > Date.parse(end)) continue;
        if (Date.parse(published) < Date.parse(start)) continue;
        out.push({
          title: (a.title ?? a.url).trim(),
          url: a.url,
          snippet: a.domain ? `${a.domain} · first seen ${published.slice(0, 16)}Z` : "",
          source: "gdelt",
          published,
        });
        if (out.length >= max) break;
      }
      return out;
    },
  };
}
