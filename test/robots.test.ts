// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * robots.txt on page reads (src/net/robots.ts) and the keyless-source switches,
 * with stubbed fetchers only (no network): group selection, longest-match
 * precedence with `*` and `$`, the per-origin cache, 4xx / 5xx / timeout
 * behaviour, the operator overrides, a blocked page read through `readPage`
 * and `web fetch`, and `MARINA_SEARCH_DUCKDUCKGO` / `MARINA_FORECAST_YAHOO`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { webCommand } from "../src/engine/commands/web";
import { DUCKDUCKGO_DISABLED, duckDuckGoProvider } from "../src/engine/search-providers/duckduckgo";
import { registerProvider, search } from "../src/engine/search-providers/index";
import { describeSearchReadiness } from "../src/engine/search-readiness";
import { seriesHistory, YAHOO_DISABLED } from "../src/forecast/series-history";
import {
  __setRobotsFetcherForTest,
  clearRobotsCache,
  parseRobots,
  ROBOTS_BLOCKED,
  ROBOTS_RETRY_TTL_MS,
  ROBOTS_TTL_MS,
  type RobotsFetcher,
  robotsAllowsPath,
  robotsCheck,
} from "../src/net/robots";
import { readPage } from "../src/research/page-reader";
import { searchBackendsFromEnv } from "../src/research/web-search";
import type { EntityId, RoomContext } from "../src/types";
import { stripAnsi } from "./helpers";
import { scopeProcessState } from "./process-state";

const RESPECT = { MARINA_ROBOTS_TXT: "respect" } as NodeJS.ProcessEnv;

/** A fetcher answering robots.txt per origin and counting calls. */
function robotsServer(answers: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = [];
  const fetcher: RobotsFetcher = async (url) => {
    calls.push(url);
    const answer = answers[url];
    if (!answer) throw new Error(`unexpected fetch ${url}`);
    return answer();
  };
  return { fetcher, calls };
}

const text =
  (body: string, status = 200) =>
  () =>
    new Response(body, { status });

beforeEach(() => clearRobotsCache());
afterEach(() => {
  clearRobotsCache();
  __setRobotsFetcherForTest(null);
});

describe("robots.txt parsing and matching", () => {
  const FILE = `
# comment
User-agent: *
Disallow: /private
Allow: /private/open
Disallow: /*.pdf$

User-agent: Googlebot
User-agent: MarinaResearch/1.1   # versioned token still matches
Disallow: /search
Allow: /search/about

Sitemap: https://x.test/sitemap.xml
User-agent: marinaresearch
Disallow: /drafts/
`;

  it("groups consecutive user-agent lines and merges groups naming the same agent", () => {
    const groups = parseRobots(FILE);
    expect(groups.map((g) => g.agents)).toEqual([
      ["*"],
      ["googlebot", "marinaresearch"],
      ["marinaresearch"],
    ]);
  });

  it("uses the MarinaResearch group(s) over `*`, case-insensitively", () => {
    const groups = parseRobots(FILE);
    expect(robotsAllowsPath(groups, "MarinaResearch", "/search?q=x")).toBe(false);
    expect(robotsAllowsPath(groups, "MarinaResearch", "/search/about")).toBe(true);
    expect(robotsAllowsPath(groups, "MarinaResearch", "/drafts/a")).toBe(false);
    // The `*` group does not apply once our own group exists.
    expect(robotsAllowsPath(groups, "MarinaResearch", "/private")).toBe(true);
    // Another agent falls back to `*`.
    expect(robotsAllowsPath(groups, "OtherBot", "/private/x")).toBe(false);
    expect(robotsAllowsPath(groups, "OtherBot", "/private/open/x")).toBe(true);
  });

  it("longest match wins, Allow on a tie; `*` and `$` patterns", () => {
    const g = parseRobots(`User-agent: *
Disallow: /a
Allow: /a/b
Disallow: /a/b/c
Allow: /tie
Disallow: /tie
Disallow: /*.pdf$
Disallow: /x*y`);
    expect(robotsAllowsPath(g, "MarinaResearch", "/a/z")).toBe(false);
    expect(robotsAllowsPath(g, "MarinaResearch", "/a/b/z")).toBe(true);
    expect(robotsAllowsPath(g, "MarinaResearch", "/a/b/c/d")).toBe(false);
    expect(robotsAllowsPath(g, "MarinaResearch", "/tie")).toBe(true);
    expect(robotsAllowsPath(g, "MarinaResearch", "/docs/file.pdf")).toBe(false);
    expect(robotsAllowsPath(g, "MarinaResearch", "/docs/file.pdf?v=1")).toBe(true);
    expect(robotsAllowsPath(g, "MarinaResearch", "/x-and-y")).toBe(false);
    expect(robotsAllowsPath(g, "MarinaResearch", "/robots.txt")).toBe(true);
  });

  it("an empty Disallow, no matching group or no groups allows everything", () => {
    expect(robotsAllowsPath(parseRobots("User-agent: *\nDisallow:"), "MarinaResearch", "/a")).toBe(
      true,
    );
    expect(
      robotsAllowsPath(parseRobots("User-agent: bot\nDisallow: /"), "MarinaResearch", "/"),
    ).toBe(true);
    expect(robotsAllowsPath(parseRobots(""), "MarinaResearch", "/")).toBe(true);
    // Rules before any user-agent line belong to no group.
    expect(robotsAllowsPath(parseRobots("Disallow: /"), "MarinaResearch", "/")).toBe(true);
  });
});

