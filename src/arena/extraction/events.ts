// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The scheduled-events extractor (`events`): does the subject have a dated
 * event inside the forecast window (a release, premiere, final, election,
 * ceremony, trial, anniversary), or one that just ended?
 *
 *   1. candidates, mechanically: sentences of the article's own text at the
 *      cutoff (the revision at or before it, `rvstart`) and of date-strict
 *      search results (`ctx.retriever`, `asof:…`) that state a date in the
 *      window (or up to `EVENT_LEAD_DAYS` before it), or a recent past date
 *      next to an ending word;
 *   2. one narrow model call per subject WITH candidates classifies them —
 *      which sentence, what kind, how sure — and never invents a date: the
 *      date it returns must be one the cited sentence states;
 *   3. a subject with no dated sentence costs nothing and gets no record.
 *
 * Records: `event.in_window` (1, the event's date and kind in `detail`) and
 * `event.ended` (1), with the model's confidence and the sentence's source.
 */

import { wikitextToPlain } from "../../engine/search-providers/wikipedia";
import {
  type AttentionContext,
  type AttentionFeature,
  addDays,
  atOrBefore,
  type Extractor,
  mapLimit,
  skipOnError,
} from "./features";

export const EVENT_LEAD_DAYS = 2;
/** How far back an "ended" sentence may be dated. */
export const ENDED_LOOKBACK_DAYS = 14;
const MAX_SENTENCES = 12;
const SENTENCE_CHARS = 400;
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
/** Words that make a year-less date ("on October 23") a scheduled one, so the window's year applies. */
const FUTURE =
  /\b(will|scheduled|set to|slated|expected|upcoming|due to|is to|are to|plans? to|planned|to be (?:released|held|broadcast)|premieres|opens)\b/i;
const ENDED =
  /\b(ended|concluded|finale|final episode|closed|closing|wrapped|last episode|was cancelled|canceled)\b/i;
export const EVENT_KINDS = [
  "release",
  "premiere",
  "sports",
  "election",
  "ceremony",
  "trial",
  "anniversary",
  "launch",
  "other",
] as const;

/** Every date a sentence states, as YYYY-MM-DD (month-name forms need a year in the sentence). */
export function datesIn(sentence: string, defaultYear?: string): string[] {
  const out = new Set<string>();
  const pad = (n: number) => String(n).padStart(2, "0");
  const add = (y: number, m: number, d: number) => {
    const s = `${y}-${pad(m)}-${pad(d)}`;
    const t = Date.parse(`${s}T00:00:00Z`);
    if (Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s) out.add(s);
  };
  for (const m of sentence.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(+m[1]!, +m[2]!, +m[3]!);
  const mon = MONTHS.join("|");
  const years = [...sentence.matchAll(/\b(20\d{2})\b/g)].map((m) => m[1]!);
  const year = years[0] ?? defaultYear;
  // "October 23, 2026", "October 23" (the sentence's year)
  for (const m of sentence.matchAll(
    new RegExp(`\\b(${mon})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\b`, "gi"),
  )) {
    const y = m[3] ?? year;
    if (y) add(+y, MONTHS.indexOf(m[1]!.toLowerCase()) + 1, +m[2]!);
  }
  // "23 October 2026", "23 October"
  for (const m of sentence.matchAll(
    new RegExp(`\\b(\\d{1,2})\\s+(${mon})(?:\\s+(\\d{4}))?\\b`, "gi"),
  )) {
    const y = m[3] ?? year;
    if (y) add(+y, MONTHS.indexOf(m[2]!.toLowerCase()) + 1, +m[1]!);
  }
  return [...out].sort();
}

export interface DatedSentence {
  text: string;
  dates: string[];
  source: string;
  /** When the source was published or revised (≤ cutoff). */
  at: string;
  ended: boolean;
}

/** Sentences of `text` stating a date in [window.start − lead, window.end], or a recent date beside an ending word. */
export function datedSentences(
  text: string,
  ctx: Pick<AttentionContext, "window" | "lastDay">,
  source: string,
  at: string,
): DatedSentence[] {
  const lo = addDays(ctx.window.start, -EVENT_LEAD_DAYS);
  const endedLo = addDays(ctx.lastDay, -ENDED_LOOKBACK_DAYS);
  const out: DatedSentence[] = [];
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.trim();
    if (s.length < 12) continue;
    // A year-less date is read in the window's year only beside a scheduling word.
    const dates = datesIn(s, FUTURE.test(s) ? ctx.window.start.slice(0, 4) : undefined);
    const inWindow = dates.filter((d) => d >= lo && d <= ctx.window.end);
    const ended = ENDED.test(s) && dates.some((d) => d >= endedLo && d < ctx.window.start);
    if (inWindow.length || ended)
      out.push({
        text: s.slice(0, SENTENCE_CHARS),
        dates: inWindow.length ? inWindow : dates.filter((d) => d >= endedLo),
        source,
        at,
        ended: !inWindow.length,
      });
    if (out.length >= MAX_SENTENCES) break;
  }
  return out;
}

/** The article's full wikitext at the latest revision at or before `asOf`. */
export function fullRevisionUrl(title: string, asOf: string): string {
  return (
    "https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&prop=revisions" +
    `&titles=${encodeURIComponent(title.replace(/_/g, " "))}` +
    `&rvlimit=1&rvdir=older&rvstart=${encodeURIComponent(new Date(asOf).toISOString())}` +
    "&rvprop=ids%7Ctimestamp%7Ccontent&rvslots=main"
  );
}

async function articleAsOf(
  ctx: AttentionContext,
  title: string,
): Promise<{ text: string; permalink: string; at: string } | undefined> {
  const body = (await ctx.fetchJson(fullRevisionUrl(title, ctx.cutoff))) as {
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
  if (!rev?.revid || !rev.timestamp || !atOrBefore(rev.timestamp, ctx.cutoff)) return undefined;
  return {
    text: wikitextToPlain(rev.slots?.main?.content ?? ""),
    permalink: `https://en.wikipedia.org/w/index.php?oldid=${rev.revid}`,
    at: rev.timestamp,
  };
}

const SYSTEM =
  "You classify dated sentences about one Wikipedia article's subject for an attention forecast. Use ONLY the numbered sentences; never invent a date. Reply with ONE JSON object and nothing else.";

export function eventsPrompt(
  subject: string,
  ctx: Pick<AttentionContext, "window" | "cutoff">,
  sentences: DatedSentence[],
): string {
  return [
    `Article: ${subject.replace(/_/g, " ")}. Information as of ${ctx.cutoff.slice(0, 10)}. Forecast window: ${ctx.window.start} to ${ctx.window.end}.`,
    "Which sentence (if any) says an event that will draw readers to THIS article is scheduled in the window (still upcoming as of the information date): a release, premiere, finale, match or final, election, ceremony, trial or verdict, anniversary or launch? Which (if any) says such an event just ENDED before the window? Ignore dates of past history, births, or unrelated subjects.",
    `Reply: {"upcoming": {"sentence": <n>, "date": "YYYY-MM-DD", "kind": "${EVENT_KINDS.join("|")}", "confidence": <0-1>} | null, "ended": {"sentence": <n>, "date": "YYYY-MM-DD", "confidence": <0-1>} | null}`,
    "",
    ...sentences.map((s, i) => `[${i}] ${s.text}`),
  ].join("\n");
}

export interface EventPick {
  sentence: number;
  date: string;
  kind?: string;
  confidence: number;
}

export function parseEventReply(reply: string): { upcoming?: EventPick; ended?: EventPick } {
  const m = reply.match(/\{[\s\S]*\}/);
  if (!m) return {};
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    // allow-empty-catch: an unparseable reply is no event
    return {};
  }
  const pick = (x: unknown): EventPick | undefined => {
    const o = x as Record<string, unknown> | null;
    if (!o || typeof o.sentence !== "number" || typeof o.date !== "string") return undefined;
    const c = typeof o.confidence === "number" ? Math.min(1, Math.max(0, o.confidence)) : 0.5;
    return {
      sentence: o.sentence,
      date: o.date.trim(),
      confidence: c,
      ...(typeof o.kind === "string" ? { kind: o.kind } : {}),
    };
  };
  const out: { upcoming?: EventPick; ended?: EventPick } = {};
  const u = pick(j.upcoming);
  const e = pick(j.ended);
  if (u) out.upcoming = u;
  if (e) out.ended = e;
  return out;
}

/**
 * The mechanical check of a model's pick: the sentence exists, states that
 * date, and the date is in the window (upcoming) or before it beside an ending
 * word (ended).
 */
export function verifyPick(
  pick: EventPick,
  sentences: DatedSentence[],
  ctx: Pick<AttentionContext, "window">,
  ended: boolean,
): DatedSentence | undefined {
  const s = sentences[pick.sentence];
  if (!s?.dates.includes(pick.date)) return undefined;
  if (ended) return s.ended && pick.date < ctx.window.start ? s : undefined;
  return !s.ended && pick.date <= ctx.window.end ? s : undefined;
}

export function eventsExtractor(opts: { concurrency?: number; search?: boolean } = {}): Extractor {
  return {
    name: "events",
    kind: "model",
    async extract(ctx) {
      const complete = ctx.complete;
      if (!complete) throw new Error("the events extractor needs a model");
      const rows = await mapLimit(ctx.subjects, opts.concurrency ?? 4, async (subject) => {
        const sentences: DatedSentence[] = [];
        const page = await articleAsOf(ctx, subject).catch(
          skipOnError("article revision", undefined),
        );
        if (page) sentences.push(...datedSentences(page.text, ctx, page.permalink, page.at));
        if (opts.search !== false && ctx.retriever) {
          const human = subject
            .replace(/_/g, " ")
            .replace(/\s*\(.*?\)\s*/g, " ")
            .trim();
          const report = await ctx
            .retriever({
              roundId: `attention:${subject}`,
              since: addDays(ctx.lastDay, -21),
              until: ctx.cutoff.slice(0, 10),
              untilAt: ctx.cutoff,
              request: `Upcoming dated events for ${human} between ${ctx.window.start} and ${ctx.window.end}.`,
              queries: [`${human} ${ctx.window.start.slice(0, 7)}`],
            })
            .catch(skipOnError("event search", undefined));
          for (const src of report?.sources ?? []) {
            if (!src.published || !atOrBefore(src.published, ctx.cutoff) || !src.text) continue;
            sentences.push(...datedSentences(src.text, ctx, src.url, src.published));
          }
        }
        const kept = sentences.slice(0, MAX_SENTENCES);
        if (kept.length === 0) return [];
        const reply = await complete(SYSTEM, eventsPrompt(subject, ctx, kept)).catch(
          skipOnError("event classification call", ""),
        );
        const picks = parseEventReply(reply);
        const out: AttentionFeature[] = [];
        if (picks.upcoming) {
          const s = verifyPick(picks.upcoming, kept, ctx, false);
          if (s)
            out.push({
              subject,
              feature: "event.in_window",
              value: 1,
              asOf: ctx.cutoff,
              source: s.source,
              confidence: picks.upcoming.confidence,
              extractor: "events",
              detail: {
                date: picks.upcoming.date,
                kind: picks.upcoming.kind ?? "other",
                publishedAt: s.at,
                sentence: s.text.slice(0, 200),
              },
            });
        }
        if (picks.ended) {
          const s = verifyPick(picks.ended, kept, ctx, true);
          if (s)
            out.push({
              subject,
              feature: "event.ended",
              value: 1,
              asOf: ctx.cutoff,
              source: s.source,
              confidence: picks.ended.confidence,
              extractor: "events",
              detail: { date: picks.ended.date, publishedAt: s.at, sentence: s.text.slice(0, 200) },
            });
        }
        return out;
      });
      return rows.flat();
    },
  };
}
