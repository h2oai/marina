// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sports odds (The Odds API, `ODDS_API_KEY`): pre-game head-to-head prices
 * from several bookmakers, converted to implied probabilities with the
 * bookmaker margin removed and averaged across books.
 *
 * Live reads the current odds; a past cutoff reads the historical snapshot
 * at or before it (`/v4/historical/…`, a paid-plan endpoint — when the plan
 * refuses it the lookup says so and contributes nothing). Only games that
 * start after the cutoff are shown, so a price is always a pre-game price.
 * The key travels as a query parameter, so no URL is ever logged or shown.
 */

import { type LookupFetch, lookupFetch } from "./lookup-http";
import { nearDate, tokens } from "./lookup-match";
import {
  type ForecastLookup,
  isLiveCutoff,
  type LookupContext,
  type LookupResult,
  skippedResult,
} from "./lookup-types";

const BASE = "https://api.the-odds-api.com/v4";
const SOURCE = { url: "https://the-odds-api.com", title: "The Odds API" };

interface OddsOutcome {
  name: string;
  price: number;
}
interface OddsEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: Array<{ key: string; markets?: Array<{ key: string; outcomes?: OddsOutcome[] }> }>;
}

const SPORT_KEY = /^[a-z0-9_]{3,60}$/;

export function oddsLookup(
  apiKey: string | undefined,
  http: LookupFetch = lookupFetch("odds"),
): ForecastLookup {
  const name = "odds";
  return {
    name,
    async lookup(query, cutoff, now, ctx) {
      if (!apiKey) return skippedResult(name, "ODDS_API_KEY not set");
      const live = isLiveCutoff(cutoff, now);
      const hinted = ctx?.hints?.sport?.trim().toLowerCase();
      const sport = hinted && SPORT_KEY.test(hinted) ? hinted : undefined;
      if (!sport && !live) return skippedResult(name, "historical odds need a sport key");
      const params = new URLSearchParams({
        regions: "us,uk,eu",
        markets: "h2h",
        oddsFormat: "decimal",
        apiKey,
      });
      let events: OddsEvent[];
      let asOf = now.toISOString();
      if (live) {
        const r = await http.json<OddsEvent[]>(
          `${BASE}/sports/${sport ?? "upcoming"}/odds?${params}`,
        );
        if (!r.ok) return skippedResult(name, r.error);
        events = Array.isArray(r.value) ? r.value : [];
      } else {
        params.set("date", `${cutoff.toISOString().slice(0, 19)}Z`);
        const r = await http.json<{ timestamp?: string; data?: OddsEvent[] }>(
          `${BASE}/historical/sports/${sport}/odds?${params}`,
        );
        if (!r.ok) return skippedResult(name, `${r.error} (historical odds need a paid plan)`);
        const snap = r.value.timestamp ? Date.parse(r.value.timestamp) : Number.NaN;
        if (!Number.isFinite(snap) || snap > cutoff.getTime()) {
          return skippedResult(name, "no odds snapshot at or before the cutoff");
        }
        asOf = new Date(snap).toISOString();
        events = r.value.data ?? [];
      }
      const lines = matchedLines(events, query, cutoff, ctx, asOf);
      if (lines.length === 0) return skippedResult(name, "no upcoming game matched the question");
      const out: LookupResult = {
        name,
        lines,
        sources: [SOURCE],
        mode: live ? "live" : "historical",
        asOf,
      };
      return out;
    },
  };
}

/** Whether a team name is named in the question (its distinctive last word, or the full name). */
function named(team: string, q: Set<string>, hinted: Set<string>): boolean {
  const t = [...tokens(team)];
  if (t.length === 0) return false;
  const last = t[t.length - 1]!;
  return hinted.has(team.toLowerCase()) || q.has(last) || t.every((w) => q.has(w));
}

function matchedLines(
  events: OddsEvent[],
  query: string,
  cutoff: Date,
  ctx: LookupContext | undefined,
  asOf: string,
): string[] {
  const q = tokens(`${query} ${(ctx?.hints?.teams ?? []).join(" ")}`);
  const hinted = new Set((ctx?.hints?.teams ?? []).map((t) => t.toLowerCase()));
  const lines: string[] = [];
  for (const ev of events) {
    if (lines.length >= 3) break;
    const start = Date.parse(ev.commence_time);
    if (!Number.isFinite(start) || start <= cutoff.getTime()) continue; // pre-game only
    if (!nearDate(ev.commence_time, ctx?.endTime, 3)) continue;
    if (!named(ev.home_team, q, hinted) || !named(ev.away_team, q, hinted)) continue;
    const implied = impliedProbabilities(ev);
    if (!implied) continue;
    const parts = implied.probs.map(([n, p]) => `${n} ${Math.round(p * 100)}%`).join(", ");
    lines.push(
      `- ${asOf.slice(0, 10)} — Odds (${implied.books} bookmakers, pre-game, implied with the margin removed) ${ev.away_team} at ${ev.home_team}, starts ${ev.commence_time}: ${parts} [The Odds API](${SOURCE.url})`,
    );
  }
  return lines;
}