describe("robotsCheck: fetch, cache and failure behaviour", () => {
  it("blocks a disallowed page with a clear reason; caches per origin for 24 h", async () => {
    let now = 1_000_000;
    const { fetcher, calls } = robotsServer({
      "https://site.test/robots.txt": text("User-agent: *\nDisallow: /secret"),
    });
    const opts = { fetcher, env: RESPECT, now: () => now };
    const blocked = await robotsCheck("https://site.test/secret/page?id=1", opts);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.reason.startsWith(ROBOTS_BLOCKED)).toBe(true);
      expect(blocked.reason).toContain("/secret/page?id=1");
    }
    expect((await robotsCheck("https://site.test/public", opts)).allowed).toBe(true);
    expect(calls).toHaveLength(1);
    now += ROBOTS_TTL_MS + 1;
    await robotsCheck("https://site.test/public", opts);
    expect(calls).toHaveLength(2);
  });

  it("concurrent checks of one origin share one fetch", async () => {
    const { fetcher, calls } = robotsServer({
      "https://busy.test/robots.txt": text("User-agent: *\nDisallow:"),
    });
    await Promise.all(
      [1, 2, 3].map((i) => robotsCheck(`https://busy.test/p${i}`, { fetcher, env: RESPECT })),
    );
    expect(calls).toHaveLength(1);
  });

  it("4xx means no rules (allowed, cached 24 h)", async () => {
    for (const status of [401, 403, 404]) {
      clearRobotsCache();
      const { fetcher } = robotsServer({ "https://four.test/robots.txt": text("nope", status) });
      expect(await robotsCheck("https://four.test/a", { fetcher, env: RESPECT })).toEqual({
        allowed: true,
        via: "no-rules",
      });
    }
  });

  it("5xx, 429, network errors and timeouts fail open and retry after the short period", async () => {
    let now = 0;
    let status = 503;
    const { fetcher, calls } = robotsServer({
      "https://down.test/robots.txt": () =>
        status === 0
          ? Promise.reject(new DOMException("timed out", "TimeoutError"))
          : new Response("err", { status }),
    });
    const opts = { fetcher, env: RESPECT, now: () => now };
    expect(await robotsCheck("https://down.test/a", opts)).toEqual({
      allowed: true,
      via: "unreachable",
    });
    // Within the retry period: cached, no new fetch.
    now += ROBOTS_RETRY_TTL_MS - 1;
    await robotsCheck("https://down.test/a", opts);
    expect(calls).toHaveLength(1);
    for (const next of [429, 0]) {
      status = next;
      now += ROBOTS_RETRY_TTL_MS + 1;
      expect((await robotsCheck("https://down.test/a", opts)).allowed).toBe(true);
    }
    expect(calls).toHaveLength(3);
    // Once the site answers, its rules apply.
    status = 200;
    const ok = robotsServer({ "https://down.test/robots.txt": text("User-agent: *\nDisallow: /") });
    now += ROBOTS_RETRY_TTL_MS + 1;
    expect(
      (await robotsCheck("https://down.test/a", { ...opts, fetcher: ok.fetcher })).allowed,
    ).toBe(false);
  });

  it("operator overrides: MARINA_ROBOTS_TXT=ignore and owned origins skip the check", async () => {
    const { fetcher, calls } = robotsServer({
      "https://mine.test/robots.txt": text("User-agent: *\nDisallow: /"),
      "https://other.test/robots.txt": text("User-agent: *\nDisallow: /"),
    });
    expect(
      await robotsCheck("https://other.test/a", {
        fetcher,
        env: { MARINA_ROBOTS_TXT: "ignore" } as NodeJS.ProcessEnv,
      }),
    ).toEqual({ allowed: true, via: "ignored" });
    const owned = {
      MARINA_ROBOTS_TXT: "respect",
      MARINA_ROBOTS_TXT_IGNORE_ORIGINS: "https://mine.test, docs.example",
    } as NodeJS.ProcessEnv;
    expect((await robotsCheck("https://mine.test/a", { fetcher, env: owned })).allowed).toBe(true);
    expect((await robotsCheck("https://docs.example/a", { fetcher, env: owned })).allowed).toBe(
      true,
    );
    expect(calls).toEqual([]);
    // http://mine.test is another origin: checked (the stub has no answer → fail open).
    expect((await robotsCheck("http://mine.test/a", { fetcher, env: owned })).allowed).toBe(true);
    expect(calls).toEqual(["http://mine.test/robots.txt"]);
    expect((await robotsCheck("https://other.test/a", { fetcher, env: owned })).allowed).toBe(
      false,
    );
  });

  it("non-http URLs are left to the caller's own checks", async () => {
    expect(await robotsCheck("file:///etc/passwd", { env: RESPECT })).toEqual({
      allowed: true,
      via: "not-http",
    });
    expect(await robotsCheck("not a url", { env: RESPECT })).toEqual({
      allowed: true,
      via: "not-http",
    });
  });
});

