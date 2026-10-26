import { describe, expect, test } from "bun:test";
import {
  type AttentionContext,
  type AttentionFeature,
  adjustmentFactor,
  applyAdjustments,
  DEFAULT_ADJUST_PARAMS,
  type Extractor,
  extractionSettings,
  parseExtractorList,
  runExtractors,
} from "../src/arena/extraction";
import { toAttentionEvents } from "../src/arena/extraction/adjust";
import {
  datedSentences,
  datesIn,
  eventsExtractor,
  fullRevisionUrl,
  parseEventReply,
  verifyPick,
} from "../src/arena/extraction/events";
import {
  gdeltExtractor,
  gdeltUrl,
  newsExtractor,
  newsQuery,
  parseDirection,
  parseTimeline,
  pulse,
} from "../src/arena/extraction/news";
import {
  editCounts,
  editSurge,
  editsExtractor,
  leadRevisionUrl,
  relatedExtractor,
  revisionsUrl,
  viewGrowth,
  wikiLinks,
} from "../src/arena/extraction/wiki-deterministic";
import { forecastSettings } from "../src/arena/forecast-config";
import type { ResearchReport, Retriever } from "../src/research/retrieve";

const CUTOFF = "2099-10-16T14:00:00.000Z";
const LAST_DAY = "2099-10-14";
const WINDOW = { start: "2099-10-19", end: "2099-10-25" };
const DAY_MS = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
const before = (days: number) => iso(Date.parse(CUTOFF) - days * DAY_MS);
const after = (days: number) => iso(Date.parse(CUTOFF) + days * DAY_MS);

function ctx(over: Partial<AttentionContext> = {}): AttentionContext {
  return {
    subjects: ["Some_Film"],
    cutoff: CUTOFF,
    lastDay: LAST_DAY,
    window: WINDOW,
    fetchJson: async () => undefined,
    ...over,
  };
}

/** A fetchJson that records every URL and answers from `routes` by substring. */
function mockFetch(routes: Array<[string, unknown]>) {
  const urls: string[] = [];
  const fetchJson = async (url: string) => {
    urls.push(url);
    for (const [k, v] of routes) if (url.includes(k)) return typeof v === "function" ? v(url) : v;
    return undefined;
  };
  return { urls, fetchJson };
}

const param = (url: string, name: string) => new URL(url).searchParams.get(name);

describe("knob", () => {
  test("unset, empty or off is off; unknown names are refused", () => {
    expect(parseExtractorList(undefined)).toEqual([]);
    expect(parseExtractorList("")).toEqual([]);
    expect(parseExtractorList("off")).toEqual([]);
    expect(parseExtractorList("edits, related,edits")).toEqual(["edits", "related"]);
    expect(() => parseExtractorList("edits,vibes")).toThrow(/unknown extractor "vibes"/);
    const s = extractionSettings({ MARINA_ARENA_WIKI_EXTRACTORS: "events,news" });
    expect(s.extractors).toEqual(["events", "news"]);
    expect(s.model).toBe("openrouter/deepseek/deepseek-v4.1-flash-1017");
    expect(s.top).toBe(30);
    expect(extractionSettings({}).extractors).toEqual([]);
  });

  test("the specialist's fingerprint is unchanged while the extractors are off", () => {
    const off = forecastSettings("wiki-specialist", {});
    expect(
      forecastSettings("wiki-specialist", { MARINA_ARENA_WIKI_EXTRACTORS: "" }).fingerprint,
    ).toBe(off.fingerprint);
    const on = forecastSettings("wiki-specialist", { MARINA_ARENA_WIKI_EXTRACTORS: "edits" });
    expect(on.fingerprint).not.toBe(off.fingerprint);
    expect(forecastSettings("nowcast", { MARINA_ARENA_WIKI_EXTRACTORS: "edits" }).fingerprint).toBe(
      forecastSettings("nowcast", {}).fingerprint,
    );
  });
});

