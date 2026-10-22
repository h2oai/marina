import { describe, expect, test } from "bun:test";
import { parseForecasterSpec } from "../src/arena/config";
import { parseShadowChallengers, specKind } from "../src/arena/earned-routes";
import { forecastSettings } from "../src/arena/forecast-config";
import { type WikiApi, wikiEventsRanking } from "../src/arena/research/wiki-events";
import type { ArenaRound } from "../src/arena/types";
import {
  type DailyTop,
  DEFAULT_SPECIALIST_PARAMS,
  dayOfWeekFactors,
  persistenceWeekEnd,
  projectSeries,
  rankingSkill,
  specialistRanking,
  weekDays,
  weeklyTop,
} from "../src/arena/wiki-specialist";
import {
  asAnswerObs,
  dailyTopsForRound,
  lastPublishedDay,
  parseTop,
  topUrl,
} from "../src/arena/wikimedia";
import type { ResearchReport } from "../src/research/retrieve";

const DAY_MS = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS);

const round: ArenaRound = {
  round_id: "wiki-top10-2099-10-25",
  tracker: "wikipedia",
  question: "top-3 English Wikipedia articles",
  target_type: "ranking_list",
  lock_at: "2099-10-16T14:00:00Z",
  release_at: "2099-10-27T14:00:00Z",
  ranking: { length: 3, week_start: "2099-10-19", week_end: "2099-10-25", rbo_p: 0.9 },
};
const LAST = "2099-10-14"; // lock day − 2

/** `days` daily lists ending `last`, each article's views from `f(title, daysBeforeLast)`. */
function synth(
  last: string,
  days: number,
  titles: string[],
  f: (title: string, back: number) => number,
): DailyTop[] {
  return Array.from({ length: days }, (_, i) => {
    const back = days - 1 - i;
    const articles: Record<string, number> = { Main_Page: 9e6, "Special:Search": 5e6 };
    for (const t of titles) {
      const v = f(t, back);
      if (v > 0) articles[t] = v;
    }
    return { date: addDays(last, -back), articles };
  });
}

describe("wiki-specialist: the round's own rules", () => {
  test("weeks run Monday to Sunday; persistence is the last Sunday before the lock", () => {
    expect(weekDays("2026-10-25")).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
    ]);
    expect(() => weekDays("2026-10-24")).toThrow("not a Sunday");
    // wiki-top10-2026-10-25 locks Fri 2026-10-16: its null is the week ending 2026-10-11.
    expect(persistenceWeekEnd("2026-10-16T14:00:00Z")).toBe("2026-10-11");
    expect(lastPublishedDay("2026-10-16T14:00:00Z", Date.parse("2026-10-20T00:00:00Z"))).toBe(
      "2026-10-14",
    );
  });

  test("weeklyTop sums seven days, drops excluded titles, breaks ties by title", () => {
    const days = synth("2099-10-25", 7, ["B", "A", "C"], (t) => ({ A: 10, B: 10, C: 5 })[t]!);
    expect(weeklyTop(days, "2099-10-25", 3)).toEqual(["A", "B", "C"]);
    expect(() => weeklyTop(days.slice(1), "2099-10-25", 3)).toThrow("missing");
  });

  test("rankingSkill is 1 − RBO loss ÷ persistence loss, 0 when persistence is perfect", () => {
    const truth = ["a", "b", "c"];
    expect(rankingSkill(truth, truth, ["x", "y", "z"])).toBe(1);
    expect(rankingSkill(["x", "y", "z"], truth, ["x", "y", "z"])).toBe(0);
    expect(rankingSkill(["q", "r", "s"], truth, truth)).toBe(0);
    // Top-weighted: the first slot right beats the last slot right.
    expect(rankingSkill(["a", "x", "y"], truth, ["p", "q", "r"])).toBeGreaterThan(
      rankingSkill(["x", "y", "c"], truth, ["p", "q", "r"]),
    );
  });
});

