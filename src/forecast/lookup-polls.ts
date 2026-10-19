// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Other pollsters' published readings of one quantity — presidential approval
 * or the generic congressional ballot — from VoteHub's keyless poll API
 * (`https://api.votehub.com/polls`, the whole dated archive, attribution
 * "VoteHub"). Each poll carries its fieldwork dates and `created_at`, the day
 * VoteHub listed it; that day is the publication date used for the cutoff.
 *
 * Leakage rule: `created_at` is a calendar day without a time or time zone,
 * so for a past cutoff a poll counts only when the whole of its listing day
 * (taken as ending 08:00 UTC the next day, the latest US time zone) is before
 * the cutoff. A live read (cutoff ≈ now) may use anything listed by today.
 * Polls whose fieldwork ends after the cutoff are never read.
 *
 * Output: the polls with the most recent fieldwork (28 days at most — VoteHub
 * also lists old polls late) as lines dated by their listing day
 * (Approve/Disapprove or Dem/Rep and the net), plus one line comparing the
 * mean net of the latest 14 days of fieldwork with the 14 days before — the
 * cross-pollster change, which is what the arena may use (never the level).
 */

import { type LookupFetch, lookupFetch } from "./lookup-http";
import {
  type ForecastLookup,
  isLiveCutoff,
  type LookupResult,
  type PollHints,
  skippedResult,
} from "./lookup-types";

const API = "https://api.votehub.com/polls";
const SITE = "https://votehub.com/polls/";
const DAY_MS = 86_400_000;
/** The listing day ends at 08:00 UTC the next day (US Pacific midnight). */
const LISTING_DAY_END_MS = 32 * 3_600_000;
const WINDOW_DAYS = 14;
const MAX_POLL_LINES = 8;