describe("runExtractors", () => {
  const rec = (over: Partial<AttentionFeature>): AttentionFeature => ({
    subject: "A",
    feature: "x.y",
    value: 1,
    asOf: CUTOFF,
    source: "https://example.org",
    confidence: 1,
    extractor: "x",
    ...over,
  });

  test("drops any record dated after the cutoff, by asOf or by its publication", async () => {
    const leaky: Extractor = {
      name: "leaky",
      kind: "deterministic",
      extract: async () => [
        rec({ subject: "ok" }),
        rec({ subject: "late", asOf: after(1) }),
        rec({ subject: "late-source", detail: { publishedAt: after(0.01) } }),
        rec({ subject: "nan", value: Number.NaN }),
        rec({ subject: "undated", asOf: "" }),
      ],
    };
    const run = await runExtractors([leaky], ctx());
    expect(run.features.map((f) => f.subject)).toEqual(["ok"]);
    expect(run.dropped.map((f) => f.subject).sort()).toEqual([
      "late",
      "late-source",
      "nan",
      "undated",
    ]);
  });

  test("a failing or slow extractor adds an error and leaves the others", async () => {
    const ok: Extractor = { name: "ok", kind: "deterministic", extract: async () => [rec({})] };
    const bad: Extractor = {
      name: "bad",
      kind: "deterministic",
      extract: async () => {
        throw new Error("boom");
      },
    };
    const slow: Extractor = {
      name: "slow",
      kind: "deterministic",
      extract: () => new Promise((r) => setTimeout(() => r([rec({})]), 200)),
    };
    const run = await runExtractors([ok, bad, slow], ctx(), { timeoutMs: 20 });
    expect(run.features).toHaveLength(1);
    expect(run.errors.map((e) => e.extractor).sort()).toEqual(["bad", "slow"]);
  });
});

describe("edits (MediaWiki revisions as of the cutoff)", () => {
  test("the query is bounded by rvstart = cutoff and rvend = 28 days before", () => {
    const url = revisionsUrl("Some_Film", CUTOFF, before(28));
    expect(param(url, "rvstart")).toBe(CUTOFF);
    expect(param(url, "rvend")).toBe(before(28));
    expect(param(url, "rvdir")).toBe("older");
    expect(param(url, "titles")).toBe("Some Film");
    expect(param(leadRevisionUrl("A", CUTOFF), "rvstart")).toBe(CUTOFF);
    expect(param(fullRevisionUrl("A", CUTOFF), "rvstart")).toBe(CUTOFF);
  });

  test("counts only revisions inside (cutoff − 28 d, cutoff], following continuation", async () => {
    const page1 = {
      query: {
        pages: [
          {
            revisions: [
              { timestamp: after(0.5), user: "Future" }, // a misbehaving server: never counted
              { timestamp: before(1), user: "A" },
              { timestamp: before(2), user: "B" },
              { timestamp: before(2.5), user: "A" },
            ],
          },
        ],
      },
      continue: { rvcontinue: "next" },
    };
    const page2 = {
      query: {
        pages: [
          {
            revisions: [
              { timestamp: before(10), user: "C" },
              { timestamp: before(40), user: "Old" },
            ],
          },
        ],
      },
    };
    const { urls, fetchJson } = mockFetch([
      ["rvcontinue=next", page2],
      ["prop=revisions", page1],
    ]);
    const c = await editCounts(fetchJson, "Some_Film", CUTOFF);
    expect(c).toMatchObject({ recent: 3, window: 4, editors: 2, truncated: false });
    expect(urls).toHaveLength(2);
    for (const u of urls) expect(param(u, "rvstart")).toBe(CUTOFF);
    expect(editSurge(c)).toBeCloseTo(4 / 7 / (2 / 21), 6);
    expect(editSurge({ recent: 0, window: 0 })).toBeCloseTo(3, 6);
  });

  test("the extractor emits typed records as of the cutoff", async () => {
    const { fetchJson } = mockFetch([
      [
        "prop=revisions",
        { query: { pages: [{ revisions: [{ timestamp: before(1), user: "A" }] }] } },
      ],
    ]);
    const run = await runExtractors([editsExtractor()], ctx({ fetchJson }));
    expect(run.features.map((f) => f.feature).sort()).toEqual([
      "edits.editors",
      "edits.recent",
      "edits.surge",
    ]);
    for (const f of run.features) {
      expect(f.asOf).toBe(CUTOFF);
      expect(f.source).toContain("rvstart=");
      expect(f.confidence).toBeGreaterThan(0);
    }
  });
});

