// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A numeric series' history exactly as it could be known before a cutoff,
 * for statistical priors (`./series-prior.ts`):
 *
 *   fred      FRED/ALFRED — with FRED_API_KEY, the observations as published
 *             on the last day before the cutoff (vintage-correct, so a past
 *             cutoff never sees a later release or revision); keyless only
 *             for a live cutoff (latest revision)
 *   yahoo     daily closes (Yahoo Finance chart API), split-adjusted with the
 *             splits that happened before the cutoff only — never the
 *             dividend-adjusted close, whose factors come from later payouts
 *   dbnomics  any DBnomics series (`provider/dataset/series`)
 *
 * Every point is dated before the cutoff's UTC day (a cutoff at 00:00 sees
 * the previous day's data, not that day's). Every request goes through the
 * URL guard (`./lookup-http.ts`); a source that fails returns an error, never
 * a partial history passed off as complete.
 */

import { type HttpResult, type LookupFetch, lookupFetch } from "./lookup-http";
import { fredAsOfDay } from "./lookup-series";
import { isLiveCutoff } from "./lookup-types";

export const SERIES_SOURCES = ["fred", "yahoo", "dbnomics"] as const;
export type SeriesSource = (typeof SERIES_SOURCES)[number];

export interface SeriesRef {
  source: SeriesSource;
  /** FRED series id, ticker, or DBnomics `provider/dataset/series`. */
  id: string;
}

export interface SeriesPoint {
  date: string;
  value: number;
}

export interface SeriesHistory {
  ref: SeriesRef;
  /** Oldest first, every one dated before the cutoff's day. */
  points: SeriesPoint[];
  /** The last day whose data could be known (YYYY-MM-DD). */
  lastDay: string;
  /** True when the source served the data as published then (vintage), not as revised since. */
  vintage: boolean;
  url: string;
}

export interface SeriesHistoryDeps {
  fredApiKey?: string;
  http?: LookupFetch;
  now?: () => Date;
  /** Years of history to read (default 15). */
  years?: number;
  /** Waits before retrying an HTTP 429 (default `RATE_LIMIT_BACKOFF_MS`; `[]` never retries). */
  backoffMs?: readonly number[];
}

const FRED_ID = /^[A-Za-z0-9][A-Za-z0-9_.]{1,39}$/;
const TICKER = /^[A-Za-z0-9^][A-Za-z0-9.^=-]{0,19}$/;
/** Three path segments, each starting with a letter or digit (never `.` or `..`). */
const DBNOMICS_ID =
  /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.@-]*$/;
const DAY_MS = 86_400_000;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The last day whose data a cutoff may see: the day before the cutoff's instant. */
export function lastVisibleDay(cutoff: Date): string {
  return isoDay(cutoff.getTime() - 1);
}

export function validSeriesRef(ref: SeriesRef): boolean {
  if (ref.source === "fred") return FRED_ID.test(ref.id);
  if (ref.source === "yahoo") return TICKER.test(ref.id);
  return DBNOMICS_ID.test(ref.id);
}

/** Waits before retrying a rate-limited request (HTTP 429); the source's quota resets within a minute. */
export const RATE_LIMIT_BACKOFF_MS = [2_000, 8_000, 30_000];

/** `http` with rate-limited requests retried after `backoff` (other failures return at once). */
export function retryRateLimited(
  http: LookupFetch,
  backoff: readonly number[] = RATE_LIMIT_BACKOFF_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): LookupFetch {
  const retry = async <T>(call: () => Promise<HttpResult<T>>): Promise<HttpResult<T>> => {
    let r = await call();
    for (const ms of backoff) {
      if (r.ok || !r.error.endsWith("HTTP 429")) return r;
      await sleep(ms);
      r = await call();
    }
    return r;
  };
  return {
    json: (url, init) => retry(() => http.json(url, init)),
    text: (url) => retry(() => http.text(url)),
  };
}

export async function seriesHistory(
  ref: SeriesRef,
  cutoff: Date,
  deps: SeriesHistoryDeps = {},
): Promise<SeriesHistory | { error: string }> {
  if (!validSeriesRef(ref)) return { error: `not a ${ref.source} series id` };
  const now = deps.now?.() ?? new Date();
  if (cutoff.getTime() > now.getTime()) cutoff = now;
  const http = retryRateLimited(deps.http ?? lookupFetch(ref.source), deps.backoffMs);
  const last = lastVisibleDay(cutoff);
  const start = isoDay(cutoff.getTime() - (deps.years ?? 15) * 365.25 * DAY_MS);
  const got =
    ref.source === "fred"
      ? await fred(http, ref.id, cutoff, now, start, deps.fredApiKey)
      : ref.source === "yahoo"
        ? await yahoo(http, ref.id, start, last)
        : await dbnomics(http, ref.id);
  if ("error" in got) return got;
  const points = got.points
    .filter((p) => p.date >= start && p.date <= last && Number.isFinite(p.value))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (points.length === 0) return { error: `${ref.source}: no observation before the cutoff` };
  return { ref, points, lastDay: last, vintage: got.vintage, url: got.url };
}

