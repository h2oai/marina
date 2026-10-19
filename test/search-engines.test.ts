// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenRouter web plugin engines (`openrouter-web:<model>@<engine>[:<mode>]`)
 * and the DeepSeek Search API backend (`search:deepseek`) — stubbed fetch, no
 * network.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ResearchBrief } from "../src/arena/research/briefs";
import {
  openRouterWebPluginUsd,
  openRouterWebRetriever,
  parseOpenRouterWebEngine,
  retrieverFromSpec,
} from "../src/arena/research/retrieve";
import {
  searchBackendsFromEnv,
  WEB_SEARCH_BACKEND_NAMES,
  webSearchRetriever,
} from "../src/arena/research/web-search";
import {
  DEEPSEEK_BILLING_STARTS_AT,
  DEEPSEEK_SEARCH_URL,
  DEEPSEEK_USD_PER_SEARCH,
  deepSeekQuery,
  deepSeekSearchProvider,
} from "../src/engine/search-providers/deepseek";
import { resetSearchHealthForTests } from "../src/engine/search-providers/health";
import type { SearchHttp, SearchProvider } from "../src/engine/search-providers/index";
import { describeSearchReadiness } from "../src/engine/search-readiness";
import { resetSpendLedgerForTests, spentTodayUsd } from "../src/engine/spend-ledger";

const BILLED = DEEPSEEK_BILLING_STARTS_AT + 1;
const noHttp: SearchHttp = {
  httpGet: async () => ({ error: "no network in tests" }),
  httpPost: async () => ({ error: "no network in tests" }),
};

beforeEach(() => {
  resetSpendLedgerForTests();
  resetSearchHealthForTests();
});
afterEach(() => {
  resetSpendLedgerForTests();
  resetSearchHealthForTests();
});

const brief = (over: Partial<ResearchBrief> = {}): ResearchBrief => ({
  roundId: "t",
  since: "2026-09-01",
  request: "Who leads the generic ballot?\nmore",
  queries: ["generic ballot poll"],
  ...over,
});

function orReply(usage: Record<string, unknown> = { cost: 0.002 }): Response {
  return Response.json({
    choices: [
      {
        message: {
          content: "- D+3 [p](https://polls.example/a)",
          annotations: [{ url_citation: { url: "https://polls.example/a", title: "p" } }],
        },
      },
    ],
    usage,
  });
}

// ─── OpenRouter web plugin engines ───────────────────────────────────────────

describe("openrouter-web engine and mode parsing", () => {
  it("accepts every engine, its modes and the legacy @exa / @native forms", () => {
    expect(parseOpenRouterWebEngine("exa")).toEqual({ engine: "exa" });
    expect(parseOpenRouterWebEngine("native")).toEqual({ engine: "native" });
    expect(parseOpenRouterWebEngine("exa:deep-reasoning")).toEqual({
      engine: "exa",
      mode: "deep-reasoning",
    });
    expect(parseOpenRouterWebEngine("PARALLEL:Turbo")).toEqual({
      engine: "parallel",
      mode: "turbo",
    });
    expect(parseOpenRouterWebEngine("perplexity")).toEqual({ engine: "perplexity" });
    expect(parseOpenRouterWebEngine("firecrawl")).toEqual({ engine: "firecrawl" });
    for (const spec of [
      "openrouter-web:m@exa",
      "openrouter-web:m@native",
      "openrouter-web:m@exa:fast",
      "openrouter-web:m@parallel:advanced",
      "openrouter-web:m@perplexity",
      "openrouter-web:m@firecrawl",
      "openrouter-web:vendor/model:free@parallel:turbo",
    ]) {
      expect(() => retrieverFromSpec(spec, { openrouter: "k" })).not.toThrow();
    }
  });

  it("refuses an unknown engine, an unknown mode and a mode on a modeless engine", () => {
    expect(() => parseOpenRouterWebEngine("bing")).toThrow("unknown web plugin engine");
    expect(() => parseOpenRouterWebEngine("exa:turbo")).toThrow("unknown exa mode");
    expect(() => parseOpenRouterWebEngine("parallel:deep")).toThrow("unknown parallel mode");
    expect(() => parseOpenRouterWebEngine("perplexity:fast")).toThrow("takes no mode");
    expect(() => parseOpenRouterWebEngine("native:high")).toThrow("takes no mode");
    expect(() => retrieverFromSpec("openrouter-web:m@bing", { openrouter: "k" })).toThrow(
      'entry "openrouter-web:m@bing"',
    );
    expect(() => retrieverFromSpec("openrouter-web:m@exa:nope", { openrouter: "k" })).toThrow(
      "unknown exa mode",
    );
  });
});

