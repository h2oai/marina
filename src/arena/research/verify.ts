// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Citation verification: a search-grounded researcher can still state a wrong
 * number with a real-looking citation (seen live: a poll "at 39%" whose source
 * said 35%). A model judge cannot catch that — it checks a rationale against
 * the dossier, not the dossier against the web. This does it mechanically:
 * every dossier line that cites a page has its figures looked up IN that page
 * (fetched through the SSRF guard). Lines are tagged
 *
 *   [verified]    every figure found on a cited page
 *   [unverified]  a cited page was read and a figure is not on it
 *   [unreachable] no cited page could be read (paywall, bot block, timeout)
 *
 * and only [verified] lines count as evidence for the judge. Deterministic
 * given the fetched pages; no model involved.
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
}

export interface VerifiedDossier {
  /** The report with a status tag at the start of every cited line. */
  annotated: string;
  /** Only the verified lines — what the judge may treat as evidence. */
  verifiedText: string;
  lines: VerifiedLine[];
  stats: Record<LineStatus, number>;
}

export type PageText = (url: string) => Promise<string | undefined>;

const LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
const MAX_PAGES = 12;
const MAX_PAGE_BYTES = 2_000_000;

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

/** Does `figure` appear in `page` as a number (not as part of a longer one)? */
function hasFigure(page: string, figure: string): boolean {
  const escaped = figure.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/^-/, "[-−]?");
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d]|\\.\\d)`).test(page);
}

export function defaultPageText(timeoutMs = 8_000): PageText {
  return async (url) => {
    try {
      const res = await guardedFetch(
        url,
        {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { "User-Agent": "Mozilla/5.0 (compatible; MarinaResearch/1.0)" },
        },
        { maxHops: 3 },
      );
      if (!res.ok) return undefined;
      const body = await res.text();
      if (body.length > MAX_PAGE_BYTES) return undefined;
      return /<html|<body/i.test(body) ? extractReadableText(body).text : body;
    } catch {
      return undefined;
    }
  };
}

export async function verifyDossier(report: string, pageText: PageText): Promise<VerifiedDossier> {
  const rawLines = report.split("\n");
  const urls = new Set<string>();
  for (const line of rawLines) for (const m of line.matchAll(LINK)) urls.add(m[2]!);
  const pages = new Map<string, string | undefined>();
  await Promise.all(
    [...urls]
      .filter(fetchAllowed)
      .slice(0, MAX_PAGES)
      .map(async (u) => pages.set(u, await pageText(u))),
  );

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
      .map(normalize);
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
  return { annotated: annotated.join("\n"), verifiedText: verified.join("\n"), lines, stats };
}
