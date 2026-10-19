// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every dated, leakage-safe outside signal per arena task family — what
 * `MARINA_ARENA_RESEARCH_SIGNALS=all` hands the research dossier
 * (data-evidence.ts). No network imports: forecast-config.ts reads the
 * settings helpers below for the strategy fingerprint.
 *
 * Each signal is evidence of a CHANGE, never the level (the round's own
 * history sets the level), and every source is read as of the brief's cutoff:
 *
 *   FRED     ALFRED vintages (`FRED_API_KEY`): exactly what was published on
 *            the cutoff's prior UTC day for a past lock, so release dates and
 *            later revisions are handled by the vintage, not by guesswork
 *            (keyless FRED serves only the latest revision and is live-only).
 *   markets  Polymarket / Kalshi: the last price at or before the cutoff from
 *            the venue's price history, never a later price or the result.
 *   votehub  other pollsters' published polls, cut at their listing day
 *            (lookup-polls.ts); the target's own pollster is excluded.
 *
 * Not used, and why:
 *   BLS      duplicates the FRED series (CPIAUCSL, UNRATE) and serves only the
 *            latest revision, so it is skipped for every past lock; keyless
 *            quota is 25 requests a day.
 *   SP500, DJIA, WILL5000IND — no ALFRED vintages (index licensing), so a
 *            past lock reads nothing; NASDAQCOM / NASDAQ100 stand in for stocks.
 *   UMCSENT for umich_* rounds — it is the target itself, republished on FRED
 *            a month late (the August 2026 resolution correction).
 *   google_trends / wikipedia — no keyless, dated company or event calendar;
 *            scheduled launches and earnings stay in the web research playbook.
 *   Odds     no arena family.
 *
 * Market phrases name the 2026 contracts that matched at past locks (checked
 * against Polymarket's search); revisit them when the season rolls over.
 *
 * Order matters: the first matching entry wins.
 */

import type { DataHints } from "../../forecast/lookup-types";

export interface ArenaSignalEntry {
  /** Family label, for reports and docs. */
  family: string;
  /** Round ids this entry covers (arena round_id). */
  round: RegExp;
  hints: DataHints;
  /** Why these signals bear on the family's quantity (shown in the dossier heading). */
  why: string;
}

const TRUMP_APPROVAL_MARKETS = "Trump approval rating";
const approvalPolls = (exclude: string[]): DataHints["polls"] => ({
  type: "approval",
  subject: "Donald Trump",
  exclude,
  label: "Trump approval",
});
const genericPolls = (exclude: string[]): DataHints["polls"] => ({
  type: "generic-ballot",
  subject: "2026",
  exclude,
  label: "2026 generic ballot",
});

/** Consumer-economy series: sentiment, prices, labour, stocks, inflation compensation. */
const ECONOMY = ["UMCSENT", "GASREGW", "ICSA", "UNRATE", "CPIAUCSL", "NASDAQCOM", "T5YIE"];

export const ARENA_SIGNAL_MAP: ArenaSignalEntry[] = [
  {
    family: "civiqs-econ",
    round: /^civiqs-.*-econ-(now|direction)$/,
    hints: { fred: ECONOMY, markets: "US recession 2026" },
    why: "consumer sentiment, gasoline prices, jobless claims, unemployment, CPI, Nasdaq and 5-year breakeven inflation; recession market prices",
  },
  {
    family: "civiqs-family-finances",
    round: /^civiqs-.*-family-finances$/,
    hints: { fred: ["UMCSENT", "GASREGW", "ICSA", "UNRATE", "CPIAUCSL", "NASDAQCOM"] },
    why: "consumer sentiment, gasoline prices, jobless claims, unemployment, CPI and the Nasdaq (household budgets and wealth)",
  },
  {
    family: "civiqs-inflation-concern",
    round: /^civiqs-.*-inflation-concern$/,
    hints: {
      fred: ["CPIAUCSL", "GASREGW", "MICH", "T5YIE", "EXPINF1YR"],
      markets: "How high will inflation get in 2026",
    },
    why: "CPI, gasoline prices, Michigan and Cleveland Fed expected inflation, 5-year breakevens; inflation market prices",
  },
  {
    family: "civiqs-angry-share",
    round: /^civiqs-.*-angry-share$/,
    hints: {
      fred: ["UMCSENT", "GASREGW"],
      markets: TRUMP_APPROVAL_MARKETS,
      polls: approvalPolls(["civiqs"]),
    },
    why: "political and economic mood: other pollsters' Trump approval, approval markets, consumer sentiment and gasoline prices",
  },
  {
    family: "civiqs-approval",
    // Weekly approval, the approval profile and the demographic approval cells.
    round: /^civiqs-(\d{4}-w\d+-approval|profile-.*|[a-z]+\d*-\d{4}-w\d+)$/,
    hints: { markets: TRUMP_APPROVAL_MARKETS, polls: approvalPolls(["civiqs"]) },
    why: "other pollsters' Trump approval (VoteHub, Civiqs excluded) and approval market prices",
  },
  {
    family: "yougov-generic",
    round: /^yougov-.*-generic$/,
    hints: { markets: "House control 2026", polls: genericPolls(["yougov"]) },
    why: "other pollsters' generic ballot (VoteHub, YouGov excluded) and House control market prices",
  },
  {
    family: "yougov-approval",
    round: /^yougov-(\d{4}-w\d+-(rv-|strong-)?approval|xtab-.*)$/,
    hints: { markets: TRUMP_APPROVAL_MARKETS, polls: approvalPolls(["yougov"]) },
    why: "other pollsters' Trump approval (VoteHub, YouGov excluded) and approval market prices",
  },
  {
    family: "harvard-harris",
    round: /^hh-.*-approval$/,
    hints: { markets: TRUMP_APPROVAL_MARKETS, polls: approvalPolls(["harris"]) },
    why: "other pollsters' Trump approval (VoteHub, Harvard-Harris/HarrisX excluded) and approval market prices",
  },
  {
    family: "morning-consult",
    round: /^mc-.*-approval$/,
    hints: { markets: TRUMP_APPROVAL_MARKETS, polls: approvalPolls(["morning consult"]) },
    why: "other pollsters' Trump approval (VoteHub, Morning Consult excluded) and approval market prices",
  },
  {
    family: "midterm",
    round: /^midterm-/,
    hints: { markets: "House control 2026", polls: genericPolls([]) },
    why: "published generic-ballot polls (VoteHub) and House control market prices",
  },
  {
    family: "umich",
    // UMCSENT is the target itself (FRED republishes it a month late): never a signal here.
    round: /^umich-/,
    hints: { fred: ["MICH", "GASREGW", "NASDAQCOM", "ICSA", "UNRATE", "CPIAUCSL", "T5YIE"] },
    why: "Michigan expected inflation, gasoline prices, the Nasdaq, jobless claims, unemployment, CPI and 5-year breakevens",
  },
  {
    family: "sce-infl1y",
    round: /^sce-.*-infl1y$/,
    hints: {
      fred: ["MICH", "EXPINF1YR", "T5YIE", "CPIAUCSL", "GASREGW"],
      markets: "How high will inflation get in 2026",
    },
    why: "Michigan and Cleveland Fed 1-year expected inflation, 5-year breakevens, CPI and gasoline prices; inflation market prices",
  },
  {
    family: "sce-infl3y",
    round: /^sce-.*-infl3y$/,
    hints: {
      fred: ["EXPINF3YR", "T5YIE", "MICH", "CPIAUCSL", "GASREGW"],
      markets: "How high will inflation get in 2026",
    },
    why: "Cleveland Fed 3-year expected inflation, 5-year breakevens, Michigan expected inflation, CPI and gasoline prices",
  },
  {
    family: "aaii",
    round: /^aaii-/,
    hints: { fred: ["NASDAQCOM", "NASDAQ100", "VIXCLS"], markets: "S&P 500 close end of 2026" },
    why: "recent Nasdaq Composite and Nasdaq-100 returns and the VIX (investor sentiment follows the market); year-end S&P 500 market prices",
  },
];

/** The `all` entry for a round, if its family has outside signals. */
export function arenaSignalEntry(roundId: string): ArenaSignalEntry | undefined {
  return ARENA_SIGNAL_MAP.find((e) => e.round.test(roundId));
}

export type ArenaSignalSet = "off" | "consumer" | "all";

/** `MARINA_ARENA_RESEARCH_SIGNALS`: `consumer` and `all` are treatments; anything else is off. */
export function arenaSignalSet(env: NodeJS.ProcessEnv): ArenaSignalSet {
  const v = env.MARINA_ARENA_RESEARCH_SIGNALS?.trim();
  if (v === "consumer") return "consumer";
  if (v?.toLowerCase() === "all") return "all";
  return "off";
}

/** The lookups `all` turns on when `MARINA_ARENA_RESEARCH_LOOKUPS` is unset. */
export const ALL_SIGNALS_LOOKUPS = "polymarket,kalshi,fred,votehub";

/**
 * The effective `MARINA_ARENA_RESEARCH_LOOKUPS` spec: as set; unset ⇒ off,
 * except under `MARINA_ARENA_RESEARCH_SIGNALS=all`, which needs its lookups.
 */
export function arenaLookupSpec(env: NodeJS.ProcessEnv): string {
  const set = env.MARINA_ARENA_RESEARCH_LOOKUPS;
  if (set !== undefined) return set;
  return arenaSignalSet(env) === "all" ? ALL_SIGNALS_LOOKUPS : "off";
}
