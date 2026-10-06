// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `search` — evidence retrieval that reads the pages itself, for forecasting,
 * typed answers and research crews. Where `openrouter-web:` asks ONE model to
 * search and summarise, this retriever:
 *
 *   1. searches EVERY brief query (the planner's decomposition: entities,
 *      latest news, the resolution source, official data, base rates);
 *   2. through a backend chain — Tavily, Exa, SearXNG, DuckDuckGo, then
 *      OpenRouter's Exa plugin, whichever this installation has, in that order. A backend that fails (a key out
 *      of credit answers HTTP 432, an outage, the daily spend cap) is recorded
 *      in the search-health ledger (shown by `readiness`), skipped for the
 *      rest of the brief, and the next backend answers the same query. Every
 *      failure rides on the report's funnel; only ALL backends failing is an
 *      error — never a silent zero. Wikipedia (as of the cutoff) adds
 *      background for the first query;
 *   3. fuses the hits (reciprocal rank across queries), caps pages per domain
 *      for source diversity and, for a live question, prefers recent pages;
 *   4. reads the pages in parallel (SSRF guard, per-page timeout, size cap,
 *      never a `NO_FETCH_DOMAINS` publisher), extracts the main text and the
 *      publication date;
 *   5. selects the passages most relevant to the question (BM25 over every
 *      page's passages, not the head of each page) within a character budget
 *      the caller sizes to the model's context window.
 *
 * Each selected passage becomes one report line quoting the page verbatim:
 *   `- <date|undated> — "<passage>" [<title>](<url>)`
 * and the page text rides on the `Source`, so the citation check verifies the
 * line against the same text — figures and, for a line without figures, the
 * quote itself. Pages dated after the brief's cutoff are dropped; undated
 * pages stay (this engine is not date-strict — use `asof` for backtests).
 * Paid backends check the daily spend cap and record their cost (`search`).
 */

import { extractPublishedDate, extractReadableText } from "../../engine/html-text";
import { standaloneSearchHttp } from "../../engine/search-providers/asof-http";
import { dateBoundProvider } from "../../engine/search-providers/asof-providers";
import { duckDuckGoProvider } from "../../engine/search-providers/duckduckgo";
import { recordSearchOutcome, searchBackendDown } from "../../engine/search-providers/health";
import type { SearchHttp, SearchProvider, SearchResult } from "../../engine/search-providers/index";
import { searxngProvider } from "../../engine/search-providers/searxng";
import { tavilyProvider } from "../../engine/search-providers/tavily";
import { dailyCapRefusal, recordSpend } from "../../engine/spend-ledger";
import { guardedFetch } from "../../net/url-guard";
import type { ResearchBrief, SourceExclusion } from "./briefs";
import type { ResearchReport, Retriever, Source } from "./retrieve";
import { fetchAllowed, readCapped, VERIFY_USER_AGENT } from "./verify";

/** One backend's share of a brief: calls, results and the last failure. */
export interface BackendUse {
  name: string;
  calls: number;
  results: number;
  failures: number;
  error?: string;
}

/**
 * Where evidence was found and lost, stage by stage — kept on the report and
 * in the forecast's audit trail, so a thin dossier says why it is thin.
 */
export interface RetrievalFunnel {
  retriever: string;
  queries: number;
  backends: BackendUse[];
  /** Search results returned (all queries, all backends). */
  hits: number;
  /** Distinct pages among them. */
  unique: number;
  /** Pages kept after the per-domain cap and the page budget. */
  kept: number;
  /** Pages dropped as published after the cutoff. */
  afterCutoff: number;
  /** Pages read (fetched, or text the backend already held). */
  read: number;
  /** Page reads that failed (HTTP error, bot wall, timeout, not text). */
  readFailed: number;
  /** Pages never fetched (`NO_FETCH_DOMAINS`). */
  noFetch: number;
  /** Characters of main text extracted from the pages read. */
  extractedChars: number;
  /** Settlement pages (`brief.readFirst`) read. */
  settlement: number;
  /** Passages dropped by the relevance gate (far below the best passage). */
  belowRelevance: number;
  /** Passages selected for the report, and their characters. */
  passages: number;
  passageChars: number;
  /** Pages dropped because the brief bars them (`brief.exclude`); absent when nothing is barred. */
  excluded?: number;
}

export interface WebSearchOptions {
  /** Backends in fallback order (default: `searchBackendsFromEnv`). */
  backends?: SearchProvider[];
  /** Background backend for the first query (default Wikipedia as of the cutoff; null = none). */
  background?: SearchProvider | null;
  http?: SearchHttp;
  /** Reads one page: HTML or text, or undefined (default: guarded fetch). */
  fetchPage?: (url: string) => Promise<{ body: string; contentType: string } | undefined>;
  /** Queries searched per brief (default 8). */
  maxQueries?: number;
  /** Results asked per query (default 8). */
  perQuery?: number;
  /** Pages kept per domain (default 3). */
  domainCap?: number;
  /** Pages read per brief (default 14). */
  maxPages?: number;
  /**
   * Characters of passages in the report. Unset: the brief's `maxChars` (the
   * caller's budget for the model's context window), else 16 000.
   */
  passageChars?: number;
  /** Passages kept per brief — the top-k relevance cut (default 15). */
  maxPassages?: number;
  /** Passages per page (default 3). */
  perPage?: number;
  now?: () => Date;
}

/** Defaults, also read by `retrieverFromSpec` from the environment. */
export const WEB_SEARCH_DEFAULTS = {
  maxQueries: 8,
  perQuery: 8,
  domainCap: 3,
  maxPages: 14,
  passageChars: 16_000,
  maxPassages: 15,
  perPage: 3,
} as const;

/** Per-page fetch timeout and size cap. */
const PAGE_TIMEOUT_MS = 10_000;
const PAGE_MAX_BYTES = 4 * 1024 * 1024;
const FETCH_CONCURRENCY = 6;
const SEARCH_CONCURRENCY = 3;
/** Page text kept on a source for the citation check. */
const SOURCE_TEXT_CHARS = 200_000;
/** Passage length bounds. */
const PASSAGE_MIN = 60;
const PASSAGE_MAX = 700;
/** A cutoff within this of now is a live question (recency preferred). */
const LIVE_SLACK_MS = 2 * 86_400_000;

// ─── Backends ────────────────────────────────────────────────────────────────

const EXA_SEARCH_URL = "https://api.exa.ai/search";
/** Exa's list price per search with contents (an estimate; plans differ). */
export const EXA_USD_PER_SEARCH = 0.006;

/** Exa as a search backend: results carry page text, priced per search. */
export function exaSearchProvider(
  apiKey: string,
  fetcher?: (url: string, init: RequestInit) => Promise<Response>,
): SearchProvider {
  return {
    name: "exa",
    engines: ["web", "news"],
    async search(query, opts) {
      const capped = dailyCapRefusal();
      if (capped) throw new Error(`exa: ${capped}`);
      // The key travels in a header, which the shared SearchHttp surface does
      // not carry: a direct call, through the same SSRF guard.
      let status: number;
      let body: string;
      try {
        const res = await (fetcher ?? guardedFetch)(EXA_SEARCH_URL, {
          method: "POST",
          headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            query,
            type: "auto",
            numResults: opts.maxResults ?? 8,
            ...(opts.before ? { endPublishedDate: opts.before } : {}),
            contents: { text: { maxCharacters: 8_000 } },
          }),
          signal: AbortSignal.timeout(30_000),
        });
        status = res.status;
        body = await res.text();
      } catch (err) {
        throw new Error(`exa: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (status !== 200) throw new Error(`exa HTTP ${status}: ${body.slice(0, 160)}`);
      let data: {
        results?: Array<{ url?: string; title?: string; publishedDate?: string; text?: string }>;
        costDollars?: { total?: number };
      };
      try {
        data = JSON.parse(body);
      } catch {
        throw new Error("exa: unreadable reply");
      }
      const usd = data.costDollars?.total ?? EXA_USD_PER_SEARCH;
      recordSpend("search", usd);
      if (opts.spend) opts.spend.usd += usd;
      return (data.results ?? []).flatMap((r) =>
        r.url
          ? [
              {
                title: r.title ?? "",
                url: r.url,
                snippet: (r.text ?? "").slice(0, 400),
                source: "exa",
                ...(isoInstant(r.publishedDate) ? { published: isoInstant(r.publishedDate) } : {}),
                ...(r.text ? { text: r.text } : {}),
              },
            ]
          : [],
      );
    },
  };
}

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
/** The model that carries an `openrouter` search (it writes nothing; the plugin searches). */
export const DEFAULT_OPENROUTER_SEARCH_MODEL = "openai/gpt-6-luna";

/**
 * OpenRouter's web plugin on Exa as a plain search backend: one minimal chat
 * call per query whose url_citation annotations ARE the results (url, title,
 * page excerpt). Priced per call (the plugin's results plus the injected
 * prompt), recorded as source `search`, refused at the daily cap.
 */
export function openRouterSearchProvider(
  apiKey: string,
  model: string = DEFAULT_OPENROUTER_SEARCH_MODEL,
  fetcher?: (url: string, init: RequestInit) => Promise<Response>,
): SearchProvider {
  return {
    name: "openrouter",
    engines: ["web", "news"],
    async search(query, opts) {
      const capped = dailyCapRefusal();
      if (capped) throw new Error(`openrouter: ${capped}`);
      let status: number;
      let body: string;
      try {
        const res = await (fetcher ?? guardedFetch)(OPENROUTER_CHAT_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: query }],
            plugins: [{ id: "web", engine: "exa", max_results: opts.maxResults ?? 8 }],
            max_tokens: 16,
            reasoning: { effort: "minimal" },
          }),
          signal: AbortSignal.timeout(60_000),
        });
        status = res.status;
        body = await res.text();
      } catch (err) {
        throw new Error(`openrouter: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (status !== 200) throw new Error(`openrouter HTTP ${status}: ${body.slice(0, 160)}`);
      let data: {
        choices?: Array<{
          message?: {
            annotations?: Array<{
              url_citation?: { url?: string; title?: string; content?: string };
            }>;
          };
        }>;
        usage?: { cost?: number };
      };
      try {
        data = JSON.parse(body);
      } catch {
        throw new Error("openrouter: unreadable reply");
      }
      recordSpend("search", data.usage?.cost);
      if (opts.spend) opts.spend.usd += data.usage?.cost ?? 0;
      return (data.choices?.[0]?.message?.annotations ?? []).flatMap((a) => {
        const c = a.url_citation;
        if (!c?.url) return [];
        return [
          {
            title: c.title ?? "",
            url: c.url,
            snippet: (c.content ?? "").slice(0, 400),
            source: "openrouter",
            ...(c.content ? { text: c.content } : {}),
          },
        ];
      });
    },
  };
}

/** Backend names `MARINA_RESEARCH_SEARCH_BACKENDS` accepts. */
export const WEB_SEARCH_BACKEND_NAMES = [
  "tavily",
  "exa",
  "searxng",
  "duckduckgo",
  "openrouter",
] as const;

/**
 * The backend chain: `MARINA_RESEARCH_SEARCH_BACKENDS` (comma-separated names,
 * in order) or, unset, every configured one — Tavily (TAVILY_API_KEY), Exa
 * (EXA_API_KEY), SearXNG (SEARXNG_URL) — then keyless DuckDuckGo, then
 * OpenRouter's Exa plugin (OPENROUTER_API_KEY) as the paid fallback when the
 * free engine is throttled. A named backend without its key is left out and
 * reported in `skipped`.
 */
export function searchBackendsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  backends: SearchProvider[];
  skipped: string[];
} {
  const listed = env.MARINA_RESEARCH_SEARCH_BACKENDS?.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const names = listed?.length ? listed : [...WEB_SEARCH_BACKEND_NAMES];
  const backends: SearchProvider[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    const tavily = env.TAVILY_API_KEY?.trim();
    const exa = env.EXA_API_KEY?.trim();
    const searx = env.SEARXNG_URL?.trim();
    if (name === "tavily") {
      if (tavily) backends.push(tavilyProvider(tavily));
      else if (listed) skipped.push("tavily (no TAVILY_API_KEY)");
    } else if (name === "exa") {
      if (exa) backends.push(exaSearchProvider(exa));
      else if (listed) skipped.push("exa (no EXA_API_KEY)");
    } else if (name === "searxng") {
      if (searx) backends.push(searxngProvider(searx));
      else if (listed) skipped.push("searxng (no SEARXNG_URL)");
    } else if (name === "duckduckgo") {
      backends.push(duckDuckGoProvider());
    } else if (name === "openrouter") {
      const key = env.OPENROUTER_API_KEY?.trim();
      if (key) {
        backends.push(
          openRouterSearchProvider(
            key,
            env.MARINA_RESEARCH_SEARCH_MODEL?.trim() || DEFAULT_OPENROUTER_SEARCH_MODEL,
          ),
        );
      } else if (listed) skipped.push("openrouter (no OPENROUTER_API_KEY)");
    } else {
      throw new Error(`unknown search backend "${name}" (${WEB_SEARCH_BACKEND_NAMES.join(", ")})`);
    }
  }
  return { backends, skipped };
}

