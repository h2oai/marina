// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Hacker News (Algolia search API) with a creation-time window.
 *
 * Free, no key. `numericFilters=created_at_i<=…,created_at_i>=…` bounds the
 * query server-side and each hit's `created_at_i` is re-checked. Story titles
 * and self-text are as posted; points and comment counts are current.
 */

import { clipText, parseJson, plainQuery, politeGet } from "./asof-http";
import type { SearchHttp, SearchOpts, SearchProvider, SearchResult } from "./index";

export const HN_SEARCH_URL = "https://hn.algolia.com/api/v1/search";
const HN_MIN_INTERVAL_MS = 250;
const DEFAULT_LOOKBACK_DAYS = 90;

interface HnHit {
  objectID?: string;
  title?: string;
  url?: string | null;
  story_text?: string | null;
  created_at_i?: number;
  points?: number;
}

export function hnProvider(): SearchProvider {
  return {
    name: "hn",
    engines: ["social", "code", "news"],
    dateBound: "strict",
    boundOnly: true,
    describe: "Hacker News stories (Algolia); created_at_i window server-side, re-checked",
    async search(
      query: string,
      o: SearchOpts,
      http: SearchHttp,
      entityId?: string,
    ): Promise<SearchResult[]> {
      const q = plainQuery(query);
      if (!q) return [];
      const end = Math.floor(Date.parse(o.before ?? new Date().toISOString()) / 1000);
      const start = o.after
        ? Math.floor(Date.parse(o.after) / 1000)
        : end - DEFAULT_LOOKBACK_DAYS * 86_400;
      const max = Math.min(Math.max(o.maxResults ?? 10, 1), 50);
      const url =
        `${HN_SEARCH_URL}?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=${max}` +
        `&numericFilters=${encodeURIComponent(`created_at_i<=${end},created_at_i>=${start}`)}`;
      const reply = await politeGet(http, url, HN_MIN_INTERVAL_MS, entityId);
      if ("error" in reply || reply.status !== 200) return [];
      const data = parseJson<{ hits?: HnHit[] }>(reply.body);
      const out: SearchResult[] = [];
      for (const h of data?.hits ?? []) {
        if (!h.objectID || typeof h.created_at_i !== "number") continue;
        if (h.created_at_i > end || h.created_at_i < start) continue;
        const item = `https://news.ycombinator.com/item?id=${h.objectID}`;
        const text = (h.story_text ?? "").replace(/<[^>]+>/g, " ");
        out.push({
          title: (h.title ?? item).trim(),
          url: h.url && /^https?:\/\//.test(h.url) ? h.url : item,
          snippet: text ? clipText(text, 300) : `HN discussion: ${item}`,
          source: "hn",
          published: new Date(h.created_at_i * 1000).toISOString(),
          ...(text ? { text } : {}),
        });
      }
      return out;
    },
  };
}
