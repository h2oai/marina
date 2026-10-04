// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared shapes for forecast lookups (src/forecast/lookups.ts): structured
 * sources a forecaster consults beside web research — market prices, sports
 * odds and official data series. Kept in their own module so each lookup
 * family can live in its own file without an import cycle.
 */

import type { AnswerType } from "./answer-types";

/** What the planner says a lookup should look for (all optional; lookups fall back to the question). */
export interface DataHints {
  /** A short phrase to search prediction markets with. */
  markets?: string;
  /** A sports-odds sport key (for example `basketball_nba`, `soccer_epl`). */
  sport?: string;
  /** Team or competitor names, as the sport writes them. */
  teams?: string[];
  /** FRED series ids for official numeric targets (for example `UNRATE`, `CPIAUCSL`). */
  fred?: string[];
  /** BLS series ids (for example `CUUR0000SA0`). */
  bls?: string[];
}

/** What every lookup is told about the question beside the search phrase. */
export interface LookupContext {
  hints?: DataHints;
  answerType?: AnswerType;
  /** When the question closes (ISO), if known. */
  endTime?: string;
}

/** One official reading of a numeric series. */
export interface Reading {
  source: string;
  series: string;
  label?: string;
  value: number;
  /** The observation's own date (the period it measures). */
  date: string;
  /**
   * The information time it reflects: the vintage date for a vintage-aware
   * source, else the cutoff it was fetched for. Never later than the cutoff.
   */
  asOf: string;
  unit?: string;
  /** Earlier observations, oldest first (for the horizon spread). */
  history?: Array<{ date: string; value: number }>;
}

export interface LookupResult {
  name: string;
  lines: string[];
  sources: Array<{ url: string; title?: string }>;
  /** Why the lookup contributed nothing, when it did not. */
  skipped?: string;
  /** `live` read current values; `historical` read values as of the cutoff. */
  mode?: "live" | "historical";
  /** The information time of what was read (ISO). */
  asOf?: string;
  /** Official numeric readings, for the numeric anchor. */
  readings?: Reading[];
  /**
   * Market lookups: each priced market's first-outcome ("Yes") price and the
   * time it was read (never after the cutoff), for a forecast's prior.
   */
  prices?: MarketPrice[];
}

export interface MarketPrice {
  venue: string;
  market: string;
  outcome: string;
  p: number;
  /** ISO time of the price (the cutoff's last trade or candle, or now for a live read). */
  at: string;
}

export interface ForecastLookup {
  name: string;
  lookup(query: string, cutoff: Date, now: Date, ctx?: LookupContext): Promise<LookupResult>;
}

/** A lookup that only knows current values may run when the cutoff is within this of now. */
export const LIVE_SLACK_MS = 6 * 3_600_000;

export function isLiveCutoff(cutoff: Date, now: Date): boolean {
  return now.getTime() - cutoff.getTime() <= LIVE_SLACK_MS;
}

export function skippedResult(name: string, why: string): LookupResult {
  return { name, lines: [], sources: [], skipped: why.slice(0, 160) };
}
