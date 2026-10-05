// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local corpora — a fixed document collection searched offline with BM25.
 *
 * A corpus is one SQLite file, `<dir>/<name>.db`, holding a `docs` table
 * (docid, title, url, text) and an FTS5 index over title and text (porter
 * stemming, unicode61). `bm25()` ranks matches. Nothing leaves the machine and
 * no key is needed, so anyone can point Marina at their own documents: build
 * once from JSONL (`bun run corpus build <name> <file.jsonl>`), then search it
 * like any engine —
 *
 *   web search engines:corpus:<name> <query>      (any agent, any room)
 *   web fetch corpus://<name>/<docid>             (the whole document)
 *   search <query> engine:corpus:<name>            (the search tool room)
 *   MARINA_FORECAST_RETRIEVER=corpus:<name>        (research over the corpus)
 *
 * The directory is `MARINA_CORPUS_DIR`, else `~/.local/share/marina/corpora`.
 * It is never under the system temp dir (often a small tmpfs); an index for a
 * 100K-document corpus is several GB.
 *
 * A corpus provider is named `corpus:<name>` and answers only searches that
 * name it (`boundOnly`) — it never joins open web searches, and it declares no
 * date bound, so a date-strict (`before:`) search never uses it.
 *
 * Ranking: FTS5's `bm25()` has k1 = 1.2 and b = 0.75 built in, which suit short
 * passages, not long documents. With BM25 parameters set (`bm25` option, or
 * MARINA_CORPUS_BM25_K1 / MARINA_CORPUS_BM25_B), FTS5 only supplies the top
 * `depth` candidates (default 1,000) and they are rescored here — term counts
 * from the Porter-stemmed document text (the stemmer FTS5 indexed with),
 * document frequencies from the index, length normalised by characters.
 * Quoted phrases in a query count as one more term (a boost), never split
 * into unrelated words only. A ranking is cached, so `offset` pages through it
 * cheaply. Each hit carries the window of the document that best matches the
 * query (`window`), not only its opening characters.
 *
 * Hybrid search (optional, `corpus-vectors.ts`): a corpus may also hold dense
 * vectors (`bun run corpus embed` / `corpus vectors import`). When the process
 * has a query embedder for the same model (MARINA_CORPUS_EMBEDDINGS), the BM25
 * ranking and the dense ranking are fused by weighted reciprocal rank
 * (MARINA_CORPUS_HYBRID_WEIGHT). With no embedder or no matching vectors the
 * search is the BM25 search above, unchanged.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EmbeddingProvider } from "../../memory/embeddings";
import {
  type CorpusVectorInfo,
  closeCorpusVectors,
  corpusEmbedder,
  corpusVectorSets,
  denseRanking,
  fuseHybrid,
  hybridWeightFromEnv,
  queryVector,
} from "./corpus-vectors";
import type { SearchProvider, SearchResult } from "./index";
import { porterStem } from "./porter";

/** `[a-z0-9][a-z0-9._-]*`, at most 64 characters. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Query terms kept (FTS5 OR-query). */
const MAX_QUERY_TERMS = 48;
/** Default characters of document text returned with each hit (~512 tokens). */
export const CORPUS_LEAD_CHARS = 2_000;
/** Longest document text `getCorpusDocument` returns unless asked for more. */
export const CORPUS_DOC_MAX_CHARS = 200_000;

export interface CorpusDoc {
  docid: string;
  title?: string;
  url?: string;
  text: string;
}

export interface CorpusHit {
  docid: string;
  title: string;
  url: string;
  /** Higher is better (the negated FTS5 `bm25()`). */
  score: number;
  /** The best-matching passage, terms in [brackets]. */
  passage: string;
  /** The first `leadChars` characters of the document. */
  lead: string;
  /** About `leadChars` characters around the document's best match for the query. */
  window?: string;
}

export interface CorpusInfo {
  name: string;
  path: string;
  docs: number;
  builtAt?: string;
  source?: string;
}