describe("openrouter-web request body per engine", () => {
  async function bodyFor(spec: Parameters<typeof openRouterWebRetriever>[0]) {
    let body: Record<string, unknown> = {};
    const r = openRouterWebRetriever({
      ...spec,
      fetcher: async (_u, init) => {
        body = JSON.parse(String(init.body));
        return orReply();
      },
    });
    const rep = await r(brief());
    return { body, rep };
  }

  it("sends engine, mode and results; native also sends the search context size", async () => {
    const exa = await bodyFor({ model: "m", apiKey: "k", engine: "exa", mode: "deep" });
    expect(exa.body.plugins).toEqual([{ id: "web", max_results: 10, engine: "exa", mode: "deep" }]);
    expect(exa.body.web_search_options).toBeUndefined();
    expect(exa.rep.retriever).toBe("openrouter-web:m@exa:deep");

    const par = await bodyFor({ model: "m", apiKey: "k", engine: "parallel" });
    expect(par.body.plugins).toEqual([{ id: "web", max_results: 10, engine: "parallel" }]);

    const fc = await bodyFor({ model: "m", apiKey: "k", engine: "firecrawl" });
    expect(fc.body.plugins).toEqual([{ id: "web", max_results: 5, engine: "firecrawl" }]);

    const pplx = await bodyFor({ model: "m", apiKey: "k", engine: "perplexity" });
    expect(pplx.body.plugins).toEqual([{ id: "web", max_results: 10, engine: "perplexity" }]);

    const nat = await bodyFor({ model: "m", apiKey: "k", engine: "native" });
    expect(nat.body.plugins).toEqual([{ id: "web", max_results: 10, engine: "native" }]);
    expect(nat.body.web_search_options).toEqual({ search_context_size: "medium" });

    // No engine: the previous request shape, unchanged.
    const plain = await bodyFor({ model: "m", apiKey: "k" });
    expect(plain.body.plugins).toEqual([{ id: "web", max_results: 8 }]);
    expect(plain.body.web_search_options).toBeUndefined();
    expect(plain.rep.retriever).toBe("openrouter-web:m");
  });
});

describe("openrouter-web cost accounting", () => {
  it("prices each engine and mode, with per-result extras", () => {
    expect(openRouterWebPluginUsd(undefined, undefined, 8)).toBe(0);
    expect(openRouterWebPluginUsd("native", undefined, 10)).toBe(0);
    expect(openRouterWebPluginUsd("exa", undefined, 10)).toBeCloseTo(0.007, 10);
    expect(openRouterWebPluginUsd("exa", "deep-lite", 10)).toBeCloseTo(0.012, 10);
    expect(openRouterWebPluginUsd("exa", "deep-reasoning", 15)).toBeCloseTo(0.015 + 0.005, 10);
    expect(openRouterWebPluginUsd("parallel", "turbo", 10)).toBeCloseTo(0.001, 10);
    expect(openRouterWebPluginUsd("parallel", undefined, 10)).toBeCloseTo(0.005, 10);
    expect(openRouterWebPluginUsd("perplexity", undefined, 25)).toBeCloseTo(0.005, 10);
    expect(openRouterWebPluginUsd("firecrawl", undefined, 5)).toBeCloseTo(0.0675, 10);
    // Several searches in one call are each priced.
    expect(openRouterWebPluginUsd("exa", "fast", 10, 3)).toBeCloseTo(0.021, 10);
  });

  it("records model tokens plus the plugin's price, once", async () => {
    const r = openRouterWebRetriever({
      model: "m",
      apiKey: "k",
      engine: "parallel",
      mode: "fast",
      fetcher: async () =>
        orReply({ cost: 0.002, server_tool_use_details: { web_search_requests: 2 } }),
    });
    const rep = await r(brief());
    expect(rep.costUsd).toBeCloseTo(0.002 + 2 * 0.001, 10);
    expect(rep.searches).toBe(2);
    expect(spentTodayUsd()).toBeCloseTo(0.004, 10);
  });

  it("sonar is never charged a plugin price", async () => {
    const r = retrieverFromSpec("sonar:sonar-pro", { openrouter: "k" });
    expect(typeof r).toBe("function");
    const direct = openRouterWebRetriever({
      model: "perplexity/sonar-pro",
      apiKey: "k",
      nativeSearch: true,
      fetcher: async () => orReply({ cost: 0.01 }),
    });
    expect((await direct(brief())).costUsd).toBeCloseTo(0.01, 10);
  });
});

// ─── DeepSeek Search API ─────────────────────────────────────────────────────

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function stub(replies: Array<() => Response>) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    const next = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return next();
  };
  return { calls, fetcher };
}

