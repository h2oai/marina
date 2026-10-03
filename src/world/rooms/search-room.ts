// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The search room — a trusted harness room that IS a tool (rooms-as-tools).
 * Its commands exist only for entities standing in it, so the capability is
 * local and scoped by construction:
 *
 *   search <query> [before:<date>] [engine:<name|category>] [limit:N]
 *   fetch <url> asof:<date>          — the page as archived at or before the date
 *   wiki <title> [asof:<date>]       — the article's revision as of the date
 *   sources                          — engines, and how each enforces a date bound
 *   markets <query> [asof:<date>]    — prediction-market prices (Polymarket, Kalshi)
 *   odds <sport_key|team…>           — pre-game sports odds, de-vigged (ODDS_API_KEY)
 *   series <id|query> [asof:<date>]  — official series (FRED, BLS)
 *
 * The data verbs are the same general surface as the `data` command
 * (src/forecast/data-query.ts): the sources forecasts consult, asked directly.
 *
 * `searchRoom()` is a dedicated room with those verbs. `searchToolCommands()`
 * mounts the same tool on an existing room under other verbs (the default and
 * showcase worlds use `find` / `archive` / `wiki` / `sources`, so the global
 * `search` command keeps working there).
 *
 * Keyless: DuckDuckGo and academic engines for open searches, and the
 * date-strict engines (GDELT, Wikipedia revisions, Hacker News, arXiv,
 * Wayback) for bounded ones. A bounded search never falls back to an
 * unfiltered engine. Results are cached in room KV per (engine, query, bound)
 * with a TTL; each entity is limited to one query per few seconds. Every
 * command runs through the engine's command path, so it is recorded and traced
 * like any other agent action.
 */

import { createHash } from "node:crypto";
import { type ModifierSpec, parseModifiers } from "../../engine/parse-input";
import { standaloneSearchHttp } from "../../engine/search-providers/asof-http";
import {
  initProvidersSync,
  listProviders,
  parseBound,
  type SearchHttp,
  type SearchResult,
  search,
  splitEnginesAndProviders,
} from "../../engine/search-providers/index";
import { waybackFetch } from "../../engine/search-providers/wayback";
import { wikipediaRevision } from "../../engine/search-providers/wikipedia";
import {
  type DataQueryOptions,
  dataMarkets,
  dataOdds,
  dataSeries,
} from "../../forecast/data-query";
import type { CommandInput, EntityId, RoomContext, RoomId, RoomModule } from "../../types";

/** Cached replies live this long (ms). */
export const SEARCH_ROOM_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Cached replies kept per room (oldest evicted). */
const CACHE_MAX_ENTRIES = 200;
/** One query per entity per this long (ms). */
export const SEARCH_ROOM_MIN_INTERVAL_MS = 3_000;
/** Longest reply body sent back. */
const MAX_REPLY_CHARS = 6_000;

const SEARCH_SPEC: ModifierSpec = {
  before: { type: "string", aliases: ["asof"] },
  engine: { type: "string", aliases: ["engines"] },
  limit: { type: "int", aliases: ["max"] },
};
const ASOF_SPEC: ModifierSpec = { asof: { type: "string", aliases: ["before"] } };

interface CacheEntry {
  at: number;
  out: string;
}

export interface SearchToolOptions {
  /** HTTP surface (tests inject one); default: SSRF-guarded standalone fetch. */
  http?: SearchHttp;
  now?: () => number;
  /** Verb names (default search / fetch / wiki / sources / markets / odds / series). */
  verbs?: Partial<
    Record<"search" | "fetch" | "wiki" | "sources" | "markets" | "odds" | "series", string>
  >;
  /** Data-lookup options (tests inject lookups and a clock). */
  data?: DataQueryOptions;
}

export interface SearchRoomOptions extends SearchToolOptions {
  short?: string;
  long?: string;
  exits?: Record<string, RoomId>;
}

/** A dedicated search room (`search`, `fetch`, `wiki`, `sources`). */
export function searchRoom(opts: SearchRoomOptions = {}): RoomModule {
  const tool = searchToolCommands(opts);
  return {
    short: opts.short ?? "Search Room",
    long:
      opts.long ??
      "A quiet reading room wired to the open web. Search here, read a page as it stood on a date, or a Wikipedia article as of then. `sources` lists the engines; `search <query> before:<date>` sees only what was published before that date.",
    ...(opts.exits ? { exits: opts.exits } : {}),
    items: { catalog: tool.catalog },
    commands: tool.commands,
  };
}

/**
 * The search tool as room commands, to mount on any room: `commands` plus a
 * one-line `catalog` describing them under the chosen verbs.
 */
