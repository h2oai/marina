// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Date-bounded ("as of") search, against fake HTTP (no network): each keyless
 * provider (GDELT, Wayback, Wikipedia revisions, Hacker News, arXiv) queries by
 * date AND re-checks every item, so nothing after the bound is ever returned;
 * the orchestrator answers a bounded search only from date-strict providers;
 * the `asof:` retriever spec is date-strict and refuses to mix in unfiltered
 * engines; `web search before:` / `web fetch asof:` parse; the search room
 * serves, caches and throttles.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  asOfBound,
  asOfRetriever,
  isDateStrict,
  isDateStrictSpec,
  retrieverFromSpec,
} from "../src/arena/research/retrieve";
import { parseWebSearchArgs } from "../src/engine/commands/web";
import { arxivAsOfProvider } from "../src/engine/search-providers/arxiv";
import { resetPoliteGetForTests } from "../src/engine/search-providers/asof-http";
import { gdeltProvider } from "../src/engine/search-providers/gdelt";
import { hnProvider } from "../src/engine/search-providers/hn";
import {
  initProvidersSync,
  parseBound,
  registerProvider,
  type SearchHttp,
  search,
  withinBound,
} from "../src/engine/search-providers/index";
import { waybackCapture, waybackFetch } from "../src/engine/search-providers/wayback";
import {
  wikipediaProvider,
  wikipediaRevision,
  wikitextToPlain,
} from "../src/engine/search-providers/wikipedia";
import type { CommandInput, EntityId, KeyValueStore, RoomContext, RoomId } from "../src/types";
import { searchRoom, searchToolCommands } from "../src/world/rooms/search-room";

type Reply = { status: number; body: string } | { error: string };

function fakeHttp(route: (url: string) => Reply) {
  const calls: string[] = [];
  const http = {
    httpGet: async (url: string) => {
      calls.push(url);
      return route(url);
    },
    httpPost: async (url: string) => {
      calls.push(url);
      return route(url);
    },
  } as unknown as SearchHttp;
  return { http, calls };
}

