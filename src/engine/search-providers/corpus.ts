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
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SearchProvider, SearchResult } from "./index";

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

/** Free text → an FTS5 OR-query of quoted terms (operators and syntax never pass through). */
export function ftsQuery(text: string): string | undefined {
  const terms = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (t) => t.length > 1 && !CORPUS_STOPWORDS.has(t),
  );
  const unique = [...new Set(terms)].slice(0, MAX_QUERY_TERMS);
  if (unique.length === 0) return undefined;
  return unique.map((t) => `"${t}"`).join(" OR ");
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
}

export interface CorpusSearchOptions {
  dir?: string;
  /** Hits returned (default 5, max 50). */
  k?: number;
  /** Characters of each document's lead text (default `CORPUS_LEAD_CHARS`). */
  leadChars?: number;
}

/** BM25 search over one corpus. An empty query matches nothing. */
export function searchCorpus(
  name: string,
  query: string,
  opts: CorpusSearchOptions = {},
): CorpusHit[] {
  if (!isCorpusName(name)) throw new Error(`invalid corpus name "${name}"`);
  const match = ftsQuery(query);
  if (!match) return [];
  const k = Math.min(Math.max(opts.k ?? 5, 1), 50);
  const lead = Math.max(0, opts.leadChars ?? CORPUS_LEAD_CHARS);
  const db = corpusDb(name, opts.dir ?? corpusDir());
  const rows = db
    .query(
      `SELECT d.docid AS docid, d.title AS title, d.url AS url,
              -bm25(docs_fts) AS score,
              snippet(docs_fts, 1, '[', ']', '…', 32) AS passage,
              substr(d.text, 1, ?) AS lead
         FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid
        WHERE docs_fts MATCH ?
        ORDER BY bm25(docs_fts)
        LIMIT ?`,
    )
    .all(lead, match, k) as CorpusHit[];
  return rows;
}

/** One document by docid (text capped at `maxChars`, default `CORPUS_DOC_MAX_CHARS`). */
export function getCorpusDocument(
  name: string,
  docid: string,
  opts: { dir?: string; maxChars?: number } = {},
): CorpusDoc | undefined {
  const db = corpusDb(name, opts.dir ?? corpusDir());
  const row = db
    .query("SELECT docid, title, url, substr(text, 1, ?) AS text FROM docs WHERE docid = ?")
    .get(opts.maxChars ?? CORPUS_DOC_MAX_CHARS, docid) as CorpusDoc | null;
  return row ?? undefined;
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
      const hits = searchCorpus(name, query, { dir, k: o.maxResults ?? 5 });
      return hits.map(
        (h): SearchResult => ({
          title: h.title || h.docid,
          url: corpusUrl(name, h.docid),
          snippet: h.passage || h.lead.slice(0, 300),
          source: `corpus:${name}`,
          score: h.score,
          text: h.lead,
        }),
      );
    },
  };
}

/** Providers for every corpus present (registered at startup). */
export function corpusProviders(dir: string = corpusDir()): SearchProvider[] {
  return listCorpora(dir).map((c) => corpusProvider(c.name, dir));
}
