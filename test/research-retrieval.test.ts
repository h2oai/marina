// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Research retrieval: the `search` retriever (backend chain with fallback,
 * fused hits, domain cap, cutoff, page reading, passage selection), the
 * citation check's quote and locale-number matching, budgets and the
 * follow-up round in typed forecasts, retriever specs, readiness — all with
 * fake backends and pages (no network).
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { ResearchBrief } from "../src/arena/research/briefs";
import {
  combineRetrievers,
  openRouterWebRetriever,
  type Retriever,
  retrieverFromSpec,
} from "../src/arena/research/retrieve";
import { verifyDossier } from "../src/arena/research/verify";
import {
  exaSearchProvider,
  openRouterSearchProvider,
  pageKey,
  passagesOf,
  rankPassages,
  searchBackendsFromEnv,
  siteOf,
  webSearchRetriever,
} from "../src/arena/research/web-search";
import { extractPublishedDate, extractReadableText } from "../src/engine/html-text";
import {
  resetSearchHealthForTests,
  searchBackendHealth,
} from "../src/engine/search-providers/health";
import type { SearchProvider, SearchResult } from "../src/engine/search-providers/index";
import { describeSearchReadiness } from "../src/engine/search-readiness";
import {
  DEFAULT_DAILY_SPEND_CAP_USD,
  recordSpend,
  resetSpendLedgerForTests,
  spentTodayUsd,
} from "../src/engine/spend-ledger";
import {
  budgetDossier,
  dossierBudgetChars,
  forecastTyped,
  type ModelPart,
} from "../src/forecast/typed";

afterEach(() => {
  resetSearchHealthForTests();
  resetSpendLedgerForTests();
});

const NOW = new Date("2026-10-04T12:00:00Z");
const brief = (over: Partial<ResearchBrief> = {}): ResearchBrief => ({
  roundId: "t",
  since: "2026-08-20",
  until: "2026-10-04",
  untilAt: NOW.toISOString(),
  request: "Who will lead the Sao Paulo Senate race?\nmore",
  queries: ["sao paulo senate poll", "datafolha senate sao paulo"],
  ...over,
});

const hit = (url: string, extra: Partial<SearchResult> = {}): SearchResult => ({
  title: `Title ${url}`,
  url,
  snippet: "",
  source: "fake",
  ...extra,
});

