// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Optional data lookups for forecasting (src/forecast/typed.ts): structured
 * sources a forecaster consults beside web research — today prediction-market
 * prices. Each lookup returns dossier lines in the research report's format
 * (`- <date> — <fact> [title](url)`) so the same citation and judge steps
 * treat them like any other evidence.
 *
 * Lookups are opt-in (`MARINA_FORECAST_LOOKUPS`), never required: a lookup
 * that is not configured, fails, or times out contributes nothing and the
 * forecast proceeds. A lookup reports CURRENT values, so it is skipped when
 * the forecast's cutoff lies in the past (a backtest must not read the future).
 */

import { type PolymarketEvent, searchEvents } from "../net/polymarket-client";

export interface LookupResult {
  name: string;
  lines: string[];
  sources: Array<{ url: string; title?: string }>;
  /** Why the lookup contributed nothing, when it did not. */
  skipped?: string;
}

export interface ForecastLookup {
  name: string;
  lookup(query: string, cutoff: Date, now: Date): Promise<LookupResult>;
}

/** A lookup is current-only: reading it for a cutoff more than this far in the past would leak. */
const LIVE_SLACK_MS = 6 * 3_600_000;

export function polymarketLookup(
  search: typeof searchEvents = searchEvents,
  maxEvents = 4,
): ForecastLookup {
  return {
    name: "polymarket",
    async lookup(query, cutoff, now) {
      if (now.getTime() - cutoff.getTime() > LIVE_SLACK_MS) {
        return { name: "polymarket", lines: [], sources: [], skipped: "cutoff in the past" };
      }
      const r = await search(query.slice(0, 200), maxEvents);
      if (!r.ok)
        return { name: "polymarket", lines: [], sources: [], skipped: r.error.slice(0, 120) };
      const day = now.toISOString().slice(0, 10);
      const lines: string[] = [];
      const sources: Array<{ url: string; title?: string }> = [];
      for (const ev of r.response.slice(0, maxEvents)) {
        const url = `https://polymarket.com/event/${encodeURIComponent(ev.slug)}`;
        const priced = marketLines(ev);
        if (priced.length === 0) continue;
        sources.push({ url, title: ev.title });
        for (const p of priced) {
          lines.push(`- ${day} — Polymarket "${ev.title}": ${p} [Polymarket](${url})`);
        }
      }
      return {
        name: "polymarket",
        lines,
        sources,
        ...(lines.length ? {} : { skipped: "no priced open markets matched" }),
      };
    },
  };
}

function marketLines(ev: PolymarketEvent): string[] {
  const out: string[] = [];
  for (const m of (ev.markets ?? []).slice(0, 6)) {
    if (m.closed) continue;
    let prices: string[] = [];
    let outcomes: string[] = ["Yes", "No"];
    try {
      prices = JSON.parse(m.outcomePrices ?? "[]");
      if (m.outcomes) outcomes = JSON.parse(m.outcomes);
    } catch {
      continue;
    }
    const pairs = outcomes
      .map((o, i) => `${o} ${Math.round(Number(prices[i]) * 100)}%`)
      .filter((s) => !s.endsWith("NaN%"));
    if (pairs.length) out.push(`${m.question} — ${pairs.join(", ")}`);
  }
  return out;
}

/** `MARINA_FORECAST_LOOKUPS` (comma list): `polymarket`. Unknown names are ignored. */
export function lookupsFromSpec(spec: string | undefined): ForecastLookup[] {
  const names = (spec ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out: ForecastLookup[] = [];
  for (const n of new Set(names)) if (n === "polymarket") out.push(polymarketLookup());
  return out;
}

/** Run every lookup; failures become `skipped`, never throws. */
export async function runLookups(
  lookups: ForecastLookup[],
  query: string,
  cutoff: Date,
  now: Date,
): Promise<LookupResult[]> {
  return Promise.all(
    lookups.map(async (l) => {
      try {
        return await l.lookup(query, cutoff, now);
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