// ─── Text helpers ────────────────────────────────────────────────────────────

function isoInstant(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** One report line's worth of text: markdown links reduced, brackets dropped, whitespace collapsed. */
export function oneLine(text: string, max = PASSAGE_MAX): string {
  let s = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[[\]"“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) {
    const cut = s.lastIndexOf(" ", max);
    s = s.slice(0, cut > max / 2 ? cut : max);
  }
  return s;
}

/** A page's identity for de-duplication: scheme-less, no tracking params, no trailing slash. */
export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|ref_src|cmpid|ocid)/i.test(k)) u.searchParams.delete(k);
    }
    const host = u.hostname.toLowerCase().replace(/^www\.|^m\.|^amp\./, "");
    return `${host}${u.pathname.replace(/\/amp\/?$|\.amp(?=\.|$)|\/+$/g, "")}${u.search}`;
  } catch {
    return url.toLowerCase();
  }
}

/** A title folded for matching: lower case, letters/digits/CJK only, single spaces. */
function foldTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Shortest barred title matched by containment: shorter ones match unrelated pages by chance. */
const MIN_BARRED_TITLE = 16;

/**
 * Page keys a URL can stand for: its own, plus any URL embedded in its path or
 * query — a reader proxy (`r.jina.ai/https://…`), an archive
 * (`web.archive.org/web/2025/…`) or a redirector (`?url=https%3A%2F%2F…`)
 * serves the embedded page, so a bar on that page bars them too. Lower case:
 * a bar errs toward refusing.
 */
