// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Barred sources for any retriever. `brief.exclude` is honoured only by the
 * engines that read it (`search`, the web agent, the page reader); the others
 * (OpenRouter web, Tavily, Exa, as-of) return whatever they found. This wrapper
 * makes a barred list hold for every engine: it passes the list down on the
 * brief, then drops barred sources and every report line that cites one. A
 * captured evidence snapshot that held a barred source is dropped whole (its
 * hash covers the barred bytes), with a warning — never kept half-filtered.
 *
 * Callers own their lists: a benchmark adapter bars its own dataset, answer
 * and leaderboard pages; nothing here knows any board.
 */

import type { SourceExclusion } from "./briefs";
import type { Retriever } from "./retrieve";
import { excludedSource } from "./web-search";

const URL_IN_TEXT = /https?:\/\/[^\s)\]>"'<]+/g;

/** Both lists in one (a brief's own exclusions are kept). */
export function mergeExclusions(
  a: SourceExclusion | undefined,
  b: SourceExclusion | undefined,
): SourceExclusion | undefined {
  if (!a) return b;
  if (!b) return a;
  const urls = [...new Set([...(a.urls ?? []), ...(b.urls ?? [])])];
  const titles = [...new Set([...(a.titles ?? []), ...(b.titles ?? [])])];
  return { ...(urls.length ? { urls } : {}), ...(titles.length ? { titles } : {}) };
}

/** True when the list bars nothing. */
export function emptyExclusion(e: SourceExclusion | undefined): boolean {
  return !e || ((e.urls?.length ?? 0) === 0 && (e.titles?.length ?? 0) === 0);
}

export function barredRetriever(inner: Retriever, exclude: SourceExclusion): Retriever {
  if (emptyExclusion(exclude)) return inner;
  const barred = excludedSource(exclude);
  return async (brief) => {
    const r = await inner({ ...brief, exclude: mergeExclusions(brief.exclude, exclude) });
    const sources = r.sources.filter((s) => !barred(s.url, s.title));
    const lines = r.report.split("\n");
    const kept = lines.filter((line) => !(line.match(URL_IN_TEXT) ?? []).some((u) => barred(u)));
    const droppedSources = r.sources.length - sources.length;
    const droppedLines = lines.length - kept.length;
    const evidenceBarred =
      r.evidence?.sources.some((s) => barred(s.url, s.title)) ||
      (r.evidence?.report.match(URL_IN_TEXT) ?? []).some((u) => barred(u));
    if (droppedSources === 0 && droppedLines === 0 && !evidenceBarred) return r;
    const { evidence, ...rest } = r;
    return {
      ...rest,
      report: kept.join("\n"),
      sources,
      ...(evidence && !evidenceBarred ? { evidence } : {}),
      warnings: [
        ...(r.warnings ?? []),
        `barred sources: ${droppedSources} source(s) and ${droppedLines} line(s) dropped${evidenceBarred ? "; evidence snapshot dropped" : ""}`,
      ],
    };
  };
}
