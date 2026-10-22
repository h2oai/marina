// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Research authority mode (`src/research/authority.ts`): target parsing and
 * validation, domain-restricted query building, `[authoritative]` tagging in
 * the citation check, the gap review naming a publisher, and the cutoff rule
 * (a named page is fetched directly only for a live cutoff). Fake backends,
 * pages and models only — no network.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { ResearchBrief } from "../src/arena/research/briefs";
import { resetSearchHealthForTests } from "../src/engine/search-providers/health";
import type {
  SearchOpts,
  SearchProvider,
  SearchResult,
} from "../src/engine/search-providers/index";
import { resetSpendLedgerForTests } from "../src/engine/spend-ledger";
import {
  authorityClue,
  authorityEnabled,
  authorityQueries,
  markAuthoritative,
  matchesAuthority,
  mergeAuthority,
  normalizeDomain,
  parseAuthority,
  seedAuthority,
  siteQuery,
} from "../src/research/authority";
import { claimTextKey } from "../src/research/evidence-index";
import { evidenceLoopRetriever } from "../src/research/evidence-loop";
import { readSwarmRetriever, swarmDossierLines } from "../src/research/read-swarm-retriever";
import type { ResearchReport, Retriever } from "../src/research/retrieve";
import { researchFeatures } from "../src/research/settings";
import { AUTHORITATIVE_TAG, stripAuthorityTag, verifyDossier } from "../src/research/verify";
import { webSearchRetriever } from "../src/research/web-search";

afterEach(() => {
  resetSearchHealthForTests();
  resetSpendLedgerForTests();
});

