// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Citation verification: a search-grounded researcher can still state a wrong
 * number with a real-looking citation (seen live: a poll "at 39%" whose source
 * said 35%). A model judge cannot catch that — it checks a rationale against
 * the dossier, not the dossier against the web. This does it mechanically:
 * every dossier line that cites a page has its figures looked up IN that page
 * (fetched through the SSRF guard, or the text the search engine already
 * fetched when a source carries it — see `PageText.provided`). Lines are tagged
 *
 *   [verified]    every figure found on a cited page (in the English or the
 *                 continental-European number reading)
 *   [verified]    also: a line with no figure whose whole text is on a cited
 *                 page, verbatim up to case, quote marks and whitespace
 *   [unverified]  a cited page was read and a figure is not on it
 *   [unreachable] no cited page could be read (paywall, bot block, timeout)
 *
 * and only [verified] lines count as evidence for the judge. A figureless
 * line that is not on its page stays untagged and is never evidence.
 * Deterministic given the fetched pages; no model involved.
 */

import { extractReadableText } from "../../engine/html-text";
import { guardedFetch } from "../../net/url-guard";

export type LineStatus = "verified" | "unverified" | "unreachable" | "uncited";

/**
 * Publishers whose terms bar automated access or passing content on (the
 * arena's own rights review, `ssa/inventory.py` / docs/sources.md): YouGov
 * (CC BY-NC with a bar on bots), AAII ("may not be forwarded"), Conference
 * Board and Penta-CivicScience (database extraction / scraping barred).
 * Citation verification never fetches them; their lines stay unverified.
 */
export const NO_FETCH_DOMAINS = [
  "yougov.com",
  "aaii.com",
  "conference-board.org",
  "civicscience.com",
];

