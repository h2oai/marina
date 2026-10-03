// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { ResearchBrief } from "../src/arena/research/briefs";
import {
  citedUrls,
  closedBookRetriever,
  daysMentioned,
  filterReport,
  isolationOfSpec,
  strictDateFilter,
  urlPublishedDay,
} from "../src/arena/research/isolation";
import {
  exaRetriever,
  isDateStrictSpec,
  type ResearchReport,
  retrieverFromSpec,
} from "../src/arena/research/retrieve";

const brief = (until?: string): ResearchBrief =>
  ({
    roundId: "t",
    since: "2026-08-01",
    ...(until ? { until } : {}),
    queries: ["q"],
    request: "q",
  }) as ResearchBrief;

describe("publication dates", () => {
  it("reads dates from URL paths", () => {
    expect(urlPublishedDay("https://news.example.com/2026/09/14/story")).toBe("2026-09-14");
    expect(urlPublishedDay("https://x.example.com/a/2026-09-03-thing")).toBe("2026-09-03");
    expect(urlPublishedDay("https://x.example.com/p/20260902/story")).toBe("2026-09-02");
    expect(urlPublishedDay("https://x.example.com/p/story")).toBeUndefined();
    expect(urlPublishedDay("https://x.example.com/2026/13/40/bad")).toBeUndefined();
    expect(urlPublishedDay("not a url")).toBeUndefined();
  });

  it("finds every day a line names, month-only as the month's last day", () => {
    expect(daysMentioned("on 2026-09-14 and September 20, 2026 and 3 Oct 2026")).toEqual([
      "2026-09-14",
      "2026-09-20",
      "2026-10-03",
    ]);
    expect(daysMentioned("expected in October 2026")).toEqual(["2026-10-31"]);
    expect(daysMentioned("on 14 Sep 2026")).toEqual(["2026-09-14"]);
    expect(daysMentioned("as of August 2026, on 2026-08-02", { monthOnly: false })).toEqual([
      "2026-08-02",
    ]);
  });

  it("finds cited URLs in markdown links and bare", () => {
    expect(
      citedUrls("a [x](https://a.example.com/2026/09/01/x). b https://b.example.com/y, c"),
    ).toEqual(["https://a.example.com/2026/09/01/x", "https://b.example.com/y"]);
  });
});

describe("the strict pre-cutoff filter", () => {
  const report: ResearchReport = {
    report: [
      "## engine",
      "- kept: rate held at 4% [r](https://news.example.com/2026/09/01/rates)",
      "- undated page [u](https://news.example.com/rates)",
      "- after cutoff [a](https://news.example.com/2026/09/20/rates)",
      "- live result [w](https://en.wikipedia.org/wiki/2026/09/01/Event)",
      "- names a later day: final on September 25, 2026 [r](https://news.example.com/2026/09/01/rates)",
      "- no citation at all",
      "- engine-dated [d](https://e.example.com/x)",
    ].join("\n"),
    sources: [
      { url: "https://news.example.com/2026/09/01/rates" },
      { url: "https://news.example.com/rates" },
      { url: "https://e.example.com/x", published: "2026-09-05" },
    ],
    costUsd: 0.01,
    searches: 1,
    retriever: "openrouter-web:m",
  };

  it("keeps only provably pre-cutoff, cited, non-live lines", () => {
    const { report: out, stats } = filterReport(report, "2026-09-10");
    expect(out.report).toBe(
      [
        "## engine",
        "- kept: rate held at 4% [r](https://news.example.com/2026/09/01/rates)",
        "- engine-dated [d](https://e.example.com/x)",
      ].join("\n"),
    );
    expect(stats).toEqual({
      linesIn: 7,
      linesKept: 2,
      dropped: { uncited: 1, undated: 1, afterCutoff: 1, liveResult: 1, laterDate: 1 },
    });
    expect(out.sources.map((s) => s.url).sort()).toEqual([
      "https://e.example.com/x",
      "https://news.example.com/2026/09/01/rates",
    ]);
    expect(out.retriever).toBe("strict(openrouter-web:m)");
  });

  it("says so when nothing provable survives", () => {
    const { report: out } = filterReport(report, "2026-08-01");
    expect(out.report).toContain(
      "Nothing found that is provably published on or before 2026-08-01",
    );
  });

  it("refuses a brief with no cutoff rather than pass everything", async () => {
    const wrapped = strictDateFilter(async () => report);
    await expect(wrapped(brief())).rejects.toThrow(/no cutoff/);
    const ok = await wrapped(brief("2026-09-10"));
    expect(ok.report).toContain("kept: rate held");
  });
});

describe("isolation levels and engines", () => {
  it("labels specs by what they guarantee", () => {
    expect(isolationOfSpec("closed-book", false)).toBe("closed-book");
    expect(isolationOfSpec("tavily:basic", false)).toBe("date-filtered");
    expect(isolationOfSpec("exa:auto,tavily:basic", false)).toBe("date-filtered");
    expect(isolationOfSpec("openrouter-web:m", false)).toBe("contaminated");
    expect(isolationOfSpec("openrouter-web:m", true)).toBe("post-filtered");
    expect(isolationOfSpec("tavily:basic,openrouter-web:m", false)).toBe("contaminated");
    expect(isolationOfSpec("asof", false)).toBe("date-filtered");
    expect(isolationOfSpec("asof:gdelt,wikipedia,hn", false)).toBe("date-filtered");
    expect(isolationOfSpec("asof,openrouter-web:m", false)).toBe("contaminated");
    expect(isDateStrictSpec("closed-book")).toBe(true);
    expect(() => retrieverFromSpec("closed-book", {}, { requireDateStrict: true })).not.toThrow();
  });

  it("closed-book retrieves nothing, and the spec parser knows it", async () => {
    const r = await closedBookRetriever()(brief("2026-09-01"));
    expect(r.sources).toEqual([]);
    expect(r.costUsd).toBe(0);
    const viaSpec = await retrieverFromSpec("closed-book", {})(brief("2026-09-01"));
    expect(viaSpec.retriever).toBe("closed-book");
    expect(() => retrieverFromSpec("exa:auto", {})).toThrow(/EXA_API_KEY/);
    expect(() => retrieverFromSpec("exa:bogus", { exa: "k" })).toThrow(/exa:auto/);
  });

  it("exa asks for the brief's window and drops undated or out-of-window results", async () => {
    let body: Record<string, unknown> = {};
    const exa = exaRetriever({
      type: "auto",
      apiKey: "k",
      fetcher: async (_url, init) => {
        body = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            results: [
              {
                url: "https://a.example.com/x",
                title: "A",
                publishedDate: "2026-09-05T10:00:00Z",
                text: "inside",
              },
              { url: "https://b.example.com/y", title: "B", text: "undated" },
              {
                url: "https://c.example.com/z",
                title: "C",
                publishedDate: "2026-09-20T00:00:00Z",
                text: "late",
              },
            ],
            costDollars: { total: 0.005 },
          }),
          { status: 200 },
        );
      },
    });
    const r = await exa(brief("2026-09-10"));
    expect(body.startPublishedDate).toBe("2026-08-01T00:00:00.000Z");
    expect(body.endPublishedDate).toBe("2026-09-10T23:59:59.999Z");
    expect(r.sources.map((s) => s.url)).toEqual(["https://a.example.com/x"]);
    expect(r.sources[0]!.published).toBe("2026-09-05");
    expect(r.report).toContain("2026-09-05 — inside");
    expect(r.costUsd).toBeCloseTo(0.005);
  });
});
