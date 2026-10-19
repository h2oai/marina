// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Crowd-forecast lookups: community probabilities from public forecasting
 * sites, as dossier lines and market-style prices. OPT-IN only — named in
 * `MARINA_FORECAST_LOOKUPS` / `MARINA_ARENA_RESEARCH_LOOKUPS`, never part of
 * `auto`, `all` or `markets` (`lookups.ts` `OPT_IN_LOOKUP_NAMES`).
 *
 *   manifold  Manifold Markets' keyless public API (api.manifold.markets/v0):
 *             market search, then each matched market's probability, volume
 *             and close date. Play money — the lines say so.
 *
 * Leakage rule (the same as the venue lookups in `lookup-markets.ts`):
 *
 *   live        (the cutoff is within `LIVE_SLACK_MS` of now) the market's
 *               current probability, volume and scheduled close; resolved or
 *               closed markets are skipped.
 *   historical  (a past cutoff) the probability AFTER the last trade at or
 *               before the cutoff, from the market's bet history
 *               (`/v0/bets?contractId=…&beforeTime=…`), and the mana traded
 *               up to the cutoff counted from those same bets. Never the
 *               current probability, the current volume, the (editable) close
 *               date or the resolution. A market created after the cutoff, one
 *               already resolved at the cutoff, one with no trade in the 30
 *               days before it, or one whose history cannot be read
 *               contributes NOTHING — no history, no line.
 *
 * Only yes/no (`BINARY`) markets are read historically: a multiple-choice
 * market's answers move together, so a single answer's last trade is not its
 * price at the cutoff. Live multiple-choice markets show their leading answers.
 *
 * Extension point: Good Judgment Open is NOT implemented. It publishes no
 * public API, its terms forbid automated collection, and its crowd forecast
 * history is not exposed at a past date, so no backtest-safe reading exists.
 * A future crowd source implements `ForecastLookup` here (search → dated
 * probability at or before the cutoff, nothing when history is missing) and
 * registers one builder in `lookups.ts` `OPT_IN_LOOKUPS`.
 */

import { type LookupFetch, lookupFetch } from "./lookup-http";
import { bestMatches, nearDate, tokens } from "./lookup-match";
import {
  type ForecastLookup,
  isLiveCutoff,
  type LookupResult,
  type MarketPrice,
  skippedResult,
} from "./lookup-types";

const API = "https://api.manifold.markets/v0";
const SITE = "https://manifold.markets";
const DAY_MS = 86_400_000;
/** Markets searched per question, and priced at most. */
const SEARCH_LIMIT = 20;
const MAX_MARKETS = 4;
/** A historical price older than this before the cutoff is stale, not "as of". */
const HISTORY_WINDOW_MS = 30 * DAY_MS;
/** Bets read per market for a past cutoff (newest first): the price and the mana traded. */
const BET_PAGE = 1000;
/** A market whose close is this far from the question's end is about another period. */
const CLOSE_NEAR_DAYS = 31;
const MAX_ANSWERS = 3;

export interface ManifoldAnswer {
  id?: string;
  text: string;
  probability?: number;
}

export interface ManifoldMarket {
  id: string;
  question: string;
  slug?: string;
  url?: string;
  creatorUsername?: string;
  outcomeType: string;
  probability?: number;
  volume?: number;
  createdTime: number;
  closeTime?: number | null;
  isResolved?: boolean;
  resolutionTime?: number | null;
  answers?: ManifoldAnswer[];
}