describe("wiki-specialist: projection", () => {
  const horizons = [5, 6, 7, 8, 9, 10, 11];
  const p = { ...DEFAULT_SPECIALIST_PARAMS, dayOfWeek: false, risk: 0 };

  test("a flat page projects seven days at its level, nothing transient", () => {
    const r = projectSeries(Array(28).fill(1000), horizons, p);
    expect(r.weekly).toBeCloseTo(7000, 6);
    expect(r.transient).toBe(0);
  });

  test("a spike decays with the half-life measured from its own decline", () => {
    // base 100, excess 6400 at the peak halving every 2 days, peak 8 days ago
    const series = Array.from({ length: 28 }, (_, i) => {
      const since = i - 19;
      return since < 0 ? 100 : 100 + 6400 * 0.5 ** (since / 2);
    });
    const page = projectSeries(series, horizons, { ...p, pageWeight: 1, baseQuantile: 0.5 });
    expect(page.base).toBe(100);
    expect(page.pageHalfLife).toBeCloseTo(2, 6);
    const excess = 6400 * 0.5 ** (8 / 2);
    const expected = 7 * 100 + horizons.reduce((s, h) => s + excess * 0.5 ** (h / 2), 0);
    expect(page.weekly).toBeCloseTo(expected, 6);
    // Shrinking toward a slower prior projects more of the spike forward.
    const shrunk = projectSeries(series, horizons, { ...p, pageWeight: 0.5, baseQuantile: 0.5 });
    expect(shrunk.halfLife).toBeCloseTo(Math.sqrt(2 * p.halfLifeDays), 6);
    expect(shrunk.weekly).toBeGreaterThan(page.weekly);
  });

  test("weekday factors average 1 and correct a weekend-heavy level", () => {
    const days = synth("2099-10-14", 28, ["A"], (_t, back) => {
      const dow = new Date(`${addDays("2099-10-14", -back)}T00:00:00Z`).getUTCDay();
      return dow === 0 || dow === 6 ? 2000 : 1000;
    });
    const f = dayOfWeekFactors(days);
    expect(f.reduce((s, x) => s + x, 0) / 7).toBeCloseTo(1, 1);
    expect(f[0]!).toBeGreaterThan(f[3]!);
  });
});

describe("wiki-specialist: ranking", () => {
  // Steady keeps 1000/day; Spike hit 20000 four days ago and halves daily.
  const titles = ["Steady", "Spike", "Small", "Other"];
  const views = (t: string, back: number) =>
    t === "Steady"
      ? 1000
      : t === "Spike"
        ? back > 4
          ? 50
          : 50 + 20000 * 0.5 ** (4 - back)
        : t === "Small"
          ? 300
          : 200;
  const days = synth(LAST, 28, titles, views);

  test("a fading spike above a steady page today ranks below it for next week", () => {
    const today = days.at(-1)!.articles;
    expect(today.Spike!).toBeGreaterThan(today.Steady!);
    const r = specialistRanking(days, { weekEnd: "2099-10-25", lastDay: LAST, length: 3 });
    // Its projected week (~1.5k after the transient discount) falls below even Small (2.1k).
    expect(r.ranking).toEqual(["Steady", "Small", "Spike"]);
    expect(r.read).toEqual({ from: addDays(LAST, -27), to: LAST, days: 28 });
    expect(r.ranking).not.toContain("Main_Page");
  });

  test("the transient discount yields a top slot to the steadier page", () => {
    const close = synth(LAST, 28, ["Steady", "Spiky"], (t, back) =>
      t === "Steady" ? 1000 : back > 3 ? 200 : 2600,
    );
    const opts = { weekEnd: "2099-10-25", lastDay: LAST, length: 2 } as const;
    const neutral = specialistRanking(close, {
      ...opts,
      params: { risk: 0, dayOfWeek: false, halfLifeDays: 20, pageWeight: 0 },
    });
    expect(neutral.ranking[0]).toBe("Spiky");
    const cautious = specialistRanking(close, {
      ...opts,
      params: { risk: 0.6, dayOfWeek: false, halfLifeDays: 20, pageWeight: 0 },
    });
    expect(cautious.ranking[0]).toBe("Steady");
  });

  test("no list after the cutoff is ever read", () => {
    const later = [...days, ...synth("2099-10-16", 2, ["Leak"], () => 9e7).map((d) => ({ ...d }))];
    const r = specialistRanking(later, { weekEnd: "2099-10-25", lastDay: LAST, length: 3 });
    expect(r.ranking).not.toContain("Leak");
    expect(r.read.to).toBe(LAST);
    expect(() =>
      specialistRanking(later, { weekEnd: "2099-10-25", lastDay: "2099-01-01", length: 3 }),
    ).toThrow("no daily top list");
  });
});

