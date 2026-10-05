// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reads one web page for a research agent: SSRF-guarded fetch (`guardedFetch`
 * re-validates every redirect hop), a byte cap, HTML → readable text plus the
 * page's meta description and its links (a browsing agent needs somewhere to
 * go next), PDFs through `pdftotext` when the host has it. Every read — good or
 * failed — is filed in the provenance cache when one is given.
 *
 * Policy refusals happen before any request: `NO_FETCH_DOMAINS` (publishers
 * whose terms bar automated access) and the caller's deny list (`deny`), e.g.
 * an evaluation's own answer key.
 */

import { spawn } from "node:child_process";
import { fetchAllowed, VERIFY_USER_AGENT } from "../arena/research/verify";
import { getErrorMessage } from "../engine/errors";
import { decodeEntities, extractReadableText } from "../engine/html-text";
import { guardedFetch } from "../net/url-guard";
import { type BrowserReader, needsRender } from "./browser-reader";
import { isPdf, type PageCapture, type ProvenanceCache } from "./provenance-cache";

export interface PageLink {
  text: string;
  url: string;
}

export interface PageRead {
  url: string;
  ok: boolean;
  status: number;
  contentType?: string;
  title?: string;
  /** Extracted text ("" on failure). */
  text: string;
  links: PageLink[];
  kind: "web" | "pdf";
  error?: string;
  /** True when the reader refused the URL by policy (no request was made). */
  refused?: boolean;
}

export interface ReadPageOptions {
  cache?: ProvenanceCache;
  /** `host/path-prefix` patterns never fetched (matched without `www.`, case-insensitive). */
  deny?: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  /** Injected for tests. */
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  /** PDF bytes → text (default: `pdftotext` when installed, else undefined). */
  pdfText?: (bytes: Uint8Array) => Promise<string | undefined>;
  /** Opt-in rendered reads for pages a plain fetch cannot read (`browser-reader.ts`). */
  browser?: BrowserReader;
}

export const READ_TIMEOUT_MS = 20_000;
export const READ_MAX_BYTES = 8 * 1024 * 1024;
const MAX_LINKS = 120;

/** True when `url` matches a deny pattern (`host/path-prefix`, `www.` ignored). */
export function deniedByPattern(url: string, deny: readonly string[] = []): boolean {
  if (deny.length === 0) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const hostPath = `${u.hostname.replace(/^www\./i, "")}${u.pathname}`.toLowerCase();
  return deny.some((p) => {
    const pat = p
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "");
    return pat.length > 0 && hostPath.startsWith(pat);
  });
}