describe("related (lead links at the cutoff, their pageviews to the last published day)", () => {
  test("wikiLinks keeps article links in order and drops namespaces and duplicates", () => {
    expect(
      wikiLinks(
        "[[Alpha beta|the alpha]] and [[File:x.png]] [[gamma]] [[Alpha beta]] [[Delta#Sec|d]] [[Category:Films]]",
      ),
    ).toEqual(["Alpha_beta", "Gamma", "Delta"]);
  });

  test("views after the last published day never move the growth", async () => {
    const series = (rising: boolean) =>
      Array.from({ length: 20 }, (_, k) => {
        const date = iso(Date.parse(`${LAST_DAY}T00:00:00Z`) + (k - 13) * DAY_MS).slice(0, 10);
        // Days after LAST_DAY carry a huge spike that must be ignored.
        const views = date > LAST_DAY ? 1_000_000 : rising && date > "2099-10-11" ? 300 : 100;
        return { date, views };
      });
    const flat = series(false);
    expect(viewGrowth(flat, LAST_DAY)).toBeCloseTo(1, 2);
    const asked: Array<[string, string, string]> = [];
    const { fetchJson } = mockFetch([
      [
        "rvsection=0",
        {
          query: {
            pages: [
              {
                revisions: [
                  {
                    revid: 7,
                    timestamp: before(3),
                    slots: { main: { content: "[[Up]] [[Flat]]" } },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    const run = await runExtractors(
      [relatedExtractor()],
      ctx({
        fetchJson,
        dailyViews: async (title, start, end) => {
          asked.push([title, start, end]);
          return series(title === "Up"); // returns days beyond `end` too
        },
      }),
    );
    expect(asked.every(([, , end]) => end === LAST_DAY)).toBe(true);
    const growth = run.features.find((f) => f.feature === "related.growth")!;
    expect(growth.value).toBeGreaterThan(1.5);
    expect(growth.value).toBeLessThan(3);
    expect(growth.source).toBe("https://en.wikipedia.org/w/index.php?oldid=7");
    expect(run.features.find((f) => f.feature === "related.rising_share")!.value).toBe(0.5);
  });

  test("a lead revision dated after the cutoff is not read", async () => {
    const { fetchJson } = mockFetch([
      [
        "rvsection=0",
        {
          query: {
            pages: [
              {
                revisions: [
                  { revid: 9, timestamp: after(1), slots: { main: { content: "[[X]]" } } },
                ],
              },
            ],
          },
        },
      ],
    ]);
    const run = await runExtractors(
      [relatedExtractor()],
      ctx({ fetchJson, dailyViews: async () => [] }),
    );
    expect(run.features).toEqual([]);
  });
});

describe("news (Portal:Current events and GDELT, bounded to the cutoff)", () => {
  const stamp = (t: string) => t.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

  test("GDELT queries end at the cutoff and points after it are dropped", async () => {
    const url = gdeltUrl("Some_Film_(2099_film)", before(14), CUTOFF);
    expect(param(url, "enddatetime")).toBe("20991016140000");
    expect(param(url, "query")).toBe('"Some Film"');
    expect(newsQuery("Cher")).toBe("Cher");
    const body = {
      timeline: [
        {
          data: [
            { date: stamp(before(1)), value: 2 },
            { date: stamp(before(5)), value: 1 },
            { date: stamp(after(0.5)), value: 999 },
          ],
        },
      ],
    };
    const daily = parseTimeline(body, CUTOFF);
    expect([...daily.values()]).not.toContain(999);
    expect(daily.size).toBe(2);
    const p = pulse(daily, CUTOFF);
    expect(p.volume).toBeCloseTo(2 / 3, 6);
    expect(p.trend).toBeGreaterThan(5);
    const urls: string[] = [];
    const run = await runExtractors(
      [gdeltExtractor()],
      ctx({
        gdeltJson: async (u) => {
          urls.push(u);
          return body;
        },
      }),
    );
    expect(urls.every((u) => param(u, "enddatetime") === "20991016140000")).toBe(true);
    expect(run.features.find((f) => f.feature === "news.trend")!.value).toBeCloseTo(p.trend, 9);
  });

  test("digest pages are read at their revision at the cutoff; later revisions are ignored", async () => {
    const asked: string[] = [];
    const page = (revid: number, timestamp: string, content: string) => ({
      query: { pages: [{ revisions: [{ revid, timestamp, slots: { main: { content } } }] }] },
    });
    const fetchJson = async (url: string) => {
      asked.push(url);
      const title = param(url, "titles")!;
      // A revision saved after the cutoff (a misbehaving server): never read.
      if (title.endsWith("October 16"))
        return page(99, after(0.3), "*LEAK [[Some Film]] is a hit. [https://x.example (X)]");
      const mention = title.endsWith("October 15") || title.endsWith("October 13");
      return page(
        10,
        before(0.5),
        mention
          ? "'''Arts'''\n*Trailer for [[Some Film]] breaks records. [https://y.example (Y)]"
          : "*Unrelated [[Other]] news.",
      );
    };
    const prompts: string[] = [];
    const run = await runExtractors(
      [newsExtractor()],
      ctx({
        fetchJson,
        complete: async (_s, user) => {
          prompts.push(user);
          return '{"direction": "rising", "confidence": 0.8}';
        },
      }),
    );
    expect(asked).toHaveLength(7);
    for (const u of asked) expect(param(u, "rvstart")).toBe(CUTOFF);
    expect(asked.map((u) => param(u, "titles"))).toContain("Portal:Current events/2099 October 10");
    expect(run.features.find((f) => f.feature === "news.portal_days")!.value).toBe(2);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Trailer for Some Film breaks records.");
    expect(prompts[0]).not.toContain("LEAK");
    expect(run.features.find((f) => f.feature === "news.direction")).toMatchObject({
      value: 1,
      confidence: 0.8,
    });
    expect(parseDirection("nope")).toBeUndefined();
    expect(parseDirection('{"direction":"fading"}')).toEqual({ direction: -1, confidence: 0.5 });
  });
});

describe("events (dated sentences as of the cutoff, mechanically verified)", () => {
  test("datesIn reads ISO and month-name dates, with the sentence's year", () => {
    expect(datesIn("It opens on October 23, 2099 in theatres.")).toEqual(["2099-10-23"]);
    expect(datesIn("Premiere 21 October 2099; finale 2099-12-01.")).toEqual([
      "2099-10-21",
      "2099-12-01",
    ]);
    expect(datesIn("Scheduled for October 22.", "2099")).toEqual(["2099-10-22"]);
    expect(datesIn("Scheduled for October 22.")).toEqual([]);
    expect(datesIn("February 30, 2099")).toEqual([]);
  });

  test("datedSentences keeps in-window dates and recent endings only", () => {
    const text =
      "The film was announced on March 3, 2098. It is scheduled to be released on October 23, 2099. The series finale aired on October 10, 2099. Born on October 23, 1950.";
    const got = datedSentences(text, { window: WINDOW, lastDay: LAST_DAY }, "u", CUTOFF);
    expect(got.map((s) => [s.dates, s.ended])).toEqual([
      [["2099-10-23"], false],
      [["2099-10-10"], true],
    ]);
    // A year-less date takes the window's year only beside a scheduling word.
    const ctx0 = { window: WINDOW, lastDay: LAST_DAY };
    expect(
      datedSentences("The hearing proceeded on October 21 with testimony.", ctx0, "u", CUTOFF),
    ).toEqual([]);
    expect(
      datedSentences("The hearing is scheduled for October 21 in Texas.", ctx0, "u", CUTOFF).map(
        (s) => s.dates,
      ),
    ).toEqual([["2099-10-21"]]);
  });

  test("a pick must cite a sentence that states its date", () => {
    const s = datedSentences(
      "It is scheduled to be released on October 23, 2099.",
      { window: WINDOW, lastDay: LAST_DAY },
      "u",
      CUTOFF,
    );
    expect(
      verifyPick({ sentence: 0, date: "2099-10-23", confidence: 1 }, s, { window: WINDOW }, false),
    ).toBeDefined();
    expect(
      verifyPick({ sentence: 0, date: "2099-10-24", confidence: 1 }, s, { window: WINDOW }, false),
    ).toBeUndefined();
    expect(
      verifyPick({ sentence: 3, date: "2099-10-23", confidence: 1 }, s, { window: WINDOW }, false),
    ).toBeUndefined();
    expect(parseEventReply('x {"upcoming": null, "ended": null}')).toEqual({});
  });

  test("reads the revision at the cutoff, ignores sources published after it, and verifies the model", async () => {
    const page = {
      query: {
        pages: [
          {
            revisions: [
              {
                revid: 42,
                timestamp: before(2),
                slots: {
                  main: {
                    content: "'''Some Film''' is scheduled to be released on October 23, 2099.",
                  },
                },
              },
            ],
          },
        ],
      },
    };
    const { urls, fetchJson } = mockFetch([["prop=revisions", page]]);
    const report: ResearchReport = {
      report: "",
      costUsd: 0,
      searches: 1,
      retriever: "asof:test",
      sources: [
        {
          url: "https://late.example",
          published: after(1).slice(0, 10),
          text: "LEAK: Some Film premieres on October 20, 2099.",
        },
        {
          url: "https://early.example",
          published: before(3).slice(0, 10),
          text: "Some Film tour stops on October 21, 2099.",
        },
      ],
    };
    const briefs: Array<{ untilAt?: string }> = [];
    const retriever: Retriever = async (b) => {
      briefs.push(b);
      return report;
    };
    const prompts: string[] = [];
    const run = await runExtractors(
      [eventsExtractor()],
      ctx({
        fetchJson,
        retriever,
        complete: async (_s, user) => {
          prompts.push(user);
          return '{"upcoming": {"sentence": 0, "date": "2099-10-23", "kind": "release", "confidence": 0.9}, "ended": null}';
        },
      }),
    );
    expect(param(urls[0]!, "rvstart")).toBe(CUTOFF);
    expect(briefs[0]!.untilAt).toBe(CUTOFF);
    expect(prompts[0]).not.toContain("LEAK");
    expect(prompts[0]).toContain("October 21, 2099");
    expect(run.features).toHaveLength(1);
    expect(run.features[0]).toMatchObject({
      feature: "event.in_window",
      value: 1,
      confidence: 0.9,
      source: "https://en.wikipedia.org/w/index.php?oldid=42",
      detail: { date: "2099-10-23", kind: "release" },
    });
  });

  test("a subject with no dated sentence makes no model call; an invented date is rejected", async () => {
    let calls = 0;
    const plain = {
      query: {
        pages: [
          {
            revisions: [
              {
                revid: 1,
                timestamp: before(1),
                slots: { main: { content: "No dates here at all, none." } },
              },
            ],
          },
        ],
      },
    };
    const none = await runExtractors(
      [eventsExtractor({ search: false })],
      ctx({
        fetchJson: mockFetch([["prop=revisions", plain]]).fetchJson,
        complete: async () => {
          calls++;
          return "{}";
        },
      }),
    );
    expect(none.features).toEqual([]);
    expect(calls).toBe(0);
    const dated = {
      query: {
        pages: [
          {
            revisions: [
              {
                revid: 1,
                timestamp: before(1),
                slots: { main: { content: "It opens on October 23, 2099." } },
              },
            ],
          },
        ],
      },
    };
    const invented = await runExtractors(
      [eventsExtractor({ search: false })],
      ctx({
        fetchJson: mockFetch([["prop=revisions", dated]]).fetchJson,
        complete: async () =>
          '{"upcoming": {"sentence": 0, "date": "2099-10-24", "confidence": 1}}',
      }),
    );
    expect(invented.features).toEqual([]);
  });
});

describe("adjustments", () => {
  const feat = (
    subject: string,
    feature: string,
    value: number,
    confidence = 1,
  ): AttentionFeature => ({
    subject,
    feature,
    value,
    asOf: CUTOFF,
    source: "s",
    confidence,
    extractor: "t",
  });

  test("each feature is a bounded multiplier with a fixed elasticity", () => {
    const p = { ...DEFAULT_ADJUST_PARAMS, editElasticity: 0.5, ratioCap: 4, maxFactor: 3 };
    const m = (fs: AttentionFeature[]) =>
      adjustmentFactor(new Map(fs.map((f) => [f.feature, f])), p);
    expect(m([]).factor).toBe(1);
    expect(m([feat("a", "edits.surge", 4)]).factor).toBeCloseTo(2, 9);
    expect(m([feat("a", "edits.surge", 100)]).factor).toBeCloseTo(2, 9); // ratio capped at 4
    expect(m([feat("a", "edits.surge", 4, 0.5)]).factor).toBeCloseTo(4 ** 0.25, 9);
    expect(m([feat("a", "event.in_window", 1, 0.5)]).factor).toBeCloseTo(
      1 + (p.eventMultiplier - 1) / 2,
      9,
    );
    expect(m([feat("a", "event.ended", 1)]).factor).toBeCloseTo(p.endedMultiplier, 9);
    expect(
      m([
        feat("a", "edits.surge", 4),
        feat("a", "event.in_window", 1),
        feat("a", "news.direction", 1),
      ]).factor,
    ).toBe(3); // total bound
  });

  test("applyAdjustments re-orders, widens the transient share, and leaves the rest alone", () => {
    const scored = [
      { title: "A", weekly: 1000, transient: 0, score: 1000 },
      { title: "B", weekly: 900, transient: 0, score: 900 },
    ];
    const none = applyAdjustments(scored, []);
    expect(none.scored.map((s) => s.title)).toEqual(["A", "B"]);
    expect(none.adjustments).toEqual([]);
    const p = { ...DEFAULT_ADJUST_PARAMS, eventMultiplier: 1.5, risk: 0.15 };
    const got = applyAdjustments(scored, [feat("B", "event.in_window", 1)], p);
    const b = got.scored[0]!;
    expect(b.title).toBe("B");
    expect(b.weekly).toBeCloseTo(1350, 9);
    expect(b.transient).toBeCloseTo(450 / 1350, 9);
    expect(b.score).toBeCloseTo(1350 * (1 - 0.15 * (450 / 1350)), 9);
    expect(got.adjustments).toHaveLength(1);
    expect(scored[1]!.weekly).toBe(900); // input untouched
  });

  test("verified events become the arena's scenario effects", () => {
    const ev = toAttentionEvents(
      [feat("A", "event.in_window", 1, 1), feat("B", "edits.surge", 3)],
      WINDOW,
    );
    expect(ev).toEqual([
      {
        item: "A",
        startsAt: "2099-10-19T00:00:00Z",
        endsAt: "2099-10-25T23:59:59Z",
        knownAt: CUTOFF,
        source: "s",
        multiplier: DEFAULT_ADJUST_PARAMS.eventMultiplier,
      },
    ]);
  });
});

describe("the specialist's extraction stage", () => {
  test("off by default: no stage, no model, no usage", async () => {
    const { wikiExtractionTooling } = await import("../src/arena/service");
    expect(await wikiExtractionTooling({})).toBeUndefined();
    expect(await wikiExtractionTooling({ MARINA_ARENA_WIKI_EXTRACTORS: " " })).toBeUndefined();
    const det = await wikiExtractionTooling({ MARINA_ARENA_WIKI_EXTRACTORS: "edits,related" });
    expect(det?.settings.extractors).toEqual(["edits", "related"]);
    expect(det?.usage).toBeUndefined(); // deterministic extractors make no paid call
    await expect(
      wikiExtractionTooling({ MARINA_ARENA_WIKI_EXTRACTORS: "psychic" }),
    ).rejects.toThrow(/unknown extractor/);
    await expect(
      wikiExtractionTooling({
        MARINA_ARENA_WIKI_EXTRACTORS: "edits",
        MARINA_ARENA_WIKI_EXTRACTOR_RETRIEVER: "tavily:basic",
        TAVILY_API_KEY: "test",
      }),
    ).rejects.toThrow(/date-strict/);
  });
});

describe("scripts/arena-wiki-backtest.ts --out / --features", () => {
  test("writes per-item JSONL per variant; uncovered weeks are excluded", async () => {
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "wiki-bt-"));
    try {
      let seed = 7;
      const rand = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 2 ** 32;
      };
      const start = Date.parse("2099-01-04T00:00:00Z"); // a Sunday
      const days: string[] = [];
      for (let d = 0; d < 84; d++) {
        const day = iso(start + d * DAY_MS).slice(0, 10);
        days.push(day);
        const articles: Record<string, number> = {};
        for (let a = 0; a < 25; a++)
          articles[`Page_${a}`] = Math.round(1000 * (25 - a) * (0.5 + rand()));
        writeFileSync(join(dir, `${day}.json`), JSON.stringify({ articles }));
      }
      const feats = join(dir, "feats.jsonl");
      const out = join(dir, "items.jsonl");
      // Features for one week only, so the others are "not extracted".
      const firstWeek = "2099-02-22";
      writeFileSync(
        feats,
        `${JSON.stringify({ week: firstWeek, run: true, subjects: 30 })}\n${JSON.stringify({ week: firstWeek, subject: "Page_20", feature: "event.in_window", value: 1, asOf: "2099-02-13T14:00:00Z", source: "s", confidence: 1, extractor: "events" })}\n`,
      );
      const ok = Bun.spawnSync(
        [
          process.execPath,
          "run",
          "scripts/arena-wiki-backtest.ts",
          "--dir",
          dir,
          "--out",
          out,
          "--features",
          `events=${feats}`,
        ],
        { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
      );
      expect(ok.exitCode).toBe(0);
      const rows = readFileSync(out, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const variants = new Set(rows.map((r) => r.variant));
      expect([...variants].sort()).toEqual([
        "nowcast",
        "oracle-events",
        "persistence",
        "specialist",
        "specialist+events",
      ]);
      for (const r of rows) {
        expect(r.group).toBe("arena-wikipedia");
        expect(typeof r.id).toBe("string");
        expect(typeof r.score).toBe("number");
        expect(String(r.at)).toMatch(/T14:00:00Z$/);
        expect(Array.isArray(r.ranking)).toBe(true);
      }
      const ev = rows.filter((r) => r.variant === "specialist+events");
      expect(ev.find((r) => r.id === `wiki-top10-${firstWeek}`)?.exclude).toBeUndefined();
      expect(ev.filter((r) => r.exclude === "not extracted").length).toBe(ev.length - 1);
      expect(rows.filter((r) => r.variant === "persistence").every((r) => r.score === 0)).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the +extract spec suffix (a shadow arm with extractors)", () => {
  test("parses, keeps its method kind, and is a valid challenger", async () => {
    const { parseForecasterSpec } = await import("../src/arena/config");
    const { parseShadowChallengers, specKind } = await import("../src/arena/earned-routes");
    for (const spec of [
      "wiki-specialist+extract:events",
      "wiki-specialist+extract:events,news,edits,related,gdelt",
      "wiki-specialist:openrouter/x/y@asof:gdelt+wikipedia+extract:edits",
    ]) {
      expect(parseForecasterSpec(spec)).toBe(spec);
      expect(specKind(spec)).toBe("wiki-specialist");
    }
    expect(() => parseForecasterSpec("wiki-specialist+extract:vibes")).toThrow();
    expect(
      parseShadowChallengers({
        MARINA_ARENA_SHADOW_CHALLENGERS: "wikipedia=wiki-specialist+extract:events",
      }).get("wikipedia"),
    ).toEqual(["wiki-specialist+extract:events"]);
    expect(forecastSettings("wiki-specialist+extract:events", {}).wikiExtractors).toBeDefined();
    expect(forecastSettings("wiki-specialist", {}).wikiExtractors).toBeUndefined();
  });
});
