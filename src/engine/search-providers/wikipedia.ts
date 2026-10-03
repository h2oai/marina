// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wikipedia as of an instant — search, then each hit's revision at the bound.
 *
 * Free, no key. The search index is today's, so it only nominates titles; the
 * text returned is the article's latest revision at or before the bound
 * (MediaWiki revisions API, `rvstart=<bound>` with `rvdir=older`), and an
 * article with no revision by then (created later) is dropped. Results link to
 * the `oldid` permalink of that revision, so a reader or citation check sees
 * the same text. Residual: ranking and the set of nominated titles come from
 * the current index.
 */

import { clipText, parseJson, plainQuery, politeGet } from "./asof-http";
import type { SearchHttp, SearchOpts, SearchProvider, SearchResult } from "./index";

const WIKI_MIN_INTERVAL_MS = 200;
/** Titles checked per search (each costs one revisions request). */
const MAX_TITLES = 5;

function apiBase(lang: string): string {
  return `https://${lang}.wikipedia.org/w/api.php`;
}

export interface WikiRevision {
  title: string;
  revid: number;
  /** ISO time of the revision (at or before the bound). */
  at: string;
  /** Plain-ish text of the requested section(s). */
  text: string;
  permalink: string;
}

/**
 * The article's latest revision at or before `asOf` (lead section unless
 * `full`), cleaned to readable text — undefined when it did not exist yet.
 */
export async function wikipediaRevision(
  http: SearchHttp,
  title: string,
  asOf: string,
  opts: { lang?: string; full?: boolean; entityId?: string } = {},
): Promise<WikiRevision | undefined> {
  const lang = opts.lang ?? "en";
  const url =
    `${apiBase(lang)}?action=query&prop=revisions&titles=${encodeURIComponent(title)}` +
    `&rvlimit=1&rvdir=older&rvstart=${encodeURIComponent(new Date(asOf).toISOString())}` +
    `&rvprop=ids%7Ctimestamp%7Ccontent&rvslots=main${opts.full ? "" : "&rvsection=0"}` +
    "&redirects=1&format=json&formatversion=2";
  const reply = await politeGet(http, url, WIKI_MIN_INTERVAL_MS, opts.entityId);
  if ("error" in reply || reply.status !== 200) return undefined;
  const data = parseJson<{
    query?: {
      pages?: Array<{
        title?: string;
        missing?: boolean;
        revisions?: Array<{
          revid?: number;
          timestamp?: string;
          slots?: { main?: { content?: string } };
        }>;
      }>;
    };
  }>(reply.body);
  const page = data?.query?.pages?.[0];
  const rev = page?.revisions?.[0];
  if (!page || page.missing || !rev?.revid || !rev.timestamp) return undefined;
  if (Date.parse(rev.timestamp) > Date.parse(asOf)) return undefined;
  const raw = rev.slots?.main?.content ?? "";
  return {
    title: page.title ?? title,
    revid: rev.revid,
    at: new Date(rev.timestamp).toISOString(),
    text: wikitextToPlain(raw),
    permalink: `https://${lang}.wikipedia.org/w/index.php?oldid=${rev.revid}`,
  };
}

/** A rough wikitext → text pass: templates, refs, tables and markup removed. */
export function wikitextToPlain(wikitext: string): string {
  let s = wikitext;
  // Nested templates: strip innermost {{…}} repeatedly.
  for (let i = 0; i < 8 && /\{\{[^{}]*\}\}/.test(s); i++) s = s.replace(/\{\{[^{}]*\}\}/g, "");
  s = s
    .replace(/<ref[^>/]*\/>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\{\|[\s\S]*?\|\}/g, "")
    .replace(/\[\[(?:File|Image|Category):[^\]]*\]\]/gi, "")
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\[https?:\/\/\S+\s([^\]]*)\]/g, "$1")
    .replace(/'{2,}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/^=+\s*(.*?)\s*=+$/gm, "$1");
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

export function wikipediaProvider(opts: { lang?: string } = {}): SearchProvider {
  const lang = opts.lang ?? "en";
  return {
    name: "wikipedia",
    engines: ["web", "reference"],
    dateBound: "strict",
    boundOnly: true,
    describe:
      "Wikipedia: current index nominates titles, text is each article's revision at the bound (rvstart, oldid permalink)",
    async search(
      query: string,
      o: SearchOpts,
      http: SearchHttp,
      entityId?: string,
    ): Promise<SearchResult[]> {
      const q = plainQuery(query);
      if (!q) return [];
      const asOf = o.before ?? new Date().toISOString();
      const limit = Math.min(Math.max(o.maxResults ?? 5, 1), MAX_TITLES);
      const url =
        `${apiBase(lang)}?action=query&list=search&srsearch=${encodeURIComponent(q)}` +
        `&srlimit=${limit}&srprop=&format=json&formatversion=2`;
      const reply = await politeGet(http, url, WIKI_MIN_INTERVAL_MS, entityId);
      if ("error" in reply || reply.status !== 200) return [];
      const data = parseJson<{ query?: { search?: Array<{ title?: string }> } }>(reply.body);
      const titles = (data?.query?.search ?? []).flatMap((h) => (h.title ? [h.title] : []));
      const out: SearchResult[] = [];
      for (const title of titles.slice(0, limit)) {
        const rev = await wikipediaRevision(http, title, asOf, { lang });
        // An article not edited since `after` is still the article as of the
        // bound: kept, with its true revision time as `published`.
        if (!rev) continue;
        out.push({
          title: rev.title,
          url: rev.permalink,
          snippet: clipText(rev.text, 400),
          source: "wikipedia",
          published: rev.at,
          text: rev.text,
        });
      }
      return out;
    },
  };
}