/** Up to `maxBytes` of a body as bytes; the rest is cancelled, not read. */
export async function readBytesCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  try {
    while (read < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.byteLength > maxBytes - read ? value.subarray(0, maxBytes - read) : value;
      chunks.push(chunk);
      read += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(read);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** The `<meta name="description">` / `og:description` / `og:title` contents, deduplicated. */
export function metaSummary(html: string): string[] {
  const out: string[] = [];
  const re = /<meta\s[^>]*>/gi;
  for (const tag of html.match(re) ?? []) {
    const name = /(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    if (
      !name ||
      !["description", "og:description", "og:title", "twitter:description"].includes(name)
    )
      continue;
    const content = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(tag);
    const value = decodeEntities(content?.[1] ?? content?.[2] ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

/** The page's links (anchor text → absolute http(s) URL), deduplicated, in page order. */
export function pageLinks(html: string, base: string, max = MAX_LINKS): PageLink[] {
  const out: PageLink[] = [];
  const seen = new Set<string>();
  const re = /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const href = decodeEntities((m[1] ?? m[2] ?? "").trim());
    if (!href || href.startsWith("#") || /^(javascript|mailto|tel):/i.test(href)) continue;
    let abs: string;
    try {
      const u = new URL(href, base);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      u.hash = "";
      abs = u.toString();
    } catch {
      continue;
    }
    if (seen.has(abs)) continue;
    seen.add(abs);
    const text = decodeEntities((m[3] ?? "").replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
    out.push({ text, url: abs });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * All visible text of an HTML page, one block per line: scripts, styles and
 * hidden templates removed, link text kept, table cells joined with " | ".
 * Unlike a readability extraction it keeps bylines, metadata blocks, prices
 * and listings — the details a cited claim often rests on.
 */
export function visibleText(html: string): string {
  let t = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    // Timestamps many sites fill in with script (`<relative-time datetime=…>`):
    // keep the machine-readable instant, which is all a plain read sees.
    .replace(
      /<((?:relative-|local-)?time)\b[^>]*\bdatetime\s*=\s*["']([^"']+)["'][^>]*>/gi,
      (_m, _tag: string, when: string) => ` [${when}] `,
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/?(p|div|li|ul|ol|tr|table|thead|tbody|h[1-6]|section|article|header|footer|nav|aside|main|blockquote|pre|dd|dt|dl|figure|figcaption|form|details|summary|address)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ");
  t = decodeEntities(t);
  const out: string[] = [];
  for (const raw of t.split("\n")) {
    const line = raw
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/^(\s*\|\s*)+/, "")
      .trim();
    if (line && line !== out.at(-1)) out.push(line);
  }
  return out.join("\n");
}

/** PDF text through poppler's `pdftotext` (undefined when it is not installed or fails). */
export function pdftotext(bytes: Uint8Array, timeoutMs = 30_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("pdftotext", ["-layout", "-q", "-", "-"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolve(undefined);
      return;
    }
    const out: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? Buffer.concat(out).toString("utf8") : undefined);
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(Buffer.from(bytes));
  });
}

function refusal(url: string, why: string, cache?: ProvenanceCache): PageRead {
  cache?.record({ url, status: 0, error: why });
  return { url, ok: false, status: 0, text: "", links: [], kind: "web", error: why, refused: true };
}

/** Read one page. Never throws: a failure comes back as `ok: false` with `error`. */
/** One read before it is filed: the page as returned to the agent plus what the cache keeps. */
interface Attempt {
  read: PageRead;
  capture: PageCapture;
}

async function plainRead(url: string, opts: ReadPageOptions): Promise<Attempt> {
  const fetcher = opts.fetcher ?? ((u: string, init: RequestInit) => guardedFetch(u, init));
  const failed = (status: number, error: string, contentType?: string): Attempt => ({
    read: {
      url,
      ok: false,
      status,
      ...(contentType ? { contentType } : {}),
      text: "",
      links: [],
      kind: "web",
      error,
    },
    capture: { url, status, ...(contentType ? { contentType } : {}), error, via: "fetch" },
  });
  let res: Response;
  try {
    res = await fetcher(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? READ_TIMEOUT_MS),
      headers: {
        "User-Agent": opts.userAgent ?? VERIFY_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.8",
      },
    });
  } catch (e) {
    return failed(0, getErrorMessage(e).slice(0, 200));
  }
  const contentType = res.headers.get("content-type") ?? undefined;
  let body: Uint8Array;
  try {
    body = await readBytesCapped(res, opts.maxBytes ?? READ_MAX_BYTES);
  } catch (e) {
    return failed(res.status, `read failed: ${getErrorMessage(e).slice(0, 160)}`, contentType);
  }
  const ok = res.status >= 200 && res.status < 300;
  const pdf = isPdf(contentType, body);
  let text = "";
  let title: string | undefined;
  let links: PageLink[] = [];
  if (pdf) {
    text = (await (opts.pdfText ?? pdftotext)(body)) ?? "";
  } else {
    const raw = new TextDecoder().decode(body);
    if (/<html|<body|<head|<!doctype html/i.test(raw.slice(0, 4000))) {
      ({ text, title, links } = fromHtml(raw, url));
    } else {
      text = raw;
    }
  }
  // A 2xx web page with no readable text (a bot wall answering 202, a script
  // shell) is not a read: nothing on it can support a citation.
  const empty = ok && !pdf && text.trim().length === 0;
  const error = !ok
    ? `HTTP ${res.status}`
    : empty
      ? "no readable text (empty or bot-walled page)"
      : undefined;
  return {
    read: {
      url,
      ok: ok && !empty,
      status: res.status,
      ...(contentType ? { contentType } : {}),
      ...(title ? { title } : {}),
      text,
      links,
      kind: pdf ? "pdf" : "web",
      ...(error ? { error } : {}),
    },
    capture: {
      url,
      status: res.status,
      ...(contentType ? { contentType } : {}),
      body,
      text,
      ...(title ? { title } : {}),
      ...(error ? { error } : {}),
      via: "fetch",
    },
  };
}

/** Text (meta lines first, then all visible text), title and links of an HTML page. */
function fromHtml(
  raw: string,
  url: string,
  innerText?: string,
): { text: string; title?: string; links: PageLink[] } {
  const title = extractReadableText(raw).title;
  const meta = metaSummary(raw);
  const body = innerText?.trim() ? innerText.replace(/\n{3,}/g, "\n\n").trim() : visibleText(raw);
  return {
    text: [...meta.map((m) => `[meta] ${m}`), body].filter(Boolean).join("\n"),
    ...(title ? { title } : {}),
    links: pageLinks(raw, url),
  };
}

async function renderedRead(url: string, browser: BrowserReader): Promise<Attempt | undefined> {
  const r = await browser.render(url);
  if (!r.ok) return undefined;
  const { text, title, links } = fromHtml(r.html, r.finalUrl || url, r.text);
  const contentType = "text/html; rendered";
  return {
    read: {
      url,
      ok: true,
      status: r.status,
      contentType,
      ...(title ? { title } : {}),
      text,
      links,
      kind: "web",
    },
    capture: {
      url,
      status: r.status,
      contentType,
      body: new TextEncoder().encode(r.html),
      text,
      ...(title ? { title } : {}),
      ...(r.screenshot ? { screenshot: r.screenshot } : {}),
      via: "browser",
    },
  };
}

/** Read one page. Never throws: a failure comes back as `ok: false` with `error`. */
export async function readPage(url: string, opts: ReadPageOptions = {}): Promise<PageRead> {
  if (!fetchAllowed(url)) return refusal(url, "publisher terms bar automated access", opts.cache);
  if (deniedByPattern(url, opts.deny))
    return refusal(url, "refused by this run's deny list", opts.cache);
  let attempt = await plainRead(url, opts);
  // A failed read or a script shell gets one rendered read when a browser is available.
  if (opts.browser && needsRender(attempt.read)) {
    const rendered = await renderedRead(url, opts.browser).catch(() => undefined);
    if (rendered && (!attempt.read.ok || rendered.read.text.length > attempt.read.text.length)) {
      attempt = rendered;
    }
  }
  opts.cache?.record(attempt.capture);
  return attempt.read;
}
