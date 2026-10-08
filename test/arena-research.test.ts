// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseForecasterSpec } from "../src/arena/config";
import { ArenaData } from "../src/arena/data";
import { scoreShadow } from "../src/arena/evaluate";
import { forecastRound } from "../src/arena/forecast";
import { buildResearchBrief, familyOf } from "../src/arena/research/briefs";
import {
  aggregateNoAnchor,
  NoAnchorRefusal,
  questionBounds,
  researchForecastRound,
} from "../src/arena/research/forecaster";
import {
  combineRetrievers,
  inlineFootnotes,
  openRouterWebRetriever,
  type Retriever,
  retrieverFromSpec,
  sonarRetriever,
} from "../src/arena/research/retrieve";
import { figuresIn, verifyDossier } from "../src/arena/research/verify";
import type { ArenaLock, ArenaPoint, ArenaRound } from "../src/arena/types";
import type { DecisionProvider } from "../src/decisions/types";
import { MarinaDB } from "../src/persistence/database";
import { cleanupDb } from "./helpers";

const weekly = (values: number[], start = "2026-01-02"): ArenaPoint[] =>
  values.map((value, i) => ({
    date: new Date(Date.parse(start) + i * 7 * 86_400_000).toISOString().slice(0, 10),
    value,
  }));
const history = weekly(Array.from({ length: 30 }, (_, i) => 35 + (i % 2)));
const round: ArenaRound = {
  round_id: "yougov-2026-w40-rv-approval",
  tracker: "economist_yougov",
  series: "yougov_rv_approval",
  question: "Percent of RVs approving?",
  unit: "% approve",
  target_type: "continuous_normal",
  lock_at: "2026-09-27T14:00:00Z",
  release_at: "2026-09-29T14:00:00Z",
};
const lock: ArenaLock = { round_id: round.round_id, answer_history: history };

describe("research briefs", () => {
  it("routes by tracker and series, never by question prose", () => {
    expect(familyOf(round)).toBe("approval"); // "economist" must not read as economy
    expect(familyOf({ ...round, tracker: "civiqs", series: "civiqs_econ_direction" })).toBe(
      "consumer",
    );
    expect(familyOf({ ...round, tracker: "aaii", series: "aaii_bull_bear_spread" })).toBe("aaii");
    expect(familyOf({ ...round, series: "yougov_generic_margin" })).toBe("generic");
    expect(familyOf({ ...round, tracker: "wikipedia", series: "wiki_views" })).toBe("attention");
  });

  it("bounds research to after the last value and says that wave is already known", () => {
    const brief = buildResearchBrief(round, lock);
    expect(brief.since).toBe(history.at(-1)!.date);
    expect(brief.request).toContain(`after ${history.at(-1)!.date}`);
    expect(brief.request).toContain("ALREADY known");
    expect(brief.request).toContain("previous reading");
  });

  it("uses the selected same-day nowcast revision and refuses an older reading", () => {
    const sameDayLock = { ...lock, answer_history: [{ date: "2026-10-02", value: -33.1 }] };
    const fresh = buildResearchBrief(round, sameDayLock, {
      nowcast: { date: "2026-10-02", value: -34.5 },
    });
    expect(fresh.since).toBe("2026-10-02");
    expect(fresh.request).toContain("is -34.5");
    expect(fresh.request).not.toContain("is -33.1");
    const stale = buildResearchBrief(round, sameDayLock, {
      nowcast: { date: "2026-10-01", value: -34.5 },
    });
    expect(stale.since).toBe("2026-10-02");
    expect(stale.request).toContain("is -33.1");
    expect(stale.request).not.toContain("is -34.5");
  });

  it("selects same-day revisions independently for each profile cell", () => {
    const profile: ArenaRound = {
      ...round,
      target_type: "profile_energy",
      cells: ["civiqs_net_approval", "civiqs_net_family_finances"],
    };
    const brief = buildResearchBrief(
      profile,
      {
        round_id: profile.round_id,
        answer_history_by_cell: {
          civiqs_net_approval: [{ date: "2026-10-02", value: -26.7 }],
          civiqs_net_family_finances: [{ date: "2026-10-02", value: -33.1 }],
        },
      },
      {
        cellNowcasts: {
          civiqs_net_approval: { date: "2026-10-01", value: -26.0 },
          civiqs_net_family_finances: { date: "2026-10-02", value: -34.5 },
        },
      },
    );
    expect(brief.since).toBe("2026-10-02");
    expect(brief.request).toContain("-26.7");
    expect(brief.request).toContain("-34.5");
    expect(brief.request).not.toContain("-33.1");
  });
});