export interface VoteHubPoll {
  pollster: string;
  population?: string | null;
  sample_size?: number | null;
  created_at: string;
  start_date?: string | null;
  end_date?: string | null;
  url?: string | null;
  subject?: string | null;
  answers: Array<{ choice: string; pct: number }>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The day a poll measures: its fieldwork end, else its listing day. */
const fieldDay = (p: VoteHubPoll) =>
  p.end_date && DATE.test(p.end_date) ? p.end_date : p.created_at;
const round1 = (x: number) => Math.round(x * 10) / 10;

/** The poll's net (Approve − Disapprove, or Dem − Rep), when both answers are present. */
export function pollNet(p: VoteHubPoll, type: PollHints["type"]): number | undefined {
  const [a, b] = type === "approval" ? ["approve", "disapprove"] : ["dem", "rep"];
  const pct = (c: string) => p.answers.find((x) => x.choice.trim().toLowerCase() === c)?.pct;
  const x = pct(a);
  const y = pct(b);
  return Number.isFinite(x) && Number.isFinite(y) ? round1(x! - y!) : undefined;
}

/**
 * Whether a poll was public at the cutoff: listed (whole listing day) before
 * a past cutoff, or listed by today for a live read; fieldwork ended by then.
 */
export function pollAvailable(p: VoteHubPoll, cutoff: Date, now: Date): boolean {
  if (!DATE.test(p.created_at)) return false;
  const listed = Date.parse(`${p.created_at}T00:00:00Z`);
  const ok = isLiveCutoff(cutoff, now)
    ? p.created_at <= day(cutoff.getTime())
    : listed + LISTING_DAY_END_MS <= cutoff.getTime();
  if (!ok) return false;
  return !p.end_date || p.end_date <= p.created_at;
}

export function voteHubLookup(http: LookupFetch = lookupFetch("votehub")): ForecastLookup {
  const name = "votehub";
  return {
    name,
    async lookup(_query, cutoff, now, ctx) {
      const hints = ctx?.hints?.polls;
      if (!hints) return skippedResult(name, "no poll quantity named for this question");
      const params = new URLSearchParams({ poll_type: hints.type, subject: hints.subject });
      const r = await http.json<VoteHubPoll[]>(`${API}?${params}`);
      if (!r.ok) return skippedResult(name, r.error);
      if (!Array.isArray(r.value)) return skippedResult(name, "VoteHub returned no poll list");
      const exclude = (hints.exclude ?? []).map((s) => s.toLowerCase());
      const label = hints.label ?? `${hints.subject} ${hints.type}`;
      const polls = r.value
        .filter((p) => p && typeof p.pollster === "string" && Array.isArray(p.answers))
        .filter((p) => !exclude.some((x) => p.pollster.toLowerCase().includes(x)))
        .filter((p) => pollAvailable(p, cutoff, now))
        .map((p) => ({ p, net: pollNet(p, hints.type) }))
        .filter((x): x is { p: VoteHubPoll; net: number } => x.net !== undefined)
        .sort(
          (a, b) =>
            fieldDay(b.p).localeCompare(fieldDay(a.p)) ||
            b.p.created_at.localeCompare(a.p.created_at),
        );
      // Recency is the fieldwork's: VoteHub also lists old polls late (backfill).
      const end = cutoff.getTime();
      const recent = polls.filter(
        (x) => Date.parse(fieldDay(x.p)) >= end - 2 * WINDOW_DAYS * DAY_MS,
      );
      if (recent.length === 0)
        return skippedResult(name, "no poll with fieldwork in the 28 days before the cutoff");
      const lines: string[] = [];
      const netName = hints.type === "approval" ? "net" : "Dem−Rep";
      for (const { p, net } of recent.slice(0, MAX_POLL_LINES)) {
        const answers = p.answers
          .filter((a) => Number.isFinite(a.pct))
          .map((a) => `${a.choice} ${a.pct}%`)
          .join(", ");
        const who = [p.population, p.sample_size ? `n=${p.sample_size}` : undefined]
          .filter(Boolean)
          .join(", ");
        const field =
          p.start_date && p.end_date ? `fieldwork ${p.start_date} to ${p.end_date}` : "";
        const meta = [who, field].filter(Boolean).join("; ");
        lines.push(
          `- ${p.created_at} — VoteHub: ${p.pollster} ${label}${meta ? ` (${meta})` : ""}: ${answers}; ${netName} ${net} [VoteHub](${SITE})`,
        );
      }
      const windowPolls = (from: number, to: number) =>
        polls.filter((x) => {
          const t = Date.parse(fieldDay(x.p));
          return t >= from && t < to;
        });
      const mean = (xs: typeof polls) => round1(xs.reduce((s, x) => s + x.net, 0) / xs.length);
      const latest = fieldDay(polls[0]!.p);
      const lastDay = Date.parse(`${latest}T00:00:00Z`) + DAY_MS;
      const now14 = windowPolls(lastDay - WINDOW_DAYS * DAY_MS, lastDay);
      const prev14 = windowPolls(
        lastDay - 2 * WINDOW_DAYS * DAY_MS,
        lastDay - WINDOW_DAYS * DAY_MS,
      );
      if (now14.length >= 2 && prev14.length >= 2) {
        const listed = [...now14, ...prev14]
          .map((x) => x.p.created_at)
          .sort()
          .at(-1)!;
        const from = day(lastDay - WINDOW_DAYS * DAY_MS);
        const prevFrom = day(lastDay - 2 * WINDOW_DAYS * DAY_MS);
        lines.unshift(
          `- ${listed} — VoteHub: other pollsters' ${label}, mean ${netName} ${mean(now14)} across ${now14.length} polls with fieldwork ending ${from} to ${latest}, vs ${mean(prev14)} across ${prev14.length} ending from ${prevFrom}; change ${round1(mean(now14) - mean(prev14))} (mixed pollsters and populations) [VoteHub](${SITE})`,
        );
      }
      const out: LookupResult = {
        name,
        lines,
        sources: [{ url: SITE, title: `VoteHub ${label} polls` }],
        mode: isLiveCutoff(cutoff, now) ? "live" : "historical",
        asOf: cutoff.toISOString(),
      };
      return out;
    },
  };
}