export function embeddedPageKeys(url: string): string[] {
  const keys = [pageKey(url).toLowerCase()];
  let rest: string;
  try {
    const u = new URL(url);
    rest = `${u.pathname}${u.search}`;
  } catch {
    return keys;
  }
  for (let i = 0; i < 2; i++) {
    try {
      const d = decodeURIComponent(rest);
      if (d === rest) break;
      rest = d;
    } catch {
      break;
    }
  }
  const at = /(?:^|[/=])((?:https?:\/\/?)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?][^\s]*)?)/gi;
  for (const m of rest.matchAll(at)) {
    if (keys.length > 8) break;
    const inner = m[1]!.replace(/^https?:\/\/?/i, "");
    const k = pageKey(`https://${inner}`).toLowerCase();
    if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}

/** One URL bar: a prefix at a path boundary; `*` stands for exactly one path segment. */
function prefixMatcher(prefix: string): (key: string) => boolean {
  const p = pageKey(/^https?:\/\//i.test(prefix) ? prefix : `https://${prefix}`).toLowerCase();
  if (p.includes("*")) {
    const body = p
      .split("*")
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/?#]+");
    const re = new RegExp(`^${body}(?:$|[/?])`);
    return (key) => re.test(key);
  }
  return (key) =>
    key === p || key.startsWith(p.endsWith("/") ? p : `${p}/`) || key.startsWith(`${p}?`);
}

/**
 * A predicate for a brief's `exclude`: true when a page (URL, and title when
 * known) is barred. URL prefixes compare by `pageKey` (no scheme, `www.`,
 * tracking parameters or trailing slash; case-insensitive) at a path boundary,
 * `*` standing for one path segment (an owner segment of `*` bars every fork);
 * a URL that embeds a barred URL (proxy, archive, redirector) is barred; titles
 * by containment after folding.
 */
export function excludedSource(
  exclude: SourceExclusion | undefined,
): (url: string, title?: string) => boolean {
  const prefixes = (exclude?.urls ?? []).map(prefixMatcher);
  const titles = (exclude?.titles ?? []).map(foldTitle).filter((t) => t.length >= MIN_BARRED_TITLE);
  if (prefixes.length === 0 && titles.length === 0) return () => false;
  return (url, title) => {
    if (prefixes.length > 0 && embeddedPageKeys(url).some((k) => prefixes.some((m) => m(k))))
      return true;
    if (!title || titles.length === 0) return false;
    const t = foldTitle(title);
    return titles.some((b) => t.includes(b));
  };
}

/** The registrable domain, approximately (`news.bbc.co.uk` → `bbc.co.uk`). */
export function siteOf(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const sld = parts[parts.length - 2]!;
  const twoLevel = sld.length <= 3 && /^(co|com|org|net|gov|ac|edu|gob|nic)$/.test(sld);
  return parts.slice(twoLevel ? -3 : -2).join(".");
}

const STOP = new Set(
  (
    "the and for with that this from will what which who whom when where how many much does did " +
    "are was were been being have has had not but you your their its into than then them they " +
    "there these those over under after before between about would could should shall may might " +
    "also only any all each per via de la el los las del que por para con una uno das dos do da " +
    "em no na os as um uma le les des du et en au aux est"
  ).split(" "),
);

/** Han, kana and hangul runs: scripts written without spaces between words. */
const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]+/g;

