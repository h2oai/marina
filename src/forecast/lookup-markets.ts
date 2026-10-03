// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prediction-market lookups: Polymarket and Kalshi prices as dossier lines.
 *
 * Live (the cutoff is now): current prices of open markets.
 * Historical (the cutoff is in the past): the last price at or before the
 * cutoff, from each venue's price history — never a later price, never the
 * market's resolution. A venue or market without history before the cutoff
 * contributes nothing. Market search itself returns markets that exist now,
 * so a market created after the cutoff is only usable when its history
 * reaches back before it (otherwise it is dropped).
 */

import {
  getCandlesticks,
  type KalshiCandle,
  type KalshiEvent,
  type KalshiMarket,
  getEvents as kalshiEvents,
} from "../net/kalshi-client";
import {
  type PolymarketEvent,
  type PolymarketMarket,
  type pricesHistory,
  searchEvents,
} from "../net/polymarket-client";
import { bestMatches, isMatch, nearDate, overlap, tokens } from "./lookup-match";
import {
  type ForecastLookup,
  isLiveCutoff,
  type LookupContext,
  type LookupResult,
  skippedResult,
} from "./lookup-types";

/** How far back a historical price may be (older prices are stale, not "as of"). */
const HISTORY_WINDOW_S = 14 * 86_400;
const MAX_PRICED_MARKETS = 6;
/** Price-history requests per event at most (markets without history before the cutoff are skipped). */
const MAX_HISTORY_TRIES = 12;

const pct = (p: number) => `${Math.round(p * 100)}%`;
const day = (d: Date) => d.toISOString().slice(0, 10);

function questionTokens(query: string, ctx?: LookupContext): Set<string> {
  return tokens(`${query} ${ctx?.hints?.markets ?? ""}`);
}

// ─── Polymarket ─────────────────────────────────────────────────────────────

export function polymarketLookup(
  search: typeof searchEvents = searchEvents,
  maxEvents = 4,
  history?: typeof pricesHistory,
): ForecastLookup {
  const name = "polymarket";
  return {
    name,
    async lookup(query, cutoff, now, ctx) {
      const live = isLiveCutoff(cutoff, now);
      if (!live && !history) return skippedResult(name, "cutoff in the past");
      const phrase = (ctx?.hints?.markets || query).slice(0, 200);
      const r = await search(phrase, maxEvents, {}, !live);
      if (!r.ok) return skippedResult(name, r.error);
      const qt = questionTokens(query, ctx);
      const matched = bestMatches(r.response.slice(0, maxEvents * 2), qt, (ev) => ev.title);
      if (matched.length === 0) return skippedResult(name, "no market matched the question");
      const out: LookupResult = {
        name,
        lines: [],
        sources: [],
        mode: live ? "live" : "historical",
        asOf: (live ? now : cutoff).toISOString(),
      };
      let priced = 0;
      for (const ev of matched) {
        const url = `https://polymarket.com/event/${encodeURIComponent(ev.slug)}`;
        const lines = live
          ? liveLines(ev, qt)
          : await historicalLines(ev, cutoff, history!, MAX_PRICED_MARKETS - priced, qt);
        if (lines.length === 0) continue;
        priced += lines.length;
        out.sources.push({ url, title: ev.title });
        for (const l of lines) {
          out.lines.push(
            `- ${day(live ? now : cutoff)} — Polymarket "${ev.title}": ${l} [Polymarket](${url})`,
          );
        }
        if (priced >= MAX_PRICED_MARKETS) break;
      }
      if (out.lines.length === 0) {
        return {
          ...out,
          skipped: live ? "no priced open markets matched" : "no price at or before the cutoff",
        };
      }
      return out;
    },
  };
}

