// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { parseForecasterSpec } from "../src/arena/config";
import { buildResearchBrief } from "../src/arena/research/briefs";
import {
  combineRetrievers,
  type ResearchReport,
  type Retriever,
  retrieverFromSpec,
  TAVILY_USD_PER_CREDIT,
  tavilyRetriever,
  tavilySnippet,
  withProvidedText,
} from "../src/arena/research/retrieve";
import { MAX_PAGE_BYTES, readCapped, verifyDossier } from "../src/arena/research/verify";
import type { ArenaLock, ArenaRound } from "../src/arena/types";

const round: ArenaRound = {
  round_id: "civiqs-2026-w40-approval",
  tracker: "civiqs",
  series: "civiqs_trump_approval",
  question: "Civiqs Trump approval on Friday?",
  unit: "% approve",
  target_type: "continuous_normal",
  lock_at: "2026-09-25T14:00:00Z",
  release_at: "2026-09-26T14:00:00Z",
};
const lock: ArenaLock = {
  round_id: round.round_id,
  answer_history: [
    { date: "2026-09-11", value: 36 },
    { date: "2026-09-18", value: 35 },
  ],
};

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };
function fakeTavily(results: unknown[], credits = 2) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ results, usage: { credits } }), { status: 200 });
  };
  return { calls, fetcher };
}

const brief = {
  roundId: "r",
  since: "2026-09-22",
  request: "Research this.\nmore",
  queries: ["q1"],
};

describe("research brief window", () => {
  it("starts at the nowcast reading's date when it is newer than the history", () => {
    const b = buildResearchBrief(round, lock, { nowcast: { date: "2026-09-24", value: 34 } });
    expect(b.since).toBe("2026-09-24");
    expect(b.request).toContain("after 2026-09-24");
    expect(b.request).toContain("daily tracker");
    expect(b.request).toContain("34");
    expect(b.queries?.length).toBeGreaterThan(0);
  });

  it("keeps the last published value when there is no (newer) nowcast", () => {
    expect(buildResearchBrief(round, lock).since).toBe("2026-09-18");
    expect(
      buildResearchBrief(round, lock, { nowcast: { date: "2026-09-11", value: 36 } }).since,
    ).toBe("2026-09-18");
  });

  it("searches for the items an attention question names", () => {
    const b = buildResearchBrief(
      { ...round, tracker: "wikipedia", series: "wiki", question: "Top articles: Taylor Swift?" },
      lock,
    );
    expect(b.queries?.[0]).toBe("Top articles: Taylor Swift?");
  });
});

