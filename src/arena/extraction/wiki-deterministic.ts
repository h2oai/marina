// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic Wikipedia extractors (no model, free public APIs):
 *
 *   `edits`    — the article's revisions in the 28 days before the cutoff
 *                (MediaWiki `prop=revisions`, `rvdir=older`, `rvstart` = the
 *                cutoff, `rvend` = 28 days earlier): counts, distinct editors
 *                and the surge of the last 7 days over the 21 before.
 *   `related`  — the articles the lead section linked to at the cutoff (the
 *                revision at or before it, `rvstart`), and their daily
 *                pageviews up to the last published day: does the
 *                neighbourhood rise ahead of the article?
 *
 * Both re-check every timestamp they read against the cutoff.
 */

import { isExcludedTitle } from "../forecast";
import {
  type AttentionContext,
  type AttentionFeature,
  addDays,
  atOrBefore,
  DAY_MS,
  type Extractor,
  mapLimit,
  skipOnError,
} from "./features";

const API = "https://en.wikipedia.org/w/api.php";
/** Revisions read per page (MediaWiki's cap for a non-bot client). */
const RV_LIMIT = 500;
/** Continuation pages followed per article before the count is marked truncated. */
const MAX_PAGES = 3;
export const EDIT_WINDOW_DAYS = 28;
export const EDIT_RECENT_DAYS = 7;
/** Linked articles read per subject. */
export const RELATED_LINKS = 8;

/** The revisions query for `title` between `end` (older) and `start` (newer, the cutoff). */
export function revisionsUrl(title: string, start: string, end: string, cont?: string): string {
  return (
    `${API}?action=query&format=json&formatversion=2&prop=revisions` +
    `&titles=${encodeURIComponent(title.replace(/_/g, " "))}` +
    `&rvprop=timestamp%7Cuser&rvlimit=${RV_LIMIT}&rvdir=older` +
    `&rvstart=${encodeURIComponent(new Date(start).toISOString())}` +
    `&rvend=${encodeURIComponent(new Date(end).toISOString())}` +
    (cont ? `&rvcontinue=${encodeURIComponent(cont)}` : "")
  );
}

/** The lead section's wikitext at the latest revision at or before `asOf`. */
export function leadRevisionUrl(title: string, asOf: string): string {
  return (
    `${API}?action=query&format=json&formatversion=2&prop=revisions` +
    `&titles=${encodeURIComponent(title.replace(/_/g, " "))}` +
    `&rvlimit=1&rvdir=older&rvstart=${encodeURIComponent(new Date(asOf).toISOString())}` +
    "&rvprop=ids%7Ctimestamp%7Ccontent&rvslots=main&rvsection=0"
  );
}

interface RevisionsBody {
  query?: {
    pages?: Array<{
      title?: string;
      missing?: boolean;
      revisions?: Array<{
        revid?: number;
        timestamp?: string;
        user?: string;
        slots?: { main?: { content?: string } };
      }>;
    }>;
  };
  continue?: { rvcontinue?: string };
}

export interface EditCounts {
  recent: number;
  window: number;
  editors: number;
  truncated: boolean;
  newest?: string;
}

/** Revisions in (cutoff − 28 d, cutoff], every timestamp re-checked. */
export async function editCounts(
  fetchJson: AttentionContext["fetchJson"],
  title: string,
  cutoff: string,
): Promise<EditCounts> {
  const end = new Date(Date.parse(cutoff) - EDIT_WINDOW_DAYS * DAY_MS).toISOString();
  const recentFrom = Date.parse(cutoff) - EDIT_RECENT_DAYS * DAY_MS;
  const out: EditCounts = { recent: 0, window: 0, editors: 0, truncated: false };
  const editors = new Set<string>();
  let cont: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = (await fetchJson(revisionsUrl(title, cutoff, end, cont))) as
      | RevisionsBody
      | undefined;
    for (const r of body?.query?.pages?.[0]?.revisions ?? []) {
      if (!r.timestamp || !atOrBefore(r.timestamp, cutoff)) continue;
      const t = Date.parse(r.timestamp);
      if (t < Date.parse(end)) continue;
      out.window++;
      if (t > recentFrom) {
        out.recent++;
        if (r.user) editors.add(r.user);
      }
      if (!out.newest || r.timestamp > out.newest) out.newest = r.timestamp;
    }
    cont = body?.continue?.rvcontinue;
    if (!cont) break;
    if (page === MAX_PAGES - 1) out.truncated = true;
  }
  out.editors = editors.size;
  return out;
}

/**
 * Surge: the last 7 days' edits per day over the 21 before, both smoothed by
 * one edit (so a quiet page reads 1, not 0/0).
 */
export function editSurge(c: Pick<EditCounts, "recent" | "window">): number {
  const before = c.window - c.recent;
  const recentRate = (c.recent + 1) / EDIT_RECENT_DAYS;
  const beforeRate = (before + 1) / (EDIT_WINDOW_DAYS - EDIT_RECENT_DAYS);
  return recentRate / beforeRate;
}