/**
 * Lower-cased, accent-folded word tokens of three or more characters, stop
 * words out — plus, for CJK text (no spaces between words), overlapping
 * character bigrams (a lone character stands for itself), the usual
 * dictionary-free tokenisation for Chinese and Japanese retrieval.
 */
export function terms(text: string): string[] {
  const latin = (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? []
  ).filter((t) => !STOP.has(t));
  const cjk: string[] = [];
  for (const run of text.match(CJK_RUN) ?? []) {
    const chars = [...run];
    if (chars.length === 1) cjk.push(run);
    for (let i = 0; i + 1 < chars.length; i++) cjk.push(chars[i]! + chars[i + 1]!);
  }
  return cjk.length ? [...latin, ...cjk] : latin;
}

/** A page's text in passages: paragraphs, long ones split at sentence ends. */
export function passagesOf(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n+/)) {
    const p = para.replace(/\s+/g, " ").trim();
    if (p.length < PASSAGE_MIN || /^#+\s/.test(p)) continue;
    if (p.length <= PASSAGE_MAX) {
      out.push(p);
      continue;
    }
    let cur = "";
    // Latin sentence ends need a space and a capital after them; CJK full-width
    // ends (。！？) need neither.
    for (const s of p.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])|(?<=[。！？])\s*/)) {
      if (cur && cur.length + s.length + 1 > PASSAGE_MAX) {
        if (cur.length >= PASSAGE_MIN) out.push(cur);
        cur = "";
      }
      // CJK sentences join without a space, as the page wrote them (the quote check is verbatim).
      cur = cur ? (/[。！？]$/.test(cur) ? cur + s : `${cur} ${s}`) : s;
    }
    if (cur.length >= PASSAGE_MIN) out.push(cur.slice(0, PASSAGE_MAX * 2));
  }
  return out;
}