describe("Tavily retriever", () => {
  it("sends one news search per query, dated from the brief, with raw page text", async () => {
    const { calls, fetcher } = fakeTavily([]);
    await tavilyRetriever({ depth: "advanced", apiKey: "tvly-test", fetcher })({
      ...brief,
      queries: ["a", "b"],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://api.tavily.com/search");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tvly-test",
    );
    expect(calls[0]!.body).toMatchObject({
      query: "a",
      topic: "news",
      search_depth: "advanced",
      max_results: 8,
      start_date: "2026-09-22",
      include_raw_content: "text",
      include_usage: true,
    });
    // The key travels in the header only.
    expect(JSON.stringify(calls[0]!.body)).not.toContain("tvly-test");
  });

  it("falls back to the brief's first line when it has no queries", async () => {
    const { calls, fetcher } = fakeTavily([]);
    await tavilyRetriever({ depth: "basic", apiKey: "k", fetcher })({
      roundId: "r",
      since: "2026-09-22",
      request: "Find polls.\nRules…",
    });
    expect(calls[0]!.body.query).toBe("Find polls.");
  });

  it("builds a dated, cited line per result and carries each page's text", async () => {
    const { fetcher } = fakeTavily([
      {
        url: "https://news.example/poll",
        title: "Trump approval [record] low",
        content:
          "The poll, released Sept. 23, found\n 32% approve and [67%](https://x.example) disapprove.",
        raw_content: "Full page: 32% approve, 67% disapprove.",
        published_date: "Thu, 24 Sep 2026 23:00:00 GMT",
        score: 0.5,
      },
      {
        url: "https://old.example/x",
        content: "Stale 40% reading",
        published_date: "2026-09-01",
        score: 0.9,
      },
      {
        url: "https://today.yougov.com/topics/x",
        title: "YouGov",
        content: "YouGov has 38% approve",
        raw_content: "38% approve",
        published_date: "2026-09-23",
        score: 0.8,
      },
    ]);
    const r = await tavilyRetriever({ depth: "advanced", apiKey: "k", fetcher })(brief);
    const lines = r.report.split("\n");
    expect(lines).toHaveLength(2); // the result dated before `since` is dropped
    // Best score first; the YouGov line stays but carries no text.
    expect(lines[0]).toBe(
      "- 2026-09-23 — YouGov has 38% approve [YouGov](https://today.yougov.com/topics/x)",
    );
    expect(lines[1]).toBe(
      "- 2026-09-24 — The poll, released Sept. 23, found 32% approve and 67% disapprove. [Trump approval record low](https://news.example/poll)",
    );
    expect(r.sources).toEqual([
      { url: "https://today.yougov.com/topics/x", title: "YouGov", published: "2026-09-23" },
      {
        url: "https://news.example/poll",
        title: "Trump approval [record] low",
        published: "2026-09-24",
        text: "Full page: 32% approve, 67% disapprove.",
      },
    ]);
    expect(r.retriever).toBe("tavily:advanced");
    expect(r.searches).toBe(1);
    expect(r.costUsd).toBeCloseTo(2 * TAVILY_USD_PER_CREDIT);
  });

  it("estimates credits by depth when Tavily reports no usage", async () => {
    const fetcher = async () => new Response(JSON.stringify({ results: [] }), { status: 200 });
    const r = await tavilyRetriever({ depth: "advanced", apiKey: "k", fetcher })({
      ...brief,
      queries: ["a", "b", "c"],
    });
    expect(r.costUsd).toBeCloseTo(6 * TAVILY_USD_PER_CREDIT);
    expect(r.report).toContain("Nothing found");
  });

  it("fails when every query fails, survives when one does", async () => {
    let n = 0;
    const flaky = async () =>
      n++ === 0
        ? new Response("bad key", { status: 401 })
        : new Response(JSON.stringify({ results: [] }), { status: 200 });
    const r = await tavilyRetriever({ depth: "basic", apiKey: "k", fetcher: flaky })({
      ...brief,
      queries: ["a", "b"],
    });
    expect(r.searches).toBe(1);
    const dead = async () => new Response("bad key", { status: 401 });
    await expect(
      tavilyRetriever({ depth: "basic", apiKey: "k", fetcher: dead })(brief),
    ).rejects.toThrow("tavily HTTP 401");
  });

  it("cuts snippets at a word boundary so no figure is truncated", () => {
    const s = tavilySnippet(`${"word ".repeat(20)}35.25% end`, 105);
    expect(s.endsWith("…")).toBe(true);
    expect(s).not.toContain("35.2");
  });
});

describe("retriever specs", () => {
  it("accepts tavily:basic and tavily:advanced, and asks for the key it needs", () => {
    expect(() => retrieverFromSpec("tavily:advanced", { tavily: "t" })).not.toThrow();
    expect(() =>
      retrieverFromSpec("tavily:advanced,sonar:sonar-pro", { tavily: "t", openrouter: "o" }),
    ).not.toThrow();
    expect(() => retrieverFromSpec("tavily:deep", { tavily: "t" })).toThrow(
      "tavily:basic or tavily:advanced",
    );
    expect(() => retrieverFromSpec("tavily:basic", { openrouter: "o" })).toThrow("TAVILY_API_KEY");
    expect(() => retrieverFromSpec("sonar:sonar-pro", { tavily: "t" })).toThrow(
      "OPENROUTER_API_KEY",
    );
    expect(() => retrieverFromSpec("sonar:sonar-pro", "o")).not.toThrow();
  });

  it("research specs take tavily retrievers after @", () => {
    const spec =
      "research:openrouter/deepseek/deepseek-v4-pro-0813@tavily:advanced,sonar:sonar-pro";
    expect(parseForecasterSpec(spec)).toBe(spec);
    expect(() => parseForecasterSpec("research:a/b@tavily:")).toThrow();
  });
});

const fixed =
  (r: Partial<ResearchReport>): Retriever =>
  async () => ({ report: "", sources: [], costUsd: 0, searches: 0, retriever: "x", ...r });

describe("provided page text", () => {
  const report = [
    "- Poll: 32% approve [a](https://blocked.example/poll)",
    "- YouGov: 38% approve [y](https://today.yougov.com/x)",
  ].join("\n");

  it("verifies against a source's text instead of fetching the page", async () => {
    const fetched: string[] = [];
    const v = await verifyDossier(
      report,
      async (u) => {
        fetched.push(u);
        return undefined; // e.g. a 403 bot wall
      },
      [
        { url: "https://blocked.example/poll", text: "Approve 32% Disapprove 67%" },
        // Provided text from a no-fetch publisher is never used.
        { url: "https://today.yougov.com/x", text: "38% approve" },
      ],
    );
    expect(fetched).toEqual([]);
    expect(v.stats).toEqual({ verified: 1, unverified: 0, unreachable: 1, uncited: 0 });
    expect(v.reads).toEqual({ provided: 1, fetched: 0, failed: 0 });
    expect(v.verifiedText).not.toContain("YouGov");
  });

  it("carries text from retriever to verifier without storing it on the sources", async () => {
    const inner = fixed({
      report,
      sources: [
        { url: "https://blocked.example/poll", text: "Approve 32%" },
        { url: "https://today.yougov.com/x", text: "38% approve" },
      ],
    });
    const fetched: string[] = [];
    const { retriever, pageText } = withProvidedText(inner, async (u) => {
      fetched.push(u);
      return undefined;
    });
    const r = await retriever(brief);
    expect(r.sources.every((s) => s.text === undefined)).toBe(true);
    expect(pageText.provided?.("https://blocked.example/poll")).toBe("Approve 32%");
    expect(pageText.provided?.("https://today.yougov.com/x")).toBeUndefined();
    expect(await pageText("https://today.yougov.com/x")).toBeUndefined();
    const v = await verifyDossier(r.report, pageText);
    expect(v.stats.verified).toBe(1);
    expect(v.stats.unreachable).toBe(1);
    // The provided page was not fetched; the no-fetch one was not fetched either.
    expect(fetched).toEqual([]);
  });

  it("provided pages do not use up the fetch cap", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `- ${100 + i}% [s](https://p${i}.example/)`);
    const sources = lines
      .slice(0, 15)
      .map((_, i) => ({ url: `https://p${i}.example/`, text: `${100 + i}%` }));
    const fetched: string[] = [];
    const v = await verifyDossier(
      lines.join("\n"),
      async (u) => {
        fetched.push(u);
        return `${100 + Number(u.match(/p(\d+)/)![1])}%`;
      },
      sources,
    );
    expect(fetched).toHaveLength(5);
    expect(v.stats.verified).toBe(20);
  });

  it("merging engines keeps a page's text when any engine carries it", async () => {
    const r = await combineRetrievers([
      fixed({ retriever: "a", sources: [{ url: "https://u.example/" }] }),
      fixed({ retriever: "b", sources: [{ url: "https://u.example/", text: "t" }] }),
    ])(brief);
    expect(r.sources).toEqual([{ url: "https://u.example/", text: "t" }]);
  });
});

