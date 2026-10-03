// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { classifyCommandRisk } from "../src/agent/tool-policy";
import type { ResearchBrief } from "../src/arena/research/briefs";
import {
  ARENA_RELATED_SERIES,
  arenaResearchLookups,
  briefCutoff,
  withDataLookups,
} from "../src/arena/research/data-evidence";
import type { ResearchReport } from "../src/arena/research/retrieve";
import { dataCommand } from "../src/engine/commands/data";
import { dataOdds, dataSeries, dataSources } from "../src/forecast/data-query";
import type { LookupFetch } from "../src/forecast/lookup-http";
import { fredAsOfDay, fredLookup, fredToday } from "../src/forecast/lookup-series";
import type { ForecastLookup, LookupContext } from "../src/forecast/lookup-types";
import { effectiveCutoff, lookupsFromSpec, runLookups } from "../src/forecast/lookups";
import type { CommandInput, EntityId, KeyValueStore, RoomContext, RoomId } from "../src/types";
import { searchToolCommands } from "../src/world/rooms/search-room";

/** A lookup that records what it was asked and answers with one line. */
function spyLookup(
  name: string,
  seen: Array<{ query: string; cutoff: Date; ctx?: LookupContext }>,
  line = `- 2026-10-02 — ${name} fact [src](https://example.org/${name})`,
): ForecastLookup {
  return {
    name,
    async lookup(query, cutoff, _now, ctx) {
      seen.push({ query, cutoff, ...(ctx ? { ctx } : {}) });
      return {
        name,
        lines: [line],
        sources: [{ url: `https://example.org/${name}`, title: name }],
        mode: "live",
        asOf: cutoff.toISOString(),
      };
    },
  };
}

function roomCtx() {
  const data = new Map<string, unknown>();
  const store: KeyValueStore = {
    get: <T>(k: string) => data.get(k) as T | undefined,
    set: <T>(k: string, v: T) => void data.set(k, v),
    delete: (k: string) => data.delete(k),
    keys: () => [...data.keys()],
  };
  const sent: string[] = [];
  const ctx = {
    store,
    send: (_t: EntityId, m: string) => void sent.push(m),
  } as unknown as RoomContext;
  return { ctx, sent };
}

const input = (args: string, entity = "e_1"): CommandInput => ({
  raw: args,
  verb: "x",
  args,
  tokens: args.split(/\s+/).filter(Boolean),
  entity: entity as EntityId,
  room: "workbench/library" as RoomId,
});

describe("the cutoff a lookup sees", () => {
  it("is never later than now", () => {
    const now = new Date("2026-10-03T04:15:00Z");
    expect(effectiveCutoff(new Date("2026-10-09T12:30:00Z"), now).toISOString()).toBe(
      now.toISOString(),
    );
    const past = new Date("2026-09-01T00:00:00Z");
    expect(effectiveCutoff(past, now)).toBe(past);
  });

  it("runLookups passes a future cutoff through as now", async () => {
    const seen: Array<{ query: string; cutoff: Date }> = [];
    const now = new Date("2026-10-03T04:15:00Z");
    await runLookups([spyLookup("x", seen)], "q", new Date("2026-10-09T12:30:00Z"), now);
    expect(seen[0]!.cutoff.toISOString()).toBe(now.toISOString());
  });

  it("reads FRED as of FRED's own (US Central) today, never a UTC date it has not reached", async () => {
    // 04:15 UTC on Oct 3 is still Oct 2 in Chicago — FRED rejects realtime 2026-10-03 then.
    const now = new Date("2026-10-03T04:15:00Z");
    expect(fredToday(now)).toBe("2026-10-02");
    expect(fredAsOfDay(now, now)).toBe("2026-10-02");
    expect(fredAsOfDay(new Date("2026-09-15T12:00:00Z"), now)).toBe("2026-09-15");

    const urls: string[] = [];
    const http: LookupFetch = {
      async json<T>(url: string) {
        urls.push(url);
        if (url.includes("/series/observations")) {
          return {
            ok: true,
            value: {
              observations: [
                { date: "2026-08-01", value: "4.3" },
                { date: "2026-09-01", value: "4.2" },
              ],
            } as T,
          };
        }
        return {
          ok: true,
          value: { seriess: [{ title: "Unemployment Rate", units_short: "%" }] } as T,
        };
      },
      async text() {
        return { ok: false, error: "unused" };
      },
    };
    const r = await fredLookup("k", http).lookup(
      "unemployment",
      effectiveCutoff(new Date("2026-10-09T12:30:00Z"), now),
      now,
      { hints: { fred: ["UNRATE"] }, answerType: "number" },
    );
    expect(r.skipped).toBeUndefined();
    expect(r.readings?.[0]?.value).toBe(4.2);
    const obs = urls.find((u) => u.includes("/series/observations"))!;
    expect(obs).toContain("realtime_start=2026-10-02");
    expect(obs).toContain("realtime_end=2026-10-02");
    expect(obs).not.toContain("2026-10-03");
  });
});