type Got = { points: SeriesPoint[]; vintage: boolean; url: string } | { error: string };

async function fred(
  http: LookupFetch,
  id: string,
  cutoff: Date,
  now: Date,
  start: string,
  key: string | undefined,
): Promise<Got> {
  const url = `https://fred.stlouisfed.org/series/${encodeURIComponent(id)}`;
  if (key) {
    // Real-time as of the last visible day: the vintage the cutoff could read.
    const d = fredAsOfDay(new Date(cutoff.getTime() - 1), now);
    const r = await http.json<{ observations?: Array<{ date: string; value: string }> }>(
      `https://api.stlouisfed.org/fred/series/observations?${new URLSearchParams({
        series_id: id,
        api_key: key,
        file_type: "json",
        realtime_start: d,
        realtime_end: d,
        observation_start: start,
        observation_end: d,
      })}`,
    );
    const toPoints = (obs: Array<{ date: string; value: string }> = []) =>
      obs
        .map((o) => ({ date: o.date, value: Number(o.value) }))
        .filter((p) => Number.isFinite(p.value));
    if (r.ok) return { points: toPoints(r.value.observations), vintage: true, url };
    // ALFRED keeps no vintages for some series (licensed market prices such as SP500, which
    // are never revised): read the observations themselves, dated before the cutoff, and
    // label them as not vintage.
    if (!r.error.endsWith("HTTP 400")) return { error: r.error };
    const latest = await http.json<{ observations?: Array<{ date: string; value: string }> }>(
      `https://api.stlouisfed.org/fred/series/observations?${new URLSearchParams({
        series_id: id,
        api_key: key,
        file_type: "json",
        observation_start: start,
        observation_end: d,
      })}`,
    );
    if (!latest.ok) return { error: latest.error };
    return { points: toPoints(latest.value.observations), vintage: false, url };
  }
  if (!isLiveCutoff(cutoff, now)) {
    return { error: "fred: a past cutoff needs FRED_API_KEY (vintage data)" };
  }
  const r = await http.text(
    `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`,
  );
  if (!r.ok) return { error: r.error };
  const points = r.value
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.split(","))
    .map(([date, value]) => ({ date: date ?? "", value: Number(value) }));
  return { points, vintage: false, url };
}

interface YahooChart {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
      events?: {
        splits?: Record<string, { date: number; numerator: number; denominator: number }>;
      };
    }>;
  };
}

async function yahoo(http: LookupFetch, ticker: string, start: string, last: string): Promise<Got> {
  const p1 = Math.floor(Date.parse(`${start}T00:00:00Z`) / 1000);
  const p2 = Math.floor(Date.parse(`${last}T23:59:59Z`) / 1000);
  const r = await http.json<YahooChart>(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?${new URLSearchParams(
      { period1: String(p1), period2: String(p2), interval: "1d", events: "split" },
    )}`,
  );
  if (!r.ok) return { error: r.error };
  const res = r.value.chart?.result?.[0];
  const ts = res?.timestamp ?? [];
  const close = res?.indicators?.quote?.[0]?.close ?? [];
  // Restate earlier closes in post-split terms, with splits up to the last visible day only.
  const splits = Object.values(res?.events?.splits ?? {})
    .filter((s) => s.numerator > 0 && s.denominator > 0 && isoDay(s.date * 1000) <= last)
    .map((s) => ({ day: isoDay(s.date * 1000), ratio: s.numerator / s.denominator }));
  const points: SeriesPoint[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = close[i];
    if (c === null || c === undefined) continue;
    const day = isoDay(ts[i]! * 1000);
    let v = c;
    for (const s of splits) if (day < s.day) v /= s.ratio;
    points.push({ date: day, value: v });
  }
  return {
    points,
    vintage: true,
    url: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}`,
  };
}

async function dbnomics(http: LookupFetch, id: string): Promise<Got> {
  const r = await http.json<{
    series?: { docs?: Array<{ period?: string[]; value?: Array<number | string | null> }> };
  }>(`https://api.db.nomics.world/v22/series/${id}?observations=1&format=json`);
  if (!r.ok) return { error: r.error };
  const doc = r.value.series?.docs?.[0];
  if (!doc?.period) return { error: "dbnomics: series not found" };
  const points: SeriesPoint[] = [];
  doc.period.forEach((date, i) => {
    const v = doc.value?.[i];
    const day = /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? date
      : /^\d{4}-\d{2}$/.test(date)
        ? `${date}-01`
        : undefined;
    if (typeof v === "number" && day) points.push({ date: day, value: v });
  });
  // DBnomics serves the current revision; for observational series (weather, prices) it is
  // what was known then, and only points before the cutoff day are kept.
  return { points, vintage: false, url: `https://db.nomics.world/${id}` };
}