/** True when `name` is a valid corpus name. */
export function isCorpusName(name: string): boolean {
  return NAME_RE.test(name);
}

/** The directory corpora live in (created on build, never under the temp dir). */
export function corpusDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.MARINA_CORPUS_DIR?.trim();
  return resolve(configured || join(homedir(), ".local", "share", "marina", "corpora"));
}

/** True when `dir` sits under the system temp dir (usually a RAM-backed tmpfs). */
export function isUnderTempDir(dir: string): boolean {
  const t = resolve(tmpdir());
  const d = resolve(dir);
  return d === t || d.startsWith(`${t}/`) || d === "/tmp" || d.startsWith("/tmp/");
}

function corpusPath(name: string, dir: string): string {
  if (!isCorpusName(name)) throw new Error(`invalid corpus name "${name}"`);
  return join(dir, `${name}.db`);
}

/** The corpora present in `dir` (name, path, document count). */
export function listCorpora(dir: string = corpusDir()): CorpusInfo[] {
  if (!existsSync(dir)) return [];
  const out: CorpusInfo[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".db")) continue;
    const name = f.slice(0, -3);
    if (!isCorpusName(name)) continue;
    try {
      const db = new Database(join(dir, f), { readonly: true });
      try {
        const meta = readMeta(db);
        const docs = (db.query("SELECT count(*) AS n FROM docs").get() as { n: number }).n;
        out.push({
          name,
          path: join(dir, f),
          docs,
          ...(meta.built_at ? { builtAt: meta.built_at } : {}),
          ...(meta.source ? { source: meta.source } : {}),
        });
      } finally {
        db.close();
      }
    } catch {
      // allow-empty-catch: a stray or half-built file is not a corpus; skip it
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function readMeta(db: Database): Record<string, string> {
  const rows = db.query("SELECT key, value FROM meta").all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE docs (
  rowid INTEGER PRIMARY KEY,
  docid TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL
);
CREATE VIRTUAL TABLE docs_fts USING fts5(
  title, text, content='docs', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
END;
CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
END;
CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
  INSERT INTO docs_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
END;
`;

export interface BuildOptions {
  dir?: string;
  /** Recorded in the corpus metadata (e.g. the dataset it came from). */
  source?: string;
  /** Replace an existing corpus of the same name. */
  replace?: boolean;
  /** Called every `batch` documents. */
  onProgress?: (done: number) => void;
  batch?: number;
}

/**
 * Build a corpus from documents (any iterable, sync or async). Writes to a
 * temporary file beside the target and renames it into place when complete,
 * so a reader never sees a half-built index. Duplicate docids keep the first.
 */
export async function buildCorpus(
  name: string,
  docs: Iterable<CorpusDoc> | AsyncIterable<CorpusDoc>,
  opts: BuildOptions = {},
): Promise<CorpusInfo> {
  const dir = opts.dir ?? corpusDir();
  const path = corpusPath(name, dir);
  if (existsSync(path) && !opts.replace) {
    throw new Error(`corpus "${name}" already exists at ${path} (pass replace to rebuild)`);
  }
  mkdirSync(dir, { recursive: true });
  const building = `${path}.building`;
  rmSync(building, { force: true });
  const db = new Database(building, { create: true });
  let count = 0;
  try {
    db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA temp_store = FILE;");
    db.exec(SCHEMA);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO docs (docid, title, url, text) VALUES (?, ?, ?, ?)",
    );
    const batchSize = opts.batch ?? 2_000;
    let pending: CorpusDoc[] = [];
    const flush = db.transaction((rows: CorpusDoc[]) => {
      for (const d of rows) insert.run(d.docid, d.title ?? "", d.url ?? "", d.text);
    });
    for await (const d of docs as AsyncIterable<CorpusDoc>) {
      if (!d || typeof d.docid !== "string" || !d.docid || typeof d.text !== "string") continue;
      pending.push(d);
      if (pending.length >= batchSize) {
        flush(pending);
        count += pending.length;
        pending = [];
        opts.onProgress?.(count);
      }
    }
    if (pending.length) {
      flush(pending);
      count += pending.length;
      opts.onProgress?.(count);
    }
    db.exec("INSERT INTO docs_fts(docs_fts) VALUES ('optimize')");
    const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    meta.run("name", name);
    meta.run("built_at", new Date().toISOString());
    meta.run("tokenizer", "porter unicode61");
    meta.run("ranking", "bm25 (FTS5, k1=1.2, b=0.75)");
    if (opts.source) meta.run("source", opts.source);
  } finally {
    db.close();
  }
  rmSync(path, { force: true });
  renameSync(building, path);
  return { name, path, docs: count, ...(opts.source ? { source: opts.source } : {}) };
}

/**
 * English stopwords dropped from queries — Lucene's EnglishAnalyzer set, the
 * default in Anserini/Pyserini BM25. Besides matching common practice, an OR
 * over "the" or "of" touches nearly every row and makes ranking slow.
 */
export const CORPUS_STOPWORDS: ReadonlySet<string> = new Set(
  "a an and are as at be but by for if in into is it no not of on or such that the their then there these they this to was will with".split(
    " ",
  ),
);

/** A query's terms (stopwords out) and its quoted phrases of two or more words. */
export function queryParts(text: string): { terms: string[]; phrases: string[][] } {
  const words = (s: string) =>
    (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1);
  const phrases: string[][] = [];
  for (const m of text.matchAll(/["“”]([^"“”]+)["“”]/g)) {
    const p = words(m[1] ?? "");
    if (p.length >= 2) phrases.push(p.slice(0, 8));
  }
  const terms = [...new Set(words(text).filter((t) => !CORPUS_STOPWORDS.has(t)))].slice(
    0,
    MAX_QUERY_TERMS,
  );
  return { terms, phrases: phrases.slice(0, 4) };
}

/**
 * Free text → an FTS5 OR-query of quoted terms (operators and syntax never pass
 * through). A quoted phrase in the text joins as one more alternative — a
 * document holding the phrase scores higher, one holding only its words still
 * matches.
 */
export function ftsQuery(text: string): string | undefined {
  const { terms, phrases } = queryParts(text);
  if (terms.length === 0) return undefined;
  return [...phrases.map((p) => `"${p.join(" ")}"`), ...terms.map((t) => `"${t}"`)].join(" OR ");
}

const open = new Map<string, Database>();

function corpusDb(name: string, dir: string): Database {
  const path = corpusPath(name, dir);
  const hit = open.get(path);
  if (hit) return hit;
  if (!existsSync(path)) throw new Error(`no corpus "${name}" in ${dir}`);
  const db = new Database(path, { readonly: true });
  open.set(path, db);
  return db;
}

/** Close cached corpus handles (tests, rebuilds). */
export function closeCorpora(): void {
  for (const db of open.values()) db.close();
  open.clear();
  stats.clear();
  rankings.clear();
  closeCorpusVectors();
}

/** BM25 parameters for the rescorer. */
export interface Bm25Params {
  k1: number;
  b: number;
}

/**
 * The default rescoring: full length normalisation for long documents. Chosen
 * on held-out query splits of a 100k long-document corpus (raw questions and
 * replayed agent queries); on short passages it ranks close to FTS5's own.
 */
export const DEFAULT_CORPUS_BM25: Bm25Params = { k1: 6, b: 1 };

/**
 * Explicit rescoring parameters from MARINA_CORPUS_BM25_K1 / MARINA_CORPUS_BM25_B
 * (both needed), else undefined.
 */
export function explicitBm25FromEnv(
  env: Record<string, string | undefined> = process.env,
): Bm25Params | undefined {
  const k1 = Number(env.MARINA_CORPUS_BM25_K1);
  const b = Number(env.MARINA_CORPUS_BM25_B);
  if (!env.MARINA_CORPUS_BM25_K1?.trim() || !env.MARINA_CORPUS_BM25_B?.trim()) return undefined;
  if (!Number.isFinite(k1) || k1 < 0 || !Number.isFinite(b) || b < 0 || b > 1) return undefined;
  return { k1, b };
}

/**
 * The ranking a corpus search uses: explicit MARINA_CORPUS_BM25_K1 / _B, else
 * `DEFAULT_CORPUS_BM25`; `MARINA_CORPUS_RANKING=fts5` keeps FTS5's own ranking
 * (undefined).
 */
export function bm25FromEnv(
  env: Record<string, string | undefined> = process.env,
): Bm25Params | undefined {
  if (env.MARINA_CORPUS_RANKING?.trim().toLowerCase() === "fts5") return undefined;
  return explicitBm25FromEnv(env) ?? DEFAULT_CORPUS_BM25;
}

/** Candidates rescored per query unless asked otherwise. */
export const CORPUS_RESCORE_DEPTH = 1_000;
/** Rankings kept (per corpus, query, parameters and depth) for paging. */
const RANKINGS_KEPT = 64;

interface CorpusStats {
  docs: number;
  /** Mean document length in characters (title + text), from a sample. */
  avgChars: number;
  df: Map<string, number>;
}
const stats = new Map<string, CorpusStats>();
const rankings = new Map<string, Array<{ rowid: number; score: number }>>();

function statsFor(db: Database, path: string): CorpusStats {
  let s = stats.get(path);
  if (!s) {
    const docs = (db.query("SELECT count(*) AS n FROM docs").get() as { n: number }).n;
    // Every 50th document: the mean is stable and the scan stays cheap on a large corpus.
    const avg = db
      .query("SELECT avg(length(title) + 1 + length(text)) AS a FROM docs WHERE rowid % 50 = 0")
      .get() as { a: number | null };
    const all = avg.a
      ? avg.a
      : ((
          db.query("SELECT avg(length(title) + 1 + length(text)) AS a FROM docs").get() as {
            a: number | null;
          }
        ).a ?? 1);
    s = { docs, avgChars: Math.max(1, all), df: new Map() };
    stats.set(path, s);
  }
  return s;
}

/** Documents matching one term or phrase (the index's own stemming), cached. */
function docFreq(db: Database, s: CorpusStats, match: string): number {
  let n = s.df.get(match);
  if (n === undefined) {
    n = (
      db.query("SELECT count(*) AS n FROM docs_fts WHERE docs_fts MATCH ?").get(match) as {
        n: number;
      }
    ).n;
    s.df.set(match, n);
  }
  return n;
}

/** Lower case, diacritics folded (FTS5's unicode61 default). */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Stem → term index, for counting a document's query terms. */
function stemIndex(terms: string[]): Map<string, number> {
  const m = new Map<string, number>();
  terms.forEach((t, i) => {
    const st = porterStem(fold(t));
    if (!m.has(st)) m.set(st, i);
  });
  return m;
}

/** Positions (character offsets) of query-term tokens in `text`, with each one's term index. */
function termHits(text: string, stems: Map<string, number>): Array<{ at: number; term: number }> {
  if (stems.size === 0) return [];
  // Only words that start like a query stem are stemmed: one regex pass picks
  // them out, so a long document costs one scan, not a stem per word.
  const prefixes = [...new Set([...stems.keys()].map((st) => st.slice(0, 3)))]
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${prefixes})[\\p{L}\\p{N}]*`, "gu");
  // ASCII text needs no diacritic folding (the slow part on long documents).
  const src = /[\u0080-\uffff]/.test(text) ? fold(text) : text.toLowerCase();
  const out: Array<{ at: number; term: number }> = [];
  for (const m of src.matchAll(re)) {
    const term = stems.get(porterStem(m[0]));
    if (term !== undefined) out.push({ at: m.index ?? 0, term });
  }
  return out;
}

/** Occurrences of a phrase (word sequence) in folded text. */
function phraseCount(foldedText: string, phrase: string[]): number {
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])${phrase.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^\\p{L}\\p{N}]+")}(?![\\p{L}\\p{N}])`,
    "gu",
  );
  return foldedText.match(re)?.length ?? 0;
}