function backend(
  name: string,
  answer: (query: string) => SearchResult[] | Error,
): SearchProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name,
    engines: ["web", "news"],
    calls,
    search: async (q) => {
      calls.push(q);
      const a = answer(q);
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

const POLL_PAGE = `<html><head><title>Datafolha poll</title>
<meta property="article:published_time" content="2026-10-03T18:51:00-03:00"></head><body>
<nav><a href="/">Home</a> <a href="/x">Politics</a></nav>
<article><p>Teaser card</p></article>
<main><h1>Datafolha: Senate race in Sao Paulo</h1>
<p>Datafolha interviewed 2.520 voters in Sao Paulo between 2 and 3 October; the margin of error is two points.</p>
<p>In the Senate race Derrite has 22% of valid votes, Andre do Prado 22%, Marina Silva 21% and Tebet 20%, a statistical tie.</p>
<ul><li><a href="/a">Read more: another story</a></li></ul>
</main><footer>footer</footer></body></html>`;

const pages: Record<string, string> = {
  "https://news.example.com/poll": POLL_PAGE,
  "https://news.example.com/poll-2": POLL_PAGE.replace("Datafolha poll", "Second"),
  "https://news.example.com/poll-3": POLL_PAGE.replace("Datafolha poll", "Third"),
  "https://news.example.com/poll-4": POLL_PAGE.replace("Datafolha poll", "Fourth"),
  "https://other.example.org/late": POLL_PAGE.replace(
    "2026-10-03T18:51:00-03:00",
    "2026-10-04T13:00:00Z",
  ),
};
const fetchPage = async (url: string) =>
  pages[url] ? { body: pages[url]!, contentType: "text/html" } : undefined;

describe("search retriever", () => {
  it("falls through a backend out of credit, reports it, and never returns a silent zero", async () => {
    const dead = backend("tavily", () => new Error('tavily HTTP 432: {"detail":"usage limit"}'));
    const free = backend("duckduckgo", () => [hit("https://news.example.com/poll")]);
    const r = await webSearchRetriever({
      backends: [dead, free],
      background: null,
      fetchPage,
      now: () => NOW,
    })(brief());
    expect(dead.calls.length).toBeGreaterThanOrEqual(1);
    expect(free.calls).toHaveLength(2);
    const funnel = r.funnels?.[0];
    expect(funnel?.backends.find((b) => b.name === "tavily")).toMatchObject({
      failures: dead.calls.length,
      error: expect.stringContaining("432"),
    });
    expect(searchBackendHealth().find((h) => h.name === "tavily")?.lastError).toContain("432");
    expect(r.sources.map((s) => s.url)).toEqual(["https://news.example.com/poll"]);

    const allDead = webSearchRetriever({
      backends: [dead],
      background: null,
      fetchPage,
      now: () => NOW,
    });
    await expect(allDead(brief())).rejects.toThrow(/every backend failed.*432/);
  });

  it("quotes relevant passages verbatim, dated, and the citation check verifies them", async () => {
    const free = backend("duckduckgo", () => [hit("https://news.example.com/poll")]);
    const r = await webSearchRetriever({
      backends: [free],
      background: null,
      fetchPage,
      now: () => NOW,
    })(brief());
    const lines = r.report.split("\n");
    expect(lines[0]).toMatch(/^- 2026-10-03 — "/);
    expect(r.report).toContain("Derrite has 22% of valid votes");
    // Navigation, link lists and the teaser card never become evidence.
    expect(r.report).not.toContain("Read more");
    expect(r.report).not.toContain("Teaser card");
    expect(r.sources[0]?.published).toBe("2026-10-03");
    const checked = await verifyDossier(r.report, async () => undefined, r.sources);
    expect(checked.stats.verified).toBe(lines.length);
    expect(checked.reads.provided).toBe(1);
  });

  it("caps pages per domain, drops pages dated after the cutoff, and never reads a no-fetch publisher", async () => {
    const urls = [
      "https://news.example.com/poll",
      "https://news.example.com/poll-2",
      "https://news.example.com/poll-3",
      "https://news.example.com/poll-4",
      "https://other.example.org/late",
      "https://today.yougov.com/topics/poll",
    ];
    const read: string[] = [];
    const r = await webSearchRetriever({
      backends: [backend("duckduckgo", () => urls.map((u) => hit(u)))],
      background: null,
      fetchPage: async (u) => {
        read.push(u);
        return fetchPage(u);
      },
      domainCap: 2,
      now: () => NOW,
    })(brief({ queries: ["sao paulo senate poll"] }));
    const f = r.funnels![0]!;
    expect(f.unique).toBe(6);
    expect(read.filter((u) => u.includes("news.example.com"))).toHaveLength(2);
    expect(read.some((u) => u.includes("yougov"))).toBe(false);
    expect(f.noFetch).toBe(1);
    expect(f.afterCutoff).toBe(1);
    expect(r.sources.every((s) => !s.url.includes("late"))).toBe(true);
  });

  it("fills up to the brief's character budget", async () => {
    const long = Array.from(
      { length: 40 },
      (_, i) =>
        `<p>Senate poll paragraph ${i}: Derrite and Prado are tied in Sao Paulo at ${20 + (i % 5)}% each in the latest Datafolha poll.</p>`,
    ).join("");
    const r = await webSearchRetriever({
      backends: [
        backend("duckduckgo", () => [hit("https://a.example/1"), hit("https://b.example/2")]),
      ],
      background: null,
      fetchPage: async () => ({ body: `<main>${long}</main>`, contentType: "text/html" }),
      perPage: 40,
      now: () => NOW,
    })(brief({ maxChars: 2_500 }));
    expect(r.funnels![0]!.passageChars).toBeLessThanOrEqual(2_500);
    expect(r.funnels![0]!.passageChars).toBeGreaterThan(1_500);
  });

  it("uses the backend's page text instead of fetching, and prefers recent pages when live", async () => {
    let fetched = 0;
    const text = (n: string) =>
      `${n}: the Sao Paulo Senate poll shows Derrite on 22% and Prado on 22% of valid votes in the race.`;
    const r = await webSearchRetriever({
      backends: [
        backend("exa", () => [
          hit("https://old.example/a", { published: "2026-06-01T00:00:00Z", text: text("Old") }),
          hit("https://new.example/b", { published: "2026-10-03T00:00:00Z", text: text("New") }),
        ]),
      ],
      background: null,
      fetchPage: async () => {
        fetched++;
        return undefined;
      },
      now: () => NOW,
    })(brief({ queries: ["sao paulo senate poll"] }));
    expect(fetched).toBe(0);
    expect(r.report.split("\n")[0]).toContain("New:");
  });

  it("ranks passages by the question, not page order", () => {
    const ranked = rankPassages(
      [
        {
          text: "Cookie policy and newsletter signup for readers of this site every day.\nThe Senate poll in Sao Paulo shows Derrite ahead with 25% of valid votes.",
          weight: 1,
        },
      ],
      "Sao Paulo Senate poll Derrite",
    );
    expect(ranked[0]?.text).toContain("Derrite ahead");
    expect(passagesOf("short\n## heading line that is long enough to pass the minimum")).toEqual(
      [],
    );
  });

  it("normalises page identity and sites", () => {
    expect(pageKey("https://www.x.com/a/?utm_source=openai")).toBe(pageKey("https://x.com/a"));
    expect(siteOf("https://news.bbc.co.uk/x")).toBe("bbc.co.uk");
    expect(siteOf("https://www1.folha.uol.com.br/x")).toBe("uol.com.br");
  });
});

describe("search backends", () => {
  it("builds the chain from configured keys, keyless DuckDuckGo last", () => {
    expect(searchBackendsFromEnv({}).backends.map((b) => b.name)).toEqual(["duckduckgo"]);
    expect(
      searchBackendsFromEnv({ TAVILY_API_KEY: "t", EXA_API_KEY: "e" }).backends.map((b) => b.name),
    ).toEqual(["tavily", "exa", "duckduckgo"]);
    const named = searchBackendsFromEnv({
      MARINA_RESEARCH_SEARCH_BACKENDS: "duckduckgo,tavily",
    });
    expect(named.backends.map((b) => b.name)).toEqual(["duckduckgo"]);
    expect(named.skipped).toEqual(["tavily (no TAVILY_API_KEY)"]);
    expect(() => searchBackendsFromEnv({ MARINA_RESEARCH_SEARCH_BACKENDS: "bing" })).toThrow(
      "unknown search backend",
    );
  });

  it("OpenRouter's Exa plugin serves as a paid fallback backend: annotations are the results", async () => {
    expect(searchBackendsFromEnv({ OPENROUTER_API_KEY: "o" }).backends.map((b) => b.name)).toEqual([
      "duckduckgo",
      "openrouter",
    ]);
    let sent: Record<string, unknown> = {};
    const or = openRouterSearchProvider("or-key", "m", async (_u, init) => {
      sent = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
                annotations: [
                  {
                    url_citation: { url: "https://g1.example/a", title: "A", content: "page text" },
                  },
                  { url_citation: {} },
                ],
              },
            },
          ],
          usage: { cost: 0.007 },
        }),
      );
    });
    const spend = { usd: 0 };
    const results = await or.search("q", { maxResults: 5, spend }, {} as never);
    expect(spend.usd).toBeCloseTo(0.007);
    expect(sent.plugins).toEqual([{ id: "web", engine: "exa", max_results: 5 }]);
    expect(results).toEqual([
      {
        title: "A",
        url: "https://g1.example/a",
        snippet: "page text",
        source: "openrouter",
        text: "page text",
      },
    ]);
    expect(spentTodayUsd()).toBeCloseTo(0.007);
  });

  it("Exa sends its key in a header, prices each search, and refuses at the daily cap", async () => {
    const seen: RequestInit[] = [];
    const exa = exaSearchProvider("exa-key", async (_url, init) => {
      seen.push(init);
      return new Response(
        JSON.stringify({
          results: [
            { url: "https://e.example/a", title: "A", text: "body", publishedDate: "2026-10-01" },
          ],
          costDollars: { total: 0.005 },
        }),
      );
    });
    const results = await exa.search("q", { maxResults: 3 }, {} as never);
    expect((seen[0]!.headers as Record<string, string>)["x-api-key"]).toBe("exa-key");
    expect(results[0]).toMatchObject({ url: "https://e.example/a", text: "body" });
    expect(spentTodayUsd()).toBeCloseTo(0.005);
    recordSpend("forecast", DEFAULT_DAILY_SPEND_CAP_USD + 1);
    await expect(exa.search("q", {}, {} as never)).rejects.toThrow("exa:");
  });
});

