// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { queryTerms, termMatcher } from "./term-match";

/** UTF-8 prefix, without splitting a code point. */
function prefix(text: string, bytes: number): string {
  let used = 0;
  let out = "";
  for (const ch of text) {
    used += Buffer.byteLength(ch);
    if (used > bytes) break;
    out += ch;
  }
  return out;
}

/**
 * Extract original passages near query matches instead of discarding the tail
 * of a long record. Gaps are explicit, ordering is preserved, and no text is
 * generated. Short records stay byte-identical. Works on long single lines too.
 */
export function queryExcerpt(content: string, query: string, maxBytes: number): string {
  const cap = Math.max(0, Math.floor(maxBytes));
  if (Buffer.byteLength(content) <= cap) return content;
  const marker = ` […+${content.length} chars]`;
  const room = cap - Buffer.byteLength(marker);
  if (room <= 0) return prefix("…", cap);
  const marked = (text: string, kept = text.length) => `${text} […+${content.length - kept} chars]`;
  const terms = queryTerms(query);
  if (!terms.length) return marked(prefix(content, room));

  // Bound each segment so even a minified page or a giant log line can yield
  // a useful passage. Keep exact substrings, including their whitespace.
  const segmentBytes = Math.max(24, Math.min(600, Math.floor(room / 2)));
  const parts: string[] = [];
  let part = "";
  let bytes = 0;
  for (const ch of content) {
    const width = Buffer.byteLength(ch);
    if (bytes + width > segmentBytes && part) {
      parts.push(part);
      part = "";
      bytes = 0;
    }
    part += ch;
    bytes += width;
    if (ch === "\n") {
      parts.push(part);
      part = "";
      bytes = 0;
    }
  }
  if (part) parts.push(part);
  const ranked = parts
    .map((text, i) => ({ i, hits: terms.filter(termMatcher(text)).length }))
    .filter((p) => p.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.i - b.i);
  if (!ranked.length) return marked(prefix(content, room));
  const keep = new Set<number>();
  let used = 0;
  const take = (i: number) => {
    if (i < 0 || i >= parts.length || keep.has(i)) return;
    // Reserve one separator per segment (also covers a leading omission).
    const size = Buffer.byteLength(parts[i]!) + Buffer.byteLength(" … ");
    if (used + size > room) return;
    keep.add(i);
    used += size;
  };
  for (const { i } of ranked) take(i);
  // Labels, negations and values often occupy adjacent lines.
  for (const { i } of ranked) {
    if (!keep.has(i)) continue;
    take(i - 1);
    take(i + 1);
  }
  if (!keep.size) return marked(prefix(parts[ranked[0]!.i]!, room));
  let out = "";
  let last = -1;
  let kept = 0;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i !== last + 1) out += " … ";
    out += parts[i];
    kept += parts[i]!.length;
    last = i;
  }
  return marked(out, kept);
}
