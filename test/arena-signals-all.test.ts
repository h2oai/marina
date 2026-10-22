// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { forecastSettings } from "../src/arena/forecast-config";
import type { ResearchBrief } from "../src/arena/research/briefs";
import {
  arenaResearchLookups,
  arenaSignalHints,
  freezeLookupLine,
  withDataLookups,
} from "../src/arena/research/data-evidence";
import {
  ALL_SIGNALS_LOOKUPS,
  ARENA_SIGNAL_MAP,
  arenaLookupSpec,
  arenaSignalEntry,
  arenaSignalSet,
} from "../src/arena/research/signal-map";
import type { LookupFetch } from "../src/forecast/lookup-http";
import {
  pollAvailable,
  pollNet,
  type VoteHubPoll,
  voteHubLookup,
} from "../src/forecast/lookup-polls";
import { fredLookup } from "../src/forecast/lookup-series";
import type { ForecastLookup, LookupContext } from "../src/forecast/lookup-types";
import { type ResearchReport, withProvidedText } from "../src/research/retrieve";
import { verifyDossier } from "../src/research/verify";

const ALL = { MARINA_ARENA_RESEARCH_SIGNALS: "all" };
const brief = (roundId: string, untilAt?: string): ResearchBrief => ({
  roundId,
  since: "2026-09-20",
  request: "Research request text",
  queries: ["brief query one", "brief query two"],
  ...(untilAt ? { untilAt, until: untilAt.slice(0, 10) } : {}),
});
const empty: ResearchReport = {
  report: "",
  sources: [],
  costUsd: 0,
  searches: 0,
  retriever: "closed-book",
};

/** Real arena round ids (social-simulation-arena.com/data.json, 2026-10-19) per family. */
const ROUNDS: Record<string, string[]> = {
  "civiqs-econ": ["civiqs-2026-w44-econ-now", "civiqs-2026-w44-econ-direction"],
  "civiqs-family-finances": ["civiqs-2026-w44-family-finances"],
  "civiqs-inflation-concern": ["civiqs-2026-w44-inflation-concern"],
  "civiqs-angry-share": ["civiqs-2026-w44-angry-share"],
  "civiqs-approval": [
    "civiqs-2026-w44-approval",
    "civiqs-profile-2026-w44",
    "civiqs-age5064-2026-w36",
    "civiqs-hisp-2026-w36",
  ],
  "yougov-generic": ["yougov-2026-w36-generic"],
  "yougov-approval": [
    "yougov-2026-w45-rv-approval",
    "yougov-2026-w45-strong-approval",
    "yougov-2026-w36-approval",
    "yougov-xtab-2026-w45",
  ],
  "harvard-harris": ["hh-2026-10-approval"],
  "morning-consult": ["mc-2026-w39-approval"],
  midterm: ["midterm-2026-house-margin", "midterm-2026-house-seats"],
  umich: ["umich-2026-09-prelim", "umich-2026-09-final", "umich-party-2026-09-dem"],
  "sce-infl1y": ["sce-2026-09-infl1y"],
  "sce-infl3y": ["sce-2026-09-infl3y"],
  aaii: ["aaii-2026-09-24"],
};

