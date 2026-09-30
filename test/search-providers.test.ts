// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Search providers against a fake ConnectorRuntime (no network): DuckDuckGo
 * lite HTML parsing + instant-answer fallback, arXiv / Semantic Scholar
 * interleaving, SearXNG engine mapping, Tavily topic selection, and the
 * orchestrator's intent routing, per-provider grouping, failure isolation and
 * URL de-duplication.
 */

import { describe, expect, it } from "bun:test";
import type { ConnectorRuntime } from "../src/engine/connector-runtime";
import { academicProvider } from "../src/engine/search-providers/academic";
import { duckDuckGoProvider } from "../src/engine/search-providers/duckduckgo";
import {
  detectIntent,
  initProvidersSync,
  registerProvider,
  search,
} from "../src/engine/search-providers/index";
import { searxngProvider } from "../src/engine/search-providers/searxng";
import { tavilyProvider } from "../src/engine/search-providers/tavily";
import { scopeProcessState } from "./process-state";

type Reply = { status: number; body: string } | { error: string };

function fakeRuntime(route: (url: string, body?: string) => Reply) {
  const calls: Array<{ method: string; url: string; body?: string; entityId?: string }> = [];
  const runtime = {
    httpGet: async (url: string, entityId?: string) => {
      calls.push({ method: "GET", url, entityId });
      return route(url);
    },
    httpPost: async (url: string, body: string, entityId?: string) => {
      calls.push({ method: "POST", url, body, entityId });
      return route(url, body);
    },
  } as unknown as ConnectorRuntime;
  return { runtime, calls };
}

