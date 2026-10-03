// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * arXiv by submission date — `submittedDate:[from TO to]` in the query.
 *
 * Free, no key. Each entry's `<published>` (first version) is re-checked
 * against the bound, and an entry whose `<updated>` is after the bound is
 * dropped too: the API serves the latest version's title and abstract, which
 * may postdate the bound.
 */

import { clipText, plainQuery, politeGet } from "./asof-http";
import type { SearchHttp, SearchOpts, SearchProvider, SearchResult } from "./index";

export const ARXIV_API_URL = "https://export.arxiv.org/api/query";
/** arXiv asks for about one request every three seconds. */
const ARXIV_MIN_INTERVAL_MS = 3_000;
const DEFAULT_LOOKBACK_DAYS = 365;

/** `YYYYMMDDHHMM` (UTC), the precision `submittedDate` takes. */
function arxivStamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:T]/g, "").slice(0, 12);
}

function tag(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m?.[1]?.replace(/\s+/g, " ").trim();
}

export function arxivAsOfProvider(): SearchProvider {
  return {
    name: "arxiv",
    engines: ["academic"],
    dateBound: "strict",
    boundOnly: true,
    describe:
      "arXiv: submittedDate range in the query; first-version date re-checked, entries updated after the bound dropped",
    async search(
      query: string,
      o: SearchOpts,
      http: SearchHttp,
      entityId?: string,
    ): Promise<SearchResult[]> {
      const terms = plainQuery(query).replace(/["']/g, "");
      if (!terms) return [];
      const end = o.before ?? new Date().toISOString();
      const start =
        o.after ?? new Date(Date.parse(end) - DEFAULT_LOOKBACK_DAYS * 86_400_000).toISOString();
      const max = Math.min(Math.max(o.maxResults ?? 10, 1), 50);
      const q = `all:${terms.split(" ").join(" AND all:")} AND submittedDate:[${arxivStamp(start)} TO ${arxivStamp(end)}]`;
      const url = `${ARXIV_API_URL}?search_query=${encodeURIComponent(q)}&start=0&max_results=${max}&sortBy=relevance`;
      const reply = await politeGet(http, url, ARXIV_MIN_INTERVAL_MS, entityId);
      if ("error" in reply || reply.status !== 200) return [];
      const out: SearchResult[] = [];
      for (const m of reply.body.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
        const entry = m[1] ?? "";
        const id = tag(entry, "id");
        const published = tag(entry, "published");
        const updated = tag(entry, "updated");
        if (!id || !published || !Number.isFinite(Date.parse(published))) continue;
        if (Date.parse(published) > Date.parse(end)) continue;
        if (updated && Date.parse(updated) > Date.parse(end)) continue;
        const summary = tag(entry, "summary") ?? "";
        out.push({
          title: tag(entry, "title") ?? id,
          url: id.replace(/^http:/, "https:"),
          snippet: clipText(summary, 300),
          source: "arxiv",
          published: new Date(published).toISOString(),
          ...(summary ? { text: summary } : {}),
        });
        if (out.length >= max) break;
      }
      return out;
    },
  };
}