describe("authority targets", () => {
  it("normalizes publisher domains and refuses non-public hosts", () => {
    expect(normalizeDomain("https://www.Stats.Example.gov/data/table?x=1")).toBe(
      "stats.example.gov",
    );
    expect(normalizeDomain("site:example.org/path")).toBe("example.org");
    expect(normalizeDomain("WWW.example.org.")).toBe("example.org");
    for (const bad of [
      "localhost",
      "127.0.0.1",
      "http://10.0.0.1/x",
      "http://user:pw@example.org/",
      "http://example.org:8080/",
      "example",
      "",
      42,
    ])
      expect(normalizeDomain(bad)).toBeUndefined();
  });

  it("parses untrusted review JSON into a validated target", () => {
    expect(
      parseAuthority(
        {
          domain: "example.gov",
          url: "https://data.example.gov/series/cpi#latest",
          field: "  Index\n level,  all items ",
        },
        "review",
      ),
    ).toEqual({
      domain: "example.gov",
      url: "https://data.example.gov/series/cpi",
      field: "Index level, all items",
      origin: "review",
    });
    // The domain comes from the URL when missing.
    expect(parseAuthority({ url: "https://league.example.org/table" }, "review")?.domain).toBe(
      "league.example.org",
    );
    // A URL off the named domain is dropped; the domain stands.
    expect(
      parseAuthority({ domain: "example.gov", url: "https://evil.example.net/x" }, "review"),
    ).toEqual({ domain: "example.gov", origin: "review" });
    expect(parseAuthority({ url: "ftp://example.org/x" }, "review")).toBeUndefined();
    expect(parseAuthority(["example.org"], "review")).toBeUndefined();
    expect(parseAuthority("example.org", "review")).toBeUndefined();
    expect(parseAuthority({ field: "rate" }, "review")).toBeUndefined();
    expect(
      parseAuthority({ domain: "a.org", field: "x".repeat(500) }, "review")?.field,
    ).toHaveLength(200);
  });

  it("seeds from the brief and its settlement pages, merges by domain, and caps", () => {
    const seeded = seedAuthority({
      authority: [{ domain: "one.example.org", field: "rate" }, { domain: "not a host" }],
      readFirst: [
        "https://one.example.org/page",
        "https://two.example.org/p",
        "https://three.org/",
      ],
    });
    expect(seeded).toEqual([
      {
        domain: "one.example.org",
        field: "rate",
        url: "https://one.example.org/page",
        origin: "brief",
      },
      { domain: "two.example.org", url: "https://two.example.org/p", origin: "settlement" },
    ]);
    const merged = mergeAuthority(seeded, [
      { domain: "two.example.org", field: "level", origin: "review" },
    ]);
    expect(merged[1]).toMatchObject({ field: "level", url: "https://two.example.org/p" });
  });

  it("matches subdomains only and flags sources", () => {
    const t = [{ domain: "example.gov", origin: "review" as const }];
    expect(matchesAuthority("https://data.example.gov/x", t)).toBe(true);
    expect(matchesAuthority("https://example.gov/x", t)).toBe(true);
    expect(matchesAuthority("https://notexample.gov/x", t)).toBe(false);
    expect(matchesAuthority("https://example.gov.evil.net/x", t)).toBe(false);
    expect(
      markAuthoritative<{ url: string; authoritative?: boolean }>(
        [{ url: "https://example.gov/a" }, { url: "https://other.org/b" }],
        t,
      ),
    ).toEqual([
      { url: "https://example.gov/a", authoritative: true },
      { url: "https://other.org/b" },
    ]);
  });

  it("builds domain-restricted queries and reader clues", () => {
    expect(siteQuery("example.gov", "cpi site:other.org latest")).toBe(
      "site:example.gov cpi latest",
    );
    expect(
      authorityQueries(
        [
          { domain: "a.org", field: "headline rate", origin: "review" },
          { domain: "b.org", origin: "settlement" },
          { domain: "c.org", origin: "review" },
        ],
        ["first query", "second"],
      ),
    ).toEqual([
      { domain: "a.org", query: "headline rate" },
      { domain: "b.org", query: "first query" },
    ]);
    expect(
      authorityQueries([{ domain: "a.org", origin: "review" }], [], "Request line\nmore"),
    ).toEqual([{ domain: "a.org", query: "Request line" }]);
    expect(authorityClue({ domain: "b.org", origin: "review" })).toBeUndefined();
    expect(authorityClue({ domain: "a.org", field: "rate", origin: "review" })).toContain(
      "as-of or reference date",
    );
  });

  it("is off unless MARINA_RESEARCH_AUTHORITY=on, implies capture, and keeps fingerprints when off", () => {
    expect(authorityEnabled({})).toBe(false);
    expect(authorityEnabled({ MARINA_RESEARCH_AUTHORITY: "yes" })).toBe(false);
    expect(authorityEnabled({ MARINA_RESEARCH_AUTHORITY: " ON " })).toBe(true);
    const off = researchFeatures({});
    expect("authority" in off).toBe(false);
    expect(off.capture).toBe(false);
    const on = researchFeatures({ MARINA_RESEARCH_AUTHORITY: "on" });
    expect(on.authority).toBe(true);
    expect(on.capture).toBe(true);
  });
});