export function searchToolCommands(opts: SearchToolOptions = {}): {
  commands: Record<string, (ctx: RoomContext, input: CommandInput) => void | Promise<void>>;
  catalog: string;
} {
  initProvidersSync();
  const verb = {
    search: opts.verbs?.search ?? "search",
    fetch: opts.verbs?.fetch ?? "fetch",
    wiki: opts.verbs?.wiki ?? "wiki",
    sources: opts.verbs?.sources ?? "sources",
    markets: opts.verbs?.markets ?? "markets",
    odds: opts.verbs?.odds ?? "odds",
    series: opts.verbs?.series ?? "series",
  };
  const http = opts.http ?? standaloneSearchHttp();
  const now = opts.now ?? Date.now;
  const lastQuery = new Map<EntityId, number>();

  const throttled = (ctx: RoomContext, entity: EntityId): boolean => {
    const t = now();
    const last = lastQuery.get(entity) ?? 0;
    if (t - last < SEARCH_ROOM_MIN_INTERVAL_MS) {
      ctx.send(entity, "One query every few seconds — try again shortly.");
      return true;
    }
    lastQuery.set(entity, t);
    return false;
  };

  const cached = async (
    ctx: RoomContext,
    key: string,
    produce: () => Promise<string>,
  ): Promise<string> => {
    const id = `cache:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
    const hit = ctx.store.get<CacheEntry>(id);
    if (hit && now() - hit.at < SEARCH_ROOM_CACHE_TTL_MS) return `${hit.out}\n(cached)`;
    const out = await produce();
    ctx.store.set<CacheEntry>(id, { at: now(), out });
    const index = (ctx.store.get<string[]>("cache:index") ?? []).filter((k) => k !== id);
    index.push(id);
    while (index.length > CACHE_MAX_ENTRIES) {
      const old = index.shift();
      if (old) ctx.store.delete(old);
    }
    ctx.store.set("cache:index", index);
    return out;
  };

  const reply = (ctx: RoomContext, entity: EntityId, text: string) =>
    ctx.send(entity, text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}…` : text);

  const searchCmd = async (ctx: RoomContext, input: CommandInput): Promise<void> => {
    const mods = parseModifiers(input.args.trim().split(/\s+/).filter(Boolean), SEARCH_SPEC);
    const query = mods.rest.join(" ").trim();
    if (mods.errors.length > 0 || !query) {
      ctx.send(
        input.entity,
        `${mods.errors.length ? `${mods.errors.join("; ")}. ` : ""}Usage: ${verb.search} <query> [before:<date>] [engine:<name|category>] [limit:N]`,
      );
      return;
    }
    let before: string | undefined;
    if (typeof mods.values.before === "string") {
      before = parseBound(mods.values.before);
      if (!before) {
        ctx.send(input.entity, `before:${mods.values.before} is not a date (YYYY-MM-DD or ISO).`);
        return;
      }
    }
    if (throttled(ctx, input.entity)) return;
    const chosen =
      typeof mods.values.engine === "string"
        ? mods.values.engine
            .split(",")
            .map((e) => e.trim().toLowerCase())
            .filter(Boolean)
        : undefined;
    const split = chosen ? splitEnginesAndProviders(chosen) : undefined;
    const providers = split?.providers;
    const engines = split?.engines;
    const limit =
      typeof mods.values.limit === "number" ? Math.min(Math.max(mods.values.limit, 1), 20) : 8;
    const key = `search|${chosen?.join(",") ?? "auto"}|${query}|${before ?? "now"}|${limit}`;
    const out = await cached(ctx, key, async () => {
      const results = await search(
        query,
        {
          maxResults: limit,
          ...(engines?.length ? { engines } : {}),
          ...(providers?.length ? { providers } : {}),
          ...(before ? { before } : {}),
        },
        http,
        input.entity,
      );
      return formatResults(query, before, results);
    });
    reply(ctx, input.entity, out);
  };

  const fetchCmd = async (ctx: RoomContext, input: CommandInput): Promise<void> => {
    const mods = parseModifiers(input.args.trim().split(/\s+/).filter(Boolean), ASOF_SPEC);
    const url = mods.rest[0];
    const asOf = typeof mods.values.asof === "string" ? parseBound(mods.values.asof) : undefined;
    if (!url || !asOf) {
      ctx.send(
        input.entity,
        `Usage: ${verb.fetch} <url> asof:<date> (the page as archived at or before then)`,
      );
      return;
    }
    if (throttled(ctx, input.entity)) return;
    const normalized = url.startsWith("http") ? url : `https://${url}`;
    const out = await cached(ctx, `fetch|${normalized}|${asOf}`, async () => {
      const page = await waybackFetch(http, normalized, asOf, input.entity);
      if (!page) return `No archived capture of ${normalized} at or before ${asOf}.`;
      return `Archived ${page.original}\ncaptured ${page.at} (at or before ${asOf}) · ${page.replayUrl}\n\n${page.text}`;
    });
    reply(ctx, input.entity, out);
  };

  const wikiCmd = async (ctx: RoomContext, input: CommandInput): Promise<void> => {
    const mods = parseModifiers(input.args.trim().split(/\s+/).filter(Boolean), ASOF_SPEC);
    const title = mods.rest.join(" ").trim();
    if (!title) {
      ctx.send(input.entity, `Usage: ${verb.wiki} <title> [asof:<date>]`);
      return;
    }
    let asOf = new Date(now()).toISOString();
    if (typeof mods.values.asof === "string") {
      const b = parseBound(mods.values.asof);
      if (!b) {
        ctx.send(input.entity, `asof:${mods.values.asof} is not a date (YYYY-MM-DD or ISO).`);
        return;
      }
      asOf = b;
    }
    if (throttled(ctx, input.entity)) return;
    const out = await cached(ctx, `wiki|${title}|${asOf}`, async () => {
      const rev = await wikipediaRevision(http, title, asOf, { entityId: input.entity });
      if (!rev)
        return `No revision of "${title}" at or before ${asOf} (it may not have existed yet).`;
      return `${rev.title} — revision ${rev.revid} of ${rev.at} (as of ${asOf})\n${rev.permalink}\n\n${rev.text}`;
    });
    reply(ctx, input.entity, out);
  };

  const sourcesCmd = (ctx: RoomContext, input: CommandInput): void => {
    const lines = ["Engines (keyless unless noted):"];
    for (const p of listProviders()) {
      const bound = p.dateBound === "strict" ? "date-strict" : "no date bound";
      const what = p.describe ?? `engines: ${p.engines.join(", ") || "—"}`;
      lines.push(`  ${p.name} [${bound}${p.boundOnly ? ", bounded or named only" : ""}] — ${what}`);
    }
    lines.push(
      "A search with before:<date> uses only date-strict engines and drops anything undated or later.",
    );
    ctx.send(input.entity, lines.join("\n"));
  };

  const dataOpts: DataQueryOptions = {
    ...opts.data,
    ...(opts.data?.now ? {} : { now: () => new Date(now()) }),
  };
  const dataCmd =
    (kind: "markets" | "odds" | "series") =>
    async (ctx: RoomContext, input: CommandInput): Promise<void> => {
      const mods = parseModifiers(input.args.trim().split(/\s+/).filter(Boolean), ASOF_SPEC);
      const rest = mods.rest.join(" ").trim();
      if (mods.errors.length > 0 || !rest) {
        const usage =
          kind === "markets"
            ? `${verb.markets} <query> [asof:<date>]`
            : kind === "odds"
              ? `${verb.odds} <sport_key> [team…] | ${verb.odds} <team…>`
              : `${verb.series} <FRED or BLS id | query> [asof:<date>]`;
        ctx.send(input.entity, `Usage: ${usage}`);
        return;
      }
      let asOf: string | undefined;
      if (typeof mods.values.asof === "string") {
        asOf = parseBound(mods.values.asof);
        if (!asOf) {
          ctx.send(input.entity, `asof:${mods.values.asof} is not a date (YYYY-MM-DD or ISO).`);
          return;
        }
      }
      if (throttled(ctx, input.entity)) return;
      // Live answers move: cache them for minutes; a past asof: never changes.
      const bucket = asOf ?? new Date(now()).toISOString().slice(0, 15);
      const at = asOf ? new Date(asOf) : undefined;
      const out = await cached(ctx, `data|${kind}|${rest}|${bucket}`, () =>
        kind === "markets"
          ? dataMarkets(rest, at, dataOpts)
          : kind === "odds"
            ? dataOdds(rest, at, dataOpts)
            : dataSeries(rest, at, dataOpts),
      );
      reply(ctx, input.entity, out);
    };

  return {
    catalog: `Search tool here: \`${verb.search} <q> [before:<date>] [engine:<name>]\`, \`${verb.fetch} <url> asof:<date>\` (archived page), \`${verb.wiki} <title> [asof:<date>]\`, \`${verb.sources}\`. Data: \`${verb.markets} <q>\`, \`${verb.odds} <sport|team>\`, \`${verb.series} <id|q>\` (asof:<date> on each).`,
    commands: {
      [verb.search]: searchCmd,
      [verb.fetch]: fetchCmd,
      [verb.wiki]: wikiCmd,
      [verb.sources]: sourcesCmd,
      [verb.markets]: dataCmd("markets"),
      [verb.odds]: dataCmd("odds"),
      [verb.series]: dataCmd("series"),
    },
  };
}

function formatResults(query: string, before: string | undefined, results: SearchResult[]): string {
  if (results.length === 0) {
    return before
      ? `No dated results for "${query}" published before ${before}.`
      : `No results for "${query}".`;
  }
  const lines = [`Search: ${query}${before ? ` (before ${before})` : ""}`];
  results.forEach((r, i) => {
    lines.push(`[${i + 1}] ${r.title}`);
    lines.push(`    ${r.url}${r.published ? ` · ${r.published.slice(0, 10)}` : ""} · ${r.source}`);
    if (r.snippet)
      lines.push(`    ${r.snippet.length > 240 ? `${r.snippet.slice(0, 240)}…` : r.snippet}`);
  });
  return lines.join("\n");
}