describe("wiki-specialist: Wikimedia data", () => {
  test("parseTop reads the top endpoint and refuses another day's list", () => {
    const body = {
      items: [
        {
          project: "en.wikipedia",
          access: "all-access",
          year: "2099",
          month: "10",
          day: "14",
          articles: [
            { article: "Main_Page", views: 5, rank: 1 },
            { article: "A", views: 3, rank: 2 },
            { article: "Bad", views: "x", rank: 3 },
          ],
        },
      ],
    };
    expect(parseTop(body, "2099-10-14")).toEqual({
      date: "2099-10-14",
      articles: { Main_Page: 5, A: 3 },
    });
    expect(() => parseTop(body, "2099-10-13")).toThrow("asked 2099-10-13");
    expect(parseTop({ items: [] }, "2099-10-14")).toBeUndefined();
    expect(parseTop(undefined, "2099-10-14")).toBeUndefined();
    expect(topUrl("2099-10-14")).toBe(
      "https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/2099/10/14",
    );
  });

  test("archive first, Wikimedia for the gaps, nothing after the last published day", async () => {
    const asked: string[] = [];
    const data = {
      wikitopDay: async (_dir: string, day: string) =>
        day === "2099-10-14" || day === "2099-10-12"
          ? { day, articles: { A: 1 } }
          : day === "2099-10-11"
            ? undefined
            : undefined,
    };
    const fetchJson = async (url: string) => {
      asked.push(url);
      const [, y, m, d] = /(\d{4})\/(\d{2})\/(\d{2})$/.exec(url)!;
      if (`${y}-${m}-${d}` === "2099-10-11") throw new Error("Wikimedia 503");
      return { items: [{ year: y, month: m, day: d, articles: [{ article: "B", views: 2 }] }] };
    };
    const r = await dailyTopsForRound(data, round, 5, {
      fetchJson,
      now: Date.parse("2099-10-20T00:00:00Z"),
    });
    expect(r.lastDay).toBe(LAST);
    expect(r.days.map((d) => d.date)).toEqual(["2099-10-10", "2099-10-12", "2099-10-13", LAST]);
    expect(r.sources.archive).toBe(2);
    expect(r.sources.wikimedia).toBe(2);
    expect(r.sources.missing).toEqual(["2099-10-11"]);
    expect(r.sources.errors[0]).toContain("503");
    // Never a request for a day at or after the lock day − 1.
    expect(asked.some((u) => /2099\/10\/1[5-9]$/.test(u))).toBe(false);
    expect(asAnswerObs(r.days).at(-1)).toEqual({ date: LAST, items: ["A"], views: { A: 1 } });
  });

  test("an early run cannot read past its own clock", async () => {
    const asked: string[] = [];
    const r = await dailyTopsForRound({ wikitopDay: async () => undefined }, round, 3, {
      fetchJson: async (url) => {
        asked.push(url);
        return undefined;
      },
      now: Date.parse("2099-10-10T09:00:00Z"),
    });
    expect(r.lastDay).toBe("2099-10-08");
    expect(asked.every((u) => !/2099\/10\/(09|1\d)$/.test(u))).toBe(true);
  });
});

