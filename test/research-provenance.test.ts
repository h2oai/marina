// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserReader, needsRender } from "../src/research/browser-reader";
import {
  auditCitedUrls,
  citedUrls,
  citeOriginals,
  needsRepair,
  readUrlFor,
  repairRequest,
  trimUrl,
  unwrapProxyUrl,
} from "../src/research/cited-answer";
import {
  deniedByPattern,
  metaSummary,
  pageLinks,
  readPage,
  visibleText,
} from "../src/research/page-reader";
import { canonicalUrl, isPdf, ProvenanceCache } from "../src/research/provenance-cache";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "prov-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("canonicalUrl", () => {
  test("drops fragment, tracking parameters and one trailing slash", () => {
    expect(canonicalUrl("https://Example.com/a/b/?utm_source=x&id=3#top")).toBe(
      "https://example.com/a/b?id=3",
    );
    expect(canonicalUrl("https://example.com/path/")).toBe("https://example.com/path");
    expect(canonicalUrl("https://example.com/")).toBe("https://example.com/");
    expect(canonicalUrl("https://example.com/p?utm_medium=a")).toBe("https://example.com/p");
    expect(canonicalUrl("not a url")).toBe("not a url");
  });
});

describe("ProvenanceCache", () => {
  test("records reads, keeps text and PDF bytes, and survives a reopen", () => {
    const dir = tempDir();
    const cache = new ProvenanceCache(dir);
    const html = new TextEncoder().encode("<html>hi</html>");
    cache.record({
      url: "https://a.org/x#f",
      status: 200,
      contentType: "text/html",
      body: html,
      text: "hello world",
    });
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    cache.record({
      url: "https://a.org/doc",
      status: 200,
      contentType: "application/octet-stream",
      body: pdf,
      text: "pdf text",
    });
    const reopened = new ProvenanceCache(dir);
    expect(reopened.readOk("https://a.org/x")).toBe(true);
    expect(reopened.text("https://a.org/x/")).toBe("hello world");
    const rec = reopened.get("https://a.org/x")!;
    expect(rec.sha256).toHaveLength(64);
    expect(rec.kind).toBe("web");
    expect(reopened.get("https://a.org/doc")!.kind).toBe("pdf");
    expect([...reopened.pdf("https://a.org/doc")!]).toEqual([...pdf]);
  });

  test("a failed re-read never replaces a good read; failures are recorded", () => {
    const cache = new ProvenanceCache(tempDir());
    cache.record({ url: "https://a.org/x", status: 200, text: "good" });
    cache.record({ url: "https://a.org/x", status: 503, error: "HTTP 503" });
    expect(cache.readOk("https://a.org/x")).toBe(true);
    expect(cache.text("https://a.org/x")).toBe("good");
    expect(cache.get("https://a.org/x")!.reads).toBe(2);
    cache.record({ url: "https://a.org/blocked", status: 0, error: "refused" });
    expect(cache.readOk("https://a.org/blocked")).toBe(false);
    expect(cache.get("https://a.org/blocked")!.error).toBe("refused");
  });

  test("isPdf by content type or magic bytes", () => {
    expect(isPdf("application/pdf")).toBe(true);
    expect(isPdf(undefined, new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe(true);
    expect(isPdf("text/html", new Uint8Array([0x3c, 0x68]))).toBe(false);
  });
});

describe("citedUrls", () => {
  test("finds markdown links, angle links and bare URLs without trailing punctuation", () => {
    const md = [
      "See [the page](https://a.org/x_(y)) and https://b.org/p.",
      "Also <https://c.org/q?x=1> and (https://d.org/r).",
      "Ref [1]: https://e.org/s, then **https://f.org/t**",
      "Dup [again](https://a.org/x_(y))",
    ].join("\n");
    expect(citedUrls(md)).toEqual([
      "https://a.org/x_(y)",
      "https://c.org/q?x=1",
      "https://b.org/p",
      "https://d.org/r",
      "https://e.org/s",
      "https://f.org/t",
    ]);
  });

  test("trimUrl keeps balanced parentheses", () => {
    expect(trimUrl("https://en.wikipedia.org/wiki/Foo_(bar))")).toBe(
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    );
    expect(trimUrl("https://x.org/a.")).toBe("https://x.org/a");
  });
});

describe("auditCitedUrls", () => {
  test("separates read, failed and never-opened citations", () => {
    const cache = new ProvenanceCache(tempDir());
    cache.record({ url: "https://ok.org/a", status: 200, text: "x" });
    cache.record({ url: "https://bad.org/b", status: 403, error: "HTTP 403" });
    const md = [
      "- Fact one is stated on this page https://ok.org/a and it is long enough to count.",
      "- Fact two comes from https://bad.org/b which refused, still a long enough line here.",
      "- Fact three cites https://never.org/c that the run never opened at all, padding.",
      "- An uncited substantive line that has no source at all and is longer than sixty chars.",
    ].join("\n");
    const a = auditCitedUrls(md, cache);
    expect(a.read).toEqual(["https://ok.org/a"]);
    expect(a.failed).toEqual(["https://bad.org/b"]);
    expect(a.unread).toEqual(["https://never.org/c"]);
    expect(a.uncitedLines).toBe(1);
    expect(needsRepair(a)).toBe(true);
    expect(repairRequest(a)).toContain("never opened");
    const clean = auditCitedUrls("Fact https://ok.org/a", cache);
    expect(needsRepair(clean)).toBe(false);
    expect(repairRequest(clean)).toBe("");
  });
});

describe("page reader", () => {
  test("deny patterns match host/path prefixes, ignoring www and case", () => {
    const deny = [
      "huggingface.co/datasets/osunlp/mind2web-2",
      "github.com/OSU-NLP-Group/Mind2Web-2",
    ];
    expect(
      deniedByPattern("https://www.github.com/osu-nlp-group/mind2web-2/blob/main/x.py", deny),
    ).toBe(true);
    expect(
      deniedByPattern("https://huggingface.co/datasets/osunlp/Mind2Web-2/resolve/main/a.csv", deny),
    ).toBe(true);
    expect(deniedByPattern("https://github.com/osu-nlp-group/other", deny)).toBe(false);
    expect(deniedByPattern("https://github.com/x", [])).toBe(false);
  });

  test("meta summary and links", () => {
    const html = `<html><head><meta name="description" content="A &amp; B"><meta property="og:title" content='T'></head>
      <body><a href="/rel?q=1#x">Rel <b>link</b></a><a href="mailto:a@b">m</a><a href="https://o.org/">Out</a><a href="/rel?q=1">dup</a></body></html>`;
    expect(metaSummary(html)).toEqual(["A & B", "T"]);
    expect(pageLinks(html, "https://site.org/dir/page")).toEqual([
      { text: "Rel link", url: "https://site.org/rel?q=1" },
      { text: "Out", url: "https://o.org/" },
    ]);
  });

  test("readPage files good, failed and refused reads in the cache", async () => {
    const cache = new ProvenanceCache(tempDir());
    const fetcher = async (url: string) => {
      if (url.includes("err")) throw new Error("boom");
      if (url.includes("404")) return new Response("nope", { status: 404 });
      if (url.endsWith(".pdf"))
        return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), {
          headers: { "content-type": "application/pdf" },
        });
      return new Response(
        `<html><head><title>T</title><meta name="description" content="Desc"></head><body><main><p>${"Readable paragraph text. ".repeat(10)}</p><a href="/next">Next page</a></main></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    };
    const page = await readPage("https://site.org/a", { cache, fetcher });
    expect(page.ok).toBe(true);
    expect(page.title).toBe("T");
    expect(page.text).toContain("[meta] Desc");
    expect(page.text).toContain("Readable paragraph text.");
    expect(page.links).toEqual([{ text: "Next page", url: "https://site.org/next" }]);
    expect(cache.readOk("https://site.org/a")).toBe(true);

    const pdf = await readPage("https://site.org/f.pdf", {
      cache,
      fetcher,
      pdfText: async () => "PDF BODY",
    });
    expect(pdf.kind).toBe("pdf");
    expect(pdf.text).toBe("PDF BODY");
    expect(cache.pdf("https://site.org/f.pdf")).toBeDefined();

    const missing = await readPage("https://site.org/404", { cache, fetcher });
    expect(missing.ok).toBe(false);
    expect(cache.get("https://site.org/404")!.status).toBe(404);

    const err = await readPage("https://site.org/err", { cache, fetcher });
    expect(err.ok).toBe(false);
    expect(err.error).toContain("boom");

    let called = false;
    const refused = await readPage("https://github.com/osu-nlp-group/mind2web-2", {
      cache,
      deny: ["github.com/osu-nlp-group/mind2web-2"],
      fetcher: async () => {
        called = true;
        return new Response("x");
      },
    });
    expect(refused.refused).toBe(true);
    expect(called).toBe(false);
    expect(cache.get("https://github.com/osu-nlp-group/mind2web-2")!.error).toContain("deny list");

    const terms = await readPage("https://today.yougov.com/topics", { cache, fetcher });
    expect(terms.refused).toBe(true);
  });
});

describe("visible text and rendered reads", () => {
  test("visibleText keeps bylines, link text and table cells; drops scripts and head", () => {
    const html = `<html><head><title>T</title><style>.x{}</style></head><body>
      <header><a href="/u/ann">ann</a> authored on <span>Dec 7</span></header>
      <script>var hidden = 1;</script>
      <table><tr><th>Item</th><th>Price</th></tr><tr><td>Monitor</td><td>$399</td></tr></table>
      <p>Body &amp; text</p></body></html>`;
    const t = visibleText(html);
    expect(t).toContain("ann authored on Dec 7");
    expect(t).toContain("Monitor | $399");
    expect(t).toContain("Body & text");
    expect(t).not.toContain("hidden");
    expect(t).not.toContain(".x{}");
  });

  test("a 2xx page with no readable text is a failed read", async () => {
    const cache = new ProvenanceCache(tempDir());
    const r = await readPage("https://wall.org/x", {
      cache,
      fetcher: async () =>
        new Response("<html><body><script>challenge()</script></body></html>", { status: 202 }),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no readable text");
    expect(cache.readOk("https://wall.org/x")).toBe(false);
  });

  test("needsRender: failures other than not-found, thin pages and bot walls", () => {
    expect(needsRender({ ok: false, status: 403, text: "", kind: "web" })).toBe(true);
    expect(needsRender({ ok: false, status: 404, text: "", kind: "web" })).toBe(false);
    expect(needsRender({ ok: true, status: 200, text: "short", kind: "web" })).toBe(true);
    expect(
      needsRender({
        ok: true,
        status: 200,
        text: `Just a moment... ${"x".repeat(900)}`,
        kind: "web",
      }),
    ).toBe(true);
    expect(needsRender({ ok: true, status: 200, text: "y".repeat(900), kind: "web" })).toBe(false);
    expect(needsRender({ ok: false, status: 0, text: "", kind: "pdf" })).toBe(false);
  });

  test("a rendered read replaces a failed plain read and keeps its screenshot", async () => {
    const cache = new ProvenanceCache(tempDir());
    const shot = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const browser: BrowserReader = {
      render: async (url) => ({
        ok: true,
        status: 200,
        finalUrl: url,
        title: "R",
        html: `<html><head><meta name="description" content="D"></head><body><a href="/n">n</a></body></html>`,
        text: "Rendered listing text",
        screenshot: shot,
      }),
      close: async () => undefined,
    };
    const r = await readPage("https://spa.org/p", {
      cache,
      browser,
      fetcher: async () => new Response("denied", { status: 403 }),
    });
    expect(r.ok).toBe(true);
    expect(r.text).toBe("[meta] D\nRendered listing text");
    expect(r.links).toEqual([{ text: "n", url: "https://spa.org/n" }]);
    const rec = cache.get("https://spa.org/p")!;
    expect(rec.via).toBe("browser");
    expect([...cache.screenshot("https://spa.org/p")!]).toEqual([...shot]);
  });
});

describe("reader proxies", () => {
  test("citations name the page, and a proxy read counts as reading it", () => {
    expect(unwrapProxyUrl("https://r.jina.ai/https://www.imdb.com/title/tt1")).toBe(
      "https://www.imdb.com/title/tt1",
    );
    expect(unwrapProxyUrl("https://r.jina.ai/about")).toBe("https://r.jina.ai/about");
    expect(
      citeOriginals("Rated 8.6 [IMDb](https://r.jina.ai/https://www.imdb.com/title/tt1)."),
    ).toBe("Rated 8.6 [IMDb](https://www.imdb.com/title/tt1).");
    const cache = new ProvenanceCache(tempDir());
    cache.record({
      url: "https://r.jina.ai/https://www.imdb.com/title/tt1",
      status: 200,
      text: "8.6",
    });
    expect(readUrlFor(cache, "https://www.imdb.com/title/tt1")).toBe(
      "https://r.jina.ai/https://www.imdb.com/title/tt1",
    );
    expect(auditCitedUrls("x https://www.imdb.com/title/tt1", cache).read).toHaveLength(1);
  });
});