describe("authoritative tagging in the citation check", () => {
  const page = "The headline rate was 4.2% in September, the agency said.";
  const other = "A newspaper said the rate was 4.2% last month.";
  const report = [
    "- 2026-10-01 — Rate 4.2% [Agency](https://stats.example.gov/rate)",
    "- 2026-10-01 — Rate 4.2% [Paper](https://news.example.com/a)",
    "- 2026-10-01 — Rate 4.2% [Agency](https://stats.example.gov/rate) [Paper](https://news.example.com/a)",
    "- 2026-10-01 — Rate 9.9% [Agency](https://stats.example.gov/rate)",
  ].join("\n");

  it("tags lines citing only authoritative sources, after the status", async () => {
    const sources = [
      { url: "https://stats.example.gov/rate", text: page, authoritative: true },
      { url: "https://news.example.com/a", text: other },
    ];
    const checked = await verifyDossier(report, async () => undefined, sources);
    const annotated = checked.annotated.split("\n");
    expect(annotated[0]).toBe(`[verified] ${AUTHORITATIVE_TAG} ${report.split("\n")[0]}`);
    expect(annotated[1]).toStartWith("[verified] - ");
    expect(annotated[2]).toStartWith("[verified] - ");
    expect(annotated[3]).toStartWith(
      `[unverified: 9.9 not on the cited page] ${AUTHORITATIVE_TAG}`,
    );
    const verified = checked.verifiedText.split("\n");
    expect(verified).toHaveLength(3);
    expect(verified[0]).toStartWith(`${AUTHORITATIVE_TAG} - `);
    expect(verified[1]).toStartWith("- ");
    expect(checked.lines.map((l) => !!l.authoritative)).toEqual([true, false, false, true]);
    // Line text is stored without the tag; stats are unchanged by tagging.
    expect(checked.lines[0]!.text).toBe(report.split("\n")[0]!);
    expect(checked.stats).toMatchObject({ verified: 3, unverified: 1 });

    // Idempotent on its own output; without the flag the tag is removed, not trusted.
    const again = await verifyDossier(checked.verifiedText, async () => undefined, sources);
    expect(again.verifiedText).toBe(checked.verifiedText);
    const unflagged = await verifyDossier(checked.verifiedText, async () => undefined, [
      { url: "https://stats.example.gov/rate", text: page },
      { url: "https://news.example.com/a", text: other },
    ]);
    expect(unflagged.verifiedText).not.toContain(AUTHORITATIVE_TAG);
  });

  it("leaves a dossier byte-identical when no source is authoritative", async () => {
    const sources = [
      { url: "https://stats.example.gov/rate", text: page },
      { url: "https://news.example.com/a", text: other },
    ];
    const checked = await verifyDossier(report, async () => undefined, sources);
    expect(checked.annotated).not.toContain(AUTHORITATIVE_TAG);
    expect(checked.lines.some((l) => "authoritative" in l)).toBe(false);
  });

  it("tags figureless quoted lines and keeps claim identity", async () => {
    const quote = "The agency publishes the index on the second Tuesday of each month";
    const line = `- 2026-10-01 — "${quote}" [Agency](https://stats.example.gov/cal)`;
    const checked = await verifyDossier(line, async () => undefined, [
      { url: "https://stats.example.gov/cal", text: `${quote}.`, authoritative: true },
    ]);
    expect(checked.verifiedText).toBe(`${AUTHORITATIVE_TAG} ${line}`);
    expect(stripAuthorityTag(checked.verifiedText)).toBe(line);
    expect(claimTextKey(checked.verifiedText)).toBe(claimTextKey(line));
  });
});

