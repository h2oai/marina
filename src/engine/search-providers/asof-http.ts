// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared plumbing for the date-bounded ("as of") search providers:
 *   - `standaloneSearchHttp()` — the `SearchHttp` surface for callers that have
 *     no `ConnectorRuntime` (the research retriever, the search room): SSRF
 *     check, timeout and size cap, the same as the connector runtime;
 *   - `politeGet()` — a per-host minimum interval, so free public APIs are not
 *     hammered (GDELT asks for one request per few seconds);
 *   - timestamp formats the APIs want.
 */

import { guardedFetch, validateFetchUrl } from "../../net/url-guard";
import { CONNECTOR_HTTP_TIMEOUT_MS, CONNECTOR_MAX_BODY_BYTES } from "../constants";
import type { SearchHttp } from "./index";

/** Identify ourselves to public APIs (Wikipedia requires a descriptive agent). */
export const SEARCH_USER_AGENT = "Marina-search/1.0 (open source; https://github.com/h2oai/marina)";

type Reply = { status: number; body: string } | { error: string };

/** SSRF check → timeout-bounded fetch → size-capped body, with no per-entity limiter. */
export function standaloneSearchHttp(
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): SearchHttp {
  const timeoutMs = opts.timeoutMs ?? CONNECTOR_HTTP_TIMEOUT_MS * 2;
  const maxBytes = opts.maxBytes ?? CONNECTOR_MAX_BODY_BYTES * 2;
  const request = async (url: string, init: RequestInit): Promise<Reply> => {
    const urlError = await validateFetchUrl(url);
    if (urlError) return { error: urlError };
    try {
      const res = await guardedFetch(url, {
        ...init,
        headers: { "User-Agent": SEARCH_USER_AGENT, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.text();
      return { status: res.status, body: body.length > maxBytes ? body.slice(0, maxBytes) : body };
    } catch (err) {
      return { error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
  return {
    httpGet: (url: string) => request(url, { method: "GET" }),
    httpPost: (url: string, body: string) =>
      request(url, { method: "POST", body, headers: { "Content-Type": "application/json" } }),
  } as SearchHttp;
}

const lastCall = new Map<string, number>();
const queue = new Map<string, Promise<void>>();
/** Multiplies every host interval; tests set 0 so they never really sleep. */
let intervalScale = 1;

/**
 * GET with a per-host minimum interval (requests to one host run in order).
 * `entityId` rides on the first hop only — see the orchestrator's note.
 */
export async function politeGet(
  http: SearchHttp,
  url: string,
  minIntervalMs: number,
  entityId?: string,
): Promise<Reply> {
  const host = new URL(url).host;
  const prev = queue.get(host) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  queue.set(
    host,
    prev.then(() => mine),
  );
  await prev;
  try {
    const wait = (lastCall.get(host) ?? 0) + minIntervalMs * intervalScale - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    lastCall.set(host, Date.now());
    return await http.httpGet(url, entityId);
  } finally {
    release();
  }
}

/** Test hook: forget per-host timing and scale every interval (0 = never sleep). */
export function resetPoliteGetForTests(scale = 0): void {
  lastCall.clear();
  queue.clear();
  intervalScale = scale;
}

/** `YYYYMMDDHHMMSS` (UTC) — GDELT and the Wayback CDX API. */
export function compactStamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/** `YYYYMMDDHHMMSS` (or a prefix) → ISO, else undefined. */
export function fromCompactStamp(stamp: string | undefined): string | undefined {
  if (!stamp || !/^\d{8}/.test(stamp)) return undefined;
  const s = stamp.padEnd(14, "0");
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`;
  return Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString() : undefined;
}

/** Collapse whitespace and cut at a word boundary. */
export function clipText(text: string, max = 400): string {
  const s = text.replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(" ", max);
  return `${s.slice(0, cut > max / 2 ? cut : max)}…`;
}

/** Keep letters, digits, quotes and spaces — public search APIs reject most operators. */
export function plainQuery(query: string, maxChars = 200): string {
  return query
    .replace(/[^\p{L}\p{N}"'\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

export function parseJson<T>(body: string): T | undefined {
  try {
    return JSON.parse(body) as T;
  } catch {
    return undefined;
  }
}
