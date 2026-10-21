// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * robots.txt for page reads (RFC 9309).
 *
 * When Marina reads an arbitrary third-party PAGE on behalf of an agent or a
 * person — `web fetch`, the read swarm, the research page reader, the citation
 * check — it first asks the site's robots.txt whether its research user agent
 * (`MarinaResearch`) may read that path. API calls (search providers, model
 * APIs, venue and data APIs) are not page reads and never come through here.
 *
 * - Groups: the group(s) naming `MarinaResearch` (case-insensitive product
 *   token) apply; otherwise the `*` group(s); otherwise everything is allowed.
 *   Groups with the same agent are merged.
 * - Rules: the longest matching `Allow`/`Disallow` pattern wins, `Allow` on a
 *   tie; `*` matches any run of characters and a trailing `$` anchors the end.
 *   `/robots.txt` itself is always allowed.
 * - Fetch: through `guardedFetch` (SSRF guard, every redirect hop re-checked,
 *   at most 5 hops), 5 s timeout, the first 512 KiB parsed.
 * - Status: 2xx is parsed; 4xx (including 401/403/404) means "no rules" —
 *   allowed; 5xx, 429, a network error or a timeout is treated as allowed
 *   (fail-open, common crawler practice for single on-demand reads) and
 *   retried after a short cache period. RFC 9309 asks crawlers to assume a
 *   full disallow while robots.txt is unreachable; Marina's reads are single
 *   user-directed pages, not crawls, so an outage of a site's robots.txt does
 *   not stop a read of a page the same server may well be serving.
 * - Cache: per origin, 24 h for a parsed file or a 4xx, 10 min after an
 *   unreachable fetch; concurrent checks of one origin share one fetch.
 *
 * Operator overrides (env, read per call): `MARINA_ROBOTS_TXT=respect|ignore`
 * (default respect) and `MARINA_ROBOTS_TXT_IGNORE_ORIGINS` — comma-separated
 * origins (or bare hosts) the operator owns or has permission to read, which
 * skip the check.
 */

import { guardedFetch } from "./url-guard";

/** The identifying user agent of every research page read. */
export const RESEARCH_USER_AGENT =
  "Mozilla/5.0 (compatible; MarinaResearch/1.1; citation check; +https://github.com/h2oai/marina)";
/** The product token robots.txt groups are matched against. */
export const RESEARCH_UA_TOKEN = "MarinaResearch";

/** Prefix of every refusal reason; callers can match on it. */
export const ROBOTS_BLOCKED = "blocked by robots.txt";

export const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
export const ROBOTS_RETRY_TTL_MS = 10 * 60 * 1000;
export const ROBOTS_TIMEOUT_MS = 5_000;
export const ROBOTS_MAX_BYTES = 512 * 1024;
const CACHE_MAX_ORIGINS = 2_048;

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsGroup {
  /** Lower-cased product tokens of the group's `User-agent` lines. */
  agents: string[];
  rules: RobotsRule[];
}

export type RobotsVerdict =
  | { allowed: true; via: "ignored" | "rules" | "no-rules" | "unreachable" | "not-http" }
  | { allowed: false; reason: string };

export type RobotsFetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface RobotsOptions {
  /** Injected for tests and for callers with their own transport (default `guardedFetch`). */
  fetcher?: RobotsFetcher;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

// ─── Parsing ────────────────────────────────────────────────────────────────

/** The product token of a `User-agent` value: `MarinaResearch/1.1` → `marinaresearch`. */
function agentToken(value: string): string {
  return (value.trim().split(/[\s/]/)[0] ?? "").toLowerCase();
}

/** The groups of a robots.txt file. Lines outside a group and unknown keys are ignored. */
export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;
  let lastWasAgent = false;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      const token = agentToken(value);
      if (token) current.agents.push(token);
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      lastWasAgent = false;
      if (!current) continue;
      // An empty Disallow allows everything: no rule.
      if (!value) continue;
      current.rules.push({ allow: key === "allow", pattern: value });
    }
    // sitemap, crawl-delay, …: not group members, and they do not end an agent run.
  }
  return groups;
}

const patternCache = new Map<string, RegExp>();

function patternRegex(pattern: string): RegExp {
  let re = patternCache.get(pattern);
  if (re) return re;
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  re = new RegExp(`^${body}${anchored ? "$" : ""}`);
  if (patternCache.size > 4_096) patternCache.clear();
  patternCache.set(pattern, re);
  return re;
}

/** Upper-case percent escapes so `%2f` and `%2F` compare equal. */
function normalizeEscapes(s: string): string {
  return s.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
}

/**
 * True when `path` (path plus query, starting with `/`) may be read by the
 * agent `token` under `groups`: its own groups, else `*`, else everything.
 */
