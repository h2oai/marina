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
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, "\n");
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // Try to extract <article> or <main> content first (highest signal)
  const articleMatch = text.match(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i);
  if (articleMatch?.[1] && articleMatch[1].length > 200) {
    text = articleMatch[1];
  }

  // Convert headings to bold-like markers
  text = text.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, "\n\n## $1\n\n");

  // Convert list items
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1");

  // Convert block elements to newlines
  text = text.replace(/<\/?(p|div|br|tr|blockquote|section|article)[^>]*>/gi, "\n");

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
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number.parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}