describe("arena signal map", () => {
  it("maps every family's real round ids to its entry, and attention rounds to none", () => {
    for (const [family, ids] of Object.entries(ROUNDS))
      for (const id of ids) expect(`${id}:${arenaSignalEntry(id)?.family}`).toBe(`${id}:${family}`);
    for (const id of [
      "trends-basket-2026-10-31",
      "wiki-top10-2026-11-01",
      "trends-2026-08-29-tesla",
    ])
      expect(arenaSignalEntry(id)).toBeUndefined();
    expect(new Set(ARENA_SIGNAL_MAP.map((e) => e.family)).size).toBe(ARENA_SIGNAL_MAP.length);
  });

  it("names the documented signals per family", () => {
    const fred = (id: string) => arenaSignalHints(ALL)(brief(id)).hints.fred ?? [];
    expect(fred("civiqs-2026-w44-econ-now")).toEqual([
      "UMCSENT",
      "GASREGW",
      "ICSA",
      "UNRATE",
      "CPIAUCSL",
      "NASDAQCOM",
      "T5YIE",
    ]);
    expect(fred("civiqs-2026-w44-inflation-concern")).toEqual(
      expect.arrayContaining(["CPIAUCSL", "GASREGW", "MICH", "T5YIE", "EXPINF1YR"]),
    );
    // The default related series stays first.
    expect(fred("sce-2026-09-infl1y")[0]).toBe("MICH");
    expect(fred("sce-2026-09-infl3y")[0]).toBe("EXPINF3YR");
    expect(fred("aaii-2026-09-24")).toEqual(["NASDAQCOM", "NASDAQ100", "VIXCLS"]);
    // SP500 has no ALFRED vintages, so no past lock could read it.
    for (const e of ARENA_SIGNAL_MAP) expect(e.hints.fred ?? []).not.toContain("SP500");
    // UMCSENT is the umich target itself (republished late on FRED): never a umich signal.
    expect(fred("umich-2026-09-prelim")).not.toContain("UMCSENT");
    expect(fred("umich-2026-09-prelim")).toContain("MICH");

    const polls = (id: string) => arenaSignalHints(ALL)(brief(id)).hints.polls;
    expect(polls("yougov-2026-w45-rv-approval")).toMatchObject({
      type: "approval",
      exclude: ["yougov"],
    });
    expect(polls("mc-2026-w39-approval")?.exclude).toEqual(["morning consult"]);
    expect(polls("civiqs-2026-w44-approval")?.exclude).toEqual(["civiqs"]);
    expect(polls("hh-2026-10-approval")?.exclude).toEqual(["harris"]);
    expect(polls("midterm-2026-house-margin")).toMatchObject({ type: "generic-ballot" });
    expect(polls("civiqs-2026-w44-econ-now")).toBeUndefined();
    expect(arenaSignalHints(ALL)(brief("mc-2026-w39-approval")).hints.markets).toBe(
      "Trump approval rating",
    );
    expect(arenaSignalHints(ALL)(brief("trends-basket-2026-10-31")).hints).toEqual({});
  });

  it("keeps the control and `consumer` unchanged; `all` is a superset", () => {
    const econ = brief("civiqs-2026-w44-econ-now");
    expect(arenaSignalSet({})).toBe("off");
    expect(arenaSignalSet({ MARINA_ARENA_RESEARCH_SIGNALS: "consumer" })).toBe("consumer");
    expect(arenaSignalSet({ MARINA_ARENA_RESEARCH_SIGNALS: " ALL " })).toBe("all");
    expect(arenaSignalSet({ MARINA_ARENA_RESEARCH_SIGNALS: "bogus" })).toBe("off");
    expect(arenaSignalHints({})(econ).hints).toEqual({ fred: ["UMCSENT"] });
    expect(arenaSignalHints({ MARINA_ARENA_RESEARCH_SIGNALS: "consumer" })(econ).hints).toEqual({
      fred: ["UMCSENT", "GASREGW", "ICSA"],
    });
    const consumer = arenaSignalHints({ MARINA_ARENA_RESEARCH_SIGNALS: "consumer" })(econ).hints;
    const all = arenaSignalHints(ALL)(econ).hints;
    expect(all.fred).toEqual(expect.arrayContaining(consumer.fred!));
    expect(all.markets).toBe("US recession 2026");
    // `consumer` adds nothing outside Civiqs economic rounds; `all` does.
    const approval = brief("yougov-2026-w45-rv-approval");
    expect(arenaSignalHints({ MARINA_ARENA_RESEARCH_SIGNALS: "consumer" })(approval).hints).toEqual(
      {},
    );
    expect(arenaSignalHints(ALL)(approval).hints.polls).toBeDefined();
  });
});

