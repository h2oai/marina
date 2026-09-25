// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ArenaData } from "../src/arena/data";
import { scoreShadow } from "../src/arena/evaluate";
import { buildResearchBrief, familyOf } from "../src/arena/research/briefs";
import { researchForecastRound } from "../src/arena/research/forecaster";
import { openRouterWebRetriever, type Retriever } from "../src/arena/research/retrieve";
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

  it("records the first forecast per round and forecaster, and scores resolved ones", async () => {
    const forecast = JSON.stringify({ topline: { mean: history.at(-1)!.value + 1, sd: 1 } });
    const row = {
      roundId: round.round_id,
      forecaster: "research:x",
      forecast,
      detail: "{}",
      costUsd: 0.05,
    };
    expect(db.recordArenaShadow(row)).toBe(true);
    expect(db.recordArenaShadow({ ...row, forecast: "{}" })).toBe(false);
    expect(db.listArenaShadow({ forecaster: "research:x" })).toHaveLength(1);

    const files: Record<string, unknown> = {
      "questions/season0.json": { rounds: [round] },
      [`locks/${round.round_id}.json`]: lock,
      "resolutions/resolved.json": { [round.round_id]: { value: history.at(-1)!.value + 1 } },
    };
    const data = new ArenaData("https://example.test", async (url) => {
      const path = url.replace("https://example.test/", "");
      return path in files ? Response.json(files[path]) : new Response("", { status: 404 });
    });
    const scores = await scoreShadow(data, db.listArenaShadow());
    expect(scores).toHaveLength(1);
    expect(scores[0]!.skill).toBeGreaterThan(scores[0]!.baselineSkill);
    expect(scores[0]!.costUsd).toBe(0.05);
  });
});
