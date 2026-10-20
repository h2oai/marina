// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Attention extraction: several narrow extractors turn raw information about a
 * set of subjects (Wikipedia articles, search terms, …) into typed, dated
 * feature records that a statistical forecaster consumes through explicit
 * adjustments (`adjust.ts`) — never as free-form model numbers.
 *
 * Every extractor runs as of a cutoff instant: it may read only information
 * that existed then (MediaWiki revisions with `rvstart` at the cutoff,
 * pageviews of days published by then, news first seen before it, search
 * through the date-strict `asof` retrievers). `runExtractors` re-checks every
 * record and drops one dated after the cutoff, so a faulty extractor cannot
 * leak an outcome into a forecast.
 */

import { getErrorMessage, logRejection } from "../../engine/errors";
import { Logger } from "../../engine/logger";
import type { Complete } from "../model-forecaster";
import type { Retriever } from "../research/retrieve";

/** One extracted fact about one subject. */
export interface AttentionFeature {
  /** The subject it describes (a canonical Wikipedia title, a search term, …). */
  subject: string;
  /** Dotted name, `<extractor>.<what>`: `edits.surge`, `event.in_window`, `news.trend`. */
  feature: string;
  value: number;
  /** The instant the information is as of; never after the context's cutoff. */
  asOf: string;
  /** Where it came from (a MediaWiki permalink or API URL, a news URL). */
  source: string;
  /** 0–1: how far the extractor trusts the value (sample size, verification). */
  confidence: number;
  extractor: string;
  /** Extra typed detail (an event's date and kind, the counts behind a ratio). */
  detail?: Record<string, string | number | boolean>;
}

export type FetchJson = (url: string) => Promise<unknown>;

/** What an extractor may read. */
export interface AttentionContext {
  subjects: string[];
  /** The information cutoff (ISO instant): nothing after it may be read. */
  cutoff: string;
  /** The newest day whose daily pageviews were published by the cutoff (YYYY-MM-DD). */
  lastDay: string;
  /** The period being forecast (YYYY-MM-DD, inclusive). */
  window: { start: string; end: string };
  /** Wikimedia/MediaWiki JSON GET (rate-limited, cached, SSRF-guarded in production). */
  fetchJson: FetchJson;
  /** Daily pageviews of any article over [start, end]; days after `lastDay` are ignored. */
  dailyViews?: (
    title: string,
    start: string,
    end: string,
  ) => Promise<Array<{ date: string; views: number }>>;
  /** GDELT JSON GET (spaced per GDELT's guidance in production). */
  gdeltJson?: FetchJson;
  /** A date-strict retriever (`asof:…`) for the model extractors. */
  retriever?: Retriever;
  /** The model the model extractors call (narrow JSON extraction, one call per subject). */
  complete?: Complete;
  signal?: AbortSignal;
}

export interface Extractor {
  name: string;
  /** `model` extractors make paid calls; `deterministic` ones only read public APIs. */
  kind: "deterministic" | "model";
  extract(ctx: AttentionContext): Promise<AttentionFeature[]>;
}

export interface ExtractionRun {
  features: AttentionFeature[];
  /** Records dropped for being dated after the cutoff (a bug in an extractor if ever non-empty). */
  dropped: AttentionFeature[];
  errors: Array<{ extractor: string; error: string }>;
  /** Milliseconds per extractor. */
  timings: Record<string, number>;
}

/** Whether `at` is a parseable instant at or before `cutoff`. */
export function atOrBefore(at: string | undefined, cutoff: string): boolean {
  if (!at) return false;
  const t = Date.parse(at.length === 10 ? `${at}T00:00:00Z` : at);
  return Number.isFinite(t) && t <= Date.parse(cutoff);
}

/**
 * Run extractors in parallel. One that fails or overruns `timeoutMs` adds an
 * error and nothing else; every record is re-checked against the cutoff (its
 * `asOf` and any `detail.publishedAt`) and dropped if later.
 */
export async function runExtractors(
  extractors: Extractor[],
  ctx: AttentionContext,
  opts: { timeoutMs?: number } = {},
): Promise<ExtractionRun> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const timings: Record<string, number> = {};
  const settled = await Promise.allSettled(
    extractors.map(async (x) => {
      const t0 = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          x.extract(ctx),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`timed out after ${timeoutMs} ms`)),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
        timings[x.name] = Date.now() - t0;
      }
    }),
  );
  const run: ExtractionRun = { features: [], dropped: [], errors: [], timings };
  settled.forEach((s, i) => {
    const name = extractors[i]!.name;
    if (s.status === "rejected") {
      run.errors.push({ extractor: name, error: getErrorMessage(s.reason) });
      return;
    }
    for (const f of s.value) {
      const published = f.detail?.publishedAt;
      const late =
        !atOrBefore(f.asOf, ctx.cutoff) ||
        (typeof published === "string" && !atOrBefore(published, ctx.cutoff)) ||
        !Number.isFinite(f.value);
      (late ? run.dropped : run.features).push(f);
    }
  });
  return run;
}

/** Features grouped by subject, then by feature name (the last record wins). */
export function featureIndex(
  features: AttentionFeature[],
): Map<string, Map<string, AttentionFeature>> {
  const out = new Map<string, Map<string, AttentionFeature>>();
  for (const f of features) {
    let m = out.get(f.subject);
    if (!m) out.set(f.subject, (m = new Map()));
    m.set(f.feature, f);
  }
  return out;
}

const logger = new Logger();

/** A rejection handler for one subject's failed read: logged at debug, then `fallback` (no record). */
export function skipOnError<T>(what: string, fallback: T): (err: unknown) => T {
  return logRejection(logger, "arena", `attention extraction: ${what} failed`, {
    level: "debug",
    fallback,
  });
}

export const DAY_MS = 86_400_000;
export const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (day: string, n: number) =>
  isoDay(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
