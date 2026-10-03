// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Internet Archive Wayback Machine — a URL as it stood at an instant.
 *
 * Free, no key. The CDX API is asked for the LATEST 200-status capture with
 * `to=<bound>` (never the availability API, which returns the closest capture
 * in either direction), the capture timestamp is re-checked against the bound,
 * and the archived bytes are read from the `id_` (unmodified) replay URL. So a
 * page is only ever read as it was at or before the bound. Not a search engine:
 * as a provider it answers a query that is a URL.
 */

import { extractReadableText } from "../html-text";
import { clipText, compactStamp, fromCompactStamp, parseJson, politeGet } from "./asof-http";
import type { SearchHttp, SearchOpts, SearchProvider, SearchResult } from "./index";

export const WAYBACK_CDX_URL = "https://web.archive.org/cdx/search/cdx";
const WAYBACK_MIN_INTERVAL_MS = 1_000;

export interface WaybackCapture {
  /** ISO time of the capture (at or before the bound). */
  at: string;
  /** The archived URL as captured. */
  original: string;
  /** Replay URL of the unmodified archived bytes. */
  replayUrl: string;
}

/** The latest successful capture of `url` at or before `asOf`, else undefined. */
export async function waybackCapture(
  http: SearchHttp,
  url: string,
  asOf: string,
  entityId?: string,
): Promise<WaybackCapture | undefined> {
  const stamp = compactStamp(asOf);
  const cdx =
    `${WAYBACK_CDX_URL}?url=${encodeURIComponent(url)}&to=${stamp}&output=json` +
    "&fl=timestamp,original,statuscode&filter=statuscode:200&limit=-1";
  const reply = await politeGet(http, cdx, WAYBACK_MIN_INTERVAL_MS, entityId);
  if ("error" in reply || reply.status !== 200) return undefined;
  const rows = parseJson<string[][]>(reply.body);
  // First row is the header; with limit=-1 the last row is the newest capture ≤ `to`.
  const row = rows && rows.length > 1 ? rows[rows.length - 1] : undefined;
  const ts = row?.[0];
  const original = row?.[1];
  const at = fromCompactStamp(ts);
  if (!ts || !original || !at || Date.parse(at) > Date.parse(asOf)) return undefined;
  return { at, original, replayUrl: `https://web.archive.org/web/${ts}id_/${original}` };
}

export interface WaybackPage extends WaybackCapture {
  title?: string;
  text: string;
}

/** Read `url` as archived at or before `asOf` (readable text), else undefined. */
export async function waybackFetch(
  http: SearchHttp,
  url: string,
  asOf: string,
  entityId?: string,
): Promise<WaybackPage | undefined> {
  const capture = await waybackCapture(http, url, asOf, entityId);
  if (!capture) return undefined;
  const reply = await politeGet(http, capture.replayUrl, WAYBACK_MIN_INTERVAL_MS);
  if ("error" in reply || reply.status !== 200) return undefined;
  const extracted = extractReadableText(reply.body);
  return {
    ...capture,
    ...(extracted.title ? { title: extracted.title } : {}),
    text: extracted.text,
  };
}

export function waybackProvider(): SearchProvider {
  return {
    name: "wayback",
    engines: [],
    dateBound: "strict",
    boundOnly: true,
    describe:
      "Internet Archive: a URL as of the bound (CDX `to=` latest 200 capture, timestamp re-checked)",
    async search(
      query: string,
      o: SearchOpts,
      http: SearchHttp,
      entityId?: string,
    ): Promise<SearchResult[]> {
      const url = query.trim();
      if (!/^https?:\/\/\S+$/.test(url)) return [];
      const page = await waybackFetch(http, url, o.before ?? new Date().toISOString(), entityId);
      if (!page) return [];
      return [
        {
          title: page.title ?? page.original,
          url: page.replayUrl,
          snippet: clipText(page.text, 300),
          source: "wayback",
          published: page.at,
          text: page.text,
        },
      ];
    },
  };
}