describe("evidence loop: the review names the authority", () => {
  const now = () => new Date("2026-10-07T12:00:00Z");
  const brief: ResearchBrief = {
    roundId: "r",
    since: "2026-10-01",
    untilAt: now().toISOString(),
    request: "What will the official rate be?",
    queries: ["rate news"],
  };
  const reportFor = (b: ResearchBrief): ResearchReport =>
    b.authority?.length
      ? {
          report: "- Official rate 4.2% [Agency](https://stats.example.gov/rate)",
          sources: [
            {
              url: "https://stats.example.gov/rate",
              text: "Rate: 4.2% (as of September 2026)",
              published: "2026-10-05",
            },
          ],
          searches: 1,
          costUsd: 0,
          retriever: "fixture",
        }
      : {
          report: "- Paper says 4.1% [Paper](https://news.example.com/a)",
          sources: [
            { url: "https://news.example.com/a", text: "It was 4.1%.", published: "2026-10-04" },
          ],
          searches: 1,
          costUsd: 0,
          retriever: "fixture",
        };

  it("passes the named publisher on, reads its page first when live, and tags its lines", async () => {
    const seen: ResearchBrief[] = [];
    const prompts: string[] = [];
    const inner: Retriever = async (b) => {
      seen.push(b);
      return reportFor(b);
    };
    const out = await evidenceLoopRetriever(inner, {
      now,
      pageText: async () => undefined,
      maxRounds: 2,
      authority: true,
      review: async (system, user) => {
        prompts.push(system, user);
        return JSON.stringify({
          queries: ["official rate release"],
          reason: "need the publisher's own figure",
          authority: {
            domain: "stats.example.gov",
            url: "https://stats.example.gov/rate",
            field: "headline rate",
          },
        });
      },
    })(brief);
    expect(prompts[0]).toContain('"authority"');
    expect(seen[0]!.authority).toBeUndefined();
    expect(seen[1]!.authority).toEqual([
      {
        domain: "stats.example.gov",
        url: "https://stats.example.gov/rate",
        field: "headline rate",
        origin: "review",
      },
    ]);
    expect(seen[1]!.readFirst).toEqual(["https://stats.example.gov/rate"]);
    expect(out.researchLoop?.rounds[0]?.authority?.domain).toBe("stats.example.gov");
    expect(out.researchLoop?.authority).toHaveLength(1);
    expect(out.sources.find((s) => s.url === "https://stats.example.gov/rate")?.authoritative).toBe(
      true,
    );
    expect(out.sources.find((s) => s.url === "https://news.example.com/a")?.authoritative).toBe(
      undefined,
    );
    const lines = out.report.split("\n");
    expect(lines).toContain(
      `${AUTHORITATIVE_TAG} - Official rate 4.2% [Agency](https://stats.example.gov/rate)`,
    );
    expect(lines).toContain("- Paper says 4.1% [Paper](https://news.example.com/a)");
    // Downstream forecasters re-run the check on the report and its sources: same tags.
    const downstream = await verifyDossier(out.report, async () => undefined, out.sources);
    expect(downstream.verifiedText).toBe(out.report);
  });

  it("continues one round for a newly named publisher even with no further query", async () => {
    const seen: ResearchBrief[] = [];
    await evidenceLoopRetriever(
      async (b) => {
        seen.push(b);
        return reportFor(b);
      },
      {
        now,
        pageText: async () => undefined,
        maxRounds: 2,
        authority: true,
        review: async () =>
          JSON.stringify({
            queries: [],
            reason: "covered, except the publisher",
            authority: { domain: "stats.example.gov", field: "headline rate" },
          }),
      },
    )(brief);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.queries).toEqual(["headline rate"]);
    // No page URL named: nothing is added to readFirst.
    expect(seen[1]!.readFirst).toBeUndefined();
  });

  it("ignores an invalid authority without failing the loop", async () => {
    const out = await evidenceLoopRetriever(async (b) => reportFor(b), {
      now,
      pageText: async () => undefined,
      maxRounds: 2,
      authority: true,
      review: async () =>
        JSON.stringify({
          queries: [],
          reason: "covered",
          authority: { domain: "127.0.0.1", url: "http://169.254.169.254/latest" },
        }),
    })(brief);
    expect(out.researchLoop?.stop).toBe("complete");
    expect(out.researchLoop?.rounds[0]?.authorityRejected).toBe(true);
    expect(out.researchLoop?.authority).toBeUndefined();
  });

  it("off: the review prompt, inner brief and report are unchanged", async () => {
    const seen: ResearchBrief[] = [];
    const prompts: string[] = [];
    const out = await evidenceLoopRetriever(
      async (b) => {
        seen.push(b);
        return reportFor(b);
      },
      {
        now,
        pageText: async () => undefined,
        maxRounds: 2,
        review: async (system) => {
          prompts.push(system);
          return JSON.stringify({
            queries: ["more"],
            reason: "r",
            authority: { domain: "stats.example.gov" },
          });
        },
      },
    )({ ...brief, readFirst: ["https://stats.example.gov/rate"] });
    expect(prompts[0]).not.toContain("authority");
    expect(seen.every((b) => b.authority === undefined)).toBe(true);
    expect(out.report).not.toContain(AUTHORITATIVE_TAG);
    expect(out.researchLoop?.authority).toBeUndefined();
    expect(out.researchLoop?.rounds[0]).not.toHaveProperty("authority");
  });

  it("backtest: a date-strict retriever gets targets but never a direct authority fetch", async () => {
    const past: ResearchBrief = {
      ...brief,
      untilAt: "2026-06-01T00:00:00Z",
      readFirst: ["https://settle.example.org/result"],
    };
    const seen: ResearchBrief[] = [];
    const inner = Object.assign(
      async (b: ResearchBrief): Promise<ResearchReport> => {
        seen.push(b);
        return {
          report: "- Settled 7.5% [Settle](https://settle.example.org/archive)",
          sources: [
            { url: "https://settle.example.org/archive", text: "7.5%", published: "2026-05-30" },
          ],
          searches: 1,
          costUsd: 0,
          retriever: "asof",
        };
      },
      { dateStrict: true as const },
    );
    const out = await evidenceLoopRetriever(inner, {
      now,
      pageText: async () => undefined,
      maxRounds: 2,
      authority: true,
      review: async () =>
        JSON.stringify({
          queries: ["more"],
          reason: "need the agency",
          authority: { domain: "stats.example.gov", url: "https://stats.example.gov/rate" },
        }),
    })(past);
    // Seeded from the settlement page; the review's page is never added to readFirst.
    expect(seen[0]!.authority?.[0]).toMatchObject({ domain: "settle.example.org" });
    expect(seen[1]!.readFirst).toEqual(["https://settle.example.org/result"]);
    expect(seen[1]!.authority?.map((t) => t.domain)).toEqual([
      "settle.example.org",
      "stats.example.gov",
    ]);
    expect(out.report).toContain(AUTHORITATIVE_TAG);
  });

  it("a live-only retriever is still refused for a historical cutoff", async () => {
    await expect(
      evidenceLoopRetriever(async (b) => reportFor(b), {
        now,
        pageText: async () => undefined,
        authority: true,
      })({ ...brief, untilAt: "2026-06-01T00:00:00Z" }),
    ).rejects.toThrow(/date-strict/);
  });
});

