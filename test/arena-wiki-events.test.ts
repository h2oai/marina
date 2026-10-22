import { describe, expect, test } from "bun:test";
import { parseForecasterSpec } from "../src/arena/config";
import { parseShadowChallengers } from "../src/arena/earned-routes";
import { forecastRanking, rankingScores } from "../src/arena/forecast";
import {
  ENDED_FACTOR,
  endedNear,
  mentions,
  parseCandidates,
  type WikiApi,
  wikiEventsRanking,
} from "../src/arena/research/wiki-events";
import { arenaMethod } from "../src/arena/settle";
import type { ArenaLock, ArenaRound } from "../src/arena/types";
import type { ResearchReport } from "../src/research/retrieve";

const round: ArenaRound = {
  round_id: "wiki-top10-2099-10-25",
  tracker: "wikipedia",
  question: "top-3 English Wikipedia articles",
  target_type: "ranking_list",
  lock_at: "2099-10-16T14:00:00Z",
  release_at: "2099-10-27T14:00:00Z",
  ranking: { length: 3, week_start: "2099-10-19", week_end: "2099-10-25", rbo_p: 0.9 },
};

// Five articles over three published days: A > B > Bigsport_Games > D > E.
const lock: ArenaLock = {
  round_id: round.round_id,
  answer_obs: ["2099-10-12", "2099-10-13", "2099-10-14"].map((date) => ({
    date,
    items: ["A_x", "B_x", "Bigsport_Games", "D_x", "E_x"],
    views: { A_x: 5000, B_x: 4000, Bigsport_Games: 3000, D_x: 2000, E_x: 1000 },
  })),
};

const source = (url: string, text: string, published = "2099-10-10") => ({
  url,
  title: url,
  text,
  published,
});

function deps(
  reply: object,
  opts: { maxInsert?: number; published?: string; steadyGames?: boolean } = {},
) {
  const report: ResearchReport = {
    report: "",
    sources: [
      source("https://news.test/film", "Thunderfilm opens in theaters on October 21."),
      source(
        "https://news.test/late",
        "Lateshow premieres October 20.",
        opts.published ?? "2099-10-30",
      ),
      source("https://news.test/games", "The Bigsport Games closed on October 12."),
      source("https://news.test/other", "Unrelated text about weather."),
      source("https://news.test/rocket", "Rocketship launches on October 22."),
    ],
    costUsd: 0.01,
    searches: 1,
    retriever: "test",
  };
  const wiki: WikiApi = {
    canonicalTitle: async (t) =>
      ({
        "Thunderfilm (2099 film)": "Thunderfilm_(2099_film)",
        Lateshow: "Lateshow",
        "Bigsport Games": "Bigsport_Games",
        Rocketship: "Rocketship",
      })[t],
    dailyViews: async (title) => {
      const days = [
        "2099-10-09",
        "2099-10-10",
        "2099-10-11",
        "2099-10-12",
        "2099-10-13",
        "2099-10-14",
      ];
      // The Games peaked and are falling; the rest draw a steady level.
      const level: Record<string, number[]> = {
        Bigsport_Games: opts.steadyGames
          ? [3000, 3000, 3000, 3000, 3000, 3000]
          : [3000, 3000, 3000, 600, 600, 600],
        "Thunderfilm_(2099_film)": [500, 500, 500, 500, 500, 500],
        Rocketship: [400, 400, 400, 400, 400, 400],
        Lateshow: [50, 50, 50, 50, 50, 50],
      };
      const v = level[title] ?? [10, 10, 10, 10, 10, 10];
      return days.map((date, i) => ({ date, views: v[i]! }));
    },
  };
  return {
    retriever: async () => report,
    complete: async () => JSON.stringify(reply),
    wiki,
    ...(opts.maxInsert !== undefined ? { maxInsert: opts.maxInsert } : {}),
  };
}

const now = Date.parse("2099-10-15T00:00:00Z");