const ok = (body: unknown): Reply => ({
  status: 200,
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const BOUND = "2026-09-01T12:00:00.000Z";

beforeEach(() => resetPoliteGetForTests(0));
afterAll(() => resetPoliteGetForTests(1));

describe("bounds", () => {
  it("a bare date is the start of that UTC day; ISO keeps its instant", () => {
    expect(parseBound("2026-09-30")).toBe("2026-09-30T00:00:00.000Z");
    expect(parseBound("2026-09-30T13:45:00Z")).toBe("2026-09-30T13:45:00.000Z");
    expect(parseBound("not a date")).toBeUndefined();
  });

  it("withinBound needs a parseable date at or before the bound", () => {
    expect(withinBound("2026-09-01T12:00:00Z", BOUND)).toBe(true);
    expect(withinBound("2026-09-01T12:00:01Z", BOUND)).toBe(false);
    expect(withinBound(undefined, BOUND)).toBe(false);
    expect(withinBound("garbage", BOUND)).toBe(false);
    expect(withinBound("2026-08-01T00:00:00Z", BOUND, "2026-08-15T00:00:00Z")).toBe(false);
  });

  it("asOfBound: exact cutoff, else the start of the until day, never after now", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    expect(asOfBound({ untilAt: BOUND, until: "2026-09-01" }, now)).toBe(BOUND);
    expect(asOfBound({ until: "2026-09-01" }, now)).toBe("2026-09-01T00:00:00.000Z");
    expect(asOfBound({ untilAt: "2027-01-01T00:00:00Z" }, now)).toBe(now.toISOString());
    expect(asOfBound({}, now)).toBe(now.toISOString());
  });
});

describe("gdelt", () => {
  it("sends exact start/end datetimes and drops articles first seen after the bound", async () => {
    const { http, calls } = fakeHttp(() =>
      ok({
        articles: [
          {
            url: "https://news.example/a",
            title: "A",
            seendate: "20260901T110000Z",
            domain: "news.example",
          },
          { url: "https://news.example/late", title: "Late", seendate: "20260901T130000Z" },
          { url: "https://news.example/nodate", title: "No date" },
          { url: "ftp://bad", title: "bad", seendate: "20260901T100000Z" },
        ],
      }),
    );
    const out = await gdeltProvider({ minIntervalMs: 0 }).search(
      "election polls!",
      { before: BOUND, after: "2026-08-01T00:00:00Z", maxResults: 10 },
      http,
    );
    expect(calls[0]).toContain("enddatetime=20260901120000");
    expect(calls[0]).toContain("startdatetime=20260801000000");
    expect(out.map((r) => r.url)).toEqual(["https://news.example/a"]);
    expect(out[0]?.published).toBe("2026-09-01T11:00:00.000Z");
  });

  it("returns [] on a plain-text GDELT error or HTTP failure", async () => {
    const text = fakeHttp(() => ok("Your search contained a phrase that is too short."));
    expect(
      await gdeltProvider({ minIntervalMs: 0 }).search("x y", { before: BOUND }, text.http),
    ).toEqual([]);
    const down = fakeHttp(() => ({ error: "down" }));
    expect(
      await gdeltProvider({ minIntervalMs: 0 }).search("x y", { before: BOUND }, down.http),
    ).toEqual([]);
  });
});

describe("wayback", () => {
  it("asks CDX for the latest capture to the bound and reads the id_ replay", async () => {
    const { http, calls } = fakeHttp((url) => {
      if (url.includes("/cdx/")) {
        return ok([
          ["timestamp", "original", "statuscode"],
          ["20260825093000", "https://site.example/page", "200"],
        ]);
      }
      if (url.includes("id_/"))
        return ok("<html><title>Page</title><body><p>As it was.</p></body></html>");
      return { error: "unexpected" };
    });
    const page = await waybackFetch(http, "https://site.example/page", BOUND);
    expect(calls[0]).toContain("to=20260901120000");
    expect(calls[0]).toContain("limit=-1");
    expect(page?.at).toBe("2026-08-25T09:30:00.000Z");
    expect(page?.replayUrl).toBe(
      "https://web.archive.org/web/20260825093000id_/https://site.example/page",
    );
    expect(page?.text).toContain("As it was.");
  });

  it("refuses a capture after the bound even if the API returns one", async () => {
    const { http } = fakeHttp(() =>
      ok([
        ["timestamp", "original", "statuscode"],
        ["20260902000000", "https://site.example/", "200"],
      ]),
    );
    expect(await waybackCapture(http, "https://site.example/", BOUND)).toBeUndefined();
    const empty = fakeHttp(() => ok([]));
    expect(await waybackCapture(empty.http, "https://site.example/", BOUND)).toBeUndefined();
  });
});

describe("wikipedia", () => {
  const route = (url: string): Reply => {
    if (url.includes("list=search")) {
      return ok({
        query: {
          search: [{ title: "Old Article" }, { title: "New Article" }, { title: "Edited Later" }],
        },
      });
    }
    if (url.includes("Old%20Article")) {
      return ok({
        query: {
          pages: [
            {
              title: "Old Article",
              revisions: [
                {
                  revid: 101,
                  timestamp: "2026-08-20T00:00:00Z",
                  slots: {
                    main: { content: "'''Old''' is [[a|an]] article.{{cite}}<ref>x</ref>" },
                  },
                },
              ],
            },
          ],
        },
      });
    }
    if (url.includes("New%20Article")) return ok({ query: { pages: [{ title: "New Article" }] } });
    if (url.includes("Edited%20Later")) {
      // A misbehaving reply: a revision after the bound must be refused.
      return ok({
        query: {
          pages: [
            { title: "Edited Later", revisions: [{ revid: 9, timestamp: "2026-09-05T00:00:00Z" }] },
          ],
        },
      });
    }
    return { error: "unexpected" };
  };

  it("returns each article's revision at the bound and drops articles that did not exist yet", async () => {
    const { http, calls } = fakeHttp(route);
    const out = await wikipediaProvider().search("article", { before: BOUND, maxResults: 5 }, http);
    expect(out.map((r) => r.title)).toEqual(["Old Article"]);
    expect(out[0]?.url).toBe("https://en.wikipedia.org/w/index.php?oldid=101");
    expect(out[0]?.text).toBe("Old is an article.");
    expect(
      calls.some((u) => u.includes("rvdir=older") && u.includes("rvstart=2026-09-01T12")),
    ).toBe(true);
  });

  it("wikipediaRevision and the wikitext cleaner", async () => {
    const { http } = fakeHttp(route);
    expect((await wikipediaRevision(http, "Old Article", BOUND))?.revid).toBe(101);
    expect(await wikipediaRevision(http, "New Article", BOUND)).toBeUndefined();
    expect(
      wikitextToPlain("== Head ==\n[[File:x.png]]{{a|{{b}}}}text [https://e.example link]"),
    ).toBe("Head\ntext link");
  });
});

describe("hacker news", () => {
  it("bounds created_at_i server-side and re-checks each hit", async () => {
    const end = Math.floor(Date.parse(BOUND) / 1000);
    const { http, calls } = fakeHttp(() =>
      ok({
        hits: [
          { objectID: "1", title: "Before", url: "https://x.example/1", created_at_i: end - 60 },
          { objectID: "2", title: "After", url: "https://x.example/2", created_at_i: end + 60 },
          { objectID: "3", title: "Self post", story_text: "<p>hello</p>", created_at_i: end - 10 },
        ],
      }),
    );
    const out = await hnProvider().search("rust release", { before: BOUND }, http);
    expect(decodeURIComponent(calls[0] ?? "")).toContain(`created_at_i<=${end}`);
    expect(out.map((r) => r.title)).toEqual(["Before", "Self post"]);
    expect(out[1]?.url).toBe("https://news.ycombinator.com/item?id=3");
  });
});

describe("arxiv", () => {
  it("queries submittedDate and drops entries published or updated after the bound", async () => {
    const entry = (id: string, published: string, updated: string) =>
      `<entry><id>http://arxiv.org/abs/${id}</id><published>${published}</published><updated>${updated}</updated><title>T${id}</title><summary>S${id}</summary></entry>`;
    const { http, calls } = fakeHttp(() =>
      ok(
        `<feed>${entry("1", "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z")}${entry("2", "2026-09-02T00:00:00Z", "2026-09-02T00:00:00Z")}${entry("3", "2026-08-01T00:00:00Z", "2026-09-10T00:00:00Z")}</feed>`,
      ),
    );
    const out = await arxivAsOfProvider().search("graph neural networks", { before: BOUND }, http);
    expect(decodeURIComponent(calls[0] ?? "")).toContain("submittedDate:[");
    expect(decodeURIComponent(calls[0] ?? "")).toContain("TO 202609011200]");
    expect(out.map((r) => r.url)).toEqual(["https://arxiv.org/abs/1"]);
  });
});

describe("orchestrator", () => {
  it("a bounded search uses only date-strict providers and drops undated results", async () => {
    initProvidersSync();
    let looseCalled = false;
    registerProvider({
      name: "test-loose",
      engines: ["test-asof-engine"],
      search: async () => {
        looseCalled = true;
        return [{ title: "loose", url: "https://loose/", snippet: "", source: "loose" }];
      },
    });
    registerProvider({
      name: "test-strict",
      engines: ["test-asof-engine"],
      dateBound: "strict",
      boundOnly: true,
      search: async () => [
        {
          title: "ok",
          url: "https://ok/",
          snippet: "",
          source: "s",
          published: "2026-08-30T00:00:00Z",
        },
        {
          title: "late",
          url: "https://late/",
          snippet: "",
          source: "s",
          published: "2026-09-03T00:00:00Z",
        },
        { title: "undated", url: "https://undated/", snippet: "", source: "s" },
      ],
    });
    const { http } = fakeHttp(() => ({ error: "unused" }));
    const bounded = await search("q", { engines: ["test-asof-engine"], before: BOUND }, http);
    expect(bounded.map((r) => r.title)).toEqual(["ok"]);
    expect(looseCalled).toBe(false);
    // Unbounded: boundOnly providers stay out of the default routing.
    const open = await search("q", { engines: ["test-asof-engine"] }, http);
    expect(open.map((r) => r.title)).toEqual(["loose"]);
  });
});

describe("asof retriever", () => {
  it("is date-strict, bounded to the brief's cutoff, and cites the as-of capture", async () => {
    const { http } = fakeHttp((url) => {
      if (url.includes("gdeltproject")) {
        return ok({
          articles: [
            { url: "https://news.example/a", title: "Polls tighten", seendate: "20260901T080000Z" },
            {
              url: "https://news.example/after",
              title: "After cutoff",
              seendate: "20260901T200000Z",
            },
          ],
        });
      }
      if (url.includes("/cdx/")) {
        return ok([
          ["timestamp", "original", "statuscode"],
          ["20260901090000", "https://news.example/a", "200"],
        ]);
      }
      if (url.includes("id_/")) return ok("<p>The margin narrowed to two points.</p>");
      return { error: "unexpected" };
    });
    const r = asOfRetriever({ providers: ["gdelt", "wayback"], http });
    expect(isDateStrict(r)).toBe(true);
    const report = await r({
      roundId: "t",
      since: "2026-08-15",
      until: "2026-09-01",
      untilAt: BOUND,
      queries: ["senate polls"],
      request: "x",
    });
    expect(report.retriever).toBe("asof:gdelt+wayback");
    expect(report.costUsd).toBe(0);
    expect(report.sources.map((s) => s.url)).toEqual([
      "https://web.archive.org/web/20260901090000id_/https://news.example/a",
    ]);
    expect(report.sources[0]?.text).toContain("two points");
    expect(report.report).toContain("2026-09-01 — The margin narrowed to two points.");
    expect(report.report).not.toContain("After cutoff");
  });

  it("spec parsing: asof entries are date-strict; requireDateStrict refuses unfiltered engines", () => {
    expect(isDateStrictSpec("asof:gdelt,wikipedia,hn")).toBe(true);
    expect(isDateStrictSpec("asof")).toBe(true);
    expect(isDateStrictSpec("asof:gdelt,openrouter-web:openai/gpt-6-luna")).toBe(false);
    expect(isDateStrict(retrieverFromSpec("asof:gdelt,wikipedia,wayback", {}))).toBe(true);
    expect(isDateStrict(retrieverFromSpec("asof:gdelt,asof:hn", {}))).toBe(true);
    expect(() =>
      retrieverFromSpec(
        "asof,openrouter-web:openai/gpt-6-luna",
        { openrouter: "k" },
        { requireDateStrict: true },
      ),
    ).toThrow(/date-strict retriever was required/);
    expect(
      isDateStrict(retrieverFromSpec("asof,openrouter-web:openai/gpt-6-luna", { openrouter: "k" })),
    ).toBe(false);
    expect(() => retrieverFromSpec("asof:bing", {})).toThrow(/unknown asof provider/);
  });
});

describe("web command arguments", () => {
  it("parses before:/asof: and splits provider names out of engines:", () => {
    initProvidersSync();
    const a = parseWebSearchArgs(["before:2026-09-30", "engines:gdelt,news", "election", "polls"]);
    expect(a).toEqual({
      query: "election polls",
      engines: ["news"],
      providers: ["gdelt"],
      maxResults: 10,
      before: "2026-09-30T00:00:00.000Z",
    });
    expect(parseWebSearchArgs(["asof:soon", "x"])).toEqual({
      error: "before:soon is not a date (YYYY-MM-DD or ISO)",
    });
  });
});

describe("search room", () => {
  function roomCtx() {
    const data = new Map<string, unknown>();
    const store: KeyValueStore = {
      get: <T>(k: string) => data.get(k) as T | undefined,
      set: <T>(k: string, v: T) => void data.set(k, v),
      delete: (k: string) => data.delete(k),
      keys: () => [...data.keys()],
    };
    const sent: string[] = [];
    const ctx = {
      store,
      send: (_t: EntityId, m: string) => void sent.push(m),
    } as unknown as RoomContext;
    return { ctx, sent, data };
  }
  const input = (args: string, entity = "e_1"): CommandInput => ({
    raw: args,
    verb: "x",
    args,
    tokens: args.split(/\s+/),
    entity: entity as EntityId,
    room: "workbench/search" as RoomId,
  });

  it("searches before a date, caches the reply, and throttles each entity", async () => {
    let t = 1_000_000;
    const { http, calls } = fakeHttp(() =>
      ok({
        articles: [
          { url: "https://news.example/a", title: "Headline", seendate: "20260820T000000Z" },
        ],
      }),
    );
    const room = searchRoom({ http, now: () => t });
    const { ctx, sent } = roomCtx();
    await room.commands!.search!(ctx, input("engine:gdelt before:2026-09-01 senate race"));
    expect(sent.at(-1)).toContain("Headline");
    expect(sent.at(-1)).toContain("before 2026-09-01T00:00:00.000Z");
    const fetches = calls.length;
    await room.commands!.search!(ctx, input("engine:gdelt before:2026-09-01 senate race"));
    expect(sent.at(-1)).toContain("One query every few seconds");
    t += 10_000;
    await room.commands!.search!(ctx, input("engine:gdelt before:2026-09-01 senate race"));
    expect(sent.at(-1)).toContain("(cached)");
    expect(calls.length).toBe(fetches);
  });

  it("mounts on an existing room under other verbs", () => {
    const tool = searchToolCommands({ verbs: { search: "find", fetch: "archive" } });
    expect(Object.keys(tool.commands).sort()).toEqual([
      "archive",
      "find",
      "markets",
      "odds",
      "series",
      "sources",
      "wiki",
    ]);
    expect(tool.catalog).toContain("`find <q> [before:<date>]");
  });

  it("wiki asof:, fetch asof:, sources and usage errors", async () => {
    let t = 5_000_000;
    const { http } = fakeHttp((url) => {
      if (url.includes("prop=revisions")) {
        return ok({
          query: {
            pages: [
              {
                title: "Thing",
                revisions: [
                  {
                    revid: 7,
                    timestamp: "2026-08-01T00:00:00Z",
                    slots: { main: { content: "A thing." } },
                  },
                ],
              },
            ],
          },
        });
      }
      if (url.includes("/cdx/")) return ok([]);
      return { error: "unexpected" };
    });
    const room = searchRoom({ http, now: () => t });
    const { ctx, sent } = roomCtx();
    await room.commands!.wiki!(ctx, input("Thing asof:2026-09-01"));
    expect(sent.at(-1)).toContain("revision 7");
    t += 10_000;
    await room.commands!.fetch!(ctx, input("https://site.example/ asof:2026-09-01"));
    expect(sent.at(-1)).toContain("No archived capture");
    await room.commands!.fetch!(ctx, input("https://site.example/"));
    expect(sent.at(-1)).toContain("Usage: fetch");
    await room.commands!.sources!(ctx, input(""));
    expect(sent.at(-1)).toContain("gdelt [date-strict");
    expect(sent.at(-1)).toContain("duckduckgo [no date bound");
  });
});
