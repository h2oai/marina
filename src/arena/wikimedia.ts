// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wikimedia daily top lists for the Wikipedia specialist (`wiki-specialist.ts`).
 *
 * Source order: the arena's own `wikitop/` archive (what the round resolves
 * on), then the Wikimedia REST endpoint
 * `metrics/pageviews/top/en.wikipedia/all-access/{yyyy}/{mm}/{dd}` for a day
 * the archive lacks (the archive starts 2026-07-20 and has gaps; the two agree
 * view for view where both exist). Only days published before the lock are
 * requested: the newest is the lock day − `WIKITOP_PUBLICATION_LAG_DAYS`, so a
 * replayed round reads exactly what existed when it locked — a day's list is
 * final once published.
 *
 * Etiquette (https://meta.wikimedia.org/wiki/User-Agent_policy): a descriptive
 * User-Agent with a contact URL, requests serialised at least
 * `MIN_SPACING_MS` apart, and an in-process cache (published days never
 * change). Every request goes through the SSRF guard.
 */

import { getErrorMessage } from "../engine/errors";
import { guardedFetch } from "../net/url-guard";
import type { ArenaData } from "./data";
import { forecastCutoff } from "./freshness";
import { WIKITOP_PUBLICATION_LAG_DAYS } from "./research/civiqs-nowcast";
import type { ArenaLock, ArenaRound } from "./types";
import { type DailyTop, iso } from "./wiki-specialist";

const DAY_MS = 86_400_000;
export const WIKIMEDIA_USER_AGENT = "Marina-arena/1.0 (https://github.com/h2oai/marina)";
/** Minimum gap between two Wikimedia requests from this process. */
export const MIN_SPACING_MS = 100;
const CACHE_MAX = 512;

export type FetchJson = (url: string) => Promise<unknown>;

let nextSlot = 0;
const cache = new Map<string, Promise<unknown>>();

/** GET a Wikimedia JSON resource: guarded, rate-limited, cached (failures are not cached). */
export const wikimediaFetchJson: FetchJson = (url) => {
  const hit = cache.get(url);
  if (hit) return hit;
  const run = (async () => {
    const now = Date.now();
    const wait = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + MIN_SPACING_MS;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const res = await guardedFetch(url, {
      headers: { "User-Agent": WIKIMEDIA_USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`Wikimedia ${res.status}`);
    return res.json();
  })();
  cache.set(url, run);
  run.catch(() => cache.delete(url));
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return run;
};

export function topUrl(day: string, project = "en.wikipedia", access = "all-access"): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`bad day ${day}`);
  const [y, m, d] = day.split("-");
  return `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/${encodeURIComponent(project)}/${encodeURIComponent(access)}/${y}/${m}/${d}`;
}

/** The top endpoint's body → one day's `{article: views}`; undefined when it lists nothing for that day. */
export function parseTop(body: unknown, day: string): DailyTop | undefined {
  const items = (
    body as
      | { items?: Array<{ year?: string; month?: string; day?: string; articles?: unknown }> }
      | undefined
  )?.items;
  const first = items?.[0];
  if (!first || !Array.isArray(first.articles)) return undefined;
  if (first.year && first.month && first.day && `${first.year}-${first.month}-${first.day}` !== day)
    throw new Error(
      `Wikimedia top list for ${first.year}-${first.month}-${first.day}, asked ${day}`,
    );
  const articles: Record<string, number> = {};
  for (const a of first.articles as Array<{ article?: unknown; views?: unknown }>) {
    if (typeof a.article !== "string" || typeof a.views !== "number" || !Number.isFinite(a.views))
      continue;
    articles[a.article] = (articles[a.article] ?? 0) + a.views;
  }
  return Object.keys(articles).length ? { date: day, articles } : undefined;
}

/** The newest day whose list existed at the round's information cutoff. */
export function lastPublishedDay(lockAt: string, now = Date.now()): string {
  const cutoff = forecastCutoff(lockAt, lockAt, now);
  return iso(Date.parse(cutoff.slice(0, 10)) - WIKITOP_PUBLICATION_LAG_DAYS * DAY_MS);
}

export interface DailyTopsResult {
  days: DailyTop[];
  lastDay: string;
  /** Where each day came from; days neither source had are listed as missing. */
  sources: { archive: number; wikimedia: number; missing: string[]; errors: string[] };
}

/**
 * `historyDays` daily lists ending at the round's last published day: the
 * arena archive first, then Wikimedia for the rest. Never a day after it.
 */
export async function dailyTopsForRound(
  data: Pick<ArenaData, "wikitopDay">,
  round: ArenaRound,
  historyDays: number,
  opts: { fetchJson?: FetchJson; now?: number } = {},
): Promise<DailyTopsResult> {
  const spec = round.ranking as { project?: string; access?: string } | undefined;
  const project = spec?.project ?? "en.wikipedia";
  const access = spec?.access ?? "all-access";
  const lastDay = lastPublishedDay(round.lock_at, opts.now);
  const wanted = Array.from({ length: historyDays }, (_, k) =>
    iso(Date.parse(lastDay) - (historyDays - 1 - k) * DAY_MS),
  );
  const fetchJson = opts.fetchJson ?? wikimediaFetchJson;
  const sources = { archive: 0, wikimedia: 0, missing: [] as string[], errors: [] as string[] };
  const days = await Promise.all(
    wanted.map(async (day): Promise<DailyTop | undefined> => {
      // A failed archive read falls through to Wikimedia; the reason is kept with the others.
      const archived = await data.wikitopDay(`${project}.${access}`, day).catch((err: unknown) => {
        sources.errors.push(`archive ${day}: ${getErrorMessage(err)}`);
        return undefined;
      });
      if (archived?.articles && Object.keys(archived.articles).length) {
        sources.archive++;
        return { date: day, articles: archived.articles };
      }
      try {
        const got = parseTop(await fetchJson(topUrl(day, project, access)), day);
        if (got) {
          sources.wikimedia++;
          return got;
        }
      } catch (err) {
        sources.errors.push(`${day}: ${getErrorMessage(err)}`);
      }
      sources.missing.push(day);
      return undefined;
    }),
  );
  return {
    days: days.filter((d): d is DailyTop => !!d && d.date <= lastDay),
    lastDay,
    sources,
  };
}

/** Daily lists as a lock's `answer_obs` (newest last), for the freshness audit and the event merge. */
export function asAnswerObs(days: DailyTop[]): NonNullable<ArenaLock["answer_obs"]> {
  return [...days]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({
      date: d.date,
      items: Object.keys(d.articles).sort((a, b) => d.articles[b]! - d.articles[a]!),
      views: d.articles,
    }));
}