describe("search retriever: authority queries", () => {
  const NOW = new Date("2026-10-04T12:00:00Z");
  const pageHtml = (body: string) => `<html><body><article><p>${body}</p></article></body></html>`;
  const pages: Record<string, string> = {
    "https://stats.example.gov/rate": pageHtml(
      "The official headline rate for September 2026 was 4.2 percent according to the statistics agency release.",
    ),
    "https://stats.example.gov/later": pageHtml(
      "The official headline rate for October 2026 was 4.4 percent according to the statistics agency release.",
    ),
    "https://news.example.com/a": pageHtml(
      "A newspaper report says the headline rate could rise to 4.3 percent according to economists polled.",
    ),
  };
  const fetchPage = async (url: string) =>
    pages[url] ? { body: pages[url]!, contentType: "text/html" } : undefined;

  function backend(
    name: string,
    domainFilter: boolean,
    answer: (q: string, o: SearchOpts) => SearchResult[],
  ): SearchProvider & { calls: Array<{ q: string; o: SearchOpts }> } {
    const calls: Array<{ q: string; o: SearchOpts }> = [];
    return {
      name,
      engines: ["web", "news"],
      ...(domainFilter ? { domainFilter: true } : {}),
      calls,
      async search(q, o) {
        calls.push({ q, o });
        return answer(q, o);
      },
    };
  }
  const hit = (url: string, published?: string): SearchResult => ({
    title: `Title ${url}`,
    url,
    snippet: "",
    source: "fake",
    ...(published ? { published } : {}),
  });
  const brief = (over: Partial<ResearchBrief> = {}): ResearchBrief => ({
    roundId: "t",
    since: "2026-09-01",
    untilAt: NOW.toISOString(),
    request: "What is the official headline rate?",
    queries: ["headline rate"],
    authority: [{ domain: "stats.example.gov", field: "headline rate", origin: "review" }],
    ...over,
  });

  it("uses a native domain filter where the backend has one", async () => {
    const b = backend("tavily", true, (_q, o) =>
      o.domains ? [hit("https://stats.example.gov/rate")] : [hit("https://news.example.com/a")],
    );
    const r = await webSearchRetriever({
      backends: [b],
      background: null,
      fetchPage,
      now: () => NOW,
    })(brief());
    expect(b.calls).toHaveLength(2);
    const restricted = b.calls.find((c) => c.o.domains);
    expect(restricted).toMatchObject({ q: "headline rate", o: { domains: ["stats.example.gov"] } });
    expect(b.calls.some((c) => c.q.includes("site:"))).toBe(false);
    expect(r.funnels?.[0]?.authorityQueries).toBe(1);
    expect(r.sources.map((s) => s.url)).toContain("https://stats.example.gov/rate");
  });

  it("writes a site: operator for a backend without one, under the same cutoff", async () => {
    const past = new Date("2026-10-01T00:00:00Z").toISOString();
    const b = backend("duckduckgo", false, (q) =>
      q.startsWith("site:stats.example.gov")
        ? [
            hit("https://stats.example.gov/later", "2026-10-03"),
            hit("https://stats.example.gov/rate", "2026-09-20"),
          ]
        : [],
    );
    const r = await webSearchRetriever({
      backends: [b],
      background: null,
      fetchPage,
      now: () => NOW,
    })(brief({ untilAt: past }));
    const restricted = b.calls.find((c) => c.q.startsWith("site:"));
    expect(restricted?.q).toBe("site:stats.example.gov headline rate");
    expect(restricted?.o.domains).toBeUndefined();
    // A past cutoff bounds the restricted query like any other, and later pages are dropped.
    expect(restricted?.o.before).toBe(past);
    expect(r.sources.map((s) => s.url)).toEqual(["https://stats.example.gov/rate"]);
    expect(r.funnels?.[0]?.afterCutoff).toBe(1);
  });

  it("no authority: no extra query and no funnel field", async () => {
    const b = backend("duckduckgo", false, () => [hit("https://news.example.com/a")]);
    const r = await webSearchRetriever({
      backends: [b],
      background: null,
      fetchPage,
      now: () => NOW,
    })(brief({ authority: undefined }));
    expect(b.calls).toHaveLength(1);
    expect(r.funnels?.[0]).not.toHaveProperty("authorityQueries");
  });
});