/** What BM25 needs about one query's candidates: idfs, term counts, lengths. */
export interface CorpusTermStats {
  avgChars: number;
  termIdf: number[];
  phraseIdf: number[];
  candidates: Array<{ rowid: number; chars: number; tf: number[]; phraseTf: number[] }>;
}

function termStats(db: Database, path: string, query: string, depth: number): CorpusTermStats {
  const s = statsFor(db, path);
  const match = ftsQuery(query);
  const { terms, phrases } = queryParts(query);
  const stems = stemIndex(terms);
  const idf = (df: number) => Math.log(1 + (s.docs - df + 0.5) / (df + 0.5));
  const termIdf = terms.map((t) => idf(docFreq(db, s, `"${t}"`)));
  const phraseIdf = phrases.map((p) => idf(docFreq(db, s, `"${p.join(" ")}"`)));
  // Rank first (rowids only), then read just those documents: joining the text
  // into the ranked query would read every matching document before the LIMIT.
  const ids = match
    ? (db
        .query("SELECT rowid FROM docs_fts WHERE docs_fts MATCH ? ORDER BY bm25(docs_fts) LIMIT ?")
        .all(match, depth) as Array<{ rowid: number }>)
    : [];
  const read = db.prepare("SELECT rowid, title, text FROM docs WHERE rowid = ?");
  const rows = ids.flatMap((r) => {
    const row = read.get(r.rowid) as { rowid: number; title: string; text: string } | null;
    return row ? [row] : [];
  });
  const candidates = rows.map((r) => {
    const body = `${r.title}\n${r.text}`;
    const tf = new Array<number>(terms.length).fill(0);
    for (const h of termHits(body, stems)) tf[h.term]!++;
    const folded = phrases.length ? fold(body) : "";
    return {
      rowid: r.rowid,
      chars: body.length,
      tf,
      phraseTf: phrases.map((p) => phraseCount(folded, p.map(fold))),
    };
  });
  return { avgChars: s.avgChars, termIdf, phraseIdf, candidates };
}