describe("auto lookups", () => {
  it("turns on every keyless lookup, and odds only with a key", () => {
    expect(lookupsFromSpec(undefined, {}).map((l) => l.name)).toEqual([
      "polymarket",
      "kalshi",
      "fred",
      "bls",
    ]);
    expect(lookupsFromSpec("auto", { ODDS_API_KEY: "k" }).map((l) => l.name)).toEqual([
      "polymarket",
      "kalshi",
      "odds",
      "fred",
      "bls",
    ]);
    expect(lookupsFromSpec("off", { ODDS_API_KEY: "k" })).toEqual([]);
    expect(lookupsFromSpec("none", {})).toEqual([]);
    expect(lookupsFromSpec("", {})).toEqual([]);
    expect(lookupsFromSpec("fred", { ODDS_API_KEY: "k" }).map((l) => l.name)).toEqual(["fred"]);
  });
});

describe("data command", () => {
  it("lists sources, answers markets through the lookups, and throttles each entity", async () => {
    const seen: Array<{ query: string; cutoff: Date; ctx?: LookupContext }> = [];
    let t = 1_000_000;
    const now = new Date("2026-10-03T04:15:00Z");
    const cmd = dataCommand({
      options: {
        env: { ODDS_API_KEY: "k" },
        now: () => now,
        lookups: [spyLookup("polymarket", seen), spyLookup("kalshi", seen)],
      },
      now: () => t,
    });
    const { ctx, sent } = roomCtx();
    await cmd.handler(ctx, input("sources"));
    expect(sent.at(-1)).toContain("odds");
    expect(sent.at(-1)).toContain("ODDS_API_KEY set");
    expect(sent.at(-1)).toContain("FRED_API_KEY not set");

    await cmd.handler(ctx, input("markets fed rate cut october"));
    expect(sent.at(-1)).toContain("polymarket fact");
    expect(sent.at(-1)).toContain("kalshi fact");
    expect(seen[0]!.query).toBe("fed rate cut october");
    expect(seen[0]!.ctx?.hints?.markets).toBe("fed rate cut october");

    await cmd.handler(ctx, input("markets again"));
    expect(sent.at(-1)).toContain("One data query every few seconds");
    t += 5_000;

    await cmd.handler(ctx, input("markets fed asof:2026-09-01"));
    expect(seen.at(-1)!.cutoff.toISOString()).toBe("2026-09-01T00:00:00.000Z");

    await cmd.handler(ctx, input("nope x"));
    expect(sent.at(-1)).toContain("data");
    await cmd.handler(ctx, input("series x asof:soon"));
    expect(sent.at(-1)).toContain("is not a date");
  });

  it("is an outbound read for agents, like web search", () => {
    expect(classifyCommandRisk("data markets fed cut")).toBe("egress");
    expect(classifyCommandRisk("data odds americanfootball_nfl ravens")).toBe("egress");
    expect(classifyCommandRisk("data series UNRATE asof:2026-09-01")).toBe("egress");
    expect(classifyCommandRisk("data sources")).toBe("read");
    expect(classifyCommandRisk("data")).toBe("read");
    expect(classifyCommandRisk("data something-else")).toBe("mutate");
  });
});