describe("arena lookup selection", () => {
  const names = (env: NodeJS.ProcessEnv) => arenaResearchLookups(env).map((l) => l.name);

  it("is off when unset, and `all` turns on its keyless lookups plus FRED", () => {
    expect(names({})).toEqual([]);
    expect(arenaLookupSpec({})).toBe("off");
    expect(arenaLookupSpec(ALL)).toBe(ALL_SIGNALS_LOOKUPS);
    expect(names(ALL)).toEqual(["polymarket", "kalshi", "fred", "votehub"]);
    // An explicit setting always wins, even under `all`.
    expect(names({ ...ALL, MARINA_ARENA_RESEARCH_LOOKUPS: "fred" })).toEqual(["fred"]);
    expect(names({ ...ALL, MARINA_ARENA_RESEARCH_LOOKUPS: "off" })).toEqual([]);
    expect(names({ MARINA_ARENA_RESEARCH_LOOKUPS: "fred,votehub" })).toEqual(["fred", "votehub"]);
    expect(names({ MARINA_ARENA_RESEARCH_LOOKUPS: "all", ODDS_API_KEY: "k" })).toEqual([
      "polymarket",
      "kalshi",
      "fred",
      "bls",
      "votehub",
    ]);
  });

  it("records the effective lookups in the strategy fingerprint without moving existing ones", () => {
    expect(forecastSettings("nowcast", {}).lookups).toBe("off");
    expect(forecastSettings("nowcast", { MARINA_ARENA_RESEARCH_LOOKUPS: "fred" }).lookups).toBe(
      "fred",
    );
    expect(forecastSettings("nowcast", ALL).lookups).toBe(ALL_SIGNALS_LOOKUPS);
    expect(forecastSettings("nowcast", ALL).fingerprint).not.toBe(
      forecastSettings("nowcast", {}).fingerprint,
    );
  });

  it("runs a poll lookup only for a round that names a poll quantity", async () => {
    const seen: string[] = [];
    const spy = (name: string): ForecastLookup => ({
      name,
      async lookup(_q, _c, _n, ctx) {
        seen.push(`${name}:${ctx?.hints?.polls?.type ?? "-"}`);
        return { name, lines: [], sources: [], skipped: "none" };
      },
    });
    const retriever = withDataLookups(async () => empty, [spy("votehub"), spy("polymarket")], {
      hints: arenaSignalHints(ALL),
    });
    await retriever(brief("civiqs-2026-w44-econ-now"));
    expect(seen).toEqual(["polymarket:-"]);
    seen.length = 0;
    await retriever(brief("mc-2026-w39-approval"));
    expect(seen).toEqual(["votehub:approval", "polymarket:approval"]);
  });

  it("searches markets with the family's phrase under `all`, the brief's queries otherwise", async () => {
    const queries: Array<{ q: string; m?: string }> = [];
    const pm: ForecastLookup = {
      name: "polymarket",
      async lookup(q, _c, _n, ctx?: LookupContext) {
        queries.push({ q, m: ctx?.hints?.markets });
        return { name: "polymarket", lines: [], sources: [] };
      },
    };
    await withDataLookups(async () => empty, [pm], { hints: arenaSignalHints(ALL) })(
      brief("yougov-2026-w45-rv-approval"),
    );
    await withDataLookups(async () => empty, [pm])(brief("yougov-2026-w45-rv-approval"));
    expect(queries).toEqual([
      { q: "Trump approval rating", m: "Trump approval rating" },
      { q: "brief query one brief query two", m: "brief query one brief query two" },
    ]);
  });
});

/**
 * An ALFRED stand-in: each observation has a release day; a request with
 * `realtime_start=d` sees only observations released on or before `d`.
 */
function fakeAlfred(
  series: Record<string, Array<{ date: string; value: number; released: string }>>,
  requests: string[] = [],
): LookupFetch {
  return {
    async json<T>(url: string) {
      const u = new URL(url);
      const id = u.searchParams.get("series_id")!;
      requests.push(`${id}@${u.searchParams.get("realtime_start")}`);
      if (u.pathname.endsWith("/series"))
        return { ok: true, value: { seriess: [{ title: id, units_short: "Index" }] } as T };
      const d = u.searchParams.get("realtime_start")!;
      const observations = (series[id] ?? [])
        .filter((o) => o.released <= d && o.date <= u.searchParams.get("observation_end")!)
        .map((o) => ({ date: o.date, value: String(o.value) }))
        .reverse();
      return { ok: true, value: { observations } as T };
    },
    async text() {
      return { ok: false, error: "unused" };
    },
  };
}