/** Term statistics for a query's top `depth` FTS5 candidates (for rescoring and parameter sweeps). */
export function corpusTermStats(
  name: string,
  query: string,
  opts: { dir?: string; depth?: number } = {},
): CorpusTermStats {
  const dir = opts.dir ?? corpusDir();
  return termStats(
    corpusDb(name, dir),
    corpusPath(name, dir),
    query,
    opts.depth ?? CORPUS_RESCORE_DEPTH,
  );
}

/** One candidate's BM25 score (terms plus phrase boosts) under `p`. */
export function bm25Score(
  t: CorpusTermStats,
  c: CorpusTermStats["candidates"][number],
  p: Bm25Params,
): number {
  const norm = p.k1 * (1 - p.b + (p.b * c.chars) / t.avgChars);
  let score = 0;
  c.tf.forEach((tf, i) => {
    if (tf) score += (t.termIdf[i]! * tf * (p.k1 + 1)) / (tf + norm);
  });
  c.phraseTf.forEach((tf, i) => {
    if (tf) score += (t.phraseIdf[i]! * tf * (p.k1 + 1)) / (tf + norm);
  });
  return score;
}

/**
 * The query's ranking over one corpus: FTS5's own order, or — with `bm25` —
 * its top `depth` candidates rescored. Cached per (corpus, query, parameters,
 * depth) so that pages after the first cost nothing.
 */
