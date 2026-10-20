// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  type DataQueryOptions,
  dataCrowd,
  dataMarkets,
  dataOdds,
  dataPolls,
  dataSeries,
  dataSources,
} from "../../forecast/data-query";
import type { CommandDef, EntityId, RoomContext } from "../../types";
import { currentEvidenceCutoffMs } from "../evidence-fence";
import { type ModifierSpec, parseModifiers, unknownSubcommand } from "../parse-input";
import { parseBound } from "../search-providers/index";

/**
 * `data` — the structured data sources forecasts use (prediction markets,
 * sports odds, official series), asked directly by any entity, agent, crew,
 * MCP client or tool path. Read-only and rank 0; an outbound read, so the
 * agent tool policy classes it `egress` like `web search`. Free of model
 * cost; keys are env-only; every request goes through the URL guard. Each
 * entity is limited to one query every few seconds (third-party quotas).
 *
 *   data markets <query> [asof:<date>]
 *   data odds <sport_key> [team…] [asof:<date>] | data odds <team…>
 *   data series <FRED or BLS id | query> [asof:<date>]
 *   data polls <approval|generic-ballot> <subject> [asof:<date>] [exclude:<pollster,…>]
 *   data crowd <query> [asof:<date>]            (alias: data manifold)
 *   data sources
 */

const DATA_SPEC: ModifierSpec = {
  asof: { type: "string", aliases: ["before"] },
  exclude: { type: "string" },
};
/** Every `data` subcommand that reads a third-party source. */
export const DATA_LOOKUP_SUBCOMMANDS = [
  "markets",
  "odds",
  "series",
  "polls",
  "crowd",
  "manifold",
] as const;
/** One query per entity per this long (ms). */
export const DATA_MIN_INTERVAL_MS = 2_000;
const USAGE =
  "data markets <query> [asof:<date>] | data odds <sport_key> [team…] | data odds <team…> | data series <id|query> [asof:<date>] | data polls <approval|generic-ballot> <subject> [asof:<date>] | data crowd <query> [asof:<date>] | data sources";

export function dataCommand(
  deps: { options?: DataQueryOptions; now?: () => number } = {},
): CommandDef {
  const lastQuery = new Map<EntityId, number>();
  const now = deps.now ?? Date.now;
  return {
    category: "Information",
    usage: [
      { syntax: "data sources", effect: "read" },
      { syntax: "data markets <query> [asof:<date>]", effect: "read" },
      { syntax: "data odds <sport_key> [team…] [asof:<date>]", effect: "read" },
      { syntax: "data odds <team…>", effect: "read" },
      { syntax: "data series <id|query> [asof:<date>]", effect: "read" },
      { syntax: "data series UNRATE", effect: "read" },
      { syntax: "data series CPIAUCSL asof:2026-06-30", effect: "read" },
      {
        syntax:
          "data polls <approval|generic-ballot> <subject> [asof:<date>] [exclude:<pollster,…>]",
        effect: "read",
      },
      { syntax: "data polls approval Donald Trump", effect: "read" },
      { syntax: "data crowd <query> [asof:<date>]", effect: "read" },
    ],
    name: "data",
    aliases: [],
    minRank: 0,
    help: `Structured data — the sources forecasts use, asked directly.
Usage:
  data sources                              — which sources are ready here and what each needs
  data markets <query> [asof:<date>]        — prediction-market prices (Polymarket, Kalshi);
                                              a past asof: reads the price then, never a result
  data odds <sport_key> [team…]             — pre-game sports odds, implied probabilities with the
                                              bookmaker margin removed (ODDS_API_KEY)
  data odds <team…>                         — every upcoming game naming those teams
  data series <id|query> [asof:<date>]      — official series (FRED, BLS): latest reading and recent
                                              history; a past asof: reads FRED as published then
  data polls <approval|generic-ballot> <subject> [asof:<date>] [exclude:<pollster,…>]
                                            — published polls (VoteHub): fieldwork in the four weeks
                                              before asof:, newest first, with rolling means
  data crowd <query> [asof:<date>]          — crowd probabilities (Manifold, play money; alias manifold)
Read-only. Nothing returned is dated after now or after asof:.`,
    handler: async (ctx: RoomContext, input) => {
      const tokens = input.tokens;
      const sub = tokens[0]?.toLowerCase();
      if (!sub || sub === "help") {
        ctx.send(input.entity, `Usage: ${USAGE}`);
        return;
      }
      if (sub === "sources") {
        ctx.send(input.entity, dataSources(deps.options?.env ?? process.env));
        return;
      }
      if (!(DATA_LOOKUP_SUBCOMMANDS as readonly string[]).includes(sub)) {
        ctx.send(input.entity, unknownSubcommand("data", sub, USAGE));
        return;
      }
      const mods = parseModifiers(tokens.slice(1), DATA_SPEC);
      if (mods.errors.length > 0) {
        ctx.send(input.entity, `${mods.errors.join("; ")}. Usage: ${USAGE}`);
        return;
      }
      let asOf: Date | undefined;
      if (typeof mods.values.asof === "string") {
        const b = parseBound(mods.values.asof);
        if (!b) {
          ctx.send(input.entity, `asof:${mods.values.asof} is not a date (YYYY-MM-DD or ISO).`);
          return;
        }
        asOf = new Date(b);
      }
      // The as-of fence (src/engine/evidence-fence.ts): never later than the cutoff.
      const fence = currentEvidenceCutoffMs();
      if (fence !== undefined && (!asOf || asOf.getTime() > fence)) asOf = new Date(fence);
      const rest = mods.rest.join(" ").trim();
      if (!rest) {
        ctx.send(input.entity, `Usage: ${USAGE}`);
        return;
      }
      const t = now();
      const last = lastQuery.get(input.entity) ?? 0;
      if (t - last < DATA_MIN_INTERVAL_MS) {
        ctx.send(input.entity, "One data query every few seconds — try again shortly.");
        return;
      }
      lastQuery.set(input.entity, t);
      const opts = deps.options ?? {};
      const exclude =
        typeof mods.values.exclude === "string"
          ? mods.values.exclude
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean)
          : undefined;
      const out =
        sub === "markets"
          ? await dataMarkets(rest, asOf, opts)
          : sub === "odds"
            ? await dataOdds(rest, asOf, opts)
            : sub === "series"
              ? await dataSeries(rest, asOf, opts)
              : sub === "polls"
                ? await dataPolls(
                    mods.rest[0] ?? "",
                    mods.rest.slice(1).join(" "),
                    asOf,
                    exclude ? { ...opts, exclude } : opts,
                  )
                : await dataCrowd(rest, asOf, opts);
      ctx.send(input.entity, out);
    },
  };
}