describe("read swarm: authority field", () => {
  const authorityPage =
    "Headline rate: 4.2 percent. Reference period: September 2026. Released 2026-10-05 by the agency.";
  const paperPage =
    "Economists expect the headline rate to rise next month, a newspaper reported today.";
  const inner: Retriever = async () => ({
    report: "",
    sources: [
      { url: "https://news.example.com/a", title: "Paper", text: paperPage },
      { url: "https://stats.example.gov/rate", title: "Agency", text: authorityPage },
    ],
    costUsd: 0,
    searches: 1,
    retriever: "inner",
  });

  it("asks for the exact field with its as-of date, reads the publisher first, and leads with it", async () => {
    const prompts: string[] = [];
    const r = readSwarmRetriever(inner, {
      reader: {
        complete: async (_system, user) => {
          prompts.push(user);
          if (user.includes("Document [https://stats.example.gov/rate]"))
            return JSON.stringify({
              relevant: true,
              evidence: [
                { clue: 2, quote: "Headline rate: 4.2 percent. Reference period: September 2026." },
              ],
            });
          return JSON.stringify({
            relevant: true,
            evidence: [
              { clue: 1, quote: "Economists expect the headline rate to rise next month" },
            ],
          });
        },
      },
      pageText: async () => undefined,
      concurrency: 1,
    });
    const out = await r({
      roundId: "t",
      since: "2026-09-01",
      request: "What is the headline rate?",
      queries: ["headline rate"],
      authority: [{ domain: "stats.example.gov", field: "headline rate", origin: "review" }],
    });
    expect(prompts[0]).toContain("Document [https://stats.example.gov/rate]");
    expect(prompts[0]).toContain(
      '2. The exact value of "headline rate" as published by stats.example.gov',
    );
    const lines = out.report.split("\n").filter((l) => l.startsWith("- "));
    expect(lines[0]).toContain("https://stats.example.gov/rate");
    expect(out.readSwarm?.[0]?.authorityClues).toBe(1);
  });

  it("orders authority readings first in the dossier lines", () => {
    const readings = [
      {
        id: "https://news.example.com/a",
        quotes: [{ text: "x".repeat(40), verified: true }],
        clues: [1, 2],
      },
      {
        id: "https://stats.example.gov/rate",
        quotes: [{ text: "y".repeat(40), verified: true }],
        clues: [],
      },
    ] as unknown as Parameters<typeof swarmDossierLines>[0];
    const titles = new Map<string, string | undefined>();
    expect(swarmDossierLines(readings, titles)[0]).toContain("news.example.com");
    expect(
      swarmDossierLines(readings, titles, (u) => u.includes("stats.example.gov"))[0],
    ).toContain("stats.example.gov");
  });
});
