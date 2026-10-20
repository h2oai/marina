// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * News-pulse extractors: how much coverage a subject is getting and which
 * way it is moving, as of the cutoff.
 *
 * `news` — Wikipedia's own news digest, Portal:Current events, one page per
 * day, each read at its revision at or before the cutoff (`rvstart`), for the
 * 7 days ending the cutoff's day (pages are shared by every subject):
 *
 *   news.portal_days  days on which the digest links the subject (0–7);
 *   news.direction    with a model, from the digest's lines about the subject:
 *                     −1 fading, 0 steady, +1 rising — one narrow JSON call
 *                     per subject the digest mentions, never a view count.
 *
 * `gdelt` — GDELT DOC 2.0 (opt-in: GDELT throttles hard, about one query per
 * five seconds, and its full-text window is about three months):
 *
 *   news.volume  `timelinevol` share of monitored coverage, mean of the last
 *                3 days before the cutoff;
 *   news.trend   that mean over the 11 days before it (+ε smoothed).
 *
 * GDELT's `startdatetime`/`enddatetime` bound the query server-side and each
 * point's date is re-checked here.
 */

import { compactStamp, fromCompactStamp } from "../../engine/search-providers/asof-http";
import { GDELT_DOC_URL } from "../../engine/search-providers/gdelt";
import {
  type AttentionContext,
  type AttentionFeature,
  addDays,
  atOrBefore,
  DAY_MS,
  type Extractor,
  type FetchJson,
  mapLimit,
  skipOnError,
} from "./features";
import { wikiLinks } from "./wiki-deterministic";

export const NEWS_LOOKBACK_DAYS = 14;
const EPS = 1e-4;

/** A subject as a news query: underscores to spaces, disambiguation dropped, quoted when several words. */
export function newsQuery(subject: string): string {
  const s = subject
    .replace(/_/g, " ")
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/["]/g, "")
    .trim();
  return s.includes(" ") ? `"${s}"` : s;
}

export function gdeltUrl(subject: string, start: string, end: string): string {
  return (
    `${GDELT_DOC_URL}?query=${encodeURIComponent(newsQuery(subject))}&mode=timelinevol&format=json` +
    `&startdatetime=${compactStamp(start)}&enddatetime=${compactStamp(end)}`
  );
}

/** A `timelinevol` body → daily volume (UTC day → mean of its points), points after `cutoff` dropped. */
export function parseTimeline(body: unknown, cutoff: string): Map<string, number> {
  const series = (body as { timeline?: Array<{ data?: Array<{ date?: string; value?: number }> }> })
    ?.timeline?.[0]?.data;
  const sums = new Map<string, { s: number; n: number }>();
  for (const p of series ?? []) {
    const at = fromCompactStamp(p.date?.replace(/[TZ]/g, ""));
    if (!at || !atOrBefore(at, cutoff) || typeof p.value !== "number") continue;
    const day = at.slice(0, 10);
    const cur = sums.get(day) ?? { s: 0, n: 0 };
    cur.s += p.value;
    cur.n++;
    sums.set(day, cur);
  }
  return new Map([...sums].map(([d, v]) => [d, v.s / v.n]));
}

/** Mean of the 3 days ending the cutoff's day, and its ratio to the 11 days before. */
export function pulse(
  daily: Map<string, number>,
  cutoff: string,
): { volume: number; trend: number } {
  const end = Date.parse(`${cutoff.slice(0, 10)}T00:00:00Z`);
  let recent = 0;
  let before = 0;
  for (let k = 0; k < NEWS_LOOKBACK_DAYS; k++) {
    const v = daily.get(new Date(end - k * DAY_MS).toISOString().slice(0, 10)) ?? 0;
    if (k < 3) recent += v;
    else before += v;
  }
  const volume = recent / 3;
  return { volume, trend: (volume + EPS) / (before / (NEWS_LOOKBACK_DAYS - 3) + EPS) };
}

export function gdeltExtractor(opts: { concurrency?: number } = {}): Extractor {
  return {
    name: "gdelt",
    kind: "deterministic",
    async extract(ctx) {
      const gdelt: FetchJson | undefined = ctx.gdeltJson;
      if (!gdelt) throw new Error("the gdelt extractor needs a GDELT source");
      const start = new Date(Date.parse(ctx.cutoff) - NEWS_LOOKBACK_DAYS * DAY_MS).toISOString();
      const rows = await mapLimit(ctx.subjects, opts.concurrency ?? 1, async (subject) => {
        const url = gdeltUrl(subject, start, ctx.cutoff);
        const daily = parseTimeline(
          await gdelt(url).catch(skipOnError("GDELT timeline", undefined)),
          ctx.cutoff,
        );
        if (daily.size === 0) return [];
        const p = pulse(daily, ctx.cutoff);
        const confidence = Math.min(1, daily.size / NEWS_LOOKBACK_DAYS);
        const base = { subject, asOf: ctx.cutoff, source: url, extractor: "gdelt" };
        return [
          { ...base, feature: "news.volume", value: p.volume, confidence },
          {
            ...base,
            feature: "news.trend",
            value: p.trend,
            confidence: p.volume > 0 ? confidence : 0.2,
          },
        ] satisfies AttentionFeature[];
      });
      return rows.flat();
    },
  };
}

// ─── Portal:Current events ──────────────────────────────────────────────────

export const PORTAL_DAYS = 7;
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** The digest page for `day` (YYYY-MM-DD) at its revision at or before `asOf`. */
export function portalUrl(day: string, asOf: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const title = `Portal:Current events/${y} ${MONTH_NAMES[m - 1]} ${d}`;
  return (
    "https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&prop=revisions" +
    `&titles=${encodeURIComponent(title)}&rvlimit=1&rvdir=older` +
    `&rvstart=${encodeURIComponent(new Date(asOf).toISOString())}` +
    "&rvprop=ids%7Ctimestamp%7Ccontent&rvslots=main"
  );
}

export interface PortalDay {
  day: string;
  /** Linked article → the digest lines (plain-ish) that link it. */
  lines: Map<string, string[]>;
  permalink: string;
  at: string;
}

/** One digest day as of the cutoff: which articles each bullet line links. */
export async function portalDay(
  fetchJson: FetchJson,
  day: string,
  cutoff: string,
): Promise<PortalDay | undefined> {
  const body = (await fetchJson(portalUrl(day, cutoff))) as {
    query?: {
      pages?: Array<{
        revisions?: Array<{
          revid?: number;
          timestamp?: string;
          slots?: { main?: { content?: string } };
        }>;
      }>;
    };
  };
  const rev = body?.query?.pages?.[0]?.revisions?.[0];
  if (!rev?.revid || !rev.timestamp || !atOrBefore(rev.timestamp, cutoff)) return undefined;
  const lines = new Map<string, string[]>();
  for (const line of (rev.slots?.main?.content ?? "").split("\n")) {
    if (!line.startsWith("*")) continue;
    const text = line
      .replace(/^\*+/, "")
      .replace(/\[https?:\/\/\S+\s[^\]]*\]/g, "")
      .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
      .replace(/\[\[([^\]]*)\]\]/g, "$1")
      .replace(/\{\{[^}]*\}\}/g, "")
      .trim();
    for (const t of wikiLinks(line)) {
      const got = lines.get(t) ?? [];
      if (text && got.length < 3) got.push(text.slice(0, 300));
      lines.set(t, got);
    }
  }
  return {
    day,
    lines,
    permalink: `https://en.wikipedia.org/w/index.php?oldid=${rev.revid}`,
    at: rev.timestamp,
  };
}