describe("data queries", () => {
  it("series: an id becomes FRED (and BLS) hints; history is shown", async () => {
    const seen: Array<{ query: string; cutoff: Date; ctx?: LookupContext }> = [];
    const fred: ForecastLookup = {
      name: "fred",
      async lookup(query, cutoff, _now, ctx) {
        seen.push({ query, cutoff, ...(ctx ? { ctx } : {}) });
        return {
          name: "fred",
          lines: [
            "- 2026-09-01 — FRED UNRATE: 4.2 [FRED](https://fred.stlouisfed.org/series/UNRATE)",
          ],
          sources: [],
          readings: [
            {
              source: "FRED",
              series: "UNRATE",
              value: 4.2,
              date: "2026-09-01",
              asOf: "2026-10-02",
              history: [
                { date: "2026-08-01", value: 4.3 },
                { date: "2026-09-01", value: 4.2 },
              ],
            },
          ],
        };
      },
    };
    const out = await dataSeries("UNRATE", undefined, {
      lookups: [fred],
      now: () => new Date("2026-10-03T04:15:00Z"),
    });
    expect(seen[0]!.ctx?.hints?.fred).toEqual(["UNRATE"]);
    expect(seen[0]!.ctx?.answerType).toBe("number");
    expect(out).toContain("FRED UNRATE: 4.2");
    expect(out).toContain("2026-08-01 4.3 · 2026-09-01 4.2");
  });

  it("odds: a sport key and teams go to the board; errors are reported plainly", async () => {
    const asked: unknown[] = [];
    const out = await dataOdds("americanfootball_nfl titans ravens", undefined, {
      env: { ODDS_API_KEY: "k" },
      now: () => new Date("2026-10-03T00:00:00Z"),
      board: async (_key, opts) => {
        asked.push(opts);
        return {
          mode: "live",
          asOf: "2026-10-03T00:00:00.000Z",
          games: [
            {
              sport: "americanfootball_nfl",
              start: "2026-10-04T17:00:00Z",
              away: "Tennessee Titans",
              home: "Baltimore Ravens",
              books: 40,
              probs: [
                ["Baltimore Ravens", 0.85],
                ["Tennessee Titans", 0.15],
              ],
            },
          ],
        };
      },
    });
    expect(asked[0]).toMatchObject({ sport: "americanfootball_nfl", teams: ["titans", "ravens"] });
    expect(out).toContain("Baltimore Ravens 85%");
    expect(await dataOdds("", undefined, {})).toContain("Usage");
    const err = await dataOdds("ravens", undefined, {
      env: {},
      board: async () => ({ error: "ODDS_API_KEY not set" }),
    });
    expect(err).toContain("ODDS_API_KEY not set");
  });

  it("sources reflects the keys present", () => {
    expect(dataSources({})).toContain("odds       off");
    expect(dataSources({ ODDS_API_KEY: "k" })).toContain("odds       ready");
  });
});

describe("search room data verbs", () => {
  it("answers markets/series with caching and the room throttle", async () => {
    let t = 1_000_000;
    const seen: Array<{ query: string; cutoff: Date }> = [];
    const tool = searchToolCommands({
      now: () => t,
      data: { lookups: [spyLookup("polymarket", seen), spyLookup("kalshi", seen)] },
    });
    expect(Object.keys(tool.commands)).toContain("markets");
    expect(tool.catalog).toContain("`markets <q>`");
    const { ctx, sent } = roomCtx();
    await tool.commands.markets!(ctx, input("senate control"));
    expect(sent.at(-1)).toContain("polymarket fact");
    const calls = seen.length;
    t += 5_000;
    await tool.commands.markets!(ctx, input("senate control"));
    expect(sent.at(-1)).toContain("(cached)");
    expect(seen.length).toBe(calls);
    await tool.commands.series!(ctx, input(""));
    expect(sent.at(-1)).toContain("Usage");
  });
});