describe("OpenRouter web retriever", () => {
  it("returns the report, de-duplicated citations, cost and search count", async () => {
    let sent: Record<string, unknown> = {};
    const retriever = openRouterWebRetriever({
      model: "openai/gpt-6-luna",
      apiKey: "k",
      fetcher: async (_url, init) => {
        sent = JSON.parse(String(init.body));
        return Response.json({
          choices: [
            {
              message: {
                content: "Poll X: 36% ([x.com](https://x.com/a))",
                annotations: [
                  { url_citation: { url: "https://x.com/a", title: "X" } },
                  { url_citation: { url: "https://x.com/a", title: "X" } },
                ],
              },
            },
          ],
          usage: { cost: 0.03, server_tool_use_details: { web_search_requests: 4 } },
        });
      },
    });
    const r = await retriever({ roundId: "r", since: "2026-09-19", request: "find polls" });
    expect(r.sources).toEqual([{ url: "https://x.com/a", title: "X" }]);
    expect(r).toMatchObject({ costUsd: 0.03, searches: 4 });
    expect(sent.plugins).toEqual([{ id: "web", max_results: 8 }]);
    expect(sent.reasoning).toEqual({ effort: "low" });
  });

  it("refuses an empty report", async () => {
    const retriever = openRouterWebRetriever({
      model: "m",
      apiKey: "k",
      fetcher: async () => Response.json({ choices: [{ message: { content: "" } }] }),
    });
    await expect(retriever({ roundId: "r", since: "d", request: "q" })).rejects.toThrow("empty");
  });
});