const ok = (body: unknown) => ({
  status: 200,
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const DDG_HTML = `
<table>
<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x" class='result-link'>Example <b>A</b></a></td></tr>
<tr><td class='result-snippet'>First &amp; best snippet</td></tr>
<tr><td><a class="result-link" href="https://example.org/b">Example B</a></td></tr>
<tr><td class="result-snippet">Second</td></tr>
<tr><td><a class="result-link" href="//example.net/c">Example C</a></td></tr>
<tr><td><a class="result-link" href="https://duckduckgo.com/y">ad</a></td></tr>
<tr><td><a class="result-link" href="/relative">rel</a></td></tr>
<tr><td><a class="result-link" href="https://example.com/empty"></a></td></tr>
<tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=%E0%A4%A">bad</a></td></tr>
<tr><td><a href="https://nav.example/">nav link</a></td></tr>
</table>`;

describe("duckduckgo provider", () => {
  it("parses lite HTML result links, decoding redirects and entities", async () => {
    const { runtime, calls } = fakeRuntime(() => ok(DDG_HTML));
    const results = await duckDuckGoProvider().search("q x", {}, runtime, "e_1");
    expect(results.map((r) => r.url)).toEqual([
      "https://example.com/a",
      "https://example.org/b",
      "https://example.net/c",
    ]);
    expect(results[0]).toMatchObject({
      title: "Example A",
      snippet: "First & best snippet",
      source: "duckduckgo",
    });
    expect(results[2]?.snippet).toBe("");
    expect(calls[0]?.url).toContain("lite.duckduckgo.com/lite/?q=q%20x");
    expect(calls[0]?.entityId).toBe("e_1");
  });

  it("honours maxResults on the HTML path", async () => {
    const { runtime } = fakeRuntime(() => ok(DDG_HTML));
    expect(await duckDuckGoProvider().search("q", { maxResults: 1 }, runtime)).toHaveLength(1);
  });

  it("falls back to instant answers (abstract, topics, nested topics) when HTML is empty", async () => {
    const { runtime } = fakeRuntime((url) =>
      url.includes("lite.")
        ? { status: 503, body: "" }
        : ok({
            AbstractText: "Bun is a runtime",
            AbstractURL: "https://en.wikipedia.org/wiki/Bun",
            RelatedTopics: [
              { Text: "Topic one", FirstURL: "https://t/1" },
              { Text: "no url" },
              { Topics: [{ Text: "Nested", FirstURL: "https://t/2" }, { Text: "x" }] },
            ],
          }),
    );
    const results = await duckDuckGoProvider().search("bun", { maxResults: 5 }, runtime);
    expect(results.map((r) => r.title)).toEqual(["Wikipedia", "Topic one", "Nested"]);
  });

  it("stops at maxResults in instant answers and survives errors / junk JSON", async () => {
    const many = {
      AbstractSource: "Src",
      AbstractText: "a",
      AbstractURL: "https://a",
      RelatedTopics: [
        { Text: "1", FirstURL: "https://1" },
        { Topics: [{ Text: "2", FirstURL: "https://2" }] },
        { Text: "3", FirstURL: "https://3" },
      ],
    };
    let { runtime } = fakeRuntime((url) =>
      url.includes("lite.") ? ok("<html></html>") : ok(many),
    );
    expect(await duckDuckGoProvider().search("q", { maxResults: 2 }, runtime)).toHaveLength(2);
    ({ runtime } = fakeRuntime((url) => (url.includes("lite.") ? { error: "blocked" } : ok("{"))));
    expect(await duckDuckGoProvider().search("q", {}, runtime)).toEqual([]);
    ({ runtime } = fakeRuntime(() => ({ error: "blocked" })));
    expect(await duckDuckGoProvider().search("q", {}, runtime)).toEqual([]);
  });
});

const ARXIV_XML = `<feed>
<entry><id>http://arxiv.org/api/1234.5678v1</id><title>Deep
  Learning</title><summary>  An   abstract </summary></entry>
<entry><id>http://arxiv.org/api/2</id><title>Second</title><summary>s</summary></entry>
<entry><title>No id</title></entry>
<entry><id>http://arxiv.org/api/3</id><title>Third</title></entry>
</feed>`;

describe("academic provider", () => {
  it("interleaves arXiv and Semantic Scholar results", async () => {
    const { runtime, calls } = fakeRuntime((url) =>
      url.includes("arxiv")
        ? ok(ARXIV_XML)
        : ok({
            data: [
              {
                paperId: "p1",
                title: "Scholar One",
                abstract: "abs",
                year: 2024,
                citationCount: 7,
              },
              { paperId: "p2", url: "https://s2/p2" },
            ],
          }),
    );
    const results = await academicProvider().search(
      "attention (paper)",
      { maxResults: 4 },
      runtime,
    );
    expect(results.map((r) => r.source)).toEqual([
      "arxiv",
      "semantic-scholar",
      "arxiv",
      "semantic-scholar",
    ]);
    expect(results[0]).toMatchObject({
      title: "[arXiv] Deep Learning",
      url: "https://arxiv.org/abs/1234.5678v1",
      snippet: "An abstract",
    });
    expect(results[1]).toMatchObject({
      title: "[Scholar] Scholar One (2024)",
      url: "https://api.semanticscholar.org/paper/p1",
      snippet: "abs (7 citations)",
    });
    expect(results[3]).toMatchObject({
      title: "[Scholar] Untitled",
      url: "https://s2/p2",
      snippet: "",
    });
    expect(calls.find((c) => c.url.includes("arxiv"))?.url).toContain("max_results=2");
  });

  it("keeps the other source when one fails, and caps the arXiv parse", async () => {
    let { runtime } = fakeRuntime((url) =>
      url.includes("arxiv") ? { error: "x" } : ok("not json"),
    );
    expect(await academicProvider().search("q", {}, runtime)).toEqual([]);
    ({ runtime } = fakeRuntime((url) =>
      url.includes("arxiv") ? ok(ARXIV_XML) : { status: 500, body: "" },
    ));
    const results = await academicProvider().search("q", { maxResults: 2 }, runtime);
    expect(results.map((r) => r.title)).toEqual(["[arXiv] Deep Learning"]);
    ({ runtime } = fakeRuntime((url) => (url.includes("arxiv") ? ok(ARXIV_XML) : ok({}))));
    expect(await academicProvider().search("q", { maxResults: 10 }, runtime)).toHaveLength(3);
  });
});

describe("searxng provider", () => {
  it("maps engine categories and normalises results", async () => {
    const { runtime, calls } = fakeRuntime(() =>
      ok({
        results: [
          { title: "T", url: "https://x", content: "c".repeat(600), engine: "google", score: 2 },
          {},
        ],
      }),
    );
    const provider = searxngProvider("http://searx.local///");
    const results = await provider.search("q", { engines: ["web", "academic", "code"] }, runtime);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("http://searx.local/search");
    expect(url.searchParams.get("engines")).toBe("google scholar,arxiv,pubmed,github");
    expect(results[0]?.snippet).toHaveLength(500);
    expect(results[0]?.source).toBe("searxng:google");
    expect(results[1]).toMatchObject({ title: "", url: "", source: "searxng:unknown" });
  });

  it("omits engines for plain web and returns [] on errors", async () => {
    let { runtime, calls } = fakeRuntime(() => ok({}));
    expect(await searxngProvider("http://s").search("q", {}, runtime)).toEqual([]);
    expect(new URL(calls[0]!.url).searchParams.has("engines")).toBe(false);
    ({ runtime, calls } = fakeRuntime(() => ({ error: "blocked" })));
    expect(await searxngProvider("http://s").search("q", {}, runtime)).toEqual([]);
    ({ runtime } = fakeRuntime(() => ({ status: 502, body: "" })));
    expect(await searxngProvider("http://s").search("q", {}, runtime)).toEqual([]);
    ({ runtime } = fakeRuntime(() => ok("<html>")));
    expect(await searxngProvider("http://s").search("q", {}, runtime)).toEqual([]);
  });
});

describe("tavily provider", () => {
  it("posts the key and picks the news topic when asked", async () => {
    const { runtime, calls } = fakeRuntime(() =>
      ok({ results: [{ title: "N", url: "https://n", content: "body", score: 0.9 }, {}] }),
    );
    const results = await tavilyProvider("tv-key").search(
      "q",
      { engines: ["web", "news"], maxResults: 3 },
      runtime,
    );
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent).toMatchObject({ api_key: "tv-key", topic: "news", max_results: 3 });
    expect(results[0]).toEqual({
      title: "N",
      url: "https://n",
      snippet: "body",
      source: "tavily",
      score: 0.9,
    });
    expect(results[1]).toMatchObject({ title: "", url: "", snippet: "" });
  });

  it("uses the general topic by default and returns [] on errors", async () => {
    let { runtime, calls } = fakeRuntime(() => ok({}));
    expect(await tavilyProvider("k").search("q", {}, runtime)).toEqual([]);
    expect(JSON.parse(calls[0]!.body!).topic).toBe("general");
    ({ runtime, calls } = fakeRuntime(() => ({ error: "x" })));
    expect(await tavilyProvider("k").search("q", {}, runtime)).toEqual([]);
    ({ runtime } = fakeRuntime(() => ({ status: 401, body: "" })));
    expect(await tavilyProvider("k").search("q", {}, runtime)).toEqual([]);
    ({ runtime } = fakeRuntime(() => ok("{bad")));
    expect(await tavilyProvider("k").search("q", {}, runtime)).toEqual([]);
  });
});

describe("search orchestrator", () => {
  it("detects intent from keywords", () => {
    expect(detectIntent("hello")).toEqual(["web"]);
    expect(detectIntent("latest arxiv paper on the github sdk, best reviews")).toEqual([
      "web",
      "academic",
      "news",
      "code",
      "social",
    ]);
  });

  it("routes through the default providers, grouping engines and de-duplicating URLs", async () => {
    using _state = scopeProcessState({
      env: { TAVILY_API_KEY: undefined, SEARXNG_URL: undefined },
    });
    initProvidersSync();
    initProvidersSync(); // idempotent
    const { runtime, calls } = fakeRuntime((url) => {
      if (url.includes("lite.duckduckgo")) return ok(DDG_HTML);
      if (url.includes("arxiv")) return ok(ARXIV_XML);
      if (url.includes("semanticscholar"))
        return ok({ data: [{ title: "dup", url: "https://example.com/a/" }] });
      return { error: "unexpected" };
    });
    const results = await search("latest research paper", { maxResults: 10 }, runtime, "e_2");
    // web + news share one DuckDuckGo call; academic is one provider call (two fetches).
    expect(calls.filter((c) => c.url.includes("lite.duckduckgo"))).toHaveLength(1);
    const urls = results.map((r) => r.url);
    expect(urls.filter((u) => u.startsWith("https://example.com/a"))).toHaveLength(1);
    expect(urls).toContain("https://arxiv.org/abs/2");
    expect(calls.every((c) => c.entityId === "e_2")).toBe(true);
  });

  it("isolates a throwing provider and ignores engines with no provider", async () => {
    registerProvider({
      name: "throws",
      engines: ["test-only-throwing-engine"],
      search: async () => {
        throw new Error("down");
      },
    });
    registerProvider({
      name: "fixed",
      engines: ["test-only-fixed-engine"],
      search: async () => [
        { title: "one", url: "https://one/", snippet: "", source: "fixed" },
        { title: "one again", url: "HTTPS://ONE", snippet: "", source: "fixed" },
        { title: "two", url: "https://two", snippet: "", source: "fixed" },
      ],
    });
    const { runtime } = fakeRuntime(() => ({ error: "unused" }));
    const results = await search(
      "q",
      {
        engines: ["test-only-throwing-engine", "test-only-fixed-engine", "test-only-no-provider"],
        maxResults: 5,
      },
      runtime,
    );
    expect(results.map((r) => r.title)).toEqual(["one", "two"]);
    const capped = await search(
      "q",
      { engines: ["test-only-fixed-engine"], maxResults: 1 },
      runtime,
    );
    expect(capped).toHaveLength(1);
  });
});
