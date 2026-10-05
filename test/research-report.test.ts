// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Research reports (`src/research/`) and the retrieval they stand on: CJK
 * passage ranking, barred sources, citation numbering and the mechanical
 * citation audit, the plan → research → write pipeline with fake models and a
 * fake retriever, and the cross-model fact pass's edit rules. No network.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { ResearchBrief } from "../src/arena/research/briefs";
import type { ResearchReport, Retriever } from "../src/arena/research/retrieve";
import { figuresMissing } from "../src/arena/research/verify";
import {
  excludedSource,
  passagesOf,
  rankPassages,
  terms,
  webSearchRetriever,
} from "../src/arena/research/web-search";
import { resetSearchHealthForTests } from "../src/engine/search-providers/health";
import type { SearchProvider, SearchResult } from "../src/engine/search-providers/index";
import {
  auditCitations,
  citedNumbers,
  normalizeCitationMarkers,
  referenceList,
  renumberCitations,
  sentencesOf,
} from "../src/research/citations";
import { applyEdits, factCheckReport, splitSections } from "../src/research/fact-pass";
import {
  detectLanguage,
  parsePlan,
  type ReportModel,
  writeResearchReport,
} from "../src/research/report";

afterEach(() => resetSearchHealthForTests());

describe("CJK retrieval", () => {
  it("tokenises CJK runs into character bigrams and keeps Latin tokens", () => {
    expect(terms("土地财政")).toEqual(["土地", "地财", "财政"]);
    expect(terms("GDP 增长")).toEqual(["gdp", "增长"]);
    expect(terms("Land finance reform")).toEqual(["land", "finance", "reform"]);
  });

  it("splits long CJK paragraphs at full-width sentence ends without inventing spaces", () => {
    const sentence =
      "地方政府以土地出让金作为财政支柱的一种发展模式，这种模式在过去二十年里支撑了城市化的快速推进。";
    const para = sentence.repeat(30);
    const parts = passagesOf(para);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p).not.toContain("。 ");
      expect(p.length).toBeLessThanOrEqual(700 + sentence.length);
    }
  });

  it("ranks Chinese passages for a Chinese question (Latin-only tokens ranked nothing)", () => {
    const ranked = rankPassages(
      [
        {
          text: "2021年全国土地出让收入达到8.7万亿元，占地方一般公共预算收入的78%左右，依赖度很高，地方财政对土地出让收入的依赖仍在继续。",
          weight: 1,
        },
        {
          text: "今天天气很好，我们去公园散步，看到很多人在跑步和打球，非常热闹的一天，晚上还一起去吃了一顿很好吃的晚饭。",
          weight: 1,
        },
      ],
      "土地出让收入 地方一般公共预算",
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.text).toContain("土地出让收入");
  });
});

describe("barred sources", () => {
  const barred = excludedSource({
    urls: ["mdpi.com/2073-445X/11/9/1529", "huggingface.co/datasets/muset-ai"],
    titles: ["The Local Land Finance Transformation with the Synergy of Increment"],
  });

  it("bars URL prefixes at a path boundary, scheme- and www-insensitive", () => {
    expect(barred("https://www.mdpi.com/2073-445X/11/9/1529")).toBe(true);
    expect(barred("https://mdpi.com/2073-445X/11/9/1529/htm")).toBe(true);
    expect(barred("https://www.mdpi.com/2073-445X/11/9/15290")).toBe(false);
    expect(barred("https://huggingface.co/datasets/muset-ai/DeepResearch-Bench-Dataset")).toBe(
      true,
    );
    expect(barred("https://huggingface.co/datasets/other/x")).toBe(false);
  });

  it("bars a page whose title contains a barred title (case and punctuation folded)", () => {
    expect(
      barred(
        "https://www.researchgate.net/publication/1",
        "(PDF) The local land-finance transformation with the synergy of increment and inventory: a case study",
      ),
    ).toBe(true);
    expect(barred("https://example.org/a", "Land finance in China")).toBe(false);
    expect(excludedSource(undefined)("https://x.org")).toBe(false);
  });

  it("the search retriever drops barred hits and pages, and counts them", async () => {
    const hits: SearchResult[] = [
      {
        title: "Barred paper",
        url: "https://www.mdpi.com/2073-445X/11/9/1529",
        snippet: "",
        source: "f",
      },
      { title: "Mirror", url: "https://mirror.example.org/p", snippet: "", source: "f" },
      { title: "Good", url: "https://good.example.org/p", snippet: "", source: "f" },
    ];
    const backend: SearchProvider = { name: "fake", engines: ["web"], search: async () => hits };
    const body = (title: string) =>
      `<html><head><title>${title}</title></head><body><main><p>Land transfer revenue reached 8.7 trillion yuan in 2021, about 78% of local general budget revenue, a record level.</p></main></body></html>`;
    const read: string[] = [];
    const r = await webSearchRetriever({
      backends: [backend],
      background: null,
      fetchPage: async (url) => {
        read.push(url);
        return {
          body: body(
            url.includes("mirror")
              ? "The Local Land Finance Transformation with the Synergy of Increment and Inventory"
              : "Good page",
          ),
          contentType: "text/html",
        };
      },
    })({
      roundId: "t",
      since: "1900-01-01",
      request: "land transfer revenue 2021",
      queries: ["land transfer revenue 2021"],
      exclude: {
        urls: ["mdpi.com/2073-445X/11/9/1529"],
        titles: ["The Local Land Finance Transformation with the Synergy of Increment"],
      },
    });
    expect(read).not.toContain("https://www.mdpi.com/2073-445X/11/9/1529");
    expect(r.sources.map((s) => s.url)).toEqual(["https://good.example.org/p"]);
    expect(r.funnels?.[0]?.excluded).toBe(2);
  });
});

