// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Retrieval isolation: keeping a research report free of anything published
 * after an evidence cutoff. A past-cutoff forecast (a backtest, a replay) is
 * only honest when the evidence it saw could have been seen at the cutoff.
 *
 *   date-filtered   the engine itself only returns pages published inside the
 *                   brief's window (Tavily `end_date`, Exa `endPublishedDate`,
 *                   an `asof:` composite)
 *   post-filtered   any engine, wrapped by `strictDateFilter`: a report line
 *                   survives only when every page it cites has a known
 *                   publication date on or before the cutoff, and the line
 *                   itself names no later date; undated pages, uncited lines
 *                   and live result / aggregator pages are dropped
 *   closed-book     no retrieval at all (`closedBookRetriever`): a lower bound
 *   contaminated    an unfiltered engine on a past cutoff — never a headline
 *
 * The filter is deliberately strict: a dropped good line costs a little
 * accuracy, a kept leaked line invalidates the measurement.
 */

import type { ResearchBrief } from "./briefs";
import { isDateStrictSpec, type ResearchReport, type Retriever, type Source } from "./retrieve";

export type IsolationLevel = "date-filtered" | "post-filtered" | "closed-book" | "contaminated";

/**
 * Pages whose current content is a live result, score or ranking (the answer
 * itself once the event has happened), whatever the date in their URL says.
 */
export const LIVE_RESULT_HOSTS = [
  "wikipedia.org",
  "wikidata.org",
  "espn.com/scoreboard",
  "flashscore",
  "livescore",
  "sofascore",
  "oddsportal",
  "polymarket.com",
  "kalshi.com",
  "manifold.markets",
  "metaculus.com",
  "billboard.com/charts",
  "boxofficemojo.com",
  "the-numbers.com",
  "coinmarketcap.com",
  "coingecko.com",
  "finance.yahoo.com/quote",
  "google.com/finance",
  "investing.com",
  "tradingeconomics.com",
  "x.com",
  "twitter.com",
  "reddit.com",
];

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");
const valid = (y: number, m: number, d: number) =>
  y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;

/** A publication day (YYYY-MM-DD) read from a URL path (`/2026/09/14/`, `2026-09-14`, `20260914`). */
export function urlPublishedDay(url: string): string | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const slash = path.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\/|$|[^\d])/);
  if (slash) {
    const [y, m, d] = [Number(slash[1]), Number(slash[2]), Number(slash[3])];
    if (valid(y, m, d)) return `${y}-${pad(m)}-${pad(d)}`;
  }
  const dash = path.match(/(?:^|[^\d])(\d{4})-(\d{2})-(\d{2})(?:[^\d]|$)/);
  if (dash) {
    const [y, m, d] = [Number(dash[1]), Number(dash[2]), Number(dash[3])];
    if (valid(y, m, d)) return `${y}-${pad(m)}-${pad(d)}`;
  }
  const compact = path.match(/(?:^|[^\d])(20\d{2})(\d{2})(\d{2})(?:[^\d]|$)/);
  if (compact) {
    const [y, m, d] = [Number(compact[1]), Number(compact[2]), Number(compact[3])];
    if (valid(y, m, d)) return `${y}-${pad(m)}-${pad(d)}`;
  }
  return undefined;
}

/**
 * Every calendar day a line of text names (ISO dates, "September 14, 2026",
 * "14 Sep 2026"). Month-only and year-only mentions are reported as the LAST
 * day of that month / year, so "October 2026" counts as after a cutoff inside
 * October — conservative for filtering evidence. `{ monthOnly: false }` keeps
 * only explicit calendar days (for auditing reasoning, where "as of August
 * 2026" is a statement of the cutoff, not a later date).
 */
export function daysMentioned(text: string, opts: { monthOnly?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (valid(y, mo, d)) out.push(`${y}-${pad(mo)}-${pad(d)}`);
  }
  const monthWord = "(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?";
  for (const m of text.matchAll(
    new RegExp(`\\b${monthWord}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"),
  )) {
    const mo = MONTHS[m[1]!.toLowerCase().slice(0, 3)];
    const [d, y] = [Number(m[2]), Number(m[3])];
    if (mo && valid(y, mo, d)) out.push(`${y}-${pad(mo)}-${pad(d)}`);
  }
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})\\s+${monthWord}\\s+(\\d{4})\\b`, "gi"))) {
    const mo = MONTHS[m[2]!.toLowerCase().slice(0, 3)];
    const [d, y] = [Number(m[1]), Number(m[3])];
    if (mo && valid(y, mo, d)) out.push(`${y}-${pad(mo)}-${pad(d)}`);
  }
  if (opts.monthOnly === false) return out;
  // Month + year with no day ("October 2026"); "14 Sep 2026" was read above.
  for (const m of text.matchAll(new RegExp(`(?<!\\d\\s)\\b${monthWord}\\s+(\\d{4})\\b`, "gi"))) {
    const mo = MONTHS[m[1]!.toLowerCase().slice(0, 3)];
    const y = Number(m[2]);
    if (mo && valid(y, mo, 1))
      out.push(`${y}-${pad(mo)}-${pad(new Date(Date.UTC(y, mo, 0)).getUTCDate())}`);
  }
  return out;
}

