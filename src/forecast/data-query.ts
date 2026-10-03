// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The data lookups as a general, directly askable surface — the same market,
 * odds and official-series sources the forecaster consults (lookups.ts), for
 * any agent, crew, MCP client or room tool that wants a figure without a
 * forecast around it. Backs the `data` command and the search room's
 * `markets` / `odds` / `series` verbs.
 *
 * Every answer is as of a moment that is never later than now (`asOf` in the
 * past reads that past, where the source supports it, and says so where it
 * does not). Keys come from the environment only; nothing here costs model
 * money; every request goes through the URL guard.
 */

import { type OddsGame, oddsBoard } from "./lookup-odds";
import type { ForecastLookup, LookupResult } from "./lookup-types";
import { availableLookupNames, type LookupName, lookupsFromSpec, runLookups } from "./lookups";

export interface DataQueryOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Injected lookups (tests); default: built from the environment. */
  lookups?: ForecastLookup[];
  /** Injected odds board (tests). */
  board?: typeof oddsBoard;
}

const SPORT_KEY = /^[a-z0-9]+_[a-z0-9_]+$/;
/** A FRED / BLS series id as written (upper-case letters and digits). */
const SERIES_ID = /^[A-Z][A-Z0-9_.]{1,39}$/;
const BLS_ID = /^[A-Z]{2,4}[A-Z0-9]{6,26}$/;

function pick(names: LookupName[], opts: DataQueryOptions): ForecastLookup[] {
  const env = opts.env ?? process.env;
  const all = opts.lookups ?? lookupsFromSpec(names.join(","), env);
  return all.filter((l) => (names as string[]).includes(l.name));
}

function resultLines(results: LookupResult[]): string[] {
  const lines: string[] = [];
  for (const r of results) {
    if (r.lines.length > 0) {
      const how = r.mode ? ` (${r.mode}${r.asOf ? `, as of ${r.asOf.slice(0, 16)}Z` : ""})` : "";
      lines.push(`${r.name}${how}:`);
      for (const l of r.lines) lines.push(`  ${l.replace(/^- /, "")}`);
    } else {
      lines.push(`${r.name}: — ${r.skipped ?? "nothing found"}`);
    }
  }
  return lines;
}

function when(asOf: Date | undefined, now: Date): Date {
  return asOf && asOf.getTime() < now.getTime() ? asOf : now;
}

/** Prediction-market prices (Polymarket, Kalshi) for a query. */
export async function dataMarkets(
  query: string,
  asOf: Date | undefined,
  opts: DataQueryOptions = {},
): Promise<string> {
  const now = (opts.now ?? (() => new Date()))();
  const at = when(asOf, now);
  const results = await runLookups(pick(["polymarket", "kalshi"], opts), query, at, now, {
    hints: { markets: query },
  });
  return [
    `Markets: ${query} (as of ${at.toISOString().slice(0, 16)}Z)`,
    ...resultLines(results),
  ].join("\n");
}

function boardLines(games: OddsGame[]): string[] {
  return games.map((g) => {
    const parts = g.probs.map(([n, p]) => `${n} ${Math.round(p * 100)}%`).join(", ");
    return `  ${g.start.slice(0, 16)}Z ${g.away} at ${g.home} [${g.sport}]: ${parts} (${g.books} books)`;
  });
}

/**
 * Sports odds: `<sport_key> [team words…]` or `<team words…>` (every
 * upcoming game naming one of them). Implied probabilities are de-vigged
 * and averaged across bookmakers; only games not yet started are shown.
 */
export async function dataOdds(
  args: string,
  asOf: Date | undefined,
  opts: DataQueryOptions = {},
): Promise<string> {
  const env = opts.env ?? process.env;
  const now = (opts.now ?? (() => new Date()))();
  const words = args.trim().split(/\s+/).filter(Boolean);
  const sport = words[0] && SPORT_KEY.test(words[0].toLowerCase()) ? words[0] : undefined;
  const teams = sport ? words.slice(1) : words;
  if (!sport && teams.length === 0) {
    return "Usage: data odds <sport_key> [team…] | data odds <team…> (sport keys like americanfootball_nfl, basketball_nba, soccer_epl)";
  }
  const board = await (opts.board ?? oddsBoard)(env.ODDS_API_KEY?.trim() || undefined, {
    ...(sport ? { sport } : {}),
    ...(teams.length ? { teams } : {}),
    ...(asOf ? { asOf } : {}),
    now,
    limit: 10,
  });
  if ("error" in board) return `odds: — ${board.error}`;
  const head = `Odds${sport ? ` [${sport}]` : ""}${teams.length ? ` naming ${teams.join(" ")}` : ""} (${board.mode}, as of ${board.asOf.slice(0, 16)}Z, implied with the bookmaker margin removed):`;
  return board.games.length === 0
    ? `${head}\n  no upcoming game matched`
    : [head, ...boardLines(board.games)].join("\n");
}

/**
 * Official series: a FRED or BLS id (`UNRATE`, `CPIAUCSL`, `LNS14000000`) or
 * a free-text query (FRED search; needs FRED_API_KEY). A past `asOf` reads
 * FRED as it was published then (vintage data, FRED_API_KEY); BLS serves the
 * latest revision only and is skipped for a past date.
 */
export async function dataSeries(
  arg: string,
  asOf: Date | undefined,
  opts: DataQueryOptions = {},
): Promise<string> {
  const now = (opts.now ?? (() => new Date()))();
  const at = when(asOf, now);
  const text = arg.trim();
  if (!text) return "Usage: data series <FRED or BLS id | query> [asof:<date>]";
  const isId = SERIES_ID.test(text) && !/\s/.test(text);
  const hints = isId ? { fred: [text], ...(BLS_ID.test(text) ? { bls: [text] } : {}) } : {};
  const results = await runLookups(pick(["fred", "bls"], opts), text, at, now, {
    hints,
    answerType: "number",
  });
  const lines = [
    `Series: ${text} (as of ${at.toISOString().slice(0, 10)})`,
    ...resultLines(results),
  ];
  for (const r of results) {
    for (const rd of r.readings ?? []) {
      const tail = (rd.history ?? []).slice(-6);
      if (tail.length > 1) {
        lines.push(
          `  ${rd.source} ${rd.series} recent: ${tail.map((p) => `${p.date} ${p.value}`).join(" · ")}`,
        );
      }
    }
  }
  return lines.join("\n");
}

/** Which sources can answer here, and what each needs. */
export function dataSources(env: NodeJS.ProcessEnv = process.env): string {
  const on = new Set<string>(availableLookupNames(env));
  const row = (name: string, what: string) =>
    `  ${name.padEnd(10)} ${on.has(name) ? "ready" : "off  "}  ${what}`;
  return [
    "Data sources (also used automatically by forecasts — MARINA_FORECAST_LOOKUPS, default auto):",
    row("polymarket", "prediction-market prices; past dates read price history (keyless)"),
    row("kalshi", "prediction-market prices; past dates read candles (keyless)"),
    row(
      "odds",
      `sports pre-game odds, de-vigged across bookmakers (ODDS_API_KEY${env.ODDS_API_KEY?.trim() ? " set" : " not set"}; past dates need its paid plan)`,
    ),
    row(
      "fred",
      `official series (FRED_API_KEY${env.FRED_API_KEY?.trim() ? " set: vintage-correct past dates and search" : " not set: live latest only"})`,
    ),
    row("bls", "official series, latest revision only (BLS_API_KEY raises the quota)"),
  ].join("\n");
}
