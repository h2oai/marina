// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A live Civiqs reading, for OPEN rounds only.
 *
 * The nowcast's edge is freshness: the arena's archive (`civiqs/…`) is pushed
 * irregularly by a courier, so two days before a Wednesday lock the newest
 * archived snapshot may be days old while the dashboard has already moved —
 * and Civiqs republishes its whole daily history nightly, so even a reading
 * for an already-archived day can have been revised. Reading the dashboard
 * itself just before filing gives exactly what the arena will read, the way
 * the arena reads it (a port of `ssa/adapters/civiqs.py`: the Remix loader
 * payload, fractions → points, subgroup filters verified to have applied).
 *
 * Never used for a round whose lock has passed: a backtest must see only what
 * existed at its lock, which is the archive's job. One request per tracker,
 * through the SSRF guard. Civiqs's results terms allow downloading results
 * with their notices intact; there is no API, and the arena reads the same page.
 */

import { guardedFetch } from "../../net/url-guard";

export const CIVIQS_RESULTS_URL = "https://civiqs.com/results/";
const QUESTION_ROUTE = "routes/_app.results_.$question";
const USER_AGENT = "marina-arena/1.0 (Social Simulation Arena entrant; github.com/h2oai/marina)";
const TIMEOUT_MS = 60_000;
const MAX_BYTES = 12 * 1024 * 1024;
/** The arena archives the last 60 days per snapshot; the nowcast reads the last point. */
const SNAPSHOT_POINTS = 60;

export type CiviqsFetch = (url: string) => Promise<Response>;

/** The archive snapshot shape (`civiqs/<dir>/<day>.json`), which the nowcast already reads. */
export interface CiviqsLiveSnapshot {
  choices: string[];
  display_net?: { minuend: string[]; subtrahend: string[] };
  end_date?: string;
  fetched_at: string;
  url: string;
  points: Array<[string, ...number[]]>;
}

export function civiqsLiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MARINA_ARENA_CIVIQS_LIVE?.trim().toLowerCase() !== "off";
}

/** The page URL; filter values are percent-encoded (`65+` must travel as `65%2B`). */
export function civiqsUrl(name: string, filters?: Record<string, string>): string {
  const entries = Object.entries(filters ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return CIVIQS_RESULTS_URL + name;
  const q = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return `${CIVIQS_RESULTS_URL}${name}?${q.join("&")}`;
}

/** The JSON object a Remix route key points at (brace-balanced, string-aware). */
export function extractRoute(html: string, route: string): unknown {
  const marker = `"${route}":`;
  const i = html.indexOf(marker);
  if (i < 0) return undefined;
  const j = html.indexOf("{", i + marker.length);
  if (j < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let k = j; k < html.length; k++) {
    const c = html[k];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return JSON.parse(html.slice(j, k + 1));
    }
  }
  return undefined;
}

interface Payload {
  end_date?: string;
  job_description?: {
    display_net?: { minuend?: string | string[]; subtrahend?: string | string[] };
  };
  topline?: {
    line_chart_data?: Array<{ key: string; values: Array<{ date: number; value: number }> }>;
    filtered_topline?: unknown;
    unfiltered_topline?: unknown;
  };
}

const side = (x: string | string[] | undefined) =>
  x === undefined ? undefined : Array.isArray(x) ? x.map(String) : [x];

/** Build the archive-shaped snapshot from a page (throws on anything it can't trust). */
export function parseCiviqsPage(
  html: string,
  url: string,
  filtered: boolean,
  fetchedAt = new Date(),
): CiviqsLiveSnapshot {
  const payload = extractRoute(html, QUESTION_ROUTE) as Payload | undefined;
  const series = payload?.topline?.line_chart_data;
  if (!payload || !series?.length) {
    throw new Error(`no Civiqs tracker payload at ${url} (unknown tracker, or the page changed)`);
  }
  // An unrecognised filter label is silently ignored and returns the NATIONAL
  // series — the worst failure available. An applied filter changes the topline.
  if (
    filtered &&
    JSON.stringify(payload.topline?.filtered_topline) ===
      JSON.stringify(payload.topline?.unfiltered_topline)
  ) {
    throw new Error(`Civiqs subgroup filter did not apply at ${url}`);
  }
  const choices = series.map((s) => s.key);
  // Civiqs dates are epoch ms at UTC midnight; values are fractions.
  const cols = series.map(
    (s) =>
      new Map(
        s.values.map((v) => [
          new Date(v.date).toISOString().slice(0, 10),
          Math.round(v.value * 100 * 100) / 100,
        ]),
      ),
  );
  const dates = [...new Set(cols.flatMap((c) => [...c.keys()]))].sort().slice(-SNAPSHOT_POINTS);
  if (!dates.length) throw new Error(`Civiqs page at ${url} has no dated points`);
  const net = payload.job_description?.display_net;
  const minuend = side(net?.minuend);
  const subtrahend = side(net?.subtrahend);
  return {
    choices,
    ...(minuend?.length && subtrahend?.length ? { display_net: { minuend, subtrahend } } : {}),
    ...(payload.end_date ? { end_date: payload.end_date } : {}),
    fetched_at: fetchedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
    url,
    // A day a choice lacks is null, as in the archive (the nowcast skips it).
    points: dates.map((d) => [d, ...cols.map((c) => c.get(d) ?? null)]) as Array<
      [string, ...number[]]
    >,
  };
}

/** At most one request per this interval, as the arena's own reader paces itself. */
const MIN_INTERVAL_MS = 600;
let queue: Promise<unknown> = Promise.resolve();
let lastCall = 0;

function paced<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastCall + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  queue = run.catch(() => undefined);
  return run;
}

const defaultFetch: CiviqsFetch = (url) =>
  paced(() =>
    guardedFetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  );

/** Read one tracker (optionally a subgroup) from the live dashboard. */
export async function fetchCiviqsLive(
  name: string,
  filters?: Record<string, string>,
  fetcher: CiviqsFetch = defaultFetch,
): Promise<CiviqsLiveSnapshot> {
  const url = civiqsUrl(name, filters);
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`Civiqs ${res.status} for ${url}`);
  const html = await res.text();
  if (html.length > MAX_BYTES) throw new Error(`Civiqs page too large at ${url}`);
  return parseCiviqsPage(html, url, Object.keys(filters ?? {}).length > 0);
}