function rankCorpus(
  db: Database,
  path: string,
  query: string,
  bm25: Bm25Params | undefined,
  depth: number,
): Array<{ rowid: number; score: number }> {
  const match = ftsQuery(query);
  if (!match) return [];
  const key = `${path}\u0000${match}\u0000${bm25 ? `${bm25.k1},${bm25.b}` : "fts5"}\u0000${depth}`;
  const hit = rankings.get(key);
  if (hit) {
    rankings.delete(key);
    rankings.set(key, hit);
    return hit;
  }
  let ranked: Array<{ rowid: number; score: number }>;
  if (!bm25) {
    ranked = db
      .query(
        `SELECT rowid, -bm25(docs_fts) AS score FROM docs_fts WHERE docs_fts MATCH ?
          ORDER BY bm25(docs_fts) LIMIT ?`,
      )
      .all(match, depth) as Array<{ rowid: number; score: number }>;
  } else {
    const t = termStats(db, path, query, depth);
    ranked = t.candidates.map((c) => ({ rowid: c.rowid, score: bm25Score(t, c, bm25) }));
    ranked.sort((a, b) => b.score - a.score);
  }
  rankings.set(key, ranked);
  while (rankings.size > RANKINGS_KEPT) rankings.delete(rankings.keys().next().value!);
  return ranked;
}

