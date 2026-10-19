// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wikipedia top-10 with scheduled events (`research:wiki-events:<model>[@<retrievers>]`).
 *
 * The recency-weighted pageview list (`rankingScores`, the `nowcast` route)
 * cannot see what has not happened yet: a film release, a premiere, an
 * execution, a final or an event's end. This card searches for events
 * scheduled in the round's target week, then lets only MECHANICALLY verified
 * ones change the list:
 *
 *   1. retrieval: the spec's retrievers, results published before the cutoff;
 *   2. extraction: one model call proposes candidates, each naming the source
 *      it came from — it never sets a rank;
 *   3. verification, per candidate, each step recorded with its reason:
 *      - the cited source is one the retriever returned, published (when the
 *        engine reports a date) on or before the cutoff, and mentions the article;
 *      - the event date is inside the target week (an event up to
 *        `EVENT_LEAD_DAYS` before it still drives that week's views), or, for an
 *        `ended` event, before the week starts;
 *      - the English Wikipedia article exists (canonical title, redirects followed);
 *      - its daily pageviews up to the last day published before the lock;
 *   4. a bounded merge: a verified upcoming event enters at no less than the
 *      list's entry bar (the 10th score) or its own recent daily level,
 *      whichever is higher, in the list's units; an `ended` event's article is
 *      demoted by `ENDED_FACTOR`. At most `MARINA_ARENA_WIKI_EVENTS_MAX_INSERT`
 *      new articles (default 3) enter.
 *
 * Web search cannot be replayed faithfully, so this card is evidence-gated
 * like any challenger: it runs in shadow (`arena shadow challengers`) and the
 * earned routing promotes it only on paired resolved rounds.
 */

import { logRejection } from "../../engine/errors";
import { Logger } from "../../engine/logger";
import { isExcludedTitle, RANKING_HALF_LIFE_DAYS, rankingScores } from "../forecast";
import { forecastCutoff } from "../freshness";
import type { Complete } from "../model-forecaster";
import type { ArenaLock, ArenaRound } from "../types";
import type { ResearchBrief } from "./briefs";
import { WIKITOP_PUBLICATION_LAG_DAYS } from "./civiqs-nowcast";
import type { ResearchReport, Retriever, Source } from "./retrieve";

const logger = new Logger();

const DAY_MS = 86_400_000;
/** An event this many days before the target week still counts toward it. */
export const EVENT_LEAD_DAYS = 2;
/** Score multiplier for an article whose verified event ended before the week. */
export const ENDED_FACTOR = 0.25;
export const DEFAULT_MAX_INSERT = 3;
/**
 * An upcoming event's article must already draw this share of the entry bar's
 * daily views. Measured on the arena's wikitop archive (10 weeks to 2026-10-11):
 * of 62 articles that entered a week's top 10 from outside the lock-time top 30,
 * the pre-lock share of the bar was p10 0.9 %, p25 3.0 %, median 8.8 %, p75 21 %;
 * the floor is the 25th percentile, so it keeps most real entrants and drops
 * articles nobody reads yet.
 */
export const ENTRY_MIN_SHARE = 0.03;
/** An `ended` article is demoted only below this share of its own 14-day peak. */
export const FALLING_SHARE = 0.5;
const ENDED_WORDS =
  /\b(ended|ends|concluded|closed|closing ceremony|final day|wrapped up|came to an end)\b/i;
/** Characters around the article's mention within which an ending word must appear. */
const ENDED_NEAR_CHARS = 250;
const MAX_CANDIDATES = 20;
/** Text per source and in total: listing pages (release calendars) put the dates deep in the page. */
const SNIPPET_CHARS = 3_000;
const TOTAL_CHARS = 60_000;

export interface WikiApi {
  /** The canonical enwiki title (underscores), redirects followed; undefined if missing. */
  canonicalTitle(title: string): Promise<string | undefined>;
  /** Daily pageviews (all agents) for `title` over [start, end] (YYYY-MM-DD, inclusive). */
  dailyViews(
    title: string,
    start: string,
    end: string,
  ): Promise<Array<{ date: string; views: number }>>;
}

export interface WikiEventsDeps {
  retriever: Retriever;
  complete: Complete;
  wiki: WikiApi;
  maxInsert?: number;
}

export type EventKind =
  | "release"
  | "premiere"
  | "execution"
  | "trial"
  | "sports"
  | "election"
  | "anniversary"
  | "launch"
  | "other"
  | "ended";

export interface EventCandidate {
  article: string;
  event: string;
  date: string;
  kind: EventKind;
  source: number;
}

export interface EventAudit extends EventCandidate {
  verified: boolean;
  reason: string;
  canonical?: string;
  sourceUrl?: string;
  /** Mean daily views over the last three published days. */
  recentDaily?: number;
  action?: "inserted" | "raised" | "demoted" | "none";
}

export interface WikiEventsResult {
  ranking: string[];
  /** The statistical list the events were merged into. */
  base: string[];
  events: EventAudit[];
  costUsd: number;
  sources: number;
  /** What was read: each retrieved source's URL and reported publication date. */
  read: Array<{ url: string; published?: string }>;
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const KINDS = new Set<EventKind>([
  "release",
  "premiere",
  "execution",
  "trial",
  "sports",
  "election",
  "anniversary",
  "launch",
  "other",
  "ended",
]);

export function wikiEventsBrief(round: ArenaRound, cutoff: string): ResearchBrief {
  const spec = round.ranking;
  const start = spec?.week_start ?? round.release_at.slice(0, 10);
  const end = spec?.week_end ?? start;
  // Search engines match dates as people write them ("October 19-25, 2026"), not ISO.
  const human = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  const year = start.slice(0, 4);
  const month = new Date(`${start}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
  const window = `${human(start)}-${human(end).replace(`${month} `, "")}, ${year}`;
  return {
    roundId: round.round_id,
    since: iso(Date.parse(cutoff) - 21 * DAY_MS),
    until: cutoff.slice(0, 10),
    untilAt: cutoff,
    request: `List events scheduled ${window} that will draw many readers to English Wikipedia articles: film and streaming releases, TV premieres and finales, executions and major trials, sports finals and championships, elections, product launches, anniversaries, and major events ending before ${human(start)}. Give the exact date and the source for each.`,
    queries: [
      `movies releasing ${window}`,
      `new on Netflix streaming ${month} ${year}`,
      `TV premiere dates ${month} ${year}`,
      `execution scheduled ${month} ${year}`,
      `championship final schedule ${window}`,
      `election ${month} ${year}`,
      `launch event ${month} ${year}`,
      `sentencing trial verdict expected ${window}`,
      `what to watch this week ${window}`,
    ],
  };
}

function sourceList(sources: Source[]): string {
  const each = Math.min(SNIPPET_CHARS, Math.floor(TOTAL_CHARS / Math.max(1, sources.length)));
  return sources
    .map((s, i) => {
      const text = (s.text ?? "").replace(/\s+/g, " ").slice(0, each);
      return `[${i}] ${s.title ?? ""} — ${s.url}${s.published ? ` (published ${s.published.slice(0, 10)})` : ""}\n${text}`;
    })
    .join("\n\n");
}

const SYSTEM =
  "You extract scheduled events from search results for a Wikipedia attention forecast. Use ONLY the numbered sources given; never invent an event, a date or an article. Reply with ONE JSON object and nothing else.";

export function extractionPrompt(
  round: ArenaRound,
  report: ResearchReport,
  base: string[],
): string {
  const spec = round.ranking;
  return [
    `Target week: ${spec?.week_start} to ${spec?.week_end}. Current statistical top list: ${base.join(", ")}.`,
    `From the sources below, list up to ${MAX_CANDIDATES} events dated inside the target week (or up to ${EVENT_LEAD_DAYS} days before it) that should send many readers to a specific English Wikipedia article, and events that ENDED before the week starts for articles in the current list (kind "ended"). Be inclusive: every candidate is checked mechanically afterwards (its source, date, article and pageviews), so list each dated event a source names rather than choosing; skip only what no source dates.`,
    `Reply: {"events": [{"article": "<exact English Wikipedia article title>", "event": "<what happens>", "date": "YYYY-MM-DD", "kind": "release|premiere|execution|trial|sports|election|anniversary|launch|other|ended", "source": <source number>}]}`,
    "",
    sourceList(report.sources),
  ].join("\n");
}

export function parseCandidates(reply: string): EventCandidate[] {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    // allow-empty-catch: an unparseable reply proposes nothing; the statistical list stands
    return [];
  }
  const events = (parsed as { events?: unknown }).events;
  if (!Array.isArray(events)) return [];
  const out: EventCandidate[] = [];
  for (const e of events.slice(0, MAX_CANDIDATES)) {
    const c = e as Record<string, unknown>;
    if (
      typeof c.article !== "string" ||
      typeof c.date !== "string" ||
      typeof c.source !== "number" ||
      !KINDS.has(c.kind as EventKind)
    )
      continue;
    out.push({
      article: c.article.trim(),
      event: typeof c.event === "string" ? c.event.slice(0, 200) : "",
      date: c.date.trim(),
      kind: c.kind as EventKind,
      source: c.source,
    });
  }
  return out;
}

function keyWord(article: string): string | undefined {
  return article
    .replace(/\(.*?\)/g, " ")
    .split(/[_\s:,.'"!?-]+/)
    .filter((w) => w.length >= 4)
    .sort((a, b) => b.length - a.length)[0]
    ?.toLowerCase();
}

/** Whether the source text mentions the article (its most distinctive word). */
export function mentions(source: Source, article: string): boolean {
  const key = keyWord(article);
  if (!key) return false;
  return `${source.title ?? ""} ${source.text ?? ""} ${source.url}`.toLowerCase().includes(key);
}

/** Whether an ending word appears near a mention of the article (not anywhere on a long page). */
export function endedNear(source: Source, article: string): boolean {
  const key = keyWord(article);
  if (!key) return false;
  const text = `${source.title ?? ""} ${source.text ?? ""}`;
  const lower = text.toLowerCase();
  for (let at = lower.indexOf(key); at >= 0; at = lower.indexOf(key, at + 1)) {
    const near = text.slice(Math.max(0, at - ENDED_NEAR_CHARS), at + key.length + ENDED_NEAR_CHARS);
    if (ENDED_WORDS.test(near)) return true;
  }
  return false;
}

const toTitle = (s: string) => s.trim().replace(/ /g, "_");

export async function wikiEventsRanking(
  round: ArenaRound,
  lock: ArenaLock,
  deps: WikiEventsDeps,
  now = Date.now(),
): Promise<WikiEventsResult> {
  const spec = round.ranking;
  const length = spec?.length ?? 10;
  const weekStart = spec?.week_start ?? round.release_at.slice(0, 10);
  const weekEnd = spec?.week_end ?? weekStart;
  const cutoff = forecastCutoff(round.lock_at, round.lock_at, now);
  const lastPublished = iso(
    Date.parse(cutoff.slice(0, 10)) - WIKITOP_PUBLICATION_LAG_DAYS * DAY_MS,
  );
  const scored = rankingScores(lock, spec?.items);
  if (scored.length < length)
    throw new Error(`only ${scored.length} candidates for a top-${length}`);
  const base = scored.slice(0, length).map(([t]) => t);
  // The list's units: recency-weighted views; Σ weights converts a daily level.
  const obsDays = [...(lock.answer_obs ?? [])].map((o) => o.date).sort();
  const newest = Date.parse(obsDays.at(-1)!);
  const weightSum = obsDays.reduce(
    (s, d) => s + 0.5 ** ((newest - Date.parse(d)) / DAY_MS / RANKING_HALF_LIFE_DAYS),
    0,
  );
  const bar = scored[length - 1]![1];
  const barDaily = weightSum > 0 ? bar / weightSum : bar;

  const report = await deps.retriever(wikiEventsBrief(round, cutoff));
  const reply = await deps.complete(SYSTEM, extractionPrompt(round, report, base));
  const candidates = parseCandidates(reply);

  const scores = new Map(scored);
  const events: EventAudit[] = [];
  const lo = iso(Date.parse(weekStart) - EVENT_LEAD_DAYS * DAY_MS);
  const allow = spec?.items ? new Set(spec.items) : undefined;
  const seen = new Set<string>();
  for (const c of candidates) {
    const audit: EventAudit = { ...c, verified: false, reason: "" };
    events.push(audit);
    const source = report.sources[c.source];
    if (!source) {
      audit.reason = "cited source not among the retrieved results";
      continue;
    }
    audit.sourceUrl = source.url;
    if (source.published && source.published.slice(0, 10) > cutoff.slice(0, 10)) {
      audit.reason = `source published ${source.published.slice(0, 10)}, after the cutoff`;
      continue;
    }
    if (!mentions(source, c.article)) {
      audit.reason = "cited source does not mention the article";
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.date) || !Number.isFinite(Date.parse(c.date))) {
      audit.reason = "no exact event date";
      continue;
    }
    if (c.kind === "ended" ? c.date >= weekStart : c.date < lo || c.date > weekEnd) {
      audit.reason = `event date ${c.date} outside the window`;
      continue;
    }
    const canonical = await deps.wiki
      .canonicalTitle(c.article)
      .catch(
        logRejection(logger, "arena", "wiki canonical-title lookup failed", { level: "debug" }),
      );
    if (!canonical) {
      audit.reason = "no such English Wikipedia article";
      continue;
    }
    audit.canonical = canonical;
    if (isExcludedTitle(canonical) || (allow && !allow.has(canonical))) {
      audit.reason = "article excluded by the round's rules";
      continue;
    }
    if (seen.has(canonical)) {
      audit.reason = "duplicate of an earlier candidate";
      continue;
    }
    seen.add(canonical);
    const views = await deps.wiki
      .dailyViews(canonical, iso(Date.parse(lastPublished) - 13 * DAY_MS), lastPublished)
      .catch(logRejection(logger, "arena", "wiki daily-views lookup failed", { level: "debug" }));
    if (!views) {
      audit.reason = "pageviews unavailable";
      continue;
    }
    const last3 = views.filter((v) => v.date <= lastPublished).slice(-3);
    audit.recentDaily = last3.length ? last3.reduce((s, v) => s + v.views, 0) / last3.length : 0;
    audit.verified = true;
    audit.reason = "verified";
    const current = scores.get(canonical);
    if (c.kind === "ended") {
      // A model's "ended" is not evidence: demote only when the source says the
      // event ended AND the article's own views are already falling.
      const peak = Math.max(0, ...views.map((v) => v.views));
      const falling = peak > 0 && audit.recentDaily < FALLING_SHARE * peak;
      if (current === undefined) audit.action = "none";
      else if (!endedNear(source, c.article)) {
        audit.action = "none";
        audit.reason = "verified; the cited source does not say near the article that it ended";
      } else if (!falling) {
        audit.action = "none";
        audit.reason = "verified; its views are not falling yet";
      } else {
        scores.set(canonical, current * ENDED_FACTOR);
        audit.action = "demoted";
      }
      continue;
    }
    // An upcoming event enters only when the article already draws a share of
    // the entry bar's daily level; then at no less than the bar, or its own
    // recent level (list units).
    if (current === undefined && audit.recentDaily < ENTRY_MIN_SHARE * barDaily) {
      audit.action = "none";
      audit.reason = `verified; ${Math.round(audit.recentDaily)}/d is under ${ENTRY_MIN_SHARE * 100}% of the entry bar (${Math.round(barDaily)}/d)`;
      continue;
    }
    const projected = Math.max(bar * 1.0001, audit.recentDaily * weightSum);
    if (current === undefined || projected > current) {
      scores.set(canonical, Math.max(projected, current ?? 0));
      audit.action = current === undefined ? "inserted" : "raised";
    } else audit.action = "none";
  }

  const maxInsert = deps.maxInsert ?? DEFAULT_MAX_INSERT;
  const baseSet = new Set(base);
  const ordered = [...scores.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  const ranking: string[] = [];
  let inserted = 0;
  for (const [title] of ordered) {
    if (ranking.length === length) break;
    if (!baseSet.has(title)) {
      if (inserted >= maxInsert) continue;
      inserted++;
    }
    ranking.push(title);
  }
  // A verified upcoming event still below the cut takes the lowest statistical
  // slot (several at the entry bar would otherwise crowd each other out), up to
  // the cap; raised and already-inserted entries are never displaced.
  const keep = new Set(
    events.filter((e) => e.action === "raised" || e.action === "inserted").map((e) => e.canonical),
  );
  const pending = events
    .filter((e) => e.action === "inserted" && e.canonical && !ranking.includes(e.canonical))
    .sort((a, b) => (scores.get(b.canonical!) ?? 0) - (scores.get(a.canonical!) ?? 0));
  for (const e of pending) {
    if (inserted >= maxInsert) break;
    let slot = ranking.length - 1;
    while (slot >= 0 && keep.has(ranking[slot]!)) slot--;
    if (slot < 0) break;
    ranking[slot] = e.canonical!;
    inserted++;
  }
  for (const e of events)
    if (e.action === "inserted" && e.canonical && !ranking.includes(e.canonical)) e.action = "none";
  return {
    ranking,
    base,
    events,
    costUsd: report.costUsd,
    sources: report.sources.length,
    read: report.sources.map((x) => ({
      url: x.url,
      ...(x.published ? { published: x.published.slice(0, 10) } : {}),
    })),
  };
}

/** The live Wikimedia endpoints, through the SSRF guard, with a descriptive User-Agent. */
export function wikimediaApi(fetchJson: (url: string) => Promise<unknown>): WikiApi {
  return {
    async canonicalTitle(title) {
      const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1&titles=${encodeURIComponent(title.replace(/_/g, " "))}`;
      const body = (await fetchJson(url)) as {
        query?: { pages?: Array<{ title?: string; missing?: boolean; invalid?: boolean }> };
      };
      const page = body.query?.pages?.[0];
      if (!page?.title || page.missing || page.invalid) return undefined;
      return toTitle(page.title);
    },
    async dailyViews(title, start, end) {
      const day = (d: string) => d.replace(/-/g, "");
      const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/${encodeURIComponent(title)}/daily/${day(start)}00/${day(end)}00`;
      const body = (await fetchJson(url)) as {
        items?: Array<{ timestamp?: string; views?: number }>;
      };
      return (body.items ?? [])
        .filter((i) => typeof i.timestamp === "string" && typeof i.views === "number")
        .map((i) => ({
          date: `${i.timestamp!.slice(0, 4)}-${i.timestamp!.slice(4, 6)}-${i.timestamp!.slice(6, 8)}`,
          views: i.views!,
        }));
    },
  };
}