describe("arena research data evidence", () => {
  const brief = (roundId: string, untilAt?: string): ResearchBrief => ({
    roundId,
    since: "2026-09-20",
    request: "Research request text",
    queries: ["inflation expectations", "survey consumer"],
    ...(untilAt ? { untilAt } : {}),
  });
  const report: ResearchReport = {
    report: "- 2026-09-25 — a news fact [n](https://news.example/a)",
    sources: [{ url: "https://news.example/a" }],
    costUsd: 0.01,
    searches: 1,
    retriever: "fake",
  };

  it("is off unless configured, and never adds odds", () => {
    expect(arenaResearchLookups({})).toEqual([]);
    expect(arenaResearchLookups({ MARINA_ARENA_RESEARCH_LOOKUPS: "off" })).toEqual([]);
    expect(
      arenaResearchLookups({ MARINA_ARENA_RESEARCH_LOOKUPS: "all", ODDS_API_KEY: "k" }).map(
        (l) => l.name,
      ),
    ).toEqual(["polymarket", "kalshi", "fred", "bls"]);
  });

  it("appends markets for every round and a related series only where one is declared, as of the cutoff", async () => {
    const seen: Array<{ query: string; cutoff: Date; ctx?: LookupContext }> = [];
    const now = new Date("2026-10-05T00:00:00Z");
    const retriever = withDataLookups(
      async () => report,
      [spyLookup("polymarket", seen), spyLookup("fred", seen)],
      { now: () => now },
    );
    const lockAt = "2026-10-04T14:00:00Z";
    const out = await retriever(brief("sce-2026-09-infl1y", lockAt));
    expect(out.report).toContain("a news fact");
    expect(out.report).toContain("STRUCTURED DATA");
    expect(out.report).toContain("CHANGES only");
    expect(out.report).toContain("University of Michigan");
    expect(seen.map((s) => s.ctx?.hints?.fred?.[0])).toContain("MICH");
    for (const s of seen) expect(s.cutoff.toISOString()).toBe(new Date(lockAt).toISOString());
    expect(out.sources.length).toBeGreaterThan(report.sources.length);

    seen.length = 0;
    const plain = await retriever(brief("yougov-2026-w41-rv-approval", lockAt));
    expect(seen.map((s) => s.ctx).every(Boolean)).toBe(true);
    // No related series for this round: the series lookup is not consulted.
    expect(seen.length).toBe(1);
    expect(plain.report).toContain("polymarket fact");
  });

  it("adds nothing when nothing matched, and survives a failing lookup", async () => {
    const empty: ForecastLookup = {
      name: "polymarket",
      async lookup() {
        return { name: "polymarket", lines: [], sources: [], skipped: "no match" };
      },
    };
    const boom: ForecastLookup = {
      name: "kalshi",
      async lookup() {
        throw new Error("down");
      },
    };
    const out = await withDataLookups(async () => report, [empty, boom])(brief("x-round"));
    expect(out).toEqual(report);
  });

  it("reads as of the brief's cutoff", () => {
    const now = new Date("2026-10-05T00:00:00Z");
    expect(briefCutoff(brief("r", "2026-10-04T14:00:00Z"), now).toISOString()).toBe(
      "2026-10-04T14:00:00.000Z",
    );
    expect(briefCutoff({ ...brief("r"), until: "2026-10-01" }, now).toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
    expect(briefCutoff(brief("r"), now)).toBe(now);
    expect(ARENA_RELATED_SERIES.length).toBeGreaterThan(0);
  });
});