const SYSTEM =
  "You read news-digest lines about one subject and judge whether public attention to it will be rising, steady or fading over the next week. Use ONLY the lines given. Reply with ONE JSON object and nothing else.";

export function directionPrompt(
  subject: string,
  ctx: Pick<AttentionContext, "cutoff" | "window">,
  lines: Array<{ day: string; text: string }>,
): string {
  return [
    `Subject: ${subject.replace(/_/g, " ")}. Information as of ${ctx.cutoff.slice(0, 10)}; the forecast week is ${ctx.window.start} to ${ctx.window.end}.`,
    'Reply: {"direction": "rising|steady|fading", "confidence": <0-1>, "why": "<under 20 words>"}',
    "",
    ...lines.map((l, i) => `[${i}] ${l.day}: ${l.text}`),
  ].join("\n");
}

export function parseDirection(
  reply: string,
): { direction: number; confidence: number } | undefined {
  const m = reply.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    const j = JSON.parse(m[0]) as { direction?: unknown; confidence?: unknown };
    const d = { rising: 1, steady: 0, fading: -1 }[String(j.direction)];
    if (d === undefined) return undefined;
    const c = typeof j.confidence === "number" ? Math.min(1, Math.max(0, j.confidence)) : 0.5;
    return { direction: d, confidence: c };
  } catch {
    // allow-empty-catch: an unparseable reply is no feature
    return undefined;
  }
}

export function newsExtractor(opts: { concurrency?: number } = {}): Extractor {
  return {
    name: "news",
    kind: "model",
    async extract(ctx) {
      const cutoffDay = ctx.cutoff.slice(0, 10);
      const days = Array.from({ length: PORTAL_DAYS }, (_, k) =>
        addDays(cutoffDay, k - PORTAL_DAYS + 1),
      );
      const pages = (
        await Promise.all(
          days.map((d) =>
            portalDay(ctx.fetchJson, d, ctx.cutoff).catch(
              skipOnError("current-events page", undefined),
            ),
          ),
        )
      ).filter((p): p is PortalDay => !!p);
      if (pages.length === 0) return [];
      const rows = await mapLimit(ctx.subjects, opts.concurrency ?? 4, async (subject) => {
        const hits = pages.filter((p) => p.lines.has(subject));
        const newest = hits.at(-1) ?? pages.at(-1)!;
        const out: AttentionFeature[] = [
          {
            subject,
            feature: "news.portal_days",
            value: hits.length,
            asOf: ctx.cutoff,
            source: newest.permalink,
            confidence: pages.length / PORTAL_DAYS,
            extractor: "news",
            detail: { daysRead: pages.length },
          },
        ];
        const lines = hits.flatMap((p) =>
          (p.lines.get(subject) ?? []).map((text) => ({ day: p.day, text })),
        );
        if (ctx.complete && lines.length) {
          const reply = await ctx
            .complete(SYSTEM, directionPrompt(subject, ctx, lines.slice(-12)))
            .catch(skipOnError("news direction call", ""));
          const d = parseDirection(reply);
          if (d)
            out.push({
              subject,
              feature: "news.direction",
              value: d.direction,
              asOf: ctx.cutoff,
              source: newest.permalink,
              confidence: d.confidence,
              extractor: "news",
              detail: { lines: lines.length, publishedAt: newest.at },
            });
        }
        return out;
      });
      return rows.flat();
    },
  };
}
