// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dependency-free HTML → readable text, shared by the `web` and `scenario`
 * fetchers and the DuckDuckGo result parser.
 */

export interface ExtractedContent {
  text: string;
  title?: string;
  wordCount: number;
}

/**
 * Extract readable text from HTML using content scoring.
 *
 * Scores text-dense blocks higher than navigation/boilerplate.
 * Inspired by Mozilla's Readability algorithm but lightweight.
 */
export function extractReadableText(html: string): ExtractedContent {
  let text = html;

  // Extract title from <title> tag
  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1] ? titleMatch[1].replace(/\s+/g, " ").trim() : undefined;

  // Remove non-content blocks entirely
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<(svg|template|iframe|select|button|form)[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<aside[\s\S]*?<\/aside>/gi, "");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, "\n");
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // The main content block (highest signal): the text-richest <main> or
  // <article>. Pages often carry several <article> teasers before the story,
  // so the first match is not necessarily the content.
  const main = mainContentBlock(text);
  if (main) text = main;

  // Convert headings to bold-like markers
  text = text.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n\n## $1\n\n");

  // Convert list items
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1");

  // Convert block elements to newlines
  text = text.replace(
    /<\/?(p|div|br|tr|blockquote|section|article|figcaption|dd|dt)[^>]*>/gi,
    "\n",
  );

  // Drop link-dense short lines (menus, "read more" lists, tag clouds): mostly
  // anchor text and too short to be a paragraph.
  text = text
    .split("\n")
    .filter((line) => !isLinkList(line))
    .join("\n");

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  text = decodeEntities(text);

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");

  text = text.trim();

  const wordCount = text.split(/\s+/).filter(Boolean).length;

  return { text, title, wordCount };
}

/** Visible text length of an HTML fragment (tags dropped, whitespace collapsed). */
function textLength(html: string): number {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

/**
 * The text-richest `<main>` (outermost) or `<article>` block, when it holds
 * a real body (> 200 chars of text); else undefined (use the whole page).
 */
function mainContentBlock(html: string): string | undefined {
  const candidates: string[] = [];
  const main = html.match(/<main[^>]*>([\s\S]*)<\/main>/i)?.[1];
  if (main) candidates.push(main);
  for (const m of html.matchAll(/<article[^>]*>([\s\S]*?)<\/article>/gi)) {
    if (m[1]) candidates.push(m[1]);
  }
  let best: string | undefined;
  let bestLen = 200;
  for (const c of candidates) {
    const len = textLength(c);
    if (len > bestLen) {
      best = c;
      bestLen = len;
    }
  }
  return best;
}

/** A line that is mostly link text and too short to be a paragraph. */
function isLinkList(line: string): boolean {
  if (!/<a[\s>]/i.test(line)) return false;
  const total = textLength(line);
  if (total === 0 || total > 160) return false;
  let linked = 0;
  for (const m of line.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)) linked += textLength(m[1] ?? "");
  return linked / total > 0.6;
}

const DATE_META =
  /<meta[^>]+(?:property|name|itemprop)=["'](?:article:published_time|og:published_time|datePublished|date|pubdate|publishdate|publish-date|dc\.date|dc\.date\.issued|sailthru\.date|parsely-pub-date)["'][^>]*>/gi;

/**
 * The page's publication instant (ISO), from the usual metadata — Open Graph
 * / article meta tags, JSON-LD `datePublished`, or the first `<time
 * datetime>` — else undefined. Only plausible dates (1990 … one day ahead)
 * are accepted.
 */
export function extractPublishedDate(html: string, now = Date.now()): string | undefined {
  const found: string[] = [];
  for (const m of html.matchAll(DATE_META)) {
    const content = m[0].match(/content=["']([^"']+)["']/i)?.[1];
    if (content) found.push(content);
  }
  const ld = html.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1];
  if (ld) found.push(ld);
  const time = html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1];
  if (time) found.push(time);
  for (const raw of found) {
    const t = Date.parse(raw.trim());
    if (Number.isFinite(t) && t > Date.UTC(1990, 0, 1) && t < now + 86_400_000) {
      return new Date(t).toISOString();
    }
  }
  return undefined;
}

/**
 * Decode the common named entities plus numeric references. `&amp;` is decoded
 * LAST so an escaped entity (`&amp;lt;`) comes out as the literal `&lt;` rather
 * than being decoded twice into `<`.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&(?:rsquo|lsquo|apos);/g, "'")
    .replace(/&(?:rdquo|ldquo);/g, '"')
    .replace(/&(?:mdash|ndash);/g, "-")
    .replace(/&hellip;/g, "...")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number.parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}