describe("Perplexity Sonar and combined retrievers", () => {
  const reply = (content: string, url: string, cost: number) =>
    Response.json({
      choices: [{ message: { content, annotations: [{ url_citation: { url, title: url } }] } }],
      usage: { cost },
    });

  it("calls Sonar with native search: no web plugin, no reasoning knob", async () => {
    let sent: Record<string, unknown> = {};
    const retriever = sonarRetriever({
      model: "sonar-pro",
      apiKey: "k",
      fetcher: async (_url, init) => {
        sent = JSON.parse(String(init.body));
        return reply("Poll Y: 40% [1]", "https://y.com", 0.011);
      },
    });
    const r = await retriever({ roundId: "r", since: "2026-09-25", request: "polls" });
    expect(sent.model).toBe("perplexity/sonar-pro");
    expect(sent.plugins).toBeUndefined();
    expect(sent.reasoning).toBeUndefined();
    expect(r).toMatchObject({ retriever: "sonar:perplexity/sonar-pro", costUsd: 0.011 });
    expect(r.sources).toEqual([{ url: "https://y.com", title: "https://y.com" }]);
  });

  it("turns Sonar's numbered footnotes into links the verifier can check", async () => {
    expect(
      inlineFootnotes("A 35%.[2] B 40%.[1][3] C [9] D [1](https://keep)", [
        { url_citation: { url: "https://one" } },
        { url_citation: { url: "https://two" } },
        { url_citation: { url: "ftp://nope" } },
      ]),
    ).toBe("A 35%.[2](https://two) B 40%.[1](https://one)[3] C [9] D [1](https://keep)");
    const retriever = sonarRetriever({
      model: "sonar",
      apiKey: "k",
      fetcher: async () =>
        Response.json({
          choices: [
            {
              message: {
                content: "Poll Z: 41% approve.[1]",
                annotations: [{ url_citation: { url: "https://z.com/p" } }],
              },
            },
          ],
        }),
    });
    const r = await retriever({ roundId: "r", since: "d", request: "q" });
    expect(r.report).toBe("Poll Z: 41% approve.[1](https://z.com/p)");
  });

  it("merges several engines: headed reports, source union, summed cost; survives one failure", async () => {
    const a: Retriever = async () => ({
      report: "fact A",
      sources: [{ url: "https://a" }, { url: "https://shared" }],
      costUsd: 0.02,
      searches: 3,
      retriever: "openrouter-web:m",
    });
    const b: Retriever = async () => ({
      report: "fact B",
      sources: [{ url: "https://shared" }, { url: "https://b" }],
      costUsd: 0.01,
      searches: 0,
      retriever: "sonar:perplexity/sonar",
    });
    const broken: Retriever = async () => {
      throw new Error("down");
    };
    const r = await combineRetrievers([a, b, broken])({ roundId: "r", since: "d", request: "q" });
    expect(r.report).toBe("## openrouter-web:m\nfact A\n\n## sonar:perplexity/sonar\nfact B");
    expect(r.sources.map((s) => s.url)).toEqual(["https://a", "https://shared", "https://b"]);
    expect(r).toMatchObject({
      costUsd: 0.03,
      searches: 3,
      retriever: "openrouter-web:m+sonar:perplexity/sonar",
    });
    await expect(
      combineRetrievers([broken, broken])({ roundId: "r", since: "d", request: "q" }),
    ).rejects.toThrow("every research retriever failed");
  });

  it("research specs take up to eight analysts and their own retrievers after @", () => {
    const eight = Array.from({ length: 8 }, (_, i) => `openrouter/v${i}/m`).join(",");
    expect(parseForecasterSpec(`research:${eight}`)).toBe(`research:${eight}`);
    expect(() => parseForecasterSpec(`research:${eight},openrouter/v9/m`)).toThrow();
    const withRetrievers =
      "research:openrouter/deepseek/deepseek-v4-pro,openrouter/anthropic/claude-opus-5.5@sonar:sonar-pro,openrouter-web:openai/gpt-6-luna";
    expect(parseForecasterSpec(withRetrievers)).toBe(withRetrievers);
    expect(parseForecasterSpec("research:a/b@tavily:basic")).toBe("research:a/b@tavily:basic");
    expect(() => parseForecasterSpec("research:a/b@tavily:deep")).toThrow();
    // The crew keeps its three roles.
    expect(() => parseForecasterSpec("crew:a/b,c/d,e/f,g/h")).toThrow();
  });

  it("parses one or several retrievers from the setting", () => {
    expect(() => retrieverFromSpec("openrouter-web:openai/gpt-6-luna", "k")).not.toThrow();
    expect(() =>
      retrieverFromSpec("openrouter-web:openai/gpt-6-luna, sonar:sonar-pro", "k"),
    ).not.toThrow();
    expect(() => retrieverFromSpec("bing:web", "k")).toThrow("unknown");
    expect(() => retrieverFromSpec("sonar:", "k")).toThrow("names no model");
  });
});

describe("citation verification", () => {
  it("picks out the figures worth checking, not years or links", () => {
    expect(
      figuresIn(
        "Sept 22, 2026: approval 35% (1,401 RVs), net −28, $4.478 ([a](https://a.b/2026/123))",
      ),
    ).toEqual(["35", "1401", "4.478"]);
  });

  it("tags lines verified, unverified or unreachable against the cited pages", async () => {
    const report = [
      "- YouGov: **39%** approve ([yougov](https://pollster.example/poll))",
      "- Echelon: **36%** approve, 64% disapprove ([echelon](https://echelon.example/sept))",
      "- Ipsos: **32%** ([ipsos](https://paywall.example/x))",
      "- An uncited 41% claim",
      "Nothing numeric here ([a](https://echelon.example/sept))",
    ].join("\n");
    const pages: Record<string, string | undefined> = {
      "https://pollster.example/poll": "Approve 35% Disapprove 63% among 1,401 registered voters",
      "https://echelon.example/sept": "Trump approval: 36% approve / 64% disapprove",
    };
    const v = await verifyDossier(report, async (u) => pages[u]);
    expect(v.stats).toEqual({ verified: 1, unverified: 1, unreachable: 1, uncited: 1 });
    expect(v.annotated).toContain("[unverified: 39 not on the cited page]");
    expect(v.verifiedText).toContain("Echelon");
    expect(v.verifiedText).not.toContain("YouGov");
  });
});