/** Mean de-vigged implied probability per outcome across bookmakers. */
export function impliedProbabilities(
  ev: Pick<OddsEvent, "bookmakers">,
): { books: number; probs: Array<[string, number]> } | undefined {
  const sum = new Map<string, number>();
  let books = 0;
  for (const b of ev.bookmakers ?? []) {
    const h2h = b.markets?.find((m) => m.key === "h2h");
    const outs = (h2h?.outcomes ?? []).filter((o) => Number(o.price) > 1);
    if (outs.length < 2) continue;
    const inv = outs.map((o) => 1 / Number(o.price));
    const total = inv.reduce((a, c) => a + c, 0);
    outs.forEach((o, i) => {
      sum.set(o.name, (sum.get(o.name) ?? 0) + inv[i]! / total);
    });
    books++;
  }
  if (books === 0) return undefined;
  const probs = [...sum.entries()]
    .map(([n, s]) => [n, s / books] as [string, number])
    .sort((a, b) => b[1] - a[1]);
  return { books, probs };
}

/** One game on an odds board. */
export interface OddsGame {
  sport: string;
  start: string;
  away: string;
  home: string;
  books: number;
  probs: Array<[string, number]>;
}

/**
 * An odds board: upcoming games (pre-game only) with de-vigged implied
 * probabilities, for a sport key (else every upcoming game) and optionally
 * only games naming one of `teams`. A past `asOf` reads the historical
 * snapshot at or before it (a paid-plan endpoint; it needs a sport key).
 * The general surface behind `data odds` and the search room's `odds` verb.
 */
export async function oddsBoard(
  apiKey: string | undefined,
  opts: { sport?: string; teams?: string[]; asOf?: Date; now: Date; limit?: number },
  http: LookupFetch = lookupFetch("odds"),
): Promise<{ games: OddsGame[]; asOf: string; mode: "live" | "historical" } | { error: string }> {
  if (!apiKey) return { error: "ODDS_API_KEY not set" };
  const at = opts.asOf && opts.asOf.getTime() < opts.now.getTime() ? opts.asOf : opts.now;
  const live = isLiveCutoff(at, opts.now);
  const sport = opts.sport?.trim().toLowerCase();
  if (sport && !SPORT_KEY.test(sport)) return { error: `not a sport key: ${opts.sport}` };
  if (!live && !sport)
    return { error: "a past asof: needs a sport key (e.g. americanfootball_nfl)" };
  const params = new URLSearchParams({
    regions: "us,uk,eu",
    markets: "h2h",
    oddsFormat: "decimal",
    apiKey,
  });
  let events: OddsEvent[];
  let asOf = opts.now.toISOString();
  if (live) {
    const r = await http.json<OddsEvent[]>(`${BASE}/sports/${sport ?? "upcoming"}/odds?${params}`);
    if (!r.ok) return { error: r.error };
    events = Array.isArray(r.value) ? r.value : [];
  } else {
    params.set("date", `${at.toISOString().slice(0, 19)}Z`);
    const r = await http.json<{ timestamp?: string; data?: OddsEvent[] }>(
      `${BASE}/historical/sports/${sport}/odds?${params}`,
    );
    if (!r.ok) return { error: `${r.error} (historical odds need a paid plan)` };
    const snap = r.value.timestamp ? Date.parse(r.value.timestamp) : Number.NaN;
    if (!Number.isFinite(snap) || snap > at.getTime()) {
      return { error: "no odds snapshot at or before that date" };
    }
    asOf = new Date(snap).toISOString();
    events = r.value.data ?? [];
  }
  const wanted = (opts.teams ?? []).flatMap((t) => [...tokens(t)]);
  const games: OddsGame[] = [];
  for (const ev of events) {
    if (games.length >= (opts.limit ?? 10)) break;
    const start = Date.parse(ev.commence_time);
    if (!Number.isFinite(start) || start <= at.getTime()) continue; // pre-game only
    if (wanted.length > 0) {
      const names = tokens(`${ev.home_team} ${ev.away_team}`);
      if (!wanted.some((w) => names.has(w))) continue;
    }
    const implied = impliedProbabilities(ev);
    if (!implied) continue;
    games.push({
      sport: ev.sport_key,
      start: ev.commence_time,
      away: ev.away_team,
      home: ev.home_team,
      books: implied.books,
      probs: implied.probs,
    });
  }
  return { games, asOf, mode: live ? "live" : "historical" };
}
