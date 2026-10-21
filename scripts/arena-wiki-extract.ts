// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Run the attention extractors (src/arena/attention/) over reconstructed
 * Wikipedia weeks, as of each week's lock, and write their feature records
 * as JSONL for `scripts/arena-wiki-backtest.ts --features`.
 *
 * Each week ending Sunday E is set up as the arena does it (lock Friday E − 9
 * 14:00 UTC, newest readable list lock day − 2); the subjects are the
 * specialist's top `--top` candidates from the daily lists in `--dir`. Every
 * HTTP response is cached under `--cache` (published history never changes),
 * Wikimedia requests are spaced ≥ 120 ms, GDELT's ≥ 5 s. Model extractors
 * stop once `--budget` dollars are spent; the spend per model is written to
 * `<out>.spend.json`.
 *
 *   bun run scripts/arena-wiki-extract.ts --dir <daily lists> --extractors edits,related \
 *     --out features.jsonl [--cache dir] [--top 30] [--weeks 2026-07-26..2026-10-18]
 *     [--model openrouter/deepseek/deepseek-v4.1-flash] [--budget 5] [--retriever asof:wikipedia]
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { parseArgs } from "node:util";
import {
  type AttentionContext,
  type ExtractorName,
  extractorFor,
  parseExtractorList,
  runExtractors,
} from "../src/arena/extraction";
import { WIKITOP_PUBLICATION_LAG_DAYS } from "../src/arena/research/civiqs-nowcast";
import { type DailyTop, specialistRanking, weekDays } from "../src/arena/wiki-specialist";
import { WIKIMEDIA_USER_AGENT } from "../src/arena/wikimedia";
import { GDELT_MIN_INTERVAL_MS } from "../src/engine/search-providers/gdelt";
import { retrieverFromSpec } from "../src/research/retrieve";

const DAY_MS = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS);

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    dir: { type: "string" },
    extractors: { type: "string" },
    out: { type: "string" },
    cache: { type: "string" },
    top: { type: "string" },
    weeks: { type: "string" },
    model: { type: "string" },
    budget: { type: "string" },
    retriever: { type: "string" },
    concurrency: { type: "string" },
  },
});
if (!values.dir || !values.extractors || !values.out)
  throw new Error("usage: --dir <daily lists> --extractors <list> --out <features.jsonl>");
const names: ExtractorName[] = parseExtractorList(values.extractors);
const top = Number(values.top ?? 30);
const budget = Number(values.budget ?? 5);
const cacheDir = values.cache ?? `${values.out}.cache`;
mkdirSync(cacheDir, { recursive: true });

const days: DailyTop[] = readdirSync(values.dir)
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .sort()
  .map((f) => ({
    date: f.slice(0, 10),
    articles: (
      JSON.parse(readFileSync(`${values.dir}/${f}`, "utf8")) as { articles: Record<string, number> }
    ).articles,
  }));
const first = days[0]!.date;
const last = days.at(-1)!.date;

// ─── Cached, spaced HTTP ────────────────────────────────────────────────────
const nextSlot = new Map<string, number>();
async function cachedJson(url: string, spacingMs: number): Promise<unknown> {
  const file = `${cacheDir}/${createHash("sha1").update(url).digest("hex")}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const host = new URL(url).host;
  for (let attempt = 0; attempt < 12; attempt++) {
    const now = Date.now();
    const slot = Math.max(now, nextSlot.get(host) ?? 0);
    nextSlot.set(host, slot + spacingMs);
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
    const res = await fetch(url, {
      headers: { "User-Agent": `${WIKIMEDIA_USER_AGENT} backtest`, Accept: "application/json" },
      signal: AbortSignal.timeout(60_000),
    }).catch(() => undefined);
    if (res?.status === 404) {
      writeFileSync(file, "null");
      return undefined;
    }
    if (!res || res.status === 429 || res.status >= 500) {
      // Wikimedia's rate limiter says how long to back off; everything on that host waits.
      const after = Number(res?.headers.get("retry-after"));
      const backoff = (Number.isFinite(after) && after > 0 ? after : 5 * (attempt + 1)) * 1_000;
      nextSlot.set(host, Math.max(nextSlot.get(host) ?? 0, Date.now() + backoff));
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // GDELT answers query errors (a too-short term, rate limits) in plain text.
      if (/limit requests/i.test(text)) {
        await new Promise((r) => setTimeout(r, 10_000));
        continue;
      }
      writeFileSync(file, "null");
      return undefined;
    }
    writeFileSync(file, JSON.stringify(body));
    return body;
  }
  throw new Error(`gave up on ${url}`);
}
// MediaWiki's API asks for serial, unhurried clients; the REST pageview API allows more.
const wikimediaJson = (url: string) => cachedJson(url, url.includes("/w/api.php") ? 600 : 150);
const gdeltJson = (url: string) => cachedJson(url, GDELT_MIN_INTERVAL_MS + 500);
// One request per linked article for the whole period, cut to each week's
// lastDay by the extractor (and here): a cache that serves every week.
const viewsTo = last.replace(/-/g, "");
async function dailyViews(title: string, start: string, end: string) {
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/${encodeURIComponent(title)}/daily/2025040100/${viewsTo}00`;
  const body = (await wikimediaJson(url)) as
    | { items?: Array<{ timestamp: string; views: number }> }
    | undefined;
  return (body?.items ?? [])
    .map((i) => ({
      date: `${i.timestamp.slice(0, 4)}-${i.timestamp.slice(4, 6)}-${i.timestamp.slice(6, 8)}`,
      views: i.views,
    }))
    .filter((d) => d.date >= start && d.date <= end);
}