const dsResults = () =>
  Response.json({
    results: [
      {
        title: "Ballot poll",
        url: "https://news.example/a",
        snippet: "short snippet",
        summary: "Democrats lead the generic ballot by 3 points.",
        content: "# Ballot poll\nFull page text.",
        site_name: "News",
        date: "2026-09-15T10:00:00Z",
        rerank_score: 2.4,
        authority: 3,
      },
      {
        title: "Undated",
        url: "https://other.example/b",
        snippet: "an undated snippet",
        summary: "",
        content: "",
        date: null,
        rerank_score: 1.1,
      },
      { title: "too late", url: "https://late.example/c", date: "2026-10-12T00:00:00Z" },
      { title: "no url", url: "", date: null },
    ],
  });

describe("DeepSeek search backend", () => {
  it("maps the query, count and date window into the request", async () => {
    const { calls, fetcher } = stub([dsResults]);
    const p = deepSeekSearchProvider("dk", { fetcher, now: () => BILLED });
    const out = await p.search(
      "generic ballot poll",
      {
        maxResults: 8,
        after: "2026-09-01T00:00:00.000Z",
        before: "2026-10-04T12:00:00.000Z",
      },
      noHttp,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(DEEPSEEK_SEARCH_URL);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer dk");
    expect(calls[0]!.body).toEqual({
      query: "generic ballot poll after:2026-09-01 before:2026-10-04",
      count: 8,
      need_content: true,
    });
    // Dated results carry the date; the summary is the passage; content rides as page text;
    // a result dated after `before` and one without a URL are dropped; undated stays.
    expect(out).toEqual([
      {
        title: "Ballot poll",
        url: "https://news.example/a",
        snippet: "Democrats lead the generic ballot by 3 points.",
        source: "deepseek",
        score: 2.4,
        published: "2026-09-15T10:00:00.000Z",
        text: "# Ballot poll\nFull page text.",
      },
      {
        title: "Undated",
        url: "https://other.example/b",
        snippet: "an undated snippet",
        source: "deepseek",
        score: 1.1,
      },
    ]);
  });

  it("keeps the query within 128 characters with its operators and clamps count", async () => {
    const long = `${"word ".repeat(60)}end`;
    const q = deepSeekQuery(long, "2026-09-01T00:00:00Z", "2026-10-04T00:00:00Z");
    expect(q.length).toBeLessThanOrEqual(128);
    expect(q.endsWith(" after:2026-09-01 before:2026-10-04")).toBe(true);
    expect(deepSeekQuery("plain query")).toBe("plain query");
    expect(deepSeekQuery("q", undefined, "2026-10-04T23:59:59.999Z")).toBe("q before:2026-10-04");

    const { calls, fetcher } = stub([() => Response.json({ results: [] })]);
    const p = deepSeekSearchProvider("dk", { fetcher, now: () => BILLED });
    await p.search("q", { maxResults: 500 }, noHttp);
    await p.search("q", { maxResults: 0 }, noHttp);
    await p.search("q", {}, noHttp);
    expect(calls.map((c) => c.body.count)).toEqual([50, 1, 10]);
  });

  it("bills a non-empty result and never an empty one", async () => {
    const spend = { usd: 0 };
    const empty = deepSeekSearchProvider("dk", {
      fetcher: stub([() => Response.json({ results: [] })]).fetcher,
      now: () => BILLED,
    });
    expect(await empty.search("q", { spend }, noHttp)).toEqual([]);
    expect(spend.usd).toBe(0);
    expect(spentTodayUsd()).toBe(0);

    const full = deepSeekSearchProvider("dk", {
      fetcher: stub([dsResults]).fetcher,
      now: () => BILLED,
    });
    await full.search("q", { spend }, noHttp);
    expect(spend.usd).toBeCloseTo(DEEPSEEK_USD_PER_SEARCH, 10);
    expect(spentTodayUsd()).toBeCloseTo(DEEPSEEK_USD_PER_SEARCH, 10);
    expect(DEEPSEEK_USD_PER_SEARCH).toBeCloseTo(0.75 / 1000, 10);

    // Before billing starts a search is free.
    const early = deepSeekSearchProvider("dk", {
      fetcher: stub([dsResults]).fetcher,
      now: () => DEEPSEEK_BILLING_STARTS_AT - 1,
    });
    const s2 = { usd: 0 };
    await early.search("q", { spend: s2 }, noHttp);
    expect(s2.usd).toBe(0);
  });

  it("retries HTTP 429 a bounded number of times, then throws", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    const limited = () => new Response("rate limited", { status: 429 });
    const ok = stub([
      limited,
      () => new Response("x", { status: 429, headers: { "retry-after": "1" } }),
      dsResults,
    ]);
    const p = deepSeekSearchProvider("dk", { fetcher: ok.fetcher, sleep, now: () => BILLED });
    expect(await p.search("q", {}, noHttp)).toHaveLength(3);
    expect(ok.calls).toHaveLength(3);
    expect(waits).toEqual([250, 1000]);

    const always = stub([limited]);
    const q = deepSeekSearchProvider("dk", { fetcher: always.fetcher, sleep, now: () => BILLED });
    await expect(q.search("q", {}, noHttp)).rejects.toThrow("deepseek HTTP 429");
    expect(always.calls).toHaveLength(3);
    expect(spentTodayUsd()).toBeCloseTo(DEEPSEEK_USD_PER_SEARCH, 10); // only the one success
  });

  it("throws on other HTTP failures and unreadable replies", async () => {
    const bad = deepSeekSearchProvider("dk", {
      fetcher: stub([() => new Response("nope", { status: 401 })]).fetcher,
    });
    await expect(bad.search("q", {}, noHttp)).rejects.toThrow("deepseek HTTP 401");
    const junk = deepSeekSearchProvider("dk", {
      fetcher: stub([() => new Response("<html>")]).fetcher,
    });
    await expect(junk.search("q", {}, noHttp)).rejects.toThrow("unreadable reply");
  });
});