interface Passage {
  page: number;
  text: string;
  score: number;
}

/**
 * Rank every page's passages for the question with BM25 (idf over all the
 * brief's passages), a small bonus for a passage that states a figure, and
 * each page's weight (its search rank and recency).
 */
export function rankPassages(
  pages: Array<{ text: string; weight: number }>,
  question: string,
): Passage[] {
  const q = [...new Set(terms(question))];
  const all: Array<{ page: number; text: string; tf: Map<string, number>; len: number }> = [];
  pages.forEach((p, page) => {
    for (const text of passagesOf(p.text)) {
      const toks = terms(text);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      all.push({ page, text, tf, len: toks.length });
    }
  });
  if (all.length === 0 || q.length === 0) return [];
  const df = new Map<string, number>();
  for (const p of all) for (const t of q) if (p.tf.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const avg = all.reduce((s, p) => s + p.len, 0) / all.length || 1;
  const k1 = 1.2;
  const b = 0.75;
  const out: Passage[] = [];
  for (const p of all) {
    let s = 0;
    for (const t of q) {
      const f = p.tf.get(t);
      if (!f) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (all.length - n + 0.5) / (n + 0.5));
      s += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * p.len) / avg));
    }
    if (s <= 0) continue;
    if (/\d/.test(p.text)) s *= 1.15;
    out.push({ page: p.page, text: p.text, score: s * (pages[p.page]?.weight ?? 1) });
  }
  return out.sort((a, b2) => b2.score - a.score);
}

// ─── Page reading ────────────────────────────────────────────────────────────