describe("citation check: quotes and number formats", () => {
  const page =
    "Datafolha ouviu 2.520 eleitores. Derrite tem 22,5% dos votos válidos.\nThe Academy said the prize will be announced on Tuesday at 11:45.";

  it("verifies a figureless line only when its whole text is on the cited page", async () => {
    const report = [
      '- 2026-10-03 — "The Academy said the prize will be announced on Tuesday" [a](https://p.example/a)',
      "- The Academy said the prize will be announced on Tuesday and Smith will win [a](https://p.example/a)",
      "- short [a](https://p.example/a)",
    ].join("\n");
    const v = await verifyDossier(report, async () => page);
    expect(v.stats.verified).toBe(1);
    expect(v.lines[0]).toMatchObject({ status: "verified", quoted: true });
    expect(v.verifiedText).toBe(report.split("\n")[0]!);
    // The embellished line and the too-short line are never evidence.
    expect(v.annotated.split("\n")[1]).not.toContain("[verified]");
    expect(v.annotated.split("\n")[2]).not.toContain("[verified]");
  });

  it("matches figures in either number reading, and still rejects wrong figures", async () => {
    const v = await verifyDossier(
      [
        "- Datafolha polled 2,520 voters; Derrite has 22.5% [a](https://p.example/a)",
        "- Derrite has 23.5% [a](https://p.example/a)",
      ].join("\n"),
      async () => page,
    );
    expect(v.lines.map((l) => l.status)).toEqual(["verified", "unverified"]);
  });
});