describe("research:wiki-events", () => {
  test("rankingScores keeps forecastRanking's order", () => {
    expect(
      rankingScores(lock)
        .map(([t]) => t)
        .slice(0, 3),
    ).toEqual(forecastRanking(lock, 3));
  });

  test("only verified events move the list; every rejection has its reason", async () => {
    const reply = {
      events: [
        {
          article: "Thunderfilm (2099 film)",
          event: "release",
          date: "2099-10-21",
          kind: "release",
          source: 0,
        },
        { article: "Lateshow", event: "premiere", date: "2099-10-20", kind: "premiere", source: 1 },
        {
          article: "Bigsport Games",
          event: "games end",
          date: "2099-10-12",
          kind: "ended",
          source: 2,
        },
        {
          article: "Thunderfilm (2099 film)",
          event: "x",
          date: "2099-11-30",
          kind: "release",
          source: 0,
        },
        { article: "Nowhere Article", event: "x", date: "2099-10-21", kind: "other", source: 3 },
        { article: "Ghostpage", event: "x", date: "2099-10-21", kind: "other", source: 9 },
      ],
    };
    const r = await wikiEventsRanking(round, lock, deps(reply), now);
    expect(r.base).toEqual(["A_x", "B_x", "Bigsport_Games"]);
    const why = Object.fromEntries(
      r.events.map((e) => [`${e.article}|${e.date}|${e.source}`, e.reason]),
    );
    expect(why["Thunderfilm (2099 film)|2099-10-21|0"]).toBe("verified");
    expect(why["Lateshow|2099-10-20|1"]).toContain("after the cutoff");
    expect(why["Thunderfilm (2099 film)|2099-11-30|0"]).toContain("outside the window");
    expect(why["Nowhere Article|2099-10-21|3"]).toBe("cited source does not mention the article");
    expect(why["Ghostpage|2099-10-21|9"]).toBe("cited source not among the retrieved results");
    // The Games ended (demoted by ENDED_FACTOR, below D_x); the film takes the last slot.
    expect(ENDED_FACTOR).toBeLessThan(1);
    expect(r.ranking).toEqual(["A_x", "B_x", "Thunderfilm_(2099_film)"]);
    expect(r.events.find((e) => e.action === "demoted")?.canonical).toBe("Bigsport_Games");
  });

  test("inserted articles are capped", async () => {
    const reply = {
      events: [
        {
          article: "Thunderfilm (2099 film)",
          event: "release",
          date: "2099-10-21",
          kind: "release",
          source: 0,
        },
        { article: "Rocketship", event: "launch", date: "2099-10-22", kind: "launch", source: 4 },
      ],
    };
    const two = await wikiEventsRanking(round, lock, deps(reply, { maxInsert: 2 }), now);
    expect(two.ranking.filter((t) => !two.base.includes(t))).toHaveLength(2);
    // The statistical leader is never displaced by an entry-bar event.
    expect(two.ranking[0]).toBe("A_x");
    const one = await wikiEventsRanking(round, lock, deps(reply, { maxInsert: 1 }), now);
    expect(one.ranking.filter((t) => !one.base.includes(t))).toHaveLength(1);
    expect(one.ranking).toHaveLength(3);
    const none = await wikiEventsRanking(round, lock, deps(reply, { maxInsert: 0 }), now);
    expect(none.ranking).toEqual(none.base);
  });

  test("an ended event demotes only when its views already fall", async () => {
    const reply = {
      events: [
        {
          article: "Bigsport Games",
          event: "games end",
          date: "2099-10-12",
          kind: "ended",
          source: 2,
        },
      ],
    };
    const steady = await wikiEventsRanking(round, lock, deps(reply, { steadyGames: true }), now);
    expect(steady.ranking).toEqual(steady.base);
    expect(steady.events[0]!.reason).toContain("not falling");
    const falling = await wikiEventsRanking(round, lock, deps(reply), now);
    expect(falling.events[0]!.action).toBe("demoted");
  });

  test("an upcoming event below the entry floor does not enter", async () => {
    const reply = {
      events: [
        { article: "Lateshow", event: "premiere", date: "2099-10-20", kind: "premiere", source: 1 },
      ],
    };
    const r = await wikiEventsRanking(round, lock, deps(reply, { published: "2099-10-01" }), now);
    expect(r.events[0]!.verified).toBe(true);
    expect(r.events[0]!.reason).toContain("entry bar");
    expect(r.ranking).toEqual(r.base);
  });

  test("an unparseable reply leaves the statistical list", async () => {
    expect(parseCandidates("no json here")).toEqual([]);
    expect(parseCandidates('{"events": [{"article": 3}]}')).toEqual([]);
    const r = await wikiEventsRanking(
      round,
      lock,
      { ...deps({}), complete: async () => "sorry" },
      now,
    );
    expect(r.ranking).toEqual(r.base);
  });

  test("an ending word must sit near the article's mention", () => {
    const far = source("u", `Bigsport Games ${"x ".repeat(400)} the season closed.`);
    expect(endedNear(far, "Bigsport Games")).toBe(false);
    expect(endedNear(source("u", "The Bigsport Games closed on Sunday."), "Bigsport Games")).toBe(
      true,
    );
  });

  test("mentions matches the article's most distinctive word", () => {
    expect(mentions(source("u", "Thunderfilm opens"), "Thunderfilm (2099 film)")).toBe(true);
    expect(mentions(source("u", "nothing"), "Thunderfilm (2099 film)")).toBe(false);
  });

  test("spec, method key and shadow challenger parse", () => {
    const spec =
      "research:wiki-events:openrouter/google/gemini-3.1-pro-preview@search:tavily+duckduckgo";
    expect(parseForecasterSpec(spec)).toBe(spec);
    expect(() => parseForecasterSpec("research:wiki-events")).toThrow();
    expect(arenaMethod(`route wikipedia → ${spec}; marina wiki-events research`).methodKind).toBe(
      "research:wiki-events",
    );
    expect(arenaMethod("route civiqs → research:openrouter/x/y@tavily:basic").methodKind).toBe(
      "research",
    );
    expect(
      parseShadowChallengers({ MARINA_ARENA_SHADOW_CHALLENGERS: `wikipedia=${spec}` }).get(
        "wikipedia",
      ),
    ).toEqual([spec]);
  });
});