describe("citations", () => {
  it("normalises marker lists and ranges", () => {
    expect(normalizeCitationMarkers("a [3, 7] b [2-4] c 【5】 d [1，2]")).toBe(
      "a [3][7] b [2][3][4] c [5] d [1][2]",
    );
    expect(normalizeCitationMarkers("[1-40]")).toBe("[1-40]");
  });

  it("renumbers by first use, drops unknown numbers, and lists references FACT can parse", () => {
    const sources = [
      { n: 1, url: "https://a.org", title: "A" },
      { n: 2, url: "https://b.org", title: "B" },
      { n: 3, url: "https://c.org" },
    ];
    const { text, sources: used } = renumberCitations("x [3]. y [1][9]. z [3].", sources);
    expect(text).toBe("x [1]. y [2]. z [1].");
    expect(used.map((s) => s.url)).toEqual(["https://c.org", "https://a.org"]);
    expect(referenceList(used)).toBe("## References\n\n[1] https://c.org\n[2] https://a.org - A\n");
  });

  it("splits English and Chinese sentences, keeping trailing markers", () => {
    expect(
      sentencesOf("Revenue rose 12% [1]. It fell later [2].\n收入增长了12%[1]。随后下降[2]。"),
    ).toEqual([
      "Revenue rose 12% [1].",
      "It fell later [2].",
      "收入增长了12%[1]。",
      "随后下降[2]。",
    ]);
  });

  it("audits each cited sentence's figures against the evidence it cites", () => {
    const evidence = [
      { n: 1, quote: "Revenue reached 8.7 trillion yuan in 2021, 78% of local budget revenue." },
      { n: 2, quote: "Growth slowed to 3.5% in 2021." },
    ];
    const audit = auditCitations(
      [
        "## Findings",
        "Revenue reached 8.7 trillion yuan, 78% of local revenue [1].",
        "Growth slowed to 3.5% [1][2].",
        "Growth was 4.1% [2].",
        "Land finance is a fiscal model [1].",
        "About 41.47% depends on land.",
        "See [7].",
      ].join("\n"),
      evidence,
    );
    expect(audit).toMatchObject({
      citedSentences: 5,
      figuresVerified: 2,
      figuresUnverified: 1,
      figureless: 2,
      uncitedFigures: 1,
      danglingMarkers: 1,
      sourcesCited: 2,
    });
    expect(audit.figurePrecision).toBeCloseTo(2 / 3);
    expect(audit.unverifiedSamples[0]?.missing).toEqual(["4.1"]);
    expect(citedNumbers("a [2][2] b [5]")).toEqual([2, 5]);
    expect(figuresMissing("12.5% and 300 units", ["12.5% of 300"])).toEqual([]);
  });
});