describe("html extraction", () => {
  it("takes the text-richest block, drops link lists, and reads the publication date", () => {
    const ex = extractReadableText(POLL_PAGE);
    expect(ex.text).toContain("2.520 voters");
    expect(ex.text).not.toContain("Teaser card");
    expect(ex.text).not.toContain("Read more");
    expect(extractPublishedDate(POLL_PAGE)).toBe("2026-10-03T21:51:00.000Z");
    expect(
      extractPublishedDate(
        '<script type="application/ld+json">{"datePublished":"2026-09-30"}</script>',
      ),
    ).toBe("2026-09-30T00:00:00.000Z");
    expect(extractPublishedDate("<time datetime='2099-01-01'>")).toBeUndefined();
  });
});

describe("retriever specs", () => {
  it("parses search, search:<backends> and the web plugin's engine", () => {
    expect(() => retrieverFromSpec("search", {}, { env: {} })).not.toThrow();
    expect(() => retrieverFromSpec("search:duckduckgo", {}, { env: {} })).not.toThrow();
    expect(() => retrieverFromSpec("search:tavily", {}, { env: {} })).toThrow("no usable backend");
    expect(() => retrieverFromSpec("search:bing", {}, { env: {} })).toThrow(
      "unknown search backend",
    );
    expect(() => retrieverFromSpec("openrouter-web:m@exa", { openrouter: "k" })).not.toThrow();
    expect(() => retrieverFromSpec("openrouter-web:m@bing", { openrouter: "k" })).toThrow(
      "exa or native",
    );
    // A date-strict run can never mix in the open web.
    expect(() => retrieverFromSpec("search", {}, { requireDateStrict: true, env: {} })).toThrow(
      "date-strict",
    );
  });

  it("the web plugin asks for the engine and keeps page excerpts for the citation check", async () => {
    let body: Record<string, unknown> = {};
    const r = openRouterWebRetriever({
      model: "m",
      apiKey: "k",
      engine: "exa",
      fetcher: async (_u, init) => {
        body = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "- Derrite 25% [g1](https://g1.example/a)",
                  annotations: [
                    { url_citation: { url: "https://g1.example/a", content: "x".repeat(300) } },
                    { url_citation: { url: "https://yougov.com/a", content: "y".repeat(300) } },
                  ],
                },
              },
            ],
            usage: { cost: 0.001 },
          }),
        );
      },
    });
    const rep = await r(brief());
    expect((body.plugins as Array<Record<string, unknown>>)[0]).toMatchObject({ engine: "exa" });
    expect(rep.sources[0]?.text).toHaveLength(300);
    expect(rep.sources[1]?.text).toBeUndefined(); // a no-fetch publisher's text is never kept
    expect(rep.retriever).toBe("openrouter-web:m@exa");
  });

  it("a combined retriever names the engine that failed", async () => {
    const ok: Retriever = async () => ({
      report: "- x",
      sources: [],
      costUsd: 0,
      searches: 1,
      retriever: "ok",
    });
    const bad: Retriever = async () => {
      throw new Error("search retrieval: every backend failed (tavily: HTTP 432)");
    };
    const r = await combineRetrievers([ok, bad])(brief());
    expect(r.warnings).toEqual([expect.stringContaining("HTTP 432")]);
  });
});