// ─── Model + spend ──────────────────────────────────────────────────────────
const model = values.model?.trim();
let complete: AttentionContext["complete"];
let spentUsd = () => 0;
let calls = () => 0;
if (model && names.some((n) => n === "events" || n === "news")) {
  const { modelComplete } = await import("../src/model/complete");
  const made = modelComplete(model, process.env, {
    maxTokens: 2_000,
    timeoutMs: 120_000,
    purpose: "arena",
  });
  spentUsd = () => made.usage.costUsd;
  calls = () => made.usage.calls;
  complete = async (system, user) => {
    if (made.usage.costUsd >= budget) throw new Error(`budget $${budget} reached`);
    return made.complete(system, user);
  };
}
const retriever = values.retriever
  ? retrieverFromSpec(values.retriever, {}, { requireDateStrict: true })
  : undefined;

// ─── Weeks ──────────────────────────────────────────────────────────────────
const [wFrom, wTo] = (values.weeks ?? "..").split("..");
const weeks: Array<{ weekEnd: string; lockAt: string; lastDay: string }> = [];
for (let e = addDays(first, 42); e <= last; e = addDays(e, 1)) {
  if (new Date(`${e}T00:00:00Z`).getUTCDay() !== 0) continue;
  if ((wFrom && e < wFrom) || (wTo && e > wTo)) continue;
  const lockAt = `${addDays(e, -9)}T14:00:00Z`;
  const lastDay = addDays(lockAt.slice(0, 10), -WIKITOP_PUBLICATION_LAG_DAYS);
  if (addDays(lastDay, -27) < first) continue;
  weeks.push({ weekEnd: e, lockAt, lastDay });
}

writeFileSync(values.out, "");
const extractors = names.map((n) => extractorFor(n, { search: !!retriever }));
let total = 0;
for (const w of weeks) {
  const subjects = specialistRanking(days, { weekEnd: w.weekEnd, lastDay: w.lastDay })
    .scored.slice(0, top)
    .map((s) => s.title);
  const wd = weekDays(w.weekEnd);
  const ctx: AttentionContext = {
    subjects,
    cutoff: w.lockAt,
    lastDay: w.lastDay,
    window: { start: wd[0]!, end: wd[6]! },
    fetchJson: wikimediaJson,
    dailyViews,
    gdeltJson,
    ...(retriever ? { retriever } : {}),
    ...(complete ? { complete } : {}),
  };
  const run = await runExtractors(extractors, ctx, { timeoutMs: 6 * 3_600_000 });
  // A coverage marker: this week was extracted (even when it yielded no record).
  appendFileSync(
    values.out,
    `${JSON.stringify({ week: w.weekEnd, run: true, subjects: subjects.length, errors: run.errors.length, dropped: run.dropped.length })}\n`,
  );
  for (const f of run.features)
    appendFileSync(values.out, `${JSON.stringify({ week: w.weekEnd, ...f })}\n`);
  total += run.features.length;
  console.error(
    `${w.weekEnd}: ${run.features.length} features, ${run.dropped.length} dropped, ${run.errors.length} errors${run.errors.length ? ` (${run.errors[0]!.error})` : ""}; spent $${spentUsd().toFixed(4)} in ${calls()} calls`,
  );
  if (spentUsd() >= budget) {
    console.error(`budget $${budget} reached: stopping`);
    break;
  }
}
writeFileSync(
  `${values.out}.spend.json`,
  JSON.stringify(
    {
      model: model ?? null,
      extractors: names,
      weeks: weeks.length,
      top,
      calls: calls(),
      usd: spentUsd(),
    },
    null,
    2,
  ),
);
console.log(
  `${total} features for ${weeks.length} weeks → ${values.out}; spent $${spentUsd().toFixed(4)}`,
);