describe("wiki-specialist: scheduled events on the projected list", () => {
  const report: ResearchReport = {
    report: "",
    sources: [
      {
        url: "https://news.test/a",
        title: "a",
        text: "Thunderfilm opens October 21; Rocketship launches October 22; Bigshow premieres October 20.",
        published: "2099-10-10",
      },
    ],
    costUsd: 0.02,
    searches: 1,
    retriever: "test",
  };
  const wiki: WikiApi = {
    canonicalTitle: async (t) => t.replace(/ /g, "_"),
    dailyViews: async (_title, start) =>
      Array.from({ length: 14 }, (_, i) => ({ date: addDays(start, i), views: 900 })),
  };
  const event = (article: string, date: string) => ({
    article,
    event: "x",
    date,
    kind: "release",
    source: 0,
  });
  const base: Array<[string, number]> = [
    ["Steady", 7000],
    ["Spike", 6000],
    ["Small", 5000],
    ["Other", 100],
  ];
  const lock = { round_id: round.round_id, answer_obs: [] };
  const now = Date.parse("2099-10-15T00:00:00Z");

  test("models' verified events are pooled and the insertion cap holds", async () => {
    const one = async () => JSON.stringify({ events: [event("Thunderfilm", "2099-10-21")] });
    const two = async () =>
      JSON.stringify({
        events: [event("Rocketship", "2099-10-22"), event("Thunderfilm", "2099-10-21")],
      });
    const run = (maxInsert: number) =>
      wikiEventsRanking(
        round,
        lock,
        {
          retriever: async () => report,
          complete: [one, two],
          wiki,
          maxInsert,
          base: { scored: base, perDay: 7 },
        },
        now,
      );
    const capped = await run(1);
    expect(capped.base).toEqual(["Steady", "Spike", "Small"]);
    expect(capped.ranking.filter((t) => !capped.base.includes(t))).toHaveLength(1);
    expect(capped.ranking[0]).toBe("Steady");
    expect(capped.events.filter((e) => e.reason.startsWith("duplicate"))).toHaveLength(1);
    const two_ = await run(2);
    expect(two_.ranking.filter((t) => !two_.base.includes(t))).toHaveLength(2);
    expect(two_.ranking[0]).toBe("Steady");
    expect((await run(0)).ranking).toEqual(["Steady", "Spike", "Small"]);
  });

  test("one failed model leaves the others; all failing is an error", async () => {
    const bad = async () => {
      throw new Error("model down");
    };
    const good = async () => JSON.stringify({ events: [event("Thunderfilm", "2099-10-21")] });
    const deps = {
      retriever: async () => report,
      wiki,
      maxInsert: 3,
      base: { scored: base, perDay: 7 },
    };
    const r = await wikiEventsRanking(round, lock, { ...deps, complete: [bad, good] }, now);
    expect(r.ranking).toContain("Thunderfilm");
    await expect(
      wikiEventsRanking(round, lock, { ...deps, complete: [bad, bad] }, now),
    ).rejects.toThrow("model down");
  });
});

describe("wiki-specialist: spec", () => {
  test("parses alone, with event models and retrievers, and as a shadow challenger", () => {
    for (const spec of [
      "wiki-specialist",
      "wiki-specialist:openrouter/google/gemini-3-flash-preview",
      "wiki-specialist:openrouter/deepseek/deepseek-v3.2,openrouter/qwen/qwen3-max@search:tavily+duckduckgo",
    ])
      expect(parseForecasterSpec(spec)).toBe(spec);
    expect(() => parseForecasterSpec("wiki-specialist:")).toThrow();
    expect(() => parseForecasterSpec("wiki-specialist:notamodel")).toThrow();
    expect(parseForecasterSpec("route:wikipedia=wiki-specialist;*=nowcast")).toBe(
      "route:wikipedia=wiki-specialist;*=nowcast",
    );
    expect(specKind("wiki-specialist:openrouter/x/y")).toBe("wiki-specialist");
    expect(
      parseShadowChallengers({
        MARINA_ARENA_SHADOW_CHALLENGERS:
          "wikipedia=wiki-specialist|research:wiki-events:openrouter/x/y",
      }).get("wikipedia"),
    ).toEqual(["wiki-specialist", "research:wiki-events:openrouter/x/y"]);
  });

  test("the insertion cap is in the event spec's fingerprint only", () => {
    const env = { MARINA_ARENA_WIKI_EVENTS_MAX_INSERT: "2" };
    expect(forecastSettings("wiki-specialist:openrouter/x/y", env)).toHaveProperty(
      "wikiEventsMaxInsert",
      "2",
    );
    expect(forecastSettings("wiki-specialist", env)).not.toHaveProperty("wikiEventsMaxInsert");
  });
});