const LINK = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)|(?<![(\w])(https?:\/\/[^\s)\]]+)/g;

/** The URLs a report line cites. */
export function citedUrls(line: string): string[] {
  return [...line.matchAll(LINK)].map((m) => (m[1] ?? m[2])!.replace(/[.,;]+$/, ""));
}

export function isLiveResultPage(url: string): boolean {
  const u = url.toLowerCase();
  return LIVE_RESULT_HOSTS.some((h) => u.includes(h));
}

/** A source's publication day: the engine's date, else the URL's. */
export function publishedDay(src: Pick<Source, "url" | "published">): string | undefined {
  return src.published?.slice(0, 10) ?? urlPublishedDay(src.url);
}

export interface FilterStats {
  linesIn: number;
  linesKept: number;
  dropped: {
    uncited: number;
    undated: number;
    afterCutoff: number;
    liveResult: number;
    laterDate: number;
  };
}

/**
 * Keep only report lines whose every cited page has a known publication day
 * on or before `until`, that cite no live-result page, and that name no day
 * after `until`. Headings (`## engine`) pass. Sources are filtered the same way.
 */
export function filterReport(
  report: ResearchReport,
  until: string,
): { report: ResearchReport; stats: FilterStats } {
  const dated = new Map(report.sources.map((s) => [s.url, publishedDay(s)]));
  const stats: FilterStats = {
    linesIn: 0,
    linesKept: 0,
    dropped: { uncited: 0, undated: 0, afterCutoff: 0, liveResult: 0, laterDate: 0 },
  };
  const kept: string[] = [];
  for (const line of report.report.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (/^#{1,6}\s/.test(t)) {
      kept.push(line);
      continue;
    }
    stats.linesIn++;
    const urls = citedUrls(t);
    if (urls.length === 0) {
      stats.dropped.uncited++;
      continue;
    }
    if (urls.some(isLiveResultPage)) {
      stats.dropped.liveResult++;
      continue;
    }
    const days = urls.map((u) => dated.get(u) ?? urlPublishedDay(u));
    if (days.some((d) => d === undefined)) {
      stats.dropped.undated++;
      continue;
    }
    if (days.some((d) => d! > until)) {
      stats.dropped.afterCutoff++;
      continue;
    }
    if (daysMentioned(t).some((d) => d > until)) {
      stats.dropped.laterDate++;
      continue;
    }
    kept.push(line);
    stats.linesKept++;
  }
  const keptUrls = new Set(kept.flatMap(citedUrls));
  const sources = report.sources
    .filter((s) => keptUrls.has(s.url))
    .map((s) => {
      const day = publishedDay(s);
      return day ? { ...s, published: day } : s;
    });
  return {
    report: {
      ...report,
      report: kept.some((l) => !/^#{1,6}\s/.test(l.trim()))
        ? kept.join("\n")
        : `Nothing found that is provably published on or before ${until}.`,
      sources,
      retriever: `strict(${report.retriever})`,
    },
    stats,
  };
}

/**
 * Wrap any retriever so its report keeps only provably pre-cutoff lines
 * (`filterReport` against the brief's `until`). A brief without `until` is
 * refused: a strict filter with no cutoff would silently pass everything.
 * `onFilter` receives each brief's filter statistics (for an audit).
 */
export function strictDateFilter(
  inner: Retriever,
  onFilter?: (brief: ResearchBrief, stats: FilterStats) => void,
): Retriever {
  return async (brief) => {
    if (!brief.until) throw new Error("strict date filter: the brief has no cutoff (until)");
    const r = await inner(brief);
    const { report, stats } = filterReport(r, brief.until);
    onFilter?.(brief, stats);
    return report;
  };
}

/** No retrieval: every brief gets an empty report (a closed-book lower bound). */
export function closedBookRetriever(): Retriever {
  return async () => ({
    report: "Closed-book: no retrieval was performed.",
    sources: [],
    costUsd: 0,
    searches: 0,
    retriever: "closed-book",
  });
}

/**
 * The isolation a retriever spec gives a past-cutoff forecast. Engines that
 * filter by publication date server-side are `date-filtered`; a `strict` wrap
 * is `post-filtered`; `closed-book` is itself; anything else is `contaminated`.
 */
export function isolationOfSpec(spec: string, strict: boolean): IsolationLevel {
  const trimmed = spec.trim();
  if (!trimmed || trimmed.split(",").every((p) => p.trim() === "closed-book")) return "closed-book";
  // Date-strict (`asof:` engines bound to the exact cutoff instant; see retrieve.ts).
  if (isDateStrictSpec(trimmed)) return "date-filtered";
  // Day-granular server-side date filters (Tavily `end_date`, Exa `endPublishedDate`).
  const kinds = trimmed
    .split(",")
    .map((p) => p.trim().split(":")[0])
    .filter(Boolean);
  if (kinds.every((k) => k === "tavily" || k === "exa" || k === "closed-book"))
    return "date-filtered";
  return strict ? "post-filtered" : "contaminated";
}
