// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Live markets as forecasting questions: the selection `market live` lists,
// and the one market `forecast market:live` picks to answer. A pick is a real
// Kalshi yes/no market that closes soon, so the answer is scored within days
// (the `market-settle` tick job reads it until it settles).

import {
  getMarkets,
  type KalshiClientOpts,
  type KalshiMarket,
  kalshiPrice,
} from "../net/clients/kalshi-client";

/**
 * Kalshi markets closing inside (now, cutoff], combos (parlays) left out,
 * most traded in the last 24 h first. The venue filters too; this keeps the
 * window and the combo rule even when it ignores a parameter.
 */
export function selectKalshiLive(
  markets: readonly KalshiMarket[],
  now: number,
  cutoffMs: number,
  limit: number,
): KalshiMarket[] {
  const volume = (m: KalshiMarket) => {
    const v = Number(m.volume_24h_fp);
    return Number.isFinite(v) ? v : 0;
  };
  return markets
    .filter((m) => {
      if (m.mve_collection_ticker || m.ticker.startsWith("KXMVE")) return false;
      const close = Date.parse(m.close_time);
      return Number.isFinite(close) && close > now && close <= cutoffMs;
    })
    .sort((a, b) => volume(b) - volume(a) || Date.parse(a.close_time) - Date.parse(b.close_time))
    .slice(0, limit);
}

/** The default window for `forecast market:live`: markets closing within two days. */
export const LIVE_FORECAST_WINDOW_MS = 48 * 3_600_000;

/** A market priced outside [5¢, 95¢] is all but decided: forecasting it teaches little. */
const MIN_PRICE = 0.05;
const MAX_PRICE = 0.95;

/**
 * The market to forecast: the most traded open market in the window that is
 * not yet decided (yes price within 5–95¢), at most one per event (sibling
 * markets of one game are the same question), and not one in `exclude`
 * (tickers the forecaster already answered). Undefined when none qualifies.
 */
export function pickLiveKalshiMarket(
  markets: readonly KalshiMarket[],
  now: number,
  cutoffMs: number,
  exclude: ReadonlySet<string> = new Set(),
): KalshiMarket | undefined {
  const answeredEvents = new Set(
    markets.filter((m) => exclude.has(m.ticker)).map((m) => m.event_ticker ?? m.ticker),
  );
  return selectKalshiLive(markets, now, cutoffMs, markets.length).find((m) => {
    if (exclude.has(m.ticker) || answeredEvents.has(m.event_ticker ?? m.ticker)) return false;
    const yes = kalshiPrice(m.yes_ask_dollars, m.yes_ask);
    return !Number.isFinite(yes) || (yes >= MIN_PRICE && yes <= MAX_PRICE);
  });
}

/** The question a Kalshi market asks, in the venue's own resolution words. */
export function kalshiQuestion(m: KalshiMarket): string {
  const close = m.close_time.replace(/:\d\d(\.\d+)?Z$/, "Z").replace("T", " ");
  const rule = m.rules_primary?.trim();
  return [
    `${m.title.replace(/[?.]\s*$/, "")}?`,
    rule ? `Resolves YES per Kalshi: ${rule}` : `Resolves per Kalshi market ${m.ticker}.`,
    `Market closes ${close}.`,
  ].join(" ");
}

/** Fetch the open Kalshi markets closing in (now, now + windowMs] and pick one. */
export async function fetchLiveKalshiPick(
  windowMs: number,
  exclude: ReadonlySet<string>,
  opts: { now?: number; client?: KalshiClientOpts } = {},
): Promise<{ ok: true; market?: KalshiMarket } | { ok: false; error: string }> {
  const now = opts.now ?? Date.now();
  const cutoff = now + windowMs;
  const res = await getMarkets(
    {
      status: "open",
      limit: 200,
      minCloseTs: Math.floor(now / 1000),
      maxCloseTs: Math.floor(cutoff / 1000),
      excludeMultivariate: true,
    },
    opts.client,
  );
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, market: pickLiveKalshiMarket(res.response.markets, now, cutoff, exclude) };
}