export function fetchAllowed(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !NO_FETCH_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

export interface VerifiedLine {
  text: string;
  status: LineStatus;
  figures: string[];
  missing?: string[];
  /** Verified because the line's whole text is on the cited page (it has no figure). */
  quoted?: boolean;
}

export interface VerifiedDossier {
  /** The report with a status tag at the start of every cited line. */
  annotated: string;
  /** Only the verified lines — what the judge may treat as evidence. */
  verifiedText: string;
  lines: VerifiedLine[];
  stats: Record<LineStatus, number>;
  /** Where the cited pages' text came from: the retriever, a fetch, or nowhere. */
  reads: { provided: number; fetched: number; failed: number };
}

/**
 * Reads a cited page. `provided` (optional) answers synchronously from text a
 * retriever already fetched; those pages do not count toward the fetch cap.
 */
export type PageText = ((url: string) => Promise<string | undefined>) & {
  provided?: (url: string) => string | undefined;
};

const LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
/** Pages fetched per dossier (provided texts are free and uncapped). */
const MAX_PAGES = 20;
/** Pages fetched at once. */
const FETCH_CONCURRENCY = 6;
/**
 * Bytes read per fetched page. Larger pages are truncated, not rejected: the
 * figures a report cites are near the top (Civiqs results pages are 2–12 MB,
 * almost all of it chart data after the headline numbers).
 */
export const MAX_PAGE_BYTES = 16 * 1024 * 1024;
/** Per-page timeout: slow government sites (EIA, FRED) need more than 8 s. */
export const PAGE_TIMEOUT_MS = 15_000;
/** A descriptive agent with a contact URL; some sites (BLS) still refuse any bot. */
export const VERIFY_USER_AGENT =
  "Mozilla/5.0 (compatible; MarinaResearch/1.1; citation check; +https://github.com/h2oai/marina)";

/** Figures worth checking: percentages, decimals, and numbers of 3+ digits that are not years. */
export function figuresIn(line: string): string[] {
  const withoutLinks = line.replace(LINK, " ");
  const out = new Set<string>();
  for (const m of withoutLinks.matchAll(/(?<![\w.])[-−]?\d[\d,]*(?:\.\d+)?%?/g)) {
    const raw = m[0].replace(/^−/, "-");
    const bare = raw.replace(/[,%]/g, "").replace(/^-/, "");
    const isYear = /^(19|20)\d\d$/.test(bare);
    if (raw.endsWith("%") || bare.includes(".") || (bare.length >= 3 && !isYear)) {
      out.add(raw.replace(/,/g, "").replace(/%$/, ""));
    }
  }
  return [...out];
}

function normalize(page: string): string {
  return page.replace(/(\d),(\d)/g, "$1$2").replace(/−/g, "-");
}

/**
 * The page's numbers as a continental-European page writes them read the
 * English way: `3.702` (thousands) → `3702`, `25,5` (decimal) → `25.5`. A
 * figure counts as present when it is on the page in either reading — the
 * digits are the same digits, only the separators differ (a Portuguese poll
 * page says "3.702 eleitores", the report "3,702 voters").
 */
function normalizeEuropean(page: string): string {
  return page
    .replace(/(\d)\.(?=\d{3}(?!\d))/g, "$1")
    .replace(/(\d),(\d{1,2})(?!\d)/g, "$1.$2")
    .replace(/−/g, "-");
}

/** Does `figure` appear in `page` as a number (not as part of a longer one)? */
function hasFigure(page: string, figure: string): boolean {
  const escaped = figure.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/^-/, "[-−]?");
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d]|\\.\\d)`).test(page);
}

/**
 * Text folded for quote matching: lower case, accents kept, apostrophes and
 * dashes unified, double quotes, markdown links/emphasis, brackets and
 * ellipses dropped, whitespace collapsed. Applied the same way to the line and
 * to the page, so quoting a passage verbatim always matches its page.
 */
export function foldForQuote(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201a\u201b\u2032`´]/g, "'")
    .replace(/["\u201c\u201d\u201e\u201f\u2033«»]/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\*\*|__|[*_[\]]/g, "")
    .replace(/…|\.\.\./g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Shortest line body accepted as a quote: shorter text matches too easily by chance. */
export const MIN_QUOTE_CHARS = 30;

/**
 * The claim a cited line makes, without its citation: links, a leading
 * bullet and `<date> —` prefix, and surrounding quote marks removed. Lines
 * the `search` retriever writes are exactly `- <date> — "<passage>" [title](url)`.
 */
export function quoteBody(line: string): string {
  return line
    .replace(LINK, " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/^\s*(?:[-*•]|\d+\.)\s+/, "")
    .replace(/^(?:\[[^\]]*\]\s*)?(?:\d{4}-\d{2}-\d{2}|undated)\s*[—–-]\s*/i, "")
    .trim()
    .replace(/^["“”']+|["“”']+$/g, "")
    .replace(/[\s.;:,]+$/, "")
    .trim();
}

/**
 * True when the line's WHOLE claim (`quoteBody`) is on one of the pages,
 * verbatim up to `foldForQuote`. Part of a line never vouches for the rest.
 */
function quotedOnPage(line: string, foldedPages: string[]): boolean {
  const body = foldForQuote(quoteBody(line));
  if (body.length < MIN_QUOTE_CHARS) return false;
  return foldedPages.some((p) => p.includes(body));
}

/** Up to `maxBytes` of a response body as text; the rest is cancelled, not read. */
export async function readCapped(res: Response, maxBytes = MAX_PAGE_BYTES): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let read = 0;
  let out = "";
  try {
    while (read < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.byteLength > maxBytes - read ? value.subarray(0, maxBytes - read) : value;
      read += chunk.byteLength;
      out += decoder.decode(chunk, { stream: true });
    }
    out += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out;
}

export function defaultPageText(timeoutMs = PAGE_TIMEOUT_MS, maxBytes = MAX_PAGE_BYTES): PageText {
  return async (url) => {
    try {
      const res = await guardedFetch(
        url,
        {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { "User-Agent": VERIFY_USER_AGENT },
        },
        { maxHops: 3 },
      );
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return undefined;
      }
      const body = await readCapped(res, maxBytes);
      return /<html|<body/i.test(body) ? extractReadableText(body).text : body;
    } catch {
      return undefined;
    }
  };
}

/**
 * Tag every cited line of `report`. A page's text comes, in order, from
 * `sources` (a retriever's `Source.text`), `pageText.provided`, or a fetch
 * (the first `MAX_PAGES` remaining URLs). `NO_FETCH_DOMAINS` pages are never
 * read by any route.
 */
export async function verifyDossier(
  report: string,
  pageText: PageText,
  sources: ReadonlyArray<{ url: string; text?: string }> = [],
): Promise<VerifiedDossier> {
  const rawLines = report.split("\n");
  const urls = new Set<string>();
  for (const line of rawLines) for (const m of line.matchAll(LINK)) urls.add(m[2]!);
  const given = new Map<string, string>();
  for (const s of sources) if (s.text && !given.has(s.url)) given.set(s.url, s.text);
  const pages = new Map<string, string | undefined>();
  const reads = { provided: 0, fetched: 0, failed: 0 };
  const toFetch: string[] = [];
  for (const u of urls) {
    if (!fetchAllowed(u)) continue;
    const text = given.get(u) ?? pageText.provided?.(u);
    if (text) {
      pages.set(u, text);
      reads.provided++;
    } else toFetch.push(u);
  }
  const queue = toFetch.slice(0, MAX_PAGES);
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, async () => {
      for (let u = queue.shift(); u !== undefined; u = queue.shift()) {
        const text = await pageText(u);
        pages.set(u, text);
        if (text) reads.fetched++;
        else reads.failed++;
      }
    }),
  );
  const folded = new Map<string, string>();
  const foldedPage = (u: string) => {
    let f = folded.get(u);
    if (f === undefined) {
      f = foldForQuote(pages.get(u) ?? "");
      folded.set(u, f);
    }
    return f;
  };

  const lines: VerifiedLine[] = [];
  const annotated: string[] = [];
  const verified: string[] = [];
  const stats: Record<LineStatus, number> = {
    verified: 0,
    unverified: 0,
    unreachable: 0,
    uncited: 0,
  };
  for (const text of rawLines) {
    const cited = [...text.matchAll(LINK)].map((m) => m[2]!);
    const figures = figuresIn(text);
    if (cited.length > 0 && figures.length === 0) {
      // No figure to check: the line counts only when its whole claim is on a
      // cited page, verbatim (a quoted passage). Otherwise it stays untagged
      // and is never evidence, exactly as before.
      const readable = cited.filter((u) => pages.get(u));
      if (readable.length > 0 && quotedOnPage(text, readable.map(foldedPage))) {
        stats.verified++;
        lines.push({ text, status: "verified", figures, quoted: true });
        annotated.push(`[verified] ${text}`);
        verified.push(text);
      } else {
        annotated.push(text);
      }
      continue;
    }
    if (cited.length === 0 || figures.length === 0) {
      annotated.push(text);
      if (cited.length === 0 && figures.length > 0) {
        lines.push({ text, status: "uncited", figures });
        stats.uncited++;
      }
      continue;
    }
    const readable = cited
      .map((u) => pages.get(u))
      .filter((p): p is string => !!p)
      .flatMap((p) => [normalize(p), normalizeEuropean(p)]);
    let status: LineStatus;
    let missing: string[] | undefined;
    if (readable.length === 0) {
      status = "unreachable";
    } else {
      missing = figures.filter((f) => !readable.some((p) => hasFigure(p, f)));
      status = missing.length === 0 ? "verified" : "unverified";
    }
    stats[status]++;
    lines.push({ text, status, figures, ...(missing?.length ? { missing } : {}) });
    annotated.push(
      `[${status}${missing?.length ? `: ${missing.join(", ")} not on the cited page` : ""}] ${text}`,
    );
    if (status === "verified") verified.push(text);
  }
  return {
    annotated: annotated.join("\n"),
    verifiedText: verified.join("\n"),
    lines,
    stats,
    reads,
  };
}