export interface ManifoldBet {
  createdTime: number;
  probBefore?: number;
  probAfter?: number;
  amount?: number;
  isRedemption?: boolean;
  isCancelled?: boolean;
  answerId?: string | null;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const minute = (ms: number) => new Date(ms).toISOString().slice(0, 16);
const mana = (x: number) => `M${Math.round(x).toLocaleString("en-US")}`;
const isProb = (p: unknown): p is number => typeof p === "number" && p >= 0 && p <= 1;

/** The market's public page: its own URL when it is on manifold.markets, else built from the slug. */
function marketUrl(m: ManifoldMarket): string {
  if (m.url?.startsWith(`${SITE}/`)) return m.url;
  if (m.creatorUsername && m.slug) {
    return `${SITE}/${encodeURIComponent(m.creatorUsername)}/${encodeURIComponent(m.slug)}`;
  }
  return `${SITE}/market/${encodeURIComponent(m.slug ?? m.id)}`;
}

function wellFormed(m: unknown): m is ManifoldMarket {
  const x = m as ManifoldMarket | undefined;
  return (
    !!x &&
    typeof x.id === "string" &&
    typeof x.question === "string" &&
    typeof x.outcomeType === "string" &&
    Number.isFinite(x.createdTime)
  );
}

/**
 * The probability after the last trade at or before `cutoffMs`, and the mana
 * traded in the bets read (newest first) — or undefined when the history has
 * no usable trade in the window. Redemptions, cancelled orders and per-answer
 * bets are not prices of the yes/no market.
 */
export function priceAtCutoff(
  bets: ManifoldBet[],
  cutoffMs: number,
): { p: number; at: number; traded: number; trades: number } | undefined {
  const before = bets.filter(
    (b) =>
      b &&
      Number.isFinite(b.createdTime) &&
      b.createdTime <= cutoffMs &&
      !b.isRedemption &&
      !b.isCancelled &&
      !b.answerId,
  );
  const last = before
    .filter((b) => isProb(b.probAfter))
    .sort((a, b) => b.createdTime - a.createdTime)[0];
  if (!last || last.createdTime < cutoffMs - HISTORY_WINDOW_MS) return undefined;
  const traded = before.reduce((s, b) => s + Math.abs(Number(b.amount) || 0), 0);
  return { p: last.probAfter!, at: last.createdTime, traded, trades: before.length };
}

export function manifoldLookup(http: LookupFetch = lookupFetch("manifold")): ForecastLookup {
  const name = "manifold";
  return {
    name,
    async lookup(query, cutoff, now, ctx) {
      const live = isLiveCutoff(cutoff, now);
      const cutoffMs = cutoff.getTime();
      const phrase = (ctx?.hints?.markets || query).slice(0, 200);
      const params = new URLSearchParams({
        term: phrase,
        limit: String(SEARCH_LIMIT),
        filter: "all",
        sort: "score",
      });
      const r = await http.json<unknown>(`${API}/search-markets?${params}`);
      if (!r.ok) return skippedResult(name, r.error);
      if (!Array.isArray(r.value)) return skippedResult(name, "Manifold returned no market list");
      const qt = tokens(`${query} ${ctx?.hints?.markets ?? ""}`);
      const candidates = r.value
        .filter(wellFormed)
        // Nothing that did not exist at the cutoff.
        .filter((m) => m.createdTime <= cutoffMs)
        .filter((m) =>
          nearDate(
            m.closeTime ? new Date(m.closeTime).toISOString() : undefined,
            ctx?.endTime,
            CLOSE_NEAR_DAYS,
          ),
        );
      const matched = bestMatches(candidates, qt, (m) => m.question);
      if (matched.length === 0) return skippedResult(name, "no market matched the question");
      const out: LookupResult = {
        name,
        lines: [],
        sources: [],
        mode: live ? "live" : "historical",
        asOf: (live ? now : cutoff).toISOString(),
      };
      for (const m of matched) {
        if (out.sources.length >= MAX_MARKETS) break;
        const priced = live
          ? await liveReading(http, m, now)
          : await historicalReading(http, m, cutoffMs);
        if (!priced) continue;
        const url = marketUrl(m);
        out.sources.push({ url, title: m.question });
        out.lines.push(
          `- ${day(live ? now.getTime() : cutoffMs)} — Manifold (play money) "${m.question}": ${priced.text} [Manifold](${url})`,
        );
        if (priced.price) (out.prices ??= []).push({ venue: name, ...priced.price });
      }
      if (out.lines.length === 0) {
        return {
          ...out,
          skipped: live ? "no open market matched" : "no trade at or before the cutoff",
        };
      }
      return out;
    },
  };
}

type Reading = { text: string; price?: Omit<MarketPrice, "venue"> };

async function liveReading(
  http: LookupFetch,
  m: ManifoldMarket,
  now: Date,
): Promise<Reading | undefined> {
  if (m.isResolved) return undefined;
  if (m.closeTime && m.closeTime <= now.getTime()) return undefined;
  const meta = [
    Number.isFinite(m.volume) ? `volume ${mana(m.volume!)}` : "",
    m.closeTime ? `closes ${day(m.closeTime)}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const tail = meta ? ` (${meta})` : "";
  if (m.outcomeType === "BINARY") {
    if (!isProb(m.probability)) return undefined;
    return {
      text: `Yes ${pct(m.probability)}${tail}`,
      price: {
        market: m.question,
        outcome: "Yes",
        p: m.probability,
        at: now.toISOString(),
        ...(Number.isFinite(m.volume) ? { volume: m.volume!, volumeUnit: "mana" } : {}),
      },
    };
  }
  if (m.outcomeType === "MULTIPLE_CHOICE") {
    // Search results carry no answers; the market itself does.
    const full = m.answers ? { ok: true as const, value: m } : await marketById(http, m.id);
    if (!full.ok) return undefined;
    const answers = (full.value.answers ?? [])
      .filter((a) => typeof a?.text === "string" && isProb(a.probability))
      .sort((a, b) => b.probability! - a.probability!)
      .slice(0, MAX_ANSWERS);
    if (answers.length === 0) return undefined;
    return {
      text: `${answers.map((a) => `${a.text.slice(0, 60)} ${pct(a.probability!)}`).join(", ")}${tail}`,
    };
  }
  return undefined;
}

async function marketById(http: LookupFetch, id: string) {
  const r = await http.json<ManifoldMarket>(`${API}/market/${encodeURIComponent(id)}`);
  return r.ok && wellFormed(r.value)
    ? { ok: true as const, value: r.value }
    : { ok: false as const };
}

async function historicalReading(
  http: LookupFetch,
  m: ManifoldMarket,
  cutoffMs: number,
): Promise<Reading | undefined> {
  if (m.outcomeType !== "BINARY") return undefined;
  // Settled by the cutoff: its price then was its resolution, not a forecast.
  if (m.resolutionTime && m.resolutionTime <= cutoffMs) return undefined;
  if (m.closeTime && m.closeTime <= cutoffMs) return undefined;
  const params = new URLSearchParams({
    contractId: m.id,
    // `beforeTime` is exclusive: a trade AT the cutoff counts.
    beforeTime: String(cutoffMs + 1),
    limit: String(BET_PAGE),
  });
  const r = await http.json<unknown>(`${API}/bets?${params}`);
  if (!r.ok || !Array.isArray(r.value)) return undefined;
  const at = priceAtCutoff(r.value as ManifoldBet[], cutoffMs);
  if (!at) return undefined;
  const traded = `${r.value.length >= BET_PAGE ? "at least " : ""}${mana(at.traded)} traded up to the cutoff`;
  return {
    text: `Yes ${pct(at.p)} (probability after the last trade, ${minute(at.at)}Z; ${traded})`,
    price: {
      market: m.question,
      outcome: "Yes",
      p: at.p,
      at: new Date(at.at).toISOString(),
      // A full page is a lower bound, not the volume: then none is claimed.
      ...(r.value.length < BET_PAGE ? { volume: at.traded, volumeUnit: "mana" } : {}),
    },
  };
}