export function editsExtractor(opts: { concurrency?: number } = {}): Extractor {
  return {
    name: "edits",
    kind: "deterministic",
    async extract(ctx) {
      const rows = await mapLimit(ctx.subjects, opts.concurrency ?? 4, async (subject) => {
        const c = await editCounts(ctx.fetchJson, subject, ctx.cutoff).catch(
          skipOnError("revisions", undefined),
        );
        if (!c) return [];
        const source = revisionsUrl(
          subject,
          ctx.cutoff,
          new Date(Date.parse(ctx.cutoff) - EDIT_WINDOW_DAYS * DAY_MS).toISOString(),
        );
        const confidence = c.truncated ? 0.5 : Math.min(1, 0.3 + c.window / 20);
        const base = { subject, asOf: ctx.cutoff, source, extractor: "edits", confidence };
        const detail = { recent: c.recent, window: c.window, truncated: c.truncated };
        return [
          { ...base, feature: "edits.recent", value: c.recent, detail },
          { ...base, feature: "edits.editors", value: c.editors, detail },
          { ...base, feature: "edits.surge", value: editSurge(c), detail },
        ] satisfies AttentionFeature[];
      });
      return rows.flat();
    },
  };
}

/** Article links in wikitext, in order, namespaces and duplicates dropped (underscored titles). */
export function wikiLinks(wikitext: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of wikitext.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    const raw = m[1]!.trim();
    if (!raw || raw.includes(":")) continue;
    const t = (raw[0]!.toUpperCase() + raw.slice(1)).replace(/ /g, "_");
    if (seen.has(t) || isExcludedTitle(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** The lead's links at the cutoff, with that revision's permalink; undefined when it did not exist. */
export async function leadLinksAsOf(
  fetchJson: AttentionContext["fetchJson"],
  title: string,
  cutoff: string,
): Promise<{ links: string[]; permalink: string; at: string } | undefined> {
  const body = (await fetchJson(leadRevisionUrl(title, cutoff))) as RevisionsBody | undefined;
  const rev = body?.query?.pages?.[0]?.revisions?.[0];
  if (!rev?.timestamp || !rev.revid || !atOrBefore(rev.timestamp, cutoff)) return undefined;
  return {
    links: wikiLinks(rev.slots?.main?.content ?? ""),
    permalink: `https://en.wikipedia.org/w/index.php?oldid=${rev.revid}`,
    at: rev.timestamp,
  };
}

/** Sum of the last 3 days over 3 × the mean of the 11 before (1 = flat), +1 smoothed. */
export function viewGrowth(
  series: Array<{ date: string; views: number }>,
  lastDay: string,
): number {
  const by = new Map(series.filter((s) => s.date <= lastDay).map((s) => [s.date, s.views]));
  let recent = 0;
  let before = 0;
  for (let k = 0; k < 14; k++) {
    const v = by.get(addDays(lastDay, -k)) ?? 0;
    if (k < 3) recent += v;
    else before += v;
  }
  return (recent + 1) / ((before / 11) * 3 + 1);
}

export function relatedExtractor(opts: { links?: number; concurrency?: number } = {}): Extractor {
  const n = opts.links ?? RELATED_LINKS;
  return {
    name: "related",
    kind: "deterministic",
    async extract(ctx) {
      const views = ctx.dailyViews;
      if (!views) throw new Error("the related extractor needs a dailyViews source");
      const from = addDays(ctx.lastDay, -13);
      const rows = await mapLimit(ctx.subjects, opts.concurrency ?? 2, async (subject) => {
        const lead = await leadLinksAsOf(ctx.fetchJson, subject, ctx.cutoff).catch(
          skipOnError("lead revision", undefined),
        );
        if (!lead || lead.links.length === 0) return [];
        const linked = lead.links.slice(0, n);
        const series = await Promise.all(
          linked.map((t) =>
            views(t, from, ctx.lastDay)
              .then((s) => s.filter((d) => d.date <= ctx.lastDay && d.date >= from))
              .catch(skipOnError("linked pageviews", [] as Array<{ date: string; views: number }>)),
          ),
        );
        // The neighbourhood's growth: pooled views, so a big linked page weighs more.
        const pooled = new Map<string, number>();
        for (const s of series)
          for (const d of s) pooled.set(d.date, (pooled.get(d.date) ?? 0) + d.views);
        const growth = viewGrowth(
          [...pooled.entries()].map(([date, v]) => ({ date, views: v })),
          ctx.lastDay,
        );
        const rising = series.filter((s) => s.length && viewGrowth(s, ctx.lastDay) > 1.5).length;
        const read = series.filter((s) => s.length).length;
        const base = {
          subject,
          asOf: ctx.cutoff,
          source: lead.permalink,
          extractor: "related",
          confidence: Math.min(1, read / n),
        };
        const detail = { links: linked.length, read, revisionAt: lead.at };
        return [
          { ...base, feature: "related.growth", value: growth, detail },
          { ...base, feature: "related.rising_share", value: read ? rising / read : 0, detail },
        ] satisfies AttentionFeature[];
      });
      return rows.flat();
    },
  };
}