describe("readiness: search", () => {
  it("is degraded and names the backend when one keeps failing", () => {
    const now = Date.now();
    const s = describeSearchReadiness(
      { TAVILY_API_KEY: "t", OPENROUTER_API_KEY: "o" },
      [
        {
          name: "tavily",
          calls: 3,
          failures: 3,
          consecutiveFailures: 3,
          lastErrorAt: now - 1_000,
          lastError: "tavily HTTP 432: usage limit",
        },
        { name: "duckduckgo", calls: 5, failures: 0, consecutiveFailures: 0, lastOkAt: now },
      ],
      now,
    );
    expect(s.status).toBe("degraded");
    expect(s.detail).toContain("tavily failing");
    expect(s.detail).toContain("answering: duckduckgo");
    expect(s.remediation).toContain("432");
  });

  it("is ok with a healthy keyed setup and degraded when keyless only", () => {
    expect(describeSearchReadiness({ OPENROUTER_API_KEY: "o" }, []).status).toBe("ok");
    const keyless = describeSearchReadiness({}, []);
    expect(keyless.status).toBe("degraded");
    expect(keyless.detail).toContain("forecast retrieval: search");
  });
});

describe("typed forecast: evidence budget and follow-up", () => {
  it("sizes the dossier to the context window and keeps verified lines first when clipping", () => {
    expect(dossierBudgetChars([undefined])).toBe(24_000);
    expect(dossierBudgetChars([1_000_000])).toBe(60_000);
    expect(dossierBudgetChars([16_384])).toBe(12_000);
    expect(dossierBudgetChars([200_000], 5_000)).toBe(5_000);
    const text = ["- unverified one", "[verified] - keep me", "- unverified two"].join("\n");
    const cut = budgetDossier(text, 40);
    expect(cut).toContain("[verified] - keep me");
    expect(cut).toContain("left out");
    expect(budgetDossier(text, 1_000)).toBe(text);
  });

  const yesNo = { type: "choice" as const, options: [{ id: "A" }, { id: "B" }] };
  /** Lines verify only on the follow-up page; the first round's line never does. */
  function gapRetriever(briefs: ResearchBrief[]): Retriever {
    return async (b) => {
      briefs.push(b);
      const followUp = b.queries?.includes("official result page");
      return {
        report: followUp
          ? '- 2026-10-03 — "The bureau said the reading was 42.5% on Friday" [b](https://b.example/x)'
          : "- the reading was 40% [a](https://a.example/x)",
        sources: [],
        costUsd: 0,
        searches: 1,
        retriever: "fake",
      };
    };
  }
  const pageText = async (u: string) =>
    u.includes("b.example") ? "The bureau said the reading was 42.5% on Friday." : "nothing";
  const gapPlanner = (crux = false): ModelPart => ({
    name: "p",
    complete: async (system) => {
      if (system.startsWith("You plan research")) {
        return '{"queries":["reading latest"],"resolutionSource":"the bureau, https://bureau.example/release"}';
      }
      if (system.startsWith("You review a research dossier")) {
        return '{"done":false,"missing":"the official reading","queries":["official result page"]}';
      }
      if (system.startsWith("You direct one last research round")) {
        return '{"missing":"the official reading","queries":["official result page"]}';
      }
      if (crux && system.startsWith("Independent forecasters disagree")) {
        return '{"crux":"which reading counts","queries":["official result page"]}';
      }
      return '{"verdict":"keep","confidence":0.5}';
    },
  });

  it("searches again before the runs when fewer than five lines verify, reading the settlement page first", async () => {
    const briefs: ResearchBrief[] = [];
    let runCalls = 0;
    const a = await forecastTyped(
      { question: "Will it be A?", answer: yesNo },
      {
        retriever: gapRetriever(briefs),
        analysts: [
          {
            name: "m",
            complete: async () => {
              runCalls++;
              return '{"answer":"A","confidence":0.6,"reason":"r"}';
            },
          },
        ],
        planner: gapPlanner(),
        pageText,
        now: () => NOW,
        options: { runs: 2, researchRounds: 1, critique: false },
      },
    );
    // The settlement source is searched first and its page is read first.
    expect(briefs[0]?.queries?.[0]).toContain("the bureau");
    expect(briefs[0]?.readFirst).toEqual(["https://bureau.example/release"]);
    expect(briefs[1]?.readFirst).toBeUndefined();
    const extra = a.research.find((r) => r.followUp);
    expect(extra).toMatchObject({ trigger: "evidence", verifiedAdded: 1 });
    expect(runCalls).toBe(2); // the runs read the fuller dossier once
    expect(a.initialRuns).toBeUndefined();
    expect(a.evidence?.verifiedLines).toBe(1);
  });

  it("follows up after the runs when they are ungrounded, redoing them only if it verified something", async () => {
    let runCalls = 0;
    const analyst: ModelPart = {
      name: "m",
      complete: async () => {
        runCalls++;
        return '{"answer":"A","confidence":0.6,"reason":"r"}';
      },
    };
    const a = await forecastTyped(
      { question: "Will it be A?", answer: yesNo },
      {
        retriever: gapRetriever([]),
        analysts: [analyst],
        planner: gapPlanner(),
        pageText,
        now: () => NOW,
        options: { runs: 2, researchRounds: 1, critique: false, minEvidenceLines: 0 },
      },
    );
    expect(a.research.find((r) => r.followUp)).toMatchObject({
      trigger: "grounding",
      queries: ["official result page"],
      verifiedAdded: 1,
    });
    expect(a.initialRuns).toHaveLength(2);
    expect(runCalls).toBe(4);

    const off = await forecastTyped(
      { question: "Will it be A?", answer: yesNo },
      {
        retriever: gapRetriever([]),
        analysts: [analyst],
        planner: gapPlanner(),
        pageText: async () => "nothing",
        now: () => NOW,
        options: { runs: 1, researchRounds: 1, critique: false, followUp: false },
      },
    );
    expect(off.research.some((r) => r.followUp)).toBe(false);
  });

  it("when the runs disagree, searches the crux and pools one more run", async () => {
    let n = 0;
    const a = await forecastTyped(
      { question: "Will it be A?", answer: yesNo },
      {
        retriever: gapRetriever([]),
        analysts: [
          {
            name: "m",
            complete: async (system) => {
              if (!system.startsWith("You are a careful forecaster")) return "{}";
              n++;
              return `{"answer":"${n === 2 ? "B" : "A"}","confidence":0.6,"reason":"r${n}"}`;
            },
          },
        ],
        planner: gapPlanner(true),
        pageText,
        now: () => NOW,
        options: {
          runs: 2,
          researchRounds: 1,
          critique: false,
          minEvidenceLines: 0,
          followUp: false,
        },
      },
    );
    expect(a.research.find((r) => r.trigger === "disagreement")?.missing).toBe(
      "which reading counts",
    );
    expect(a.runs).toHaveLength(3);
    expect(a.runs[2]).toMatchObject({ run: 3, crux: true, formatted: "A" });
    expect(a.prediction).toBe("A");
  });
});
