// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The attention-extraction stage's registry and knobs.
 *
 *   MARINA_ARENA_WIKI_EXTRACTORS           comma list of `events`, `news`,
 *                                          `related`, `edits`, `gdelt`
 *                                          (unset/empty/off: no extraction —
 *                                          the specialist is unchanged)
 *   MARINA_ARENA_WIKI_EXTRACTOR_MODEL      the model extractors' model
 *                                          (default openrouter/deepseek/deepseek-v4.1-flash-1017)
 *   MARINA_ARENA_WIKI_EXTRACTOR_TOP        candidates extracted for (default 30)
 *   MARINA_ARENA_WIKI_EXTRACTOR_RETRIEVER  date-strict retriever for `events`
 *                                          (default none: the article text only;
 *                                          only `asof:…` specs are accepted)
 */

import { eventsExtractor } from "./events";
import type { Extractor } from "./features";
import { gdeltExtractor, newsExtractor } from "./news";
import { editsExtractor, relatedExtractor } from "./wiki-deterministic";

export const EXTRACTOR_NAMES = ["events", "news", "related", "edits", "gdelt"] as const;
export type ExtractorName = (typeof EXTRACTOR_NAMES)[number];
export const DEFAULT_EXTRACTOR_MODEL = "openrouter/deepseek/deepseek-v4.1-flash-1017";
export const DEFAULT_EXTRACTOR_TOP = 30;

/** The extractor list in a knob value; empty means off. Unknown names are an error. */
export function parseExtractorList(value: string | undefined): ExtractorName[] {
  const names = (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 1 && (names[0] === "off" || names[0] === "none")) return [];
  const out: ExtractorName[] = [];
  for (const n of names) {
    if (!(EXTRACTOR_NAMES as readonly string[]).includes(n))
      throw new Error(
        `MARINA_ARENA_WIKI_EXTRACTORS: unknown extractor "${n}" (${EXTRACTOR_NAMES.join(", ")}, or off)`,
      );
    if (!out.includes(n as ExtractorName)) out.push(n as ExtractorName);
  }
  return out;
}

export function extractorFor(name: ExtractorName, opts: { search?: boolean } = {}): Extractor {
  switch (name) {
    case "events":
      return eventsExtractor({ search: opts.search ?? true });
    case "news":
      return newsExtractor();
    case "related":
      return relatedExtractor();
    case "edits":
      return editsExtractor();
    case "gdelt":
      return gdeltExtractor();
  }
}

export interface ExtractionSettings {
  extractors: ExtractorName[];
  model: string;
  top: number;
  retriever?: string;
}

/** The stage's settings from the environment; `extractors` empty when it is off. */
export function extractionSettings(env: NodeJS.ProcessEnv): ExtractionSettings {
  const extractors = parseExtractorList(env.MARINA_ARENA_WIKI_EXTRACTORS);
  const top = Number.parseInt(env.MARINA_ARENA_WIKI_EXTRACTOR_TOP ?? "", 10);
  const retriever = env.MARINA_ARENA_WIKI_EXTRACTOR_RETRIEVER?.trim();
  return {
    extractors,
    model: env.MARINA_ARENA_WIKI_EXTRACTOR_MODEL?.trim() || DEFAULT_EXTRACTOR_MODEL,
    top: Number.isFinite(top) && top > 0 ? Math.min(top, 100) : DEFAULT_EXTRACTOR_TOP,
    ...(retriever ? { retriever } : {}),
  };
}

export * from "./adjust";
export * from "./features";
