// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { BOARD_EXCLUSIONS, boardExclusion } from "../benchmarks/forecasting/barred";
import { barredRetriever, mergeExclusions } from "../src/arena/research/barred";
import type { ResearchBrief } from "../src/arena/research/briefs";
import type { ResearchReport, Retriever } from "../src/arena/research/retrieve";

const brief = { roundId: "q1", queries: ["q"] } as unknown as ResearchBrief;
const report = (over: Partial<ResearchReport> = {}): ResearchReport => ({
  report: [
    "- Rates held at 3.75% ([fed](https://www.federalreserve.gov/p))",
    "- Resolved YES ([board](https://huggingface.co/datasets/futurex-ai/Futurex-Past/viewer))",
  ].join("\n"),
  sources: [
    { url: "https://www.federalreserve.gov/p" },
    { url: "https://huggingface.co/datasets/futurex-ai/Futurex-Past/viewer" },
  ],
  costUsd: 0,
  searches: 1,
  retriever: "fake",
  ...over,
});

describe("barred sources", () => {
  it("passes the list down and drops barred sources and the lines citing them", async () => {
    let seen: ResearchBrief | undefined;
    const inner: Retriever = async (b) => {
      seen = b;
      return report();
    };
    const r = await barredRetriever(inner, BOARD_EXCLUSIONS.futurex!)(brief);
    expect(seen?.exclude?.urls).toContain("huggingface.co/datasets/futurex-ai/Futurex-Past");
    expect(r.sources.map((s) => s.url)).toEqual(["https://www.federalreserve.gov/p"]);
    expect(r.report).toContain("Rates held");
    expect(r.report).not.toContain("Resolved YES");
    expect(r.warnings?.at(-1)).toContain("1 source(s) and 1 line(s) dropped");
  });

  it("drops a captured evidence snapshot that held a barred source, keeps a clean one", async () => {
    const evidence = (url: string) =>
      ({ sources: [{ url }], report: "" }) as unknown as NonNullable<ResearchReport["evidence"]>;
    const barred = barredRetriever(
      async () => report({ evidence: evidence("https://hf.co/datasets/futurex-ai/Futurex-Past") }),
      BOARD_EXCLUSIONS.futurex!,
    );
    const r = await barred(brief);
    expect(r.evidence).toBeUndefined();
    expect(r.warnings?.at(-1)).toContain("evidence snapshot dropped");
    const clean = barredRetriever(
      async () => report({ evidence: evidence("https://www.federalreserve.gov/p") }),
      BOARD_EXCLUSIONS.futurex!,
    );
    expect((await clean(brief)).evidence).toBeDefined();
  });

  it("returns an untouched report when nothing is barred, and keeps the brief's own list", async () => {
    const clean = report({
      report: "- a ([x](https://example.org/a))",
      sources: [{ url: "https://example.org/a" }],
    });
    const r = await barredRetriever(async () => clean, BOARD_EXCLUSIONS.metaculus!)(brief);
    expect(r).toBe(clean);
    expect(mergeExclusions({ urls: ["a.org"] }, { urls: ["b.org", "a.org"] })).toEqual({
      urls: ["a.org", "b.org"],
    });
  });

  it("finds a board's list by name and its variants", () => {
    expect(boardExclusion("futurex-past-clean")).toBe(BOARD_EXCLUSIONS.futurex);
    expect(boardExclusion("metaculus")).toBe(BOARD_EXCLUSIONS.metaculus);
    expect(boardExclusion("ForecastBench")).toBe(BOARD_EXCLUSIONS.forecastbench);
    expect(boardExclusion("prophet-arena")).toBeUndefined();
  });
});