export function robotsAllowsPath(
  groups: readonly RobotsGroup[],
  token: string,
  path: string,
): boolean {
  const own = token.toLowerCase();
  let chosen = groups.filter((g) => g.agents.includes(own));
  if (chosen.length === 0) chosen = groups.filter((g) => g.agents.includes("*"));
  if (chosen.length === 0) return true;
  const target = normalizeEscapes(path || "/");
  if (target === "/robots.txt") return true;
  let best: RobotsRule | undefined;
  for (const g of chosen) {
    for (const rule of g.rules) {
      if (!patternRegex(normalizeEscapes(rule.pattern)).test(target)) continue;
      if (
        !best ||
        rule.pattern.length > best.pattern.length ||
        (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
      ) {
        best = rule;
      }
    }
  }
  return best ? best.allow : true;
}

// ─── Settings ───────────────────────────────────────────────────────────────

/** `MARINA_ROBOTS_TXT`: `ignore` (also off/false/0/no) skips every check; anything else respects. */
export function robotsMode(env: NodeJS.ProcessEnv = process.env): "respect" | "ignore" {
  const v = env.MARINA_ROBOTS_TXT?.trim().toLowerCase();
  return v === "ignore" || v === "off" || v === "false" || v === "0" || v === "no"
    ? "ignore"
    : "respect";
}

/** True when `MARINA_ROBOTS_TXT_IGNORE_ORIGINS` names the URL's origin (or its bare host). */
export function robotsIgnoredOrigin(url: URL, env: NodeJS.ProcessEnv = process.env): boolean {
  const list = env.MARINA_ROBOTS_TXT_IGNORE_ORIGINS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list?.length) return false;
  const host = url.hostname.toLowerCase();
  return list.some((entry) => {
    if (/^https?:\/\//i.test(entry)) {
      try {
        return new URL(entry).origin === url.origin;
      } catch {
        return false;
      }
    }
    return entry.toLowerCase().replace(/\/+$/, "") === host;
  });
}

// ─── Cache + fetch ──────────────────────────────────────────────────────────

type Entry = { groups: RobotsGroup[] | "allow-all"; unreachable: boolean; expiresAt: number };

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();

/** Drop every cached robots.txt (tests; an operator who changed their own file). */
export function clearRobotsCache(): void {
  cache.clear();
  inflight.clear();
}

async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let read = 0;
  let out = "";
  try {
    while (read < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.byteLength > maxBytes - read ? value.subarray(0, maxBytes - read) : value;
      read += chunk.byteLength;
      out += decoder.decode(chunk, { stream: true });
    }
    out += decoder.decode();
  } finally {
    // allow-empty-catch: releasing a body read that is already done or capped
    await reader.cancel().catch(() => undefined);
  }
  return out;
}

async function fetchRobots(origin: string, fetcher: RobotsFetcher, now: number): Promise<Entry> {
  const unreachable = (): Entry => ({
    groups: "allow-all",
    unreachable: true,
    expiresAt: now + ROBOTS_RETRY_TTL_MS,
  });
  let res: Response;
  try {
    res = await fetcher(`${origin}/robots.txt`, {
      signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
      headers: { "User-Agent": RESEARCH_USER_AGENT, Accept: "text/plain,*/*;q=0.5" },
    });
  } catch {
    return unreachable();
  }
  if (res.status >= 200 && res.status < 300) {
    try {
      const text = await readCappedText(res, ROBOTS_MAX_BYTES);
      return { groups: parseRobots(text), unreachable: false, expiresAt: now + ROBOTS_TTL_MS };
    } catch {
      return unreachable();
    }
  }
  // allow-empty-catch: discarding the body of a response with no rules to read
  await res.body?.cancel().catch(() => undefined);
  if (res.status === 429 || res.status >= 500) return unreachable();
  // 4xx (and a 3xx left unfollowed): the site publishes no rules.
  return { groups: "allow-all", unreachable: false, expiresAt: now + ROBOTS_TTL_MS };
}

const guardedRobotsFetcher: RobotsFetcher = (url, init) => guardedFetch(url, init, { maxHops: 5 });
let defaultFetcher: RobotsFetcher = guardedRobotsFetcher;

/** Replace the default robots.txt transport (tests only; `null` restores `guardedFetch`). */
export function __setRobotsFetcherForTest(fetcher: RobotsFetcher | null): void {
  defaultFetcher = fetcher ?? guardedRobotsFetcher;
}

async function entryFor(origin: string, opts: RobotsOptions): Promise<Entry> {
  const now = opts.now?.() ?? Date.now();
  const hit = cache.get(origin);
  if (hit && hit.expiresAt > now) return hit;
  const pending = inflight.get(origin);
  if (pending) return pending;
  const p = fetchRobots(origin, opts.fetcher ?? defaultFetcher, now).then((entry) => {
    cache.delete(origin);
    cache.set(origin, entry);
    while (cache.size > CACHE_MAX_ORIGINS) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return entry;
  });
  inflight.set(origin, p);
  try {
    return await p;
  } finally {
    inflight.delete(origin);
  }
}

/** The refusal text for a page robots.txt disallows. */
export function robotsBlockedReason(url: URL): string {
  return `${ROBOTS_BLOCKED}: ${url.origin} disallows ${url.pathname}${url.search} for ${RESEARCH_UA_TOKEN}`;
}

/**
 * May Marina's research agent read `url`? Never throws: a malformed or
 * non-http(s) URL is left to the caller's own checks (`not-http`).
 */
export async function robotsCheck(url: string, opts: RobotsOptions = {}): Promise<RobotsVerdict> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { allowed: true, via: "not-http" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { allowed: true, via: "not-http" };
  const env = opts.env ?? process.env;
  if (robotsMode(env) === "ignore" || robotsIgnoredOrigin(u, env)) {
    return { allowed: true, via: "ignored" };
  }
  const entry = await entryFor(u.origin, opts);
  if (entry.groups === "allow-all") {
    return { allowed: true, via: entry.unreachable ? "unreachable" : "no-rules" };
  }
  return robotsAllowsPath(entry.groups, RESEARCH_UA_TOKEN, `${u.pathname}${u.search}`)
    ? { allowed: true, via: "rules" }
    : { allowed: false, reason: robotsBlockedReason(u) };
}