function parseJsonArray(s: string | undefined): string[] {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function liveLines(ev: PolymarketEvent, qt: Set<string>): string[] {
  const out: string[] = [];
  for (const m of rankMarkets(ev.markets ?? [], qt)) {
    if (out.length >= 6) break;
    if (m.closed) continue;
    const prices = parseJsonArray(m.outcomePrices);
    const outcomes = m.outcomes ? parseJsonArray(m.outcomes) : ["Yes", "No"];
    const pairs = outcomes
      .map((o, i) => `${o} ${pct(Number(prices[i]))}`)
      .filter((s) => !s.endsWith("NaN%"));
    if (pairs.length) out.push(`${m.question} — ${pairs.join(", ")}`);
  }
  return out;
}

/** Markets ordered by how closely their wording matches the question (stable for ties). */
function rankMarkets(markets: PolymarketMarket[], qt: Set<string>): PolymarketMarket[] {
  return markets
    .map((m, i) => ({ m, i, s: overlap(qt, m.question).shared }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.m);
}

async function historicalLines(
  ev: PolymarketEvent,
  cutoff: Date,
  history: typeof pricesHistory,
  budget: number,
  qt: Set<string>,
): Promise<string[]> {
  const out: string[] = [];
  const endTs = Math.floor(cutoff.getTime() / 1000);
  // An event's markets are often a ladder of dates or thresholds; the ones
  // closest to the question are tried first, and a market with no history
  // before the cutoff (opened later, or long settled) is passed over.
  for (const m of rankMarkets(ev.markets ?? [], qt).slice(0, MAX_HISTORY_TRIES)) {
    if (out.length >= budget) break;
    const tokenId = parseJsonArray(m.clobTokenIds)[0];
    if (!tokenId) continue;
    const h = await history(tokenId, endTs - HISTORY_WINDOW_S, endTs);
    if (!h.ok) continue;
    const last = h.response.filter((pt) => pt.t <= endTs).sort((a, b) => b.t - a.t)[0];
    if (!last || !Number.isFinite(last.p)) continue;
    const outcomes = m.outcomes ? parseJsonArray(m.outcomes) : ["Yes", "No"];
    const at = new Date(last.t * 1000).toISOString().slice(0, 16);
    out.push(`${m.question} — ${outcomes[0] ?? "Yes"} ${pct(last.p)} (price at ${at}Z)`);
  }
  return out;
}

// ─── Kalshi ─────────────────────────────────────────────────────────────────

export interface KalshiLookupDeps {
  events: typeof kalshiEvents;
  candles: typeof getCandlesticks;
}

const KALSHI_PAGES = 3;

const kalshiText = (ev: KalshiEvent) => `${ev.title} ${ev.sub_title ?? ""}`;

export function kalshiLookup(
  deps: KalshiLookupDeps = { events: kalshiEvents, candles: getCandlesticks },
): ForecastLookup {
  const name = "kalshi";
  return {
    name,
    async lookup(query, cutoff, now, ctx) {
      const live = isLiveCutoff(cutoff, now);
      // A past cutoff's market has probably closed or settled since; its
      // price is read from candles ending at the cutoff, never its result.
      const statuses = live ? ["open"] : ["open", "closed", "settled"];
      const qt = questionTokens(query, ctx);
      const found: KalshiEvent[] = [];
      let lastError: string | undefined;
      for (const status of statuses) {
        let cursor: string | undefined;
        for (let page = 0; page < KALSHI_PAGES; page++) {
          const r = await deps.events({ status, limit: 200, withMarkets: true, cursor });
          if (!r.ok) {
            lastError = r.error;
            break;
          }
          for (const ev of r.response.events ?? []) {
            if (isMatch(overlap(qt, kalshiText(ev)))) found.push(ev);
          }
          cursor = r.response.cursor;
          if (!cursor) break;
        }
      }
      if (found.length === 0) {
        return skippedResult(name, lastError ?? "no market matched the question");
      }
      const out: LookupResult = {
        name,
        lines: [],
        sources: [],
        mode: live ? "live" : "historical",
        asOf: (live ? now : cutoff).toISOString(),
      };
      for (const ev of bestMatches(found, qt, kalshiText)) {
        if (out.lines.length >= MAX_PRICED_MARKETS) break;
        const url = `https://kalshi.com/markets/${encodeURIComponent(ev.series_ticker.toLowerCase())}`;
        let added = 0;
        for (const m of (ev.markets ?? []).slice(0, 6)) {
          if (out.lines.length >= MAX_PRICED_MARKETS) break;
          if (!nearDate(m.close_time, ctx?.endTime, 10)) continue;
          const priced = live
            ? (() => {
                const p = livePrice(m);
                return p === undefined ? undefined : { p, at: "" };
              })()
            : await priceAt(deps.candles, ev.series_ticker, m.ticker, cutoff);
          if (priced === undefined) continue;
          const at = live ? "" : ` (price at ${priced.at}Z)`;
          out.lines.push(
            `- ${day(live ? now : cutoff)} — Kalshi "${ev.title}": ${m.title || m.ticker} — Yes ${pct(priced.p)}${at} [Kalshi](${url})`,
          );
          added++;
        }
        if (added) out.sources.push({ url, title: ev.title });
      }
      if (out.lines.length === 0) {
        return {
          ...out,
          skipped: live ? "no priced open markets matched" : "no price at or before the cutoff",
        };
      }
      return out;
    },
  };
}

/** A Kalshi price as 0–1: a dollar string (current API) wins over cents (older responses). */
function kalshiPrice(dollars: string | null | undefined, cents: number | null | undefined) {
  const d = dollars == null ? Number.NaN : Number(dollars);
  if (Number.isFinite(d)) return d;
  const c = cents == null ? Number.NaN : Number(cents);
  return Number.isFinite(c) ? c / 100 : Number.NaN;
}

/** Midpoint of a bid and ask, 0–1; undefined for an empty or crossed book (a zero bid is a valid long shot). */
function mid(bid: number, ask: number): number | undefined {
  return bid >= 0 && ask > 0 && ask >= bid ? (bid + ask) / 2 : undefined;
}

/** Midpoint of the best yes bid and ask, 0–1; undefined for an empty or inactive book. */
function livePrice(m: KalshiMarket): number | undefined {
  if (m.status && !["active", "open", "initialized"].includes(m.status)) return undefined;
  return mid(kalshiPrice(m.yes_bid_dollars, m.yes_bid), kalshiPrice(m.yes_ask_dollars, m.yes_ask));
}

function candlePrice(c: KalshiCandle): number | undefined {
  const close = kalshiPrice(c.price?.close_dollars, c.price?.close);
  if (close > 0) return close;
  return mid(
    kalshiPrice(c.yes_bid?.close_dollars, c.yes_bid?.close),
    kalshiPrice(c.yes_ask?.close_dollars, c.yes_ask?.close),
  );
}

/**
 * The last candle price at or before the cutoff, and when it was. Illiquid
 * markets post a candle only when something changes, so the window reaches
 * back 30 days; the line shows the candle's own time.
 */
async function priceAt(
  candles: typeof getCandlesticks,
  series: string,
  ticker: string,
  cutoff: Date,
): Promise<{ p: number; at: string } | undefined> {
  const endTs = Math.floor(cutoff.getTime() / 1000);
  const r = await candles(series, ticker, endTs - 30 * 86_400, endTs, 60);
  if (!r.ok) return undefined;
  for (const c of (r.response.candlesticks ?? [])
    .filter((x) => x.end_period_ts <= endTs)
    .sort((a, b) => b.end_period_ts - a.end_period_ts)) {
    const p = candlePrice(c);
    if (p !== undefined) {
      return { p, at: new Date(c.end_period_ts * 1000).toISOString().slice(0, 16) };
    }
  }
  return undefined;
}
