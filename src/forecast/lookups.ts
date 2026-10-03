// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Optional data lookups for forecasting (src/forecast/typed.ts): structured
 * sources a forecaster consults beside web research. Each returns dossier
 * lines in the research report's format (`- <date> — <fact> [title](url)`),
 * so the same citation, run and critique steps treat them like any other
 * evidence, plus what it read and as of when.
 *
 *   polymarket  Polymarket prices — live, or the last price at/before a past cutoff
 *   kalshi      Kalshi prices — live, or the last candle at/before a past cutoff
 *   odds        sports head-to-head odds, de-vigged (ODDS_API_KEY; historical needs a paid plan)
 *   fred        FRED series — vintage-correct as of the cutoff with FRED_API_KEY, live-only without
 *   bls         BLS series — live-only (latest revision); BLS_API_KEY raises the quota
 *   markets     = polymarket,kalshi;  all = every lookup above
 *
 * Lookups are opt-in (`MARINA_FORECAST_LOOKUPS`), never required: a lookup
 * that is not configured, fails, or times out contributes nothing and the
 * forecast proceeds. None of them reads anything published after the cutoff.
 * None of them costs model money (they are plain data requests), so they
 * have no spend line; every request goes through the URL guard.
 */

import { pricesHistory, searchEvents } from "../net/polymarket-client";
import { kalshiLookup, polymarketLookup } from "./lookup-markets";
import { oddsLookup } from "./lookup-odds";
import { blsLookup, fredLookup } from "./lookup-series";
import type { ForecastLookup, LookupContext, LookupResult } from "./lookup-types";

export { kalshiLookup, polymarketLookup } from "./lookup-markets";
export { impliedProbabilities, oddsLookup } from "./lookup-odds";
export {
  anchorLine,
  blsLookup,
  fredLookup,
  type NumericAnchor,
  numericAnchor,
} from "./lookup-series";
export type {
  DataHints,
  ForecastLookup,
  LookupContext,
  LookupResult,
  Reading,
} from "./lookup-types";

export const LOOKUP_NAMES = ["polymarket", "kalshi", "odds", "fred", "bls"] as const;

/**
 * `MARINA_FORECAST_LOOKUPS` (comma list of names, `markets`, or `all`).
 * Unknown names are ignored. Keys come from the environment only.
 */
export function lookupsFromSpec(
  spec: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ForecastLookup[] {
  const names = new Set<string>();
  for (const raw of (spec ?? "").split(",")) {
    const n = raw.trim().toLowerCase();
    if (!n) continue;
    if (n === "all") for (const x of LOOKUP_NAMES) names.add(x);
    else if (n === "markets") {
      names.add("polymarket");
      names.add("kalshi");
    } else names.add(n);
  }
  const out: ForecastLookup[] = [];
  for (const n of LOOKUP_NAMES) {
    if (!names.has(n)) continue;
    if (n === "polymarket") out.push(polymarketLookup(searchEvents, 4, pricesHistory));
    else if (n === "kalshi") out.push(kalshiLookup());
    else if (n === "odds") out.push(oddsLookup(env.ODDS_API_KEY?.trim() || undefined));
    else if (n === "fred") out.push(fredLookup(env.FRED_API_KEY?.trim() || undefined));
    else if (n === "bls") out.push(blsLookup(env.BLS_API_KEY?.trim() || undefined));
  }
  return out;
}

/** Run every lookup; failures become `skipped`, never throws. */
export async function runLookups(
  lookups: ForecastLookup[],
  query: string,
  cutoff: Date,
  now: Date,
  ctx?: LookupContext,
): Promise<LookupResult[]> {
  return Promise.all(
    lookups.map(async (l) => {
      try {
        return await l.lookup(query, cutoff, now, ctx);
      } catch (err) {
        return {
          name: l.name,
          lines: [],
          sources: [],
          skipped: (err instanceof Error ? err.message : String(err)).slice(0, 120),
        };
      }
    }),
  );
}