describe("deepseek in the search chain", () => {
  it("is a backend name, registered only with DEEPSEEK_API_KEY", () => {
    expect(WEB_SEARCH_BACKEND_NAMES).toContain("deepseek");
    // Default chain: the paid fallback after the free engine, before OpenRouter.
    const all = searchBackendsFromEnv({ DEEPSEEK_API_KEY: "dk", OPENROUTER_API_KEY: "ok" });
    expect(all.backends.map((b) => b.name)).toEqual(["duckduckgo", "deepseek", "openrouter"]);
    expect(searchBackendsFromEnv({}).backends.map((b) => b.name)).toEqual(["duckduckgo"]);
    const named = searchBackendsFromEnv({ MARINA_RESEARCH_SEARCH_BACKENDS: "deepseek,duckduckgo" });
    expect(named.backends.map((b) => b.name)).toEqual(["duckduckgo"]);
    expect(named.skipped).toEqual(["deepseek (no DEEPSEEK_API_KEY)"]);
    expect(() => retrieverFromSpec("search:deepseek", {}, { env: {} })).toThrow(
      "no usable backend",
    );
    expect(() =>
      retrieverFromSpec("search:duckduckgo+deepseek", {}, { env: { DEEPSEEK_API_KEY: "dk" } }),
    ).not.toThrow();
  });

  it("the search retriever hands the brief's window to the backend", async () => {
    const seen: Array<{ before?: string; after?: string }> = [];
    const backend: SearchProvider = {
      name: "deepseek",
      engines: ["web"],
      async search(_q, opts) {
        seen.push({
          ...(opts.before ? { before: opts.before } : {}),
          ...(opts.after ? { after: opts.after } : {}),
        });
        return [];
      },
    };
    const now = new Date("2026-10-19T12:00:00.000Z");
    const r = webSearchRetriever({
      backends: [backend],
      background: null,
      http: noHttp,
      fetchPage: async () => undefined,
      now: () => now,
    });
    await r(brief({ until: "2026-10-04", untilAt: "2026-10-04T12:00:00.000Z" }));
    expect(seen[0]).toEqual({
      before: "2026-10-04T12:00:00.000Z",
      after: "2026-09-01T00:00:00.000Z",
    });
    // A live question (cutoff ≈ now) is not bounded above.
    seen.length = 0;
    await r(brief());
    expect(seen[0]).toEqual({ after: "2026-09-01T00:00:00.000Z" });
  });
});

describe("search readiness", () => {
  it("lists deepseek after DuckDuckGo and the OpenRouter web engines", () => {
    const r = describeSearchReadiness({ DEEPSEEK_API_KEY: "dk", OPENROUTER_API_KEY: "ok" }, []);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain(
      "web search chain: duckduckgo → deepseek (Search API) → openrouter (Exa plugin, research)",
    );
    expect(r.detail).toContain(
      "openrouter-web engines: native, exa, parallel, perplexity, firecrawl",
    );
    // DeepSeek alone is a keyed backend: no longer "keyless only".
    expect(describeSearchReadiness({ DEEPSEEK_API_KEY: "dk" }, []).status).toBe("ok");
    expect(describeSearchReadiness({}, []).detail).not.toContain("deepseek");
  });

  it("reports a failing deepseek backend and engine-tagged openrouter-web calls", () => {
    const now = Date.now();
    const r = describeSearchReadiness(
      { DEEPSEEK_API_KEY: "dk" },
      [
        {
          name: "deepseek",
          calls: 3,
          failures: 3,
          consecutiveFailures: 3,
          lastErrorAt: now,
          lastError: "deepseek HTTP 429: rate limited",
        },
        {
          name: "openrouter-web@parallel:basic",
          calls: 1,
          failures: 0,
          consecutiveFailures: 0,
          lastOkAt: now,
        },
      ],
      now,
    );
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("deepseek failing (3× in a row, quota or key");
    expect(r.detail).toContain("answering: openrouter-web@parallel:basic");
  });
});