describe("page reads blocked by robots.txt", () => {
  it("readPage returns a refusal and never requests the page", async () => {
    using _state = scopeProcessState({ env: { MARINA_ROBOTS_TXT: "respect" } });
    const asked: string[] = [];
    const page = await readPage("https://blocked.test/article", {
      fetcher: async (url) => {
        asked.push(url);
        if (url.endsWith("/robots.txt"))
          return new Response("User-agent: MarinaResearch\nDisallow: /article");
        return new Response("<html><body>secret</body></html>");
      },
    });
    expect(page.ok).toBe(false);
    expect(page.refused).toBe(true);
    expect(page.error?.startsWith(ROBOTS_BLOCKED)).toBe(true);
    expect(asked).toEqual(["https://blocked.test/robots.txt"]);
  });

  it("web fetch answers 'Not read: blocked by robots.txt' without fetching the page", async () => {
    using _state = scopeProcessState({ env: { MARINA_ROBOTS_TXT: "respect" } });
    __setRobotsFetcherForTest(async () => new Response("User-agent: *\nDisallow: /"));
    const urls: string[] = [];
    const runtime = {
      httpGet: async (url: string) => {
        urls.push(url);
        return { status: 200, body: "<html><body>page</body></html>" };
      },
    } as never;
    const web = webCommand({
      getEntity: () => ({ name: "r" }) as never,
      connectorRuntime: runtime,
    });
    const out: string[] = [];
    const ctx = {
      send: (_id: unknown, t: string) => out.push(stripAnsi(t)),
    } as never as RoomContext;
    await web.handler(ctx, {
      verb: "",
      args: "fetch https://nobots.test/a",
      tokens: ["fetch", "https://nobots.test/a"],
      entity: "e_1" as EntityId,
      room: "test/start" as never,
      raw: "fetch https://nobots.test/a",
    });
    expect(out.join("\n")).toContain(`Not read: ${ROBOTS_BLOCKED}`);
    expect(urls).toEqual([]);
  });

  it("an allowed page is read with the identifying research user agent", async () => {
    using _state = scopeProcessState({ env: { MARINA_ROBOTS_TXT: "respect" } });
    __setRobotsFetcherForTest(async () => new Response("", { status: 404 }));
    const seen: Array<{ url: string; ua?: string }> = [];
    const runtime = {
      httpGet: async (url: string, _e?: string, o?: { headers?: Record<string, string> }) => {
        seen.push({ url, ua: o?.headers?.["User-Agent"] });
        return { status: 200, body: "<html><body>hello page</body></html>" };
      },
    } as never;
    const web = webCommand({
      getEntity: () => ({ name: "r" }) as never,
      connectorRuntime: runtime,
    });
    const out: string[] = [];
    const ctx = {
      send: (_id: unknown, t: string) => out.push(stripAnsi(t)),
    } as never as RoomContext;
    await web.handler(ctx, {
      verb: "",
      args: "fetch https://open.test/a",
      tokens: ["fetch", "https://open.test/a"],
      entity: "e_1" as EntityId,
      room: "test/start" as never,
      raw: "fetch https://open.test/a",
    });
    expect(out.join("\n")).toContain("hello page");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.ua).toContain("MarinaResearch");
  });
});