describe("cutoff and leakage", () => {
  const lockAt = "2026-10-14T14:00:00Z";
  const now = new Date("2026-10-19T12:00:00Z");

  it("excludes a FRED value released after the lock, for every chunk of a long series list", async () => {
    const requests: string[] = [];
    const cpi = [
      { date: "2026-08-01", value: 320.1, released: "2026-09-11" },
      // September CPI was released the day after the lock: never visible.
      { date: "2026-09-01", value: 330.9, released: "2026-10-15" },
    ];
    const weekly = (v: number) => [
      { date: "2026-10-04", value: v, released: "2026-10-09" },
      { date: "2026-10-11", value: v + 10, released: "2026-10-16" },
    ];
    const http = fakeAlfred(
      {
        CPIAUCSL: cpi,
        UMCSENT: [{ date: "2026-08-01", value: 58.2, released: "2026-09-26" }],
        GASREGW: weekly(3.1),
        ICSA: weekly(221000),
        UNRATE: [{ date: "2026-08-01", value: 4.3, released: "2026-09-05" }],
        NASDAQCOM: [
          { date: "2026-10-12", value: 6100.5, released: "2026-10-13" },
          // Released on the lock day: FRED vintages are daily, so the prior day's is read.
          { date: "2026-10-13", value: 6200.5, released: "2026-10-14" },
        ],
        T5YIE: [{ date: "2026-10-13", value: 2.41, released: "2026-10-13" }],
      },
      requests,
    );
    const out = await withDataLookups(async () => empty, [fredLookup("test-key", http)], {
      now: () => now,
      hints: arenaSignalHints(ALL),
    })(brief("civiqs-2026-w44-econ-now", lockAt));
    // A past intraday lock reads the prior UTC day's vintage — for all seven series.
    const atLock = requests.filter((r) => r.endsWith("@2026-10-13"));
    expect(new Set(atLock.map((r) => r.split("@")[0])).size).toBe(7);
    expect(requests.some((r) => r > "" && /@2026-10-1[4-9]/.test(r))).toBe(false);
    expect(out.report).toContain("FRED CPIAUCSL: 320.1");
    expect(out.report).not.toContain("330.9");
    expect(out.report).toContain("FRED GASREGW: 3.1");
    expect(out.report).not.toContain("13.1");
    expect(out.report).toContain("FRED NASDAQCOM: 6100.5");
    expect(out.report).not.toContain("6200.5");
    for (const id of ["UMCSENT", "ICSA", "UNRATE", "T5YIE"]) expect(out.report).toContain(id);
  });

  it("reads a poll only when its whole listing day precedes a past lock", () => {
    const poll = (created_at: string, end_date = "2026-10-10"): VoteHubPoll => ({
      pollster: "P",
      created_at,
      end_date,
      answers: [],
    });
    const cutoff = new Date(lockAt);
    expect(pollAvailable(poll("2026-10-13"), cutoff, now)).toBe(true);
    // Listed on the lock day: its time is unknown, so it may be after the lock.
    expect(pollAvailable(poll("2026-10-14"), cutoff, now)).toBe(false);
    expect(pollAvailable(poll("2026-10-15"), cutoff, now)).toBe(false);
    // A live read may use what is listed today.
    expect(pollAvailable(poll("2026-10-19"), now, now)).toBe(true);
    // Fieldwork ending after the listing day is malformed: dropped.
    expect(pollAvailable(poll("2026-10-12", "2026-10-13"), cutoff, now)).toBe(false);
    expect(pollAvailable({ ...poll("bad"), created_at: "x" }, cutoff, now)).toBe(false);
  });

  it("drops other-cutoff polls and the target's own pollster from the VoteHub lines", async () => {
    const polls: VoteHubPoll[] = [
      {
        pollster: "RMG Research",
        population: "rv",
        sample_size: 1000,
        created_at: "2026-10-09",
        start_date: "2026-10-02",
        end_date: "2026-10-06",
        answers: [
          { choice: "Approve", pct: 43 },
          { choice: "Disapprove", pct: 56 },
        ],
      },
      {
        pollster: "Ipsos",
        population: "a",
        created_at: "2026-10-03",
        start_date: "2026-09-30",
        end_date: "2026-10-01",
        answers: [
          { choice: "Approve", pct: 38 },
          { choice: "Disapprove", pct: 58 },
        ],
      },
      {
        pollster: "Morning Consult",
        created_at: "2026-10-10",
        end_date: "2026-10-08",
        answers: [
          { choice: "Approve", pct: 45 },
          { choice: "Disapprove", pct: 51 },
        ],
      },
      {
        pollster: "Late Poll",
        created_at: "2026-10-15",
        end_date: "2026-10-13",
        answers: [
          { choice: "Approve", pct: 49.5 },
          { choice: "Disapprove", pct: 47 },
        ],
      },
      {
        // Listed late by VoteHub (backfill): old fieldwork is not recent evidence.
        pollster: "Backfill",
        created_at: "2026-10-08",
        start_date: "2025-12-22",
        end_date: "2025-12-28",
        answers: [
          { choice: "Approve", pct: 50 },
          { choice: "Disapprove", pct: 46 },
        ],
      },
      ...["2026-09-12", "2026-09-16"].map((d) => ({
        pollster: "Earlier",
        created_at: d,
        end_date: d,
        answers: [
          { choice: "Approve", pct: 41 },
          { choice: "Disapprove", pct: 55 },
        ],
      })),
    ];
    const urls: string[] = [];
    const http: LookupFetch = {
      async json<T>(url: string) {
        urls.push(url);
        return { ok: true, value: polls as T };
      },
      async text() {
        return { ok: false, error: "unused" };
      },
    };
    expect(pollNet(polls[0]!, "approval")).toBe(-13);
    const paired = withProvidedText(
      withDataLookups(async () => empty, [voteHubLookup(http)], {
        now: () => now,
        hints: arenaSignalHints(ALL),
      }),
      async () => {
        throw new Error("no page fetch for frozen lines");
      },
    );
    const out = await paired.retriever(brief("mc-2026-w42-approval", lockAt));
    expect(urls[0]).toContain("api.votehub.com/polls?poll_type=approval&subject=Donald+Trump");
    expect(out.report).toContain("- 2026-10-09 — VoteHub: RMG Research Trump approval");
    expect(out.report).toContain("Approve 43%, Disapprove 56%; net -13");
    expect(out.report).not.toContain("VoteHub: Morning Consult");
    expect(out.report).not.toContain("Late Poll");
    expect(out.report).not.toContain("49.5");
    expect(out.report).toContain("mean net -16.5 across 2 polls");
    expect(out.report).toContain("vs -14 across 2 ending from 2026-09-09; change -2.5");
    expect(out.report).not.toContain("Backfill");
    expect(out.report).toContain("other pollsters' Trump approval");
    // Every line is a dated data line that verifies against its frozen payload.
    const checked = await verifyDossier(out.report, paired.pageText);
    expect(checked.stats.verified).toBe(
      out.report.split("\n").filter((l) => l.startsWith("- ")).length,
    );
    expect(checked.stats.unverified + checked.stats.unreachable).toBe(0);
    expect(out.sources.every((s) => s.url.includes("#marina-snapshot-"))).toBe(true);
    expect(out.sources.every((s) => s.availableAt === new Date(lockAt).toISOString())).toBe(true);
  });
});