/**
 * About `chars` characters of `text` around its densest cluster of query
 * terms (distinct terms first), cut at word boundaries; the opening
 * characters when no term occurs.
 */
export function matchWindow(text: string, query: string, chars: number): string {
  if (chars <= 0) return "";
  if (text.length <= chars) return text;
  const { terms } = queryParts(query);
  const hits = termHits(text, stemIndex(terms));
  if (hits.length === 0) return text.slice(0, chars);
  let best = 0;
  let bestScore = -1;
  let j = 0;
  const counts = new Map<number, number>();
  for (let i = 0; i < hits.length; i++) {
    while (j < hits.length && hits[j]!.at < hits[i]!.at + chars * 0.8) {
      counts.set(hits[j]!.term, (counts.get(hits[j]!.term) ?? 0) + 1);
      j++;
    }
    const score = counts.size * 1000 + (j - i);
    if (score > bestScore) {
      bestScore = score;
      best = hits[i]!.at;
    }
    const t = hits[i]!.term;
    const c = (counts.get(t) ?? 1) - 1;
    if (c <= 0) counts.delete(t);
    else counts.set(t, c);
  }
  let start = Math.max(0, best - Math.floor(chars * 0.2));
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space > 0 && space - start < 40) start = space + 1;
  }
  let end = Math.min(text.length, start + chars);
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > start + chars / 2) end = space;
  }
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export interface CorpusSearchOptions {
  dir?: string;
  /** Hits returned (default 5, max 100). */
  k?: number;
  /** Hits skipped — the page offset into the cached ranking (default 0). */
  offset?: number;
  /** Characters of each document's lead text and match window (default `CORPUS_LEAD_CHARS`). */
  leadChars?: number;
  /** Rescore with these BM25 parameters (default: `bm25FromEnv()`, else FTS5's ranking). */
  bm25?: Bm25Params | null;
  /** Candidates ranked (default `CORPUS_RESCORE_DEPTH`; max 5,000). */
  depth?: number;
}

/** BM25 search over one corpus. An empty query matches nothing. */
export function searchCorpus(
  name: string,
  query: string,
  opts: CorpusSearchOptions = {},
): CorpusHit[] {
  return searchCorpusPage(name, query, opts).hits;
}

/**
 * One page of a corpus ranking: the hits at `offset` … `offset + k`, and how
 * many documents the (cached) ranking holds in all.
 */
export function searchCorpusPage(
  name: string,
  query: string,
  opts: CorpusSearchOptions = {},
): { hits: CorpusHit[]; total: number; offset: number } {
  if (!isCorpusName(name)) throw new Error(`invalid corpus name "${name}"`);
  const k = Math.min(Math.max(opts.k ?? 5, 1), 100);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const lead = Math.max(0, opts.leadChars ?? CORPUS_LEAD_CHARS);
  const bm25 = opts.bm25 === null ? undefined : (opts.bm25 ?? bm25FromEnv());
  const depth = Math.min(Math.max(opts.depth ?? CORPUS_RESCORE_DEPTH, k + offset), 5_000);
  const dir = opts.dir ?? corpusDir();
  const db = corpusDb(name, dir);
  const ranked = rankCorpus(db, corpusPath(name, dir), query, bm25, depth);
  return {
    hits: hydrate(db, ranked.slice(offset, offset + k), query, lead),
    total: ranked.length,
    offset,
  };
}

