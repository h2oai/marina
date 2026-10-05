// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mechanical checks on a citation-backed markdown answer — no model calls:
 * which URLs it cites, whether each was actually read (successfully) during the
 * run that wrote it, and which substantive lines carry no source at all. The
 * audit feeds one repair turn ("open these or drop them") and travels with the
 * answer as part of its record.
 */

import type { ProvenanceCache } from "./provenance-cache";

/** URLs in a markdown answer, in order of first appearance, deduplicated. */
export function citedUrls(markdown: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const url = trimUrl(raw);
    if (!/^https?:\/\/[^\s/]+\.[^\s]+/i.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push(url);
  };
  // Markdown links `[text](url "title")` first: their closing paren is not part of the URL.
  const masked = markdown.replace(
    /\]\(\s*<?(https?:\/\/[^\s()<>]+(?:\([^\s()]*\)[^\s()<>]*)*)>?(?:\s+"[^"]*")?\s*\)/gi,
    (_m, u: string) => {
      add(u);
      return "]()";
    },
  );
  for (const m of masked.matchAll(/<(https?:\/\/[^>\s]+)>/gi)) add(m[1] ?? "");
  for (const m of masked.matchAll(/https?:\/\/[^\s<>"'`\]]+/gi)) add(m[0]);
  return out;
}

/** Strip punctuation that ends a sentence rather than the URL (keeps balanced parentheses). */
export function trimUrl(raw: string): string {
  let u = raw.trim();
  for (;;) {
    const last = u.at(-1);
    if (!last) return u;
    if (".,;:!?'\"*_".includes(last)) {
      u = u.slice(0, -1);
      continue;
    }
    if (last === ")" && count(u, "(") < count(u, ")")) {
      u = u.slice(0, -1);
      continue;
    }
    if (last === "]" && count(u, "[") < count(u, "]")) {
      u = u.slice(0, -1);
      continue;
    }
    return u;
  }
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/**
 * Reader proxies that fetch a page on the agent's behalf and return its text
 * (`https://r.jina.ai/<url>`). A citation should name the page itself, not the
 * proxy; the proxy read still counts as having read the page.
 */
export const READER_PROXIES = ["https://r.jina.ai/", "http://r.jina.ai/"];

/** The page behind a reader-proxy URL, or the URL unchanged. */
export function unwrapProxyUrl(url: string): string {
  for (const p of READER_PROXIES) {
    if (url.startsWith(p)) {
      const inner = url.slice(p.length);
      if (/^https?:\/\//i.test(inner)) return inner;
    }
  }
  return url;
}

/** Replace every cited reader-proxy URL in `markdown` with the page it fetched. */
export function citeOriginals(markdown: string): string {
  let out = markdown;
  for (const u of citedUrls(markdown)) {
    const original = unwrapProxyUrl(u);
    if (original !== u) out = out.split(u).join(original);
  }
  return out;
}

/**
 * The cache key under which `url` was read successfully: the URL itself, or
 * a reader-proxy read of it. Undefined when the run never read it.
 */
export function readUrlFor(cache: ProvenanceCache, url: string): string | undefined {
  if (cache.readOk(url)) return url;
  for (const p of READER_PROXIES) {
    if (cache.readOk(`${p}${url}`)) return `${p}${url}`;
  }
  return undefined;
}

export interface CitationAudit {
  cited: number;
  /** Cited URLs read successfully during the run. */
  read: string[];
  /** Cited URLs the run never opened. */
  unread: string[];
  /** Cited URLs whose read failed (HTTP error, network, refused). */
  failed: string[];
  /** Substantive lines (list items / paragraphs) with no URL and no `[n]` reference. */
  uncitedLines: number;
  substantiveLines: number;
}

const REF_MARKER = /\[\d{1,3}\]|\[\^?\w{1,8}\]/;

/** Audit `markdown` against what the run read. */
export function auditCitedUrls(markdown: string, cache: ProvenanceCache): CitationAudit {
  const urls = citedUrls(markdown);
  const read: string[] = [];
  const unread: string[] = [];
  const failed: string[] = [];
  for (const u of urls) {
    if (readUrlFor(cache, u)) read.push(u);
    else if (cache.get(u)) failed.push(u);
    else unread.push(u);
  }
  let substantive = 0;
  let uncited = 0;
  for (const line of markdown.split("\n")) {
    const t = line.trim();
    if (t.length < 60 || t.startsWith("#") || t.startsWith("|---") || /^\[\d+\]:/.test(t)) continue;
    substantive++;
    if (!/https?:\/\//i.test(t) && !REF_MARKER.test(t)) uncited++;
  }
  return {
    cited: urls.length,
    read,
    unread,
    failed,
    uncitedLines: uncited,
    substantiveLines: substantive,
  };
}

/** True when the audit found something one repair turn could fix. */
export function needsRepair(a: CitationAudit): boolean {
  return a.unread.length > 0 || a.failed.length > 0 || a.cited === 0;
}

/** The repair request for one turn (empty when nothing needs fixing). */
export function repairRequest(a: CitationAudit): string {
  if (!needsRepair(a)) return "";
  const parts = ["[Citation check] Before you finish:"];
  if (a.cited === 0)
    parts.push(
      "- The answer cites no URLs. Every key fact needs the URL of a page that states it.",
    );
  if (a.unread.length > 0)
    parts.push(
      `- You cite ${a.unread.length} URL(s) you never opened: ${a.unread.slice(0, 15).join(" ")}. ` +
        "Open each with fetch_page and keep it only if the page supports the claim; otherwise replace it with a page you read, or remove the claim.",
    );
  if (a.failed.length > 0)
    parts.push(
      `- ${a.failed.length} cited URL(s) failed to load when you tried: ${a.failed.slice(0, 15).join(" ")}. ` +
        "A grader may not be able to open them either; prefer a source that loads.",
    );
  parts.push("Then give the complete final answer again (the full text, not a diff).");
  return parts.join("\n");
}