describe("large pages", () => {
  function streamOf(totalBytes: number, chunk = 1 << 20) {
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= totalBytes) return c.close();
        const n = Math.min(chunk, totalBytes - sent);
        const bytes = new Uint8Array(n).fill(0x61);
        if (sent === 0) bytes.set(new TextEncoder().encode("Approve 34%, "));
        sent += n;
        c.enqueue(bytes);
      },
      cancel() {
        cancelled = true;
      },
    });
    return { res: new Response(body), sent: () => sent, cancelled: () => cancelled };
  }

  it("reads a 12 MB page whole (the old cap rejected anything over 2 MB)", async () => {
    const s = streamOf(12 * 1024 * 1024);
    const text = await readCapped(s.res);
    expect(text.length).toBe(12 * 1024 * 1024);
    expect(text.startsWith("Approve 34%")).toBe(true);
  });

  it("truncates past the cap instead of rejecting, and stops reading", async () => {
    const s = streamOf(40 * 1024 * 1024);
    const text = await readCapped(s.res, 4 * 1024 * 1024);
    expect(text.length).toBe(4 * 1024 * 1024);
    expect(text).toContain("34%");
    expect(s.sent()).toBeLessThan(40 * 1024 * 1024);
    expect(s.cancelled()).toBe(true);
    expect(MAX_PAGE_BYTES).toBe(16 * 1024 * 1024);
  });
});