/** Hits for ranked rowids: FTS5's passage when the document matches the query terms, else none. */
function hydrate(
  db: Database,
  page: ReadonlyArray<{ rowid: number; score: number }>,
  query: string,
  lead: number,
): CorpusHit[] {
  const match = ftsQuery(query);
  const detail = db.query(
    `SELECT d.docid AS docid, d.title AS title, d.url AS url,
            snippet(docs_fts, 1, '[', ']', '…', 32) AS passage,
            substr(d.text, 1, ?) AS lead, d.text AS text
       FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid
      WHERE docs_fts MATCH ? AND docs_fts.rowid = ?`,
  );
  // A dense-only hit (hybrid search) need not contain any query term.
  const plain = db.query(
    `SELECT docid, title, url, '' AS passage, substr(text, 1, ?) AS lead, text
       FROM docs WHERE rowid = ?`,
  );
  return page.flatMap((r) => {
    const row = ((match ? detail.get(lead, match, r.rowid) : null) ?? plain.get(lead, r.rowid)) as
      | (Omit<CorpusHit, "score" | "window"> & { text: string })
      | null;
    if (!row) return [];
    const { text, ...rest } = row;
    return [{ ...rest, score: r.score, window: matchWindow(text, query, lead) }];
  });
}

export interface HybridSearchOptions extends CorpusSearchOptions {
  /** Query embedder: omitted ⇒ the configured one (`corpusEmbedder()`), null ⇒ BM25 only. */
  embedder?: EmbeddingProvider | null;
  /** Dense list weight in the fusion (lexical = 1); default `hybridWeightFromEnv()`. */
  denseWeight?: number;
  signal?: AbortSignal;
}

export interface CorpusSearchPage {
  hits: CorpusHit[];
  total: number;
  offset: number;
  /** `hybrid` when BM25 and dense rankings were fused, else `lexical`. */
  mode: "lexical" | "hybrid";
  /** The embedding model whose vectors were searched (hybrid only). */
  model?: string;
  /** Why a configured hybrid search fell back to BM25 (never an error). */
  degraded?: "embedding_model_mismatch" | "embedding_unavailable";
}

/**
 * One page of a corpus search that fuses BM25 with dense vectors when it can:
 * the corpus holds vectors from the configured query embedder's model. With
 * no embedder, no vectors, a different model or an embedding failure, it is
 * exactly `searchCorpusPage` (BM25), labelled by `mode` / `degraded`.
 */
export async function searchCorpusHybridPage(
  name: string,
  query: string,
  opts: HybridSearchOptions = {},
): Promise<CorpusSearchPage> {
  const embedder = opts.embedder === undefined ? corpusEmbedder() : opts.embedder;
  const lexical = (degraded?: CorpusSearchPage["degraded"]): CorpusSearchPage => ({
    ...searchCorpusPage(name, query, opts),
    mode: "lexical",
    ...(degraded ? { degraded } : {}),
  });
  if (!embedder) return lexical();
  if (!isCorpusName(name)) throw new Error(`invalid corpus name "${name}"`);
  const dir = opts.dir ?? corpusDir();
  const db = corpusDb(name, dir);
  const path = corpusPath(name, dir);
  const sets = corpusVectorSets(db);
  if (sets.length === 0) return lexical();
  const info = sets.find((s) => s.model === embedder.id && s.count > 0);
  if (!info) return lexical("embedding_model_mismatch");
  const k = Math.min(Math.max(opts.k ?? 5, 1), 100);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const lead = Math.max(0, opts.leadChars ?? CORPUS_LEAD_CHARS);
  const bm25 = opts.bm25 === null ? undefined : (opts.bm25 ?? bm25FromEnv());
  const depth = Math.min(Math.max(opts.depth ?? CORPUS_RESCORE_DEPTH, k + offset), 5_000);
  const weight = opts.denseWeight ?? hybridWeightFromEnv();
  const key = `${path}\u0000hybrid\u0000${info.model}\u0000${weight}\u0000${bm25 ? `${bm25.k1},${bm25.b}` : "fts5"}\u0000${depth}\u0000${query}`;
  let ranked = rankings.get(key);
  if (!ranked) {
    let vector: number[];
    try {
      vector = await queryVector(embedder, info, query, opts.signal);
    } catch {
      opts.signal?.throwIfAborted();
      return lexical("embedding_unavailable");
    }
    const dense = denseRanking(db, path, info, vector, depth);
    ranked = fuseHybrid(rankCorpus(db, path, query, bm25, depth), dense, {
      denseWeight: weight,
      depth,
    });
    rankings.set(key, ranked);
    while (rankings.size > RANKINGS_KEPT) rankings.delete(rankings.keys().next().value!);
  }
  return {
    hits: hydrate(db, ranked.slice(offset, offset + k), query, lead),
    total: ranked.length,
    offset,
    mode: "hybrid",
    model: info.model,
  };
}