describe("dossier rendering", () => {
  it("freezes a market line under a payload URL that the citation check accepts", async () => {
    const line =
      '- 2026-10-14 — Polymarket "Trump approval on Oct 31?": Above 42%? — Yes 37% (price at 2026-10-14T13:00Z) [Polymarket](https://polymarket.com/event/trump-approval)';
    const frozen = freezeLookupLine("polymarket", line, "2026-10-14T14:00:00.000Z");
    expect(frozen.line).toContain("https://polymarket.com/event/trump-approval#marina-snapshot-");
    expect(frozen.source?.origin).toBe("https://polymarket.com/event/trump-approval");
    expect(frozen.source?.observedAt).toBe("2026-10-14");
    expect(freezeLookupLine("x", "- no link", undefined)).toEqual({ line: "- no link" });

    const pm: ForecastLookup = {
      name: "polymarket",
      async lookup(_q, cutoff) {
        return {
          name: "polymarket",
          lines: [line],
          sources: [{ url: "https://polymarket.com/event/trump-approval" }],
          mode: "historical",
          asOf: cutoff.toISOString(),
        };
      },
    };
    let fetched = 0;
    const paired = withProvidedText(
      withDataLookups(async () => empty, [pm], {
        now: () => new Date("2026-10-19T00:00:00Z"),
        hints: arenaSignalHints(ALL),
      }),
      async () => {
        fetched++;
        return "the live page has moved: Yes 55%";
      },
    );
    const out = await paired.retriever(
      brief("yougov-2026-w45-rv-approval", "2026-10-14T14:00:00Z"),
    );
    expect(out.report).toContain("STRUCTURED DATA");
    expect(out.report).toContain("other pollsters' Trump approval");
    const checked = await verifyDossier(out.report, paired.pageText);
    expect(checked.verifiedText).toContain("Yes 37%");
    expect(fetched).toBe(0);
  });
});