/** A fake retriever answering every brief with lines in the `search` retriever's format. */
function fakeRetriever(briefs: ResearchBrief[]): Retriever {
  return async (brief): Promise<ResearchReport> => {
    briefs.push(brief);
    const section = brief.request.split(":")[0]!;
    const url = `https://src.example.org/${encodeURIComponent(section)}/${briefs.length}`;
    const quote = `${section} evidence: the programme covered 21% of the poorest quintile in 2019 according to the survey`;
    return {
      report: `- 2024-05-01 — "${quote}" [Survey ${briefs.length}](${url})`,
      sources: [{ url, title: `Survey ${briefs.length}`, text: `Intro. ${quote}. More text.` }],
      costUsd: 0.01,
      searches: brief.queries?.length ?? 1,
      retriever: "fake",
      funnels: [
        {
          retriever: "fake",
          queries: 1,
          backends: [],
          hits: 1,
          unique: 1,
          kept: 1,
          afterCutoff: 0,
          read: 1,
          readFailed: 0,
          noFetch: 0,
          extractedChars: 100,
          settlement: 0,
          belowRelevance: 0,
          passages: 1,
          passageChars: 100,
          excluded: 0,
        },
      ],
    };
  };
}

function fakeLead(calls: Array<{ system: string; user: string }>): ReportModel {
  return {
    name: "fake/lead",
    complete: async (system, user) => {
      calls.push({ system, user });
      if (system.includes("You plan"))
        return JSON.stringify({
          title: "Coverage report",
          timeframe: "as of September 2023",
          sections: [
            {
              heading: "Coverage",
              goal: "coverage figures",
              queries: ["coverage poorest quintile"],
            },
            { heading: "Causes", goal: "why programmes fail", queries: ["targeting errors"] },
          ],
        });
      if (system.includes("You review the evidence"))
        return JSON.stringify({ missing: ["recent data"], queries: ["coverage 2023 update"] });
      if (system.includes("You write one section")) {
        const n = Number(user.match(/^\[(\d+)\]/m)?.[1] ?? 1);
        return `The programme covered 21% of the poorest quintile in 2019 [${n}]. Coverage of 35% is claimed elsewhere [${n}].`;
      }
      return JSON.stringify({
        title: "Coverage of social protection",
        summary: "Coverage is low [1].",
        conclusion: "Targeting must improve.",
      });
    },
  };
}