/** The vector sets a corpus holds (empty ⇒ BM25 only). */
export function corpusVectors(name: string, dir: string = corpusDir()): CorpusVectorInfo[] {
  return corpusVectorSets(corpusDb(name, dir));
}

/**
 * One document by docid: `maxChars` (default `CORPUS_DOC_MAX_CHARS`) of its
 * text from `offset` (default 0), with the document's full length so a reader
 * can page past the cap.
 */
export function getCorpusDocument(
  name: string,
  docid: string,
  opts: { dir?: string; maxChars?: number; offset?: number } = {},
): (CorpusDoc & { offset: number; totalChars: number }) | undefined {
  const db = corpusDb(name, opts.dir ?? corpusDir());
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const row = db
    .query(
      "SELECT docid, title, url, substr(text, ?, ?) AS text, length(text) AS totalChars FROM docs WHERE docid = ?",
    )
    .get(offset + 1, opts.maxChars ?? CORPUS_DOC_MAX_CHARS, docid) as
    | (CorpusDoc & { totalChars: number })
    | null;
  return row ? { ...row, offset } : undefined;
}

/** `corpus://<name>/<docid>` → its parts; anything else → undefined. */
export function parseCorpusUrl(url: string): { name: string; docid: string } | undefined {
  const m = /^corpus:\/\/([a-z0-9][a-z0-9._-]{0,63})\/(.+)$/.exec(url.trim());
  if (!m) return undefined;
  return { name: m[1]!, docid: decodeURIComponent(m[2]!) };
}

/** The citable URL of a corpus document. */
export function corpusUrl(name: string, docid: string): string {
  return `corpus://${name}/${encodeURIComponent(docid)}`;
}

/** A search provider over one corpus, named `corpus:<name>`. */
export function corpusProvider(name: string, dir: string = corpusDir()): SearchProvider {
  return {
    name: `corpus:${name}`,
    engines: ["corpus"],
    boundOnly: true,
    describe: `local corpus "${name}" (BM25, offline; fetch corpus://${name}/<docid>)`,
    async search(query, o) {
      // Hybrid (BM25 + dense) only when an embedder is configured and the
      // corpus holds its vectors; otherwise exactly the BM25 search.
      const { hits } = await searchCorpusHybridPage(name, query, { dir, k: o.maxResults ?? 5 });
      return hits.map(
        (h): SearchResult => ({
          title: h.title || h.docid,
          url: corpusUrl(name, h.docid),
          snippet: h.passage || h.lead.slice(0, 300),
          source: `corpus:${name}`,
          score: h.score,
          // The part of the document that matched, not only its opening.
          text: h.window || h.lead,
        }),
      );
    },
  };
}

/** Providers for every corpus present (registered at startup). */
export function corpusProviders(dir: string = corpusDir()): SearchProvider[] {
  return listCorpora(dir).map((c) => corpusProvider(c.name, dir));
}