/** Guarded page read: HTML or plain text, or undefined (never throws). */
async function guardedPage(
  url: string,
): Promise<{ body: string; contentType: string } | undefined> {
  try {
    const res = await guardedFetch(
      url,
      {
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
        headers: {
          "User-Agent": VERIFY_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
        },
      },
      { maxHops: 3 },
    );
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok || (contentType && !/html|text\/plain|xml/i.test(contentType))) {
      await res.body?.cancel().catch(() => undefined);
      return undefined;
    }
    return { body: await readCapped(res, PAGE_MAX_BYTES), contentType };
  } catch {
    return undefined;
  }
}

async function pool<T>(items: T[], n: number, run: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      for (let it = queue.shift(); it !== undefined; it = queue.shift()) await run(it);
    }),
  );
}

// ─── Retriever ───────────────────────────────────────────────────────────────

interface Hit {
  result: SearchResult;
  rrf: number;
  published?: string;
  /** A page the question names as its resolution source (`brief.readFirst`). */
  settlement?: boolean;
}

/** Fused rank given a settlement page: above any searched page. */
const SETTLEMENT_RRF = 1;
/** Passages scoring below this share of the best passage are dropped. */
const RELEVANCE_FLOOR = 0.2;

/** The `search` retriever (see the module comment). */
export function webSearchRetriever(opts: WebSearchOptions = {}): Retriever {
  const backends = opts.backends ?? searchBackendsFromEnv().backends;
  if (backends.length === 0) throw new Error("the search retriever needs at least one backend");
  const http = opts.http ?? standaloneSearchHttp();
  const fetchPage = opts.fetchPage ?? guardedPage;
  const background =
    opts.background === null ? undefined : (opts.background ?? dateBoundProvider("wikipedia"));
  const maxQueries = opts.maxQueries ?? WEB_SEARCH_DEFAULTS.maxQueries;
  const perQuery = opts.perQuery ?? WEB_SEARCH_DEFAULTS.perQuery;
  const domainCap = opts.domainCap ?? WEB_SEARCH_DEFAULTS.domainCap;
  const maxPages = opts.maxPages ?? WEB_SEARCH_DEFAULTS.maxPages;
  const perPage = opts.perPage ?? WEB_SEARCH_DEFAULTS.perPage;
  const maxPassages = opts.maxPassages ?? WEB_SEARCH_DEFAULTS.maxPassages;
  const label = `search:${backends.map((b) => b.name).join("+")}`;

  return async (brief: ResearchBrief): Promise<ResearchReport> => {
    const now = opts.now?.() ?? new Date();
    const boundMs = Math.min(
      brief.untilAt ? Date.parse(brief.untilAt) : Number.NaN,
      brief.until ? Date.parse(`${brief.until.slice(0, 10)}T23:59:59.999Z`) : Number.NaN,
    );
    const bound = Number.isFinite(boundMs) ? boundMs : now.getTime();
    const live = now.getTime() - bound < LIVE_SLACK_MS;
    const passageChars =
      opts.passageChars ??
      (brief.maxChars && brief.maxChars > 0
        ? Math.max(2_000, Math.floor(brief.maxChars))
        : WEB_SEARCH_DEFAULTS.passageChars);
    const queries = [
      ...new Set(
        (brief.queries?.length ? brief.queries : [brief.request.split("\n")[0] ?? ""])
          .map((q) => q.trim().slice(0, 300))
          .filter(Boolean),
      ),
    ].slice(0, maxQueries);
    if (queries.length === 0) throw new Error("search retrieval: the brief has no query");

    const use = new Map<string, BackendUse>(
      backends.map((b) => [b.name, { name: b.name, calls: 0, results: 0, failures: 0 }]),
    );
    const failedHere = new Set<string>();
    const spend = { usd: 0 };
    const batches: Array<{ query: number; results: SearchResult[] }> = [];
    let answered = 0;

    // ── Search: every query through the chain ────────────────────────────
    await pool(
      queries.map((q, i) => ({ q, i })),
      SEARCH_CONCURRENCY,
      async ({ q, i }) => {
        for (const backend of chainFor(backends, failedHere)) {
          const u = use.get(backend.name)!;
          u.calls++;
          try {
            const results = await backend.search(
              q,
              { maxResults: perQuery, engines: ["web", "news"], spend },
              http,
            );
            recordSearchOutcome(backend.name);
            u.results += results.length;
            batches.push({ query: i, results });
            answered++;
            return;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            recordSearchOutcome(backend.name, message);
            u.failures++;
            u.error = message.replace(/\s+/g, " ").slice(0, 160);
            failedHere.add(backend.name);
          }
        }
      },
    );
    if (background) {
      try {
        const bg = await background.search(
          queries[0]!,
          { maxResults: 2, before: new Date(bound).toISOString() },
          http,
        );
        batches.push({ query: queries.length, results: bg });
      } catch {
        // allow-empty-catch: background is optional; the main chain is reported
      }
    }
    const funnel: RetrievalFunnel = {
      retriever: label,
      queries: queries.length,
      backends: [...use.values()].filter((u) => u.calls > 0),
      hits: batches.reduce((s, b) => s + b.results.length, 0),
      unique: 0,
      kept: 0,
      afterCutoff: 0,
      read: 0,
      readFailed: 0,
      noFetch: 0,
      settlement: 0,
      belowRelevance: 0,
      extractedChars: 0,
      passages: 0,
      passageChars: 0,
    };
    if (answered === 0) {
      const why = funnel.backends.map((b) => `${b.name}: ${b.error ?? "failed"}`).join("; ");
      throw Object.assign(new Error(`search retrieval: every backend failed (${why})`), {
        funnel,
      });
    }

    // ── Fuse, filter by cutoff, cap per domain ───────────────────────────
    const barred = excludedSource(brief.exclude);
    if (brief.exclude) funnel.excluded = 0;
    const barredKeys = new Set<string>();
    const hits = new Map<string, Hit>();
    for (const { query, results } of batches) {
      // Background (the extra batch after the queries) counts half: it frames, it does not decide.
      const scale = query >= queries.length ? 0.5 : 1;
      results.forEach((r, rank) => {
        if (!r.url || !/^https?:\/\//i.test(r.url)) return;
        if (barred(r.url, r.title)) {
          barredKeys.add(pageKey(r.url));
          return;
        }
        const key = pageKey(r.url);
        const had = hits.get(key);
        const rrf = scale / (rank + 3);
        if (had) {
          had.rrf += rrf;
          if (!had.result.text && r.text) had.result = { ...had.result, text: r.text };
          had.published ??= r.published;
        } else
          hits.set(key, { result: r, rrf, ...(r.published ? { published: r.published } : {}) });
      });
    }
    funnel.unique = hits.size;
    // The question's settlement pages are read first, outside the domain cap.
    const first: Hit[] = (brief.readFirst ?? [])
      .filter((u) => /^https?:\/\//i.test(u) && !barred(u))
      .slice(0, 3)
      .map((url) => {
        const had = hits.get(pageKey(url));
        hits.delete(pageKey(url));
        return {
          result: had?.result ?? { title: "", url, snippet: "", source: "settlement" },
          rrf: SETTLEMENT_RRF,
          settlement: true,
          ...(had?.published ? { published: had.published } : {}),
        };
      });
    const ranked = [...hits.values()].sort((a, b) => b.rrf - a.rrf);
    const perSite = new Map<string, number>();
    const kept: Hit[] = [...first];
    for (const h of ranked) {
      if (h.published && Date.parse(h.published) > bound) {
        funnel.afterCutoff++;
        continue;
      }
      const site = siteOf(h.result.url);
      if ((perSite.get(site) ?? 0) >= domainCap) continue;
      perSite.set(site, (perSite.get(site) ?? 0) + 1);
      kept.push(h);
      if (kept.length >= maxPages + first.length) break;
    }
    funnel.kept = kept.length;

    // ── Read pages ──────────────────────────────────────────────────────
    const pages: Array<{
      hit: Hit;
      title: string;
      text: string;
      published?: string;
      weight: number;
    }> = [];
    await pool(kept, FETCH_CONCURRENCY, async (h) => {
      const url = h.result.url;
      if (!fetchAllowed(url)) {
        funnel.noFetch++;
        return;
      }
      let text = h.result.text?.trim() ?? "";
      let title = h.result.title;
      let published = h.published;
      if (text.length < PASSAGE_MIN) {
        const page = await fetchPage(url);
        if (page) {
          const html = /html|xml/i.test(page.contentType) || /<html|<body/i.test(page.body);
          if (html) {
            const ex = extractReadableText(page.body);
            text = ex.text;
            // The page's own title can reveal a barred source the search hit did not.
            if (ex.title && barred(url, ex.title)) {
              barredKeys.add(pageKey(url));
              return;
            }
            title ||= ex.title ?? "";
            published ??= extractPublishedDate(page.body, now.getTime());
          } else text = page.body;
        }
      }
      if (!text || text.length < PASSAGE_MIN) {
        funnel.readFailed++;
        return;
      }
      if (title && barred(url, title)) {
        barredKeys.add(pageKey(url));
        return;
      }
      if (published && Date.parse(published) > bound) {
        funnel.afterCutoff++;
        return;
      }
      funnel.read++;
      if (h.settlement) funnel.settlement++;
      funnel.extractedChars += text.length;
      pages.push({
        hit: h,
        title: title || url,
        text,
        ...(published ? { published } : {}),
        weight: pageWeight(h.rrf, published, bound, live),
      });
    });

    // ── Passages ────────────────────────────────────────────────────────
    const question = [brief.request.split("\n")[0] ?? "", ...queries].join(" ");
    const ranking = rankPassages(pages, question);
    // Relevance gate: a passage far below the best one is noise, not evidence.
    const floor = (ranking[0]?.score ?? 0) * RELEVANCE_FLOOR;
    const perPageUsed = new Map<number, number>();
    const chosen: Array<{ page: number; text: string; score: number }> = [];
    const seenText = new Set<string>();
    let chars = 0;
    for (const p of ranking) {
      if (chosen.length >= maxPassages) break;
      if (p.score < floor) {
        funnel.belowRelevance++;
        continue;
      }
      const used = perPageUsed.get(p.page) ?? 0;
      if (used >= perPage) continue;
      const text = oneLine(p.text);
      if (text.length < PASSAGE_MIN) continue;
      // The same boilerplate on sister pages (market rules, syndicated copy) counts once.
      const fingerprint = text.toLowerCase().replace(/\W+/g, " ");
      if (seenText.has(fingerprint)) continue;
      seenText.add(fingerprint);
      if (chars + text.length > passageChars) {
        if (chars > passageChars * 0.9) break;
        continue;
      }
      perPageUsed.set(p.page, used + 1);
      chosen.push({ page: p.page, text, score: p.score });
      chars += text.length;
    }
    funnel.passages = chosen.length;
    funnel.passageChars = chars;
    if (funnel.excluded !== undefined) funnel.excluded = barredKeys.size;

    const lines: string[] = [];
    const sources: Source[] = [];
    const cited = new Set<number>();
    for (const c of chosen) {
      const pg = pages[c.page]!;
      const day = pg.published?.slice(0, 10) ?? "undated";
      lines.push(
        `- ${day} — "${c.text}" [${oneLine(pg.title, 120) || "source"}](${pg.hit.result.url})`,
      );
      if (!cited.has(c.page)) {
        cited.add(c.page);
        sources.push({
          url: pg.hit.result.url,
          ...(pg.title ? { title: pg.title } : {}),
          ...(pg.published ? { published: pg.published.slice(0, 10) } : {}),
          text: pg.text.slice(0, SOURCE_TEXT_CHARS),
        });
      }
    }
    return {
      report: lines.length
        ? lines.join("\n")
        : `Nothing relevant found on the ${funnel.read} pages read for: ${queries.join(" | ")}`,
      sources,
      // What the paid backends charged for this brief (also in the spend ledger).
      costUsd: spend.usd,
      searches: funnel.backends.reduce((s, b) => s + b.calls, 0),
      retriever: label,
      funnels: [funnel],
    };
  };
}

/** Backends to try for one query: the chain minus those down or failed in this brief. */
function chainFor(backends: SearchProvider[], failedHere: ReadonlySet<string>): SearchProvider[] {
  const open = backends.filter((b) => !failedHere.has(b.name));
  const up = open.filter((b) => !searchBackendDown(b.name));
  // Every backend down: still try them in order rather than return nothing.
  return up.length ? up : open;
}

/**
 * A page's weight: its fused search rank, and — for a live question — a
 * recency bonus that fades over two weeks (undated pages get none).
 */
function pageWeight(
  rrf: number,
  published: string | undefined,
  bound: number,
  live: boolean,
): number {
  const rank = 0.6 + Math.min(1, rrf * 3);
  if (!live || !published) return rank;
  const ageDays = Math.max(0, (bound - Date.parse(published)) / 86_400_000);
  return rank * (1 + 0.5 * Math.exp(-ageDays / 14));
}