describe("source terms", () => {
  it("never fetches publishers whose terms bar bots or forwarding", async () => {
    const fetched: string[] = [];
    const v = await verifyDossier(
      "- YouGov: 35% ([y](https://today.yougov.com/topics/x))\n- AAII: 12.5% spread ([a](https://www.aaii.com/sentiment))",
      async (u) => {
        fetched.push(u);
        return "35% 12.5%";
      },
    );
    expect(fetched).toEqual([]);
    expect(v.stats.unreachable).toBe(2);
    expect(v.verifiedText).toBe("");
  });
});

describe("research agent pipeline", () => {
  it("required research rejects an outage or unverifiable dossier before analysts run", async () => {
    let calls = 0;
    for (const retriever of [
      async () => {
        throw new Error("search unavailable");
      },
      async () => ({
        report: "missing sources",
        sources: [],
        costUsd: 0,
        searches: 1,
        retriever: "search",
      }),
    ]) {
      await expect(
        researchForecastRound(round, lock, {
          requireResearch: true,
          retriever,
          pageText: async () => undefined,
          analysts: [
            {
              name: "fixture",
              complete: async () => {
                calls++;
                return '{"mean":38,"sd":1}';
              },
            },
          ],
        }),
      ).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });

  const retriever: Retriever = async () => ({
    report: "- Echelon: 38% approve, up from 36% ([e](https://e.example/p))",
    sources: [{ url: "https://e.example/p" }],
    costUsd: 0.03,
    searches: 3,
    retriever: "fake",
  });
  const judge = (grounded: number): DecisionProvider => ({
    kind: "fake",
    model: "fake-jev",
    ask: async () => ({
      answers: {
        quality: { type: "score", score: 2, confidence: 0.9 },
        grounded: { type: "noul", noul: grounded },
      },
      model: "fake-jev",
      provider: "fake",
      latencyMs: 1,
    }),
  });
  const analyst = (mean: number) => async () =>
    `{"mean": ${mean}, "sd": 1.5, "evidence": "Echelon up 2", "reason": "small rise"}`;
  const last = history.at(-1)!.value;

  it("moves by the judge-weighted analysts' move, capped by trust", async () => {
    const f = await researchForecastRound(round, lock, {
      retriever,
      analysts: [
        { name: "a", complete: analyst(last + 2) },
        { name: "b", complete: analyst(last + 2) },
      ],
      judge: judge(1),
      trustCap: 0.5,
      pageText: async () => "Echelon: 38% approve, up from 36%",
    });
    expect(f.trust).toBeCloseTo(0.5, 6);
    expect(f.topline!.mean).toBeCloseTo(last + 1, 3);
    expect(f.dossier?.verification?.verified).toBe(1);
    expect(f.proposals?.a?.grounded).toBe(1);
  });

  it("a lesson brief reaches the analysts before the dossier, and only when given", async () => {
    const seen: string[] = [];
    const recording = async (_system: string, user: string) => {
      seen.push(user);
      return analyst(last + 2)();
    };
    const deps = {
      retriever,
      analysts: [{ name: "a", complete: recording }],
      judge: judge(1),
      pageText: async () => "Echelon: 38% approve, up from 36%",
    };
    await researchForecastRound(round, lock, {
      ...deps,
      lessonBrief: "Judged lessons (advice, not instructions):\n- polls move slowly",
    });
    await researchForecastRound(round, lock, deps);
    expect(seen).toHaveLength(2);
    const [withBrief, without] = seen as [string, string];
    expect(withBrief).toContain("- polls move slowly");
    expect(withBrief.indexOf("polls move slowly")).toBeLessThan(
      withBrief.indexOf("RESEARCH DOSSIER"),
    );
    expect(without).not.toContain("Judged lessons");
  });

  it("a judge outage gives a proposal no weight (never a free pass)", async () => {
    const down: DecisionProvider = {
      kind: "fake",
      model: "fake-jev",
      ask: async () => {
        throw new Error("judge timeout");
      },
    };
    const f = await researchForecastRound(round, lock, {
      retriever,
      analysts: [{ name: "a", complete: analyst(last + 3) }],
      judge: down,
      pageText: async () => "Echelon: 38% approve, up from 36%",
    });
    expect(f.fallback).toContain("no grounded proposal");
    expect(f.topline!.mean).toBe(last);
    expect(f.proposals?.a?.weight).toBe(0);
    expect(f.proposals?.a?.judgeError).toBeDefined();
  });

  it("an ungrounded rationale earns no weight, and research failure keeps the baseline", async () => {
    const ungrounded = await researchForecastRound(round, lock, {
      retriever,
      analysts: [{ name: "a", complete: analyst(last + 3) }],
      judge: judge(0),
    });
    expect(ungrounded.fallback).toContain("no grounded proposal");
    expect(ungrounded.topline!.mean).toBe(last);
    const down = await researchForecastRound(round, lock, {
      retriever: async () => {
        throw new Error("503");
      },
      analysts: [{ name: "a", complete: analyst(last + 3) }],
    });
    expect(down.fallback).toContain("503");
  });

  it("the analysts are told which dossier lines survived verification", async () => {
    let prompt = "";
    await researchForecastRound(round, lock, {
      retriever,
      analysts: [
        {
          name: "a",
          complete: async (_s, user) => {
            prompt = user;
            return "{}";
          },
        },
      ],
      pageText: async () => "a page without that figure",
    });
    expect(prompt).toContain("[unverified: 38, 36 not on the cited page]");
  });

  const civiqsRound: ArenaRound = {
    ...round,
    round_id: "civiqs-2026-w40-approval",
    tracker: "civiqs",
    series: "civiqs_net_approval",
    release_at: "2026-10-02T14:00:00Z",
  };
  const nowcastStart = async () => ({
    ...forecastRound(civiqsRound, lock),
    topline: { mean: 34.2, sd: 1.2 },
    nowcast: { civiqs_net_approval: { date: "2026-09-26", value: 34.2 } },
    daily: {
      series: "civiqs_net_approval",
      source: "civiqs/approve_president_trump_2025/2026-09-27.json",
      points: [
        { date: "2026-09-25", value: 34.6 },
        { date: "2026-09-26", value: 34.2 },
      ],
    },
  });

  it("the judge grounds rationales in the series data too, and its cost and identity are recorded", async () => {
    const seen: Array<Array<{ ref: string; text: string }>> = [];
    const costly: DecisionProvider = {
      kind: "decisions-api",
      model: "typesafe/jev-1.13",
      ask: async (req) => {
        seen.push((req.state as { evidence: Array<{ ref: string; text: string }> }).evidence);
        return {
          answers: {
            quality: { type: "score", score: 2, confidence: 0.9 },
            grounded: { type: "noul", noul: 0.8 },
          },
          model: "typesafe/jev-1.13",
          provider: "decisions-api",
          latencyMs: 40,
          costUsd: 0.002,
        };
      },
    };
    const f = await researchForecastRound(civiqsRound, lock, {
      retriever,
      analysts: [
        { name: "a", complete: analyst(34) },
        { name: "b", complete: analyst(34.4) },
      ],
      judge: costly,
      pageText: async () => "unrelated page",
      base: nowcastStart,
    });
    expect(seen).toHaveLength(2);
    const refs = seen[0]!.map((e) => e.ref);
    expect(refs).toEqual(
      expect.arrayContaining(["series:history", "series:start", "series:daily"]),
    );
    const byRef = Object.fromEntries(seen[0]!.map((e) => [e.ref, e.text]));
    expect(byRef["series:start"]).toContain("STRUCTURED SOURCE DATA");
    expect(byRef["series:start"]).toContain("not web research");
    expect(byRef["series:start"]).toContain("dated 2026-09-26");
    expect(byRef["series:history"]).toContain(`${history.at(-1)!.date} ${history.at(-1)!.value}`);
    expect(byRef["series:daily"]).toContain("2026-09-25 34.6");
    // Nothing verified in the dossier — the series data is still there to ground on.
    expect(refs).toContain("dossier:1");
    expect(f.judge).toEqual({
      provider: "decisions-api",
      model: "typesafe/jev-1.13",
      calls: 2,
      latencyMs: 40,
      costUsd: 0.004,
      errors: 0,
    });
    expect(f.proposals?.a).toMatchObject({ judgeCostUsd: 0.002, judgeLatencyMs: 40 });
    expect(f.dailySource).toContain("2026-09-27.json");
    expect("daily" in f).toBe(false);
    expect(f.note).toContain("over the Civiqs nowcast");
  });

  it("records a judge outage in the judge summary", async () => {
    const down: DecisionProvider = {
      kind: "decisions-api",
      model: "typesafe/jev-1.13",
      ask: async () => {
        throw new Error("judge timeout");
      },
    };
    const f = await researchForecastRound(round, lock, {
      retriever,
      analysts: [{ name: "a", complete: analyst(last + 1) }],
      judge: down,
    });
    expect(f.judge).toMatchObject({
      provider: "decisions-api",
      model: "typesafe/jev-1.13",
      calls: 1,
      errors: 1,
      error: expect.stringContaining("judge timeout"),
    });
  });

  it("tells analysts what the start forecast is, the resolution rule, and the daily tracker", async () => {
    let system = "";
    let prompt = "";
    await researchForecastRound(civiqsRound, lock, {
      retriever,
      analysts: [
        {
          name: "a",
          complete: async (s, user) => {
            system = s;
            prompt = user;
            return "{}";
          },
        },
      ],
      base: nowcastStart,
    });
    expect(prompt).toContain(
      "the NOWCAST — the freshest daily Civiqs reading (34.2, dated 2026-09-26)",
    );
    expect(prompt).toContain("Civiqs dashboard shows for this series on Friday 2026-10-02");
    expect(prompt).toContain("every night");
    expect(prompt).toContain("skill = 1 − CRPS / CRPS(persistence)");
    expect(prompt).toContain("DAILY TRACKER");
    expect(prompt).toContain("2026-09-25 34.6");
    expect(`${system} ${prompt}`).not.toMatch(/authoritative|latest wave|calibrated baseline/);
    // A non-Civiqs round names persistence and gets no daily block.
    await researchForecastRound(round, lock, {
      retriever,
      analysts: [
        {
          name: "a",
          complete: async (_s, user) => {
            prompt = user;
            return "{}";
          },
        },
      ],
    });
    expect(prompt).toContain("the persistence baseline");
    expect(prompt).not.toContain("DAILY TRACKER");
  });
});

describe("no-anchor research (a numeric round with no history)", () => {
  const seats: ArenaRound = {
    round_id: "special-seats",
    tracker: "special",
    series: "seats",
    question: "Seats won by Party A in the chamber (all 500 decided)",
    unit: "seats",
    target_type: "continuous_normal",
    lock_at: "2026-10-20T22:00:00Z",
    release_at: "2026-11-20T00:00:00Z",
    resolve: "provisional score from official tallies; final on certified results",
  };
  const empty: ArenaLock = { round_id: seats.round_id, answer_history: [], history: [] };
  const retriever: Retriever = async () => ({
    report: "- Model X (2026-09-20): Party A wins 306 seats ([x](https://x.example/m))",
    sources: [{ url: "https://x.example/m" }],
    costUsd: 0.02,
    searches: 3,
    retriever: "fake",
  });
  const judge = (grounded: number): DecisionProvider => ({
    kind: "fake",
    model: "fake-jev",
    ask: async () => ({
      answers: {
        quality: { type: "score", score: 2, confidence: 0.9 },
        grounded: { type: "noul", noul: grounded },
      },
      model: "fake-jev",
      provider: "fake",
      latencyMs: 1,
      costUsd: 0.001,
    }),
  });
  const analyst = (mean: number, sd: number) => async () =>
    `{"mean": ${mean}, "sd": ${sd}, "evidence": "Model X 306", "reason": "consensus"}`;

  it("the baseline, nowcast and pure-model path still refuse it", () => {
    expect(() => forecastRound(seats, empty)).toThrow("no history to forecast from");
  });

  it("briefs a search for the level (forecasts, markets, base rate) over the last 30 days", () => {
    const brief = buildResearchBrief(seats, empty, { now: Date.parse("2026-09-29T12:00:00Z") });
    expect(brief.since).toBe("2026-08-30");
    expect(brief.request).toContain("No value of this quantity has been published yet");
    expect(brief.request).toContain("Prediction-market");
    expect(brief.queries?.[0]).toBe(seats.question);
  });

  it("files the median of the judged analysts' means with sd ≥ median sd, dispersion, 7% floor", async () => {
    let prompt = "";
    let system = "";
    const f = await researchForecastRound(seats, empty, {
      retriever,
      analysts: [
        {
          name: "a",
          complete: async (s, u) => {
            system = s;
            prompt = u;
            return analyst(300, 10)();
          },
        },
        { name: "b", complete: analyst(306, 12) },
        { name: "c", complete: analyst(308, 9) },
      ],
      judge: judge(1),
      pageText: async () => "Model X (2026-09-20): Party A wins 306 seats",
    });
    expect(f.anchor).toBe("none");
    expect(f.topline!.mean).toBe(306);
    // median sd 10, dispersion ≈ 4.16, floor 0.07 × 306 = 21.42 → the floor wins.
    expect(f.topline!.sd).toBeCloseTo(21.42, 3);
    expect(f.noAnchor).toMatchObject({
      used: ["a", "b", "c"],
      median: 306,
      medianSd: 10,
      floor: 21.42,
      bounds: { lo: 0, hi: 500 },
    });
    expect(f.dossier?.verification?.verified).toBe(1);
    expect(f.proposals?.b).toMatchObject({ mean: 306, sd: 12, grounded: 1 });
    expect(f.judge).toMatchObject({ calls: 3, costUsd: 0.003 });
    expect(f.note).toContain("no anchor");
    expect(system).toContain("NO published history");
    expect(prompt).toContain("Bounds: the answer lies in [0, 500]");
    expect(prompt).toContain("Resolution: provisional score from official tallies");
    expect(prompt).not.toContain("persistence");
  });

  it("drops out-of-bounds and outlying proposals, and wide analysts widen the sd", async () => {
    const f = await researchForecastRound(seats, empty, {
      retriever,
      analysts: [
        { name: "a", complete: analyst(298, 25) },
        { name: "b", complete: analyst(304, 20) },
        { name: "c", complete: analyst(700, 20) },
        { name: "d", complete: analyst(470, 20) },
        { name: "e", complete: analyst(302, 30) },
      ],
    });
    expect(f.noAnchor?.used).toEqual(["a", "b", "e"]);
    expect(f.noAnchor?.dropped.c).toContain("outside [0, 500]");
    expect(f.noAnchor?.dropped.d).toContain("from the median");
    expect(f.roles?.c).toContain("dropped");
    expect(f.topline).toEqual({ mean: 302, sd: 25 });
  });

  it("with nothing usable the round is not answered — never a fabricated number", async () => {
    const run = (deps: Partial<Parameters<typeof researchForecastRound>[2]>) =>
      researchForecastRound(seats, empty, {
        retriever,
        analysts: [{ name: "a", complete: analyst(306, 10) }],
        ...deps,
      });
    // Ungrounded rationale.
    const ungrounded = await run({ judge: judge(0) }).catch((e) => e);
    expect(ungrounded).toBeInstanceOf(NoAnchorRefusal);
    expect(ungrounded.message).toContain("not answered");
    expect(ungrounded.detail.proposals.a.weight).toBe(0);
    expect(ungrounded.detail.dossier.costUsd).toBe(0.02);
    expect(ungrounded.detail.judge.costUsd).toBe(0.001);
    // Every analyst abstains.
    const abstained = await run({
      analysts: [{ name: "a", complete: async () => '{"abstain": true, "reason": "no data"}' }],
    }).catch((e) => e);
    expect(abstained).toBeInstanceOf(NoAnchorRefusal);
    expect(abstained.detail.roles.a).toContain("abstained");
    // Research down.
    const down = await run({
      retriever: async () => {
        throw new Error("503");
      },
    }).catch((e) => e);
    expect(down).toBeInstanceOf(NoAnchorRefusal);
    expect(down.message).toContain("503");
  });

  it("aggregates deterministically; bounds come from the question, never per round", () => {
    expect(questionBounds(seats)).toMatchObject({ lo: 0, hi: 500 });
    expect(questionBounds({ ...seats, question: "Share approving?", unit: "% approve" })).toEqual({
      lo: 0,
      hi: 100,
      why: "a percentage",
    });
    expect(questionBounds({ ...seats, question: "Margin?", unit: "margin, points" })).toBe(
      undefined,
    );
    const one = aggregateNoAnchor({ a: { mean: 10, sd: 0.1 } });
    expect("topline" in one && one.topline).toEqual({ mean: 10, sd: 0.7 });
    expect(aggregateNoAnchor({ a: { mean: -1, sd: 1 } }, questionBounds(seats))).toEqual({
      dropped: { a: expect.stringContaining("outside") },
    });
  });
});

describe("shadow ledger", () => {
  const DB = `test_arena_shadow_${process.pid}.db`;
  let db: MarinaDB;
  beforeEach(() => {
    db = new MarinaDB(DB);
  });
  afterEach(() => {
    db.close();
    cleanupDb(DB);
  });

  it("keeps every recording and scores the LAST one before lock, as a filing would be", async () => {
    const good = JSON.stringify({ topline: { mean: history.at(-1)!.value + 1, sd: 1 } });
    const stale = JSON.stringify({ topline: { mean: history.at(-1)!.value - 5, sd: 1 } });
    const row = {
      roundId: round.round_id,
      forecaster: "research:x",
      forecast: stale,
      detail: "{}",
      costUsd: 0.05,
    };
    expect(db.recordArenaShadow(row)).toBe(true);
    expect(db.recordArenaShadow({ ...row, forecast: good })).toBe(true);
    expect(db.listArenaShadow({ forecaster: "research:x" })).toHaveLength(2); // append-only history

    const files: Record<string, unknown> = {
      "questions/season0.json": { rounds: [round] },
      [`locks/${round.round_id}.json`]: lock,
      "resolutions/resolved.json": { [round.round_id]: { value: history.at(-1)!.value + 1 } },
    };
    const data = new ArenaData("https://example.test", async (url) => {
      const path = url.replace("https://example.test/", "");
      return path in files ? Response.json(files[path]) : new Response("", { status: 404 });
    });
    const lockAt = Date.parse(round.lock_at);
    const base = { round_id: round.round_id, forecaster: "research:x", cost_usd: 0.05 };
    const scores = await scoreShadow(data, [
      { ...base, forecast: stale, created_at: lockAt - 5 * 86_400_000 }, // days early
      { ...base, forecast: good, created_at: lockAt - 3_600_000 }, // the last before lock
      { ...base, forecast: stale, created_at: lockAt + 60_000 }, // after lock: never counts
    ]);
    expect(scores).toHaveLength(1);
    expect(scores[0]!.skill).toBeGreaterThan(scores[0]!.baselineSkill); // the good one was scored
    expect(scores[0]!.costUsd).toBe(0.05);
  });
});