describe("research report pipeline", () => {
  it("plans, researches two rounds per section, writes with citations and appends references", async () => {
    const briefs: ResearchBrief[] = [];
    const calls: Array<{ system: string; user: string }> = [];
    const r = await writeResearchReport(
      {
        prompt: "Write a report on social protection coverage in South Asia as of September 2023.",
        exclude: { urls: ["barred.example.org"], titles: ["A barred systematic review title"] },
      },
      { lead: fakeLead(calls), retriever: fakeRetriever(briefs), pageText: async () => undefined },
    );
    expect(r.language).toBe("en");
    expect(r.plan.sections.map((s) => s.heading)).toEqual(["Coverage", "Causes"]);
    // Two sections × (first round + gap round), each brief carrying the barred sources.
    expect(briefs).toHaveLength(4);
    expect(briefs.every((b) => b.exclude?.urls?.includes("barred.example.org"))).toBe(true);
    expect(r.sections.map((s) => s.gapQueries)).toEqual([
      ["coverage 2023 update"],
      ["coverage 2023 update"],
    ]);
    expect(r.markdown).toMatch(/^# Coverage of social protection/);
    expect(r.markdown).toContain("## Executive summary");
    expect(r.markdown).toContain("## Coverage");
    expect(r.markdown).toMatch(/## References\n\n\[1\] https:\/\/src\.example\.org\//);
    // Writers were told the scope and the barred title, and never saw a rubric.
    const writer = calls.find((c) => c.system.includes("You write one section"))!;
    expect(writer.user).toContain("as of September 2023");
    expect(writer.user).toContain("A barred systematic review title");
    // 21% is in the evidence; 35% is not: one verified, one unverified figure sentence per section.
    expect(r.citations.figuresVerified).toBeGreaterThan(0);
    expect(r.citations.figuresUnverified).toBeGreaterThan(0);
    expect(r.searchUsd).toBeCloseTo(0.04);
  });

  it("falls back to one section when the plan is junk, and fails only when no section can be written", async () => {
    const lead: ReportModel = {
      name: "junk",
      complete: async (system) => {
        if (system.includes("You plan")) return "no json here";
        if (system.includes("You write one section")) return "Some text [1].";
        return "{}";
      },
    };
    const r = await writeResearchReport(
      { prompt: "关于中国土地财政转型的研究报告" },
      { lead, retriever: fakeRetriever([]), pageText: async () => undefined, gapRound: false },
    );
    expect(r.language).toBe("zh");
    expect(r.plan.fallback).toBe(true);
    expect(r.warnings.join(" ")).toContain("plan unusable");
    expect(r.markdown).toContain("## 参考文献");

    const broken: ReportModel = {
      name: "broken",
      complete: async (system) => {
        if (system.includes("You write one section")) throw new Error("model down");
        return "{}";
      },
    };
    await expect(
      writeResearchReport(
        { prompt: "x" },
        {
          lead: broken,
          retriever: fakeRetriever([]),
          pageText: async () => undefined,
          gapRound: false,
        },
      ),
    ).rejects.toThrow(/every section failed/);
  });

  it("parses plans defensively", () => {
    expect(
      parsePlan('{"sections": [{"heading": "## A", "queries": ["q1", "q1", "q2"]}]}', 8, 6),
    ).toEqual({
      title: "",
      sections: [{ heading: "A", goal: "", queries: ["q1", "q2"] }],
    });
    expect(parsePlan('{"sections": [{"heading": "A", "queries": []}]}', 8, 6)).toBeUndefined();
    expect(detectLanguage("Write about 土地")).toBe("en");
    expect(detectLanguage("请就中国地方土地财政模式撰写一份 report")).toBe("zh");
  });

  it("keeps exactly the task's sections when the task fixes them", async () => {
    const lead: ReportModel = {
      name: "fixed",
      complete: async (system) => {
        if (system.includes("You plan"))
          return JSON.stringify({
            title: "T",
            fixedStructure: true,
            sections: [
              { heading: "Basic Data Table", goal: "g", queries: ["arrivals data"] },
              { heading: "Trend Analysis", goal: "g", queries: ["trend causes"] },
            ],
          });
        if (system.includes("You write one section")) return "Text [1].";
        return JSON.stringify({ title: "T", summary: "Opening.", conclusion: "Closing." });
      },
    };
    const r = await writeResearchReport(
      { prompt: "Divide the output into two sections: Basic Data Table and Trend Analysis." },
      { lead, retriever: fakeRetriever([]), pageText: async () => undefined, gapRound: false },
    );
    expect(r.plan.fixedStructure).toBe(true);
    expect(r.body.match(/^## .*/gm)).toEqual(["## Basic Data Table", "## Trend Analysis"]);
    expect(r.body).toContain("Opening.");
    expect(r.body).not.toContain("Closing.");
  });
});

describe("cross-model fact pass", () => {
  const evidence = [
    { n: 1, quote: "The programme covered 21% of the poorest quintile in 2019." },
    { n: 2, quote: "Leakage to the non-poor was 40%." },
  ];

  it("applies unique edits, refuses ambiguous, missing and new-figure edits", () => {
    const section =
      "## Coverage\n\nIt covered 35% of the poorest [1]. Leakage was high [1]. Leakage was high [1].";
    const { text, edits } = applyEdits(
      section,
      1,
      [
        {
          find: "It covered 35% of the poorest [1].",
          replace: "It covered 21% of the poorest [1].",
          reason: "figure",
        },
        { find: "Leakage was high [1].", replace: "Leakage was 40% [2].", reason: "cite" },
        { find: "Not in the section at all.", replace: "", reason: "x" },
        {
          find: "It covered 21% of the poorest [1].",
          replace: "It covered 55% of the poorest [1].",
          reason: "bad",
        },
      ],
      evidence,
    );
    expect(edits.map((e) => e.status)).toEqual(["applied", "ambiguous", "not-found", "new-figure"]);
    expect(text).toContain("It covered 21% of the poorest [1].");
  });

  it("checks each cited section with the second model and re-audits the report", async () => {
    const r = await writeResearchReport(
      { prompt: "Report on coverage." },
      {
        lead: fakeLead([]),
        retriever: fakeRetriever([]),
        pageText: async () => undefined,
        gapRound: false,
      },
    );
    const before = r.citations.figuresUnverified;
    const checker: ReportModel = {
      name: "fake/checker",
      complete: async (_system, user) => {
        const m = user.match(/Coverage of 35% is claimed elsewhere \[(\d+)\]\./);
        return JSON.stringify({
          edits: m ? [{ find: m[0], replace: "", reason: "unsupported" }] : [],
        });
      },
    };
    const { report, audit } = await factCheckReport(r, checker);
    expect(audit.checker).toBe("fake/checker");
    expect(audit.applied).toBeGreaterThan(0);
    expect(report.citations.figuresUnverified).toBeLessThan(before);
    expect(report.markdown).not.toContain("35%");
    expect(splitSections("intro\n## A\nx\n## B\ny").join("\n")).toBe("intro\n## A\nx\n## B\ny");
  });
});