describe("keyless source switches", () => {
  it("MARINA_SEARCH_DUCKDUCKGO=off leaves DuckDuckGo out of the research chain, labelled", () => {
    const off = { MARINA_SEARCH_DUCKDUCKGO: "off" } as NodeJS.ProcessEnv;
    expect(searchBackendsFromEnv({}).backends.map((b) => b.name)).toEqual(["duckduckgo"]);
    const r = searchBackendsFromEnv(off);
    expect(r.backends).toEqual([]);
    expect(r.skipped).toEqual([`duckduckgo (${DUCKDUCKGO_DISABLED})`]);
    expect(
      searchBackendsFromEnv({ ...off, TAVILY_API_KEY: "t" }).backends.map((b) => b.name),
    ).toEqual(["tavily"]);
  });

  it("a disabled DuckDuckGo is never called; search falls through and says why", async () => {
    using _state = scopeProcessState({ env: { MARINA_SEARCH_DUCKDUCKGO: "off" } });
    registerProvider(duckDuckGoProvider());
    const urls: string[] = [];
    const runtime = {
      httpGet: async (url: string) => {
        urls.push(url);
        return { error: "no network in tests" };
      },
      httpPost: async () => ({ error: "no network in tests" }),
    } as never;
    const failures: string[] = [];
    const results = await search("anything at all", { engines: ["news"], failures }, runtime);
    expect(results).toEqual([]);
    expect(urls.some((u) => u.includes("duckduckgo"))).toBe(false);
    expect(failures).toContain(`duckduckgo: ${DUCKDUCKGO_DISABLED}`);
  });

  it("readiness reports the switches and a chain with no web backend", () => {
    const r = describeSearchReadiness(
      { MARINA_SEARCH_DUCKDUCKGO: "off", MARINA_FORECAST_YAHOO: "off" } as NodeJS.ProcessEnv,
      [],
    );
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("web search chain: none");
    expect(r.detail).toContain("yahoo finance series: off");
    expect(r.remediation).toContain("MARINA_SEARCH_DUCKDUCKGO");
    const on = describeSearchReadiness({} as NodeJS.ProcessEnv, []);
    expect(on.detail).toContain("duckduckgo");
    expect(on.detail).toContain("robots.txt");
  });

  it("MARINA_FORECAST_YAHOO=off: a yahoo series has no history and makes no request", async () => {
    const urls: string[] = [];
    const http = {
      json: async (url: string) => {
        urls.push(url);
        return { ok: false as const, error: "unexpected" };
      },
      text: async (url: string) => {
        urls.push(url);
        return { ok: false as const, error: "unexpected" };
      },
    };
    const h = await seriesHistory({ source: "yahoo", id: "SPY" }, new Date("2026-09-01"), {
      http: http as never,
      env: { MARINA_FORECAST_YAHOO: "off" } as NodeJS.ProcessEnv,
    });
    expect(h).toEqual({ error: YAHOO_DISABLED });
    expect(urls).toEqual([]);
  });
});
