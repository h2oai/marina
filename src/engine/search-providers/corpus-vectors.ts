// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Optional dense vectors for a local corpus, and hybrid (BM25 + dense) search.
 *
 * Nothing here is required. A corpus with no vectors, or a process with no
 * corpus embedding model configured (MARINA_CORPUS_EMBEDDINGS unset), searches
 * exactly as before — BM25 only. Hybrid search runs only when BOTH hold: the
 * corpus file has vectors from model M, and the configured query embedder is M
 * (same provider id). Anything else — a different model, an embedding outage,
 * the daily spend cap — falls back to BM25 and says so (`degraded`), never an
 * error.
 *
 * Vectors live in the corpus file itself (`doc_vectors`: model, rowid, blob in
 * the formats of `src/retrieval/vectors.ts`), one row per document per model,
 * with the model's parameters (format, dims, query prefix, characters
 * embedded) in `meta` under `embedding:<model>`. They are written by
 * `bun run corpus embed` (any configured embedding provider) or
 * `bun run corpus vectors import` (pre-computed vectors, e.g. a published
 * index), and searched by an exact in-memory scan.
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  CORPUS_EMBEDDING_ENV,
  embeddingMaxInputTokens,
  embeddingProviderFromConfig,
  embeddingProviderId,
  lazyEmbeddingProvider,
  parseEmbeddingEnv,
} from "../../memory/embedding-config";
import { type EmbeddingProvider, embedMany } from "../../memory/embeddings";
import { reciprocalRankFusion } from "../../retrieval/fusion";
import {
  encodeVector,
  isVectorFormat,
  type VectorFormat,
  VectorMatrix,
} from "../../retrieval/vectors";

const VECTOR_SCHEMA = `CREATE TABLE IF NOT EXISTS doc_vectors (
  model TEXT NOT NULL,
  rowid INTEGER NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (model, rowid)
) WITHOUT ROWID`;

/** Characters of each document embedded unless asked otherwise (~4k tokens). */
export const CORPUS_EMBED_CHARS = 16_000;
/** Candidates each list contributes to the fusion unless asked otherwise. */
export const HYBRID_DEPTH = 1_000;
/** Dense list weight in the fusion (the lexical list weighs 1) unless configured. */
export const HYBRID_DENSE_WEIGHT = 2;

/** One model's vectors in a corpus. */
export interface CorpusVectorInfo {
  model: string;
  format: VectorFormat;
  dims: number;
  /** Prepended to every query before embedding (instruction-tuned models). */
  queryPrefix: string;
  /** Characters of each document that were embedded (0 = unknown / pre-computed). */
  maxChars: number;
  /** Documents with a vector. */
  count: number;
}

function metaKey(model: string): string {
  return `embedding:${model}`;
}

function hasVectorTable(db: Database): boolean {
  return Boolean(
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'doc_vectors'").get(),
  );
}

/** The vector sets a corpus holds (none ⇒ BM25 only). */
export function corpusVectorSets(db: Database): CorpusVectorInfo[] {
  if (!hasVectorTable(db)) return [];
  const rows = db.query("SELECT key, value FROM meta WHERE key LIKE 'embedding:%'").all() as {
    key: string;
    value: string;
  }[];
  const out: CorpusVectorInfo[] = [];
  for (const row of rows) {
    try {
      const v = JSON.parse(row.value) as Partial<CorpusVectorInfo>;
      if (!v.format || !isVectorFormat(v.format) || !Number.isInteger(v.dims) || !v.dims) continue;
      const model = row.key.slice("embedding:".length);
      const count = (
        db.query("SELECT count(*) AS n FROM doc_vectors WHERE model = ?").get(model) as {
          n: number;
        }
      ).n;
      out.push({
        model,
        format: v.format,
        dims: v.dims,
        queryPrefix: typeof v.queryPrefix === "string" ? v.queryPrefix : "",
        maxChars: typeof v.maxChars === "number" ? v.maxChars : 0,
        count,
      });
    } catch {
      // allow-empty-catch: a malformed meta row is not a vector set; BM25 still serves
    }
  }
  return out;
}

function writeMeta(db: Database, info: Omit<CorpusVectorInfo, "count">): void {
  db.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    metaKey(info.model),
    JSON.stringify({
      format: info.format,
      dims: info.dims,
      queryPrefix: info.queryPrefix,
      maxChars: info.maxChars,
    }),
  );
}

/** Same model id, different parameters ⇒ refuse rather than mix two vector spaces. */
function assertCompatible(db: Database, info: Omit<CorpusVectorInfo, "count">): void {
  const existing = corpusVectorSets(db).find((s) => s.model === info.model);
  if (!existing || existing.count === 0) return;
  if (existing.format !== info.format || existing.dims !== info.dims)
    throw new Error(
      `corpus already holds ${existing.count} vectors for ${info.model} as ${existing.format}/${existing.dims}d; ` +
        `refusing ${info.format}/${info.dims}d (drop them first: bun run corpus vectors drop)`,
    );
}

/** The text of a document that gets embedded: title (unless the text already opens with it) and text, capped. */
export function embeddingText(title: string, text: string, maxChars: number): string {
  const head = text.slice(0, 1_000);
  const body = title && !head.includes(title) ? `${title}\n${text}` : text;
  return body.slice(0, maxChars);
}

export interface EmbedCorpusOptions {
  format?: VectorFormat;
  /** Keep a Matryoshka prefix of this many dimensions (default: all the model returns). */
  dims?: number;
  /** Characters of each document to embed (default `CORPUS_EMBED_CHARS`). */
  maxChars?: number;
  queryPrefix?: string;
  /** Documents per provider request (default 16). */
  batch?: number;
  /** Stop after this many newly embedded documents. */
  limit?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * Embed every document of a corpus that has no vector for `provider` yet
 * (resumable: rerunning continues where it stopped). Writes in place to the
 * corpus file; readers keep working (WAL is not required — each batch is one
 * short transaction).
 */
export async function embedCorpus(
  path: string,
  provider: EmbeddingProvider,
  opts: EmbedCorpusOptions = {},
): Promise<{ embedded: number; total: number; info: CorpusVectorInfo }> {
  const db = new Database(path);
  try {
    db.exec(VECTOR_SCHEMA);
    const format = opts.format ?? "int8";
    const maxChars = opts.maxChars ?? CORPUS_EMBED_CHARS;
    const batch = Math.max(1, opts.batch ?? 16);
    const pending = db
      .query(
        `SELECT d.rowid AS rowid, d.title AS title, d.text AS text FROM docs d
          WHERE NOT EXISTS (SELECT 1 FROM doc_vectors v WHERE v.model = ? AND v.rowid = d.rowid)
          ORDER BY d.rowid`,
      )
      .all(provider.id) as { rowid: number; title: string; text: string }[];
    const todo = opts.limit === undefined ? pending : pending.slice(0, opts.limit);
    const insert = db.prepare(
      "INSERT OR REPLACE INTO doc_vectors (model, rowid, vector) VALUES (?, ?, ?)",
    );
    let dims = opts.dims;
    let embedded = 0;
    for (let i = 0; i < todo.length; i += batch) {
      opts.signal?.throwIfAborted();
      const rows = todo.slice(i, i + batch);
      const vectors = await embedMany(
        provider,
        rows.map((r) => embeddingText(r.title, r.text, maxChars)),
        opts.signal,
      );
      if (dims === undefined) dims = vectors[0]!.length;
      const info = {
        model: provider.id,
        format,
        dims,
        queryPrefix: opts.queryPrefix ?? "",
        maxChars,
      };
      if (embedded === 0) assertCompatible(db, info);
      db.transaction(() => {
        for (const [j, r] of rows.entries())
          insert.run(provider.id, r.rowid, encodeVector(vectors[j]!, format, dims));
        writeMeta(db, info);
      })();
      embedded += rows.length;
      opts.onProgress?.(embedded, todo.length);
    }
    if (dims === undefined) {
      const existing = corpusVectorSets(db).find((s) => s.model === provider.id);
      if (!existing) throw new Error("no documents to embed");
      return { embedded: 0, total: existing.count, info: existing };
    }
    const info = corpusVectorSets(db).find((s) => s.model === provider.id)!;
    return { embedded, total: info.count, info };
  } finally {
    db.close();
  }
}

export interface ImportVectorsOptions {
  /** Provider id the vectors belong to — must equal the query embedder's id to be searched. */
  model: string;
  /** Dimensions of each row in the f32 file. */
  sourceDims: number;
  /** Keep this many leading dimensions (Matryoshka); default all. */
  dims?: number;
  format?: VectorFormat;
  queryPrefix?: string;
  maxChars?: number;
  onProgress?: (done: number) => void;
}

/**
 * Import pre-computed vectors: a raw little-endian float32 matrix (row-major,
 * `sourceDims` per row) and a text file with one docid per line, in the same
 * order. Docids not in the corpus are counted and skipped.
 */
export function importCorpusVectors(
  path: string,
  f32Path: string,
  idsPath: string,
  opts: ImportVectorsOptions,
): { imported: number; unknown: number; info: CorpusVectorInfo } {
  const ids = readFileSync(idsPath, "utf8").split("\n").filter(Boolean);
  const buf = readFileSync(f32Path);
  if (buf.byteLength !== ids.length * opts.sourceDims * 4)
    throw new Error(
      `${f32Path} holds ${buf.byteLength} bytes; ${ids.length} ids × ${opts.sourceDims} dims × 4 = ${ids.length * opts.sourceDims * 4}`,
    );
  const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const format = opts.format ?? "int8";
  const dims = opts.dims ?? opts.sourceDims;
  if (dims > opts.sourceDims) throw new Error(`dims ${dims} > source dims ${opts.sourceDims}`);
  const db = new Database(path);
  try {
    db.exec(VECTOR_SCHEMA);
    const info = {
      model: opts.model,
      format,
      dims,
      queryPrefix: opts.queryPrefix ?? "",
      maxChars: opts.maxChars ?? 0,
    };
    assertCompatible(db, info);
    const rowidOf = db.prepare("SELECT rowid FROM docs WHERE docid = ?");
    const insert = db.prepare(
      "INSERT OR REPLACE INTO doc_vectors (model, rowid, vector) VALUES (?, ?, ?)",
    );
    let imported = 0;
    let unknown = 0;
    const chunk = 5_000;
    for (let start = 0; start < ids.length; start += chunk) {
      db.transaction(() => {
        for (let i = start; i < Math.min(ids.length, start + chunk); i++) {
          const row = rowidOf.get(ids[i]!) as { rowid: number } | null;
          if (!row) {
            unknown++;
            continue;
          }
          const v = data.subarray(i * opts.sourceDims, (i + 1) * opts.sourceDims);
          insert.run(opts.model, row.rowid, encodeVector(v, format, dims));
          imported++;
        }
        writeMeta(db, info);
      })();
      opts.onProgress?.(imported);
    }
    return { imported, unknown, info: corpusVectorSets(db).find((s) => s.model === opts.model)! };
  } finally {
    db.close();
  }
}

/** Remove one model's vectors (and its meta row). Returns rows removed. */
export function dropCorpusVectors(path: string, model: string): number {
  const db = new Database(path);
  try {
    if (!hasVectorTable(db)) return 0;
    const n = db.query("DELETE FROM doc_vectors WHERE model = ?").run(model).changes;
    db.query("DELETE FROM meta WHERE key = ?").run(metaKey(model));
    return n;
  } finally {
    db.close();
  }
}

interface LoadedVectors {
  info: CorpusVectorInfo;
  rowids: Int32Array | number[];
  matrix: VectorMatrix;
}
const matrices = new Map<string, LoadedVectors>();

/** The in-memory matrix of one model's vectors (loaded once per corpus file and model). */
function loadVectors(db: Database, path: string, info: CorpusVectorInfo): LoadedVectors {
  const key = `${path}\u0000${info.model}`;
  const hit = matrices.get(key);
  if (hit && hit.info.count === info.count) return hit;
  const rows = db
    .query("SELECT rowid, vector FROM doc_vectors WHERE model = ? ORDER BY rowid")
    .all(info.model) as { rowid: number; vector: Uint8Array }[];
  const loaded = {
    info,
    rowids: rows.map((r) => r.rowid),
    matrix: VectorMatrix.fromBlobs(
      rows.map((r) => r.vector),
      info.format,
      info.dims,
    ),
  };
  matrices.set(key, loaded);
  return loaded;
}

/** Drop cached matrices (tests, rebuilds). */
export function closeCorpusVectors(): void {
  matrices.clear();
  queryVectors.clear();
}

/** Dense ranking of a query vector over a corpus: rowids, best first. */
export function denseRanking(
  db: Database,
  path: string,
  info: CorpusVectorInfo,
  queryVector: ArrayLike<number>,
  depth: number,
): Array<{ rowid: number; score: number }> {
  const loaded = loadVectors(db, path, info);
  return loaded.matrix
    .search(queryVector, depth)
    .map((s) => ({ rowid: loaded.rowids[s.index]!, score: s.score }));
}

const queryVectors = new Map<string, number[]>();
const QUERY_VECTORS_KEPT = 256;

/** The query's embedding (prefix applied), cached per model and text. */
export async function queryVector(
  provider: EmbeddingProvider,
  info: CorpusVectorInfo,
  query: string,
  signal?: AbortSignal,
): Promise<number[]> {
  const text = `${info.queryPrefix}${query}`;
  const key = `${provider.id}\u0000${text}`;
  const hit = queryVectors.get(key);
  if (hit) return hit;
  const v = await provider.embed(text, signal);
  queryVectors.set(key, v);
  while (queryVectors.size > QUERY_VECTORS_KEPT)
    queryVectors.delete(queryVectors.keys().next().value!);
  return v;
}

/** Fuse a lexical and a dense ranking (rowids) by weighted reciprocal rank. */
export function fuseHybrid(
  lexical: ReadonlyArray<{ rowid: number }>,
  dense: ReadonlyArray<{ rowid: number }>,
  opts: { denseWeight?: number; depth?: number } = {},
): Array<{ rowid: number; score: number }> {
  const depth = opts.depth ?? HYBRID_DEPTH;
  return reciprocalRankFusion([
    { ids: lexical.map((r) => String(r.rowid)), depth },
    {
      ids: dense.map((r) => String(r.rowid)),
      depth,
      weight: opts.denseWeight ?? HYBRID_DENSE_WEIGHT,
    },
  ]).map((f) => ({ rowid: Number(f.id), score: f.score }));
}

/** MARINA_CORPUS_HYBRID_WEIGHT: the dense list's weight (lexical = 1); invalid ⇒ the default. */
export function hybridWeightFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MARINA_CORPUS_HYBRID_WEIGHT?.trim();
  const w = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(w) && w >= 0 && w <= 100 ? w : HYBRID_DENSE_WEIGHT;
}

let configured: { key: string; provider: EmbeddingProvider | undefined } | undefined;

/**
 * The query embedder for corpora (MARINA_CORPUS_EMBEDDINGS), or undefined when
 * none is configured — or the configuration is invalid, in which case BM25
 * serves and `corpusEmbeddingStatus` reports why.
 */
export function corpusEmbedder(
  env: Record<string, string | undefined> = process.env,
): EmbeddingProvider | undefined {
  const key = Object.values(CORPUS_EMBEDDING_ENV)
    .map((k) => env[k] ?? "")
    .join("\u0000");
  if (configured?.key === key) return configured.provider;
  let provider: EmbeddingProvider | undefined;
  try {
    const config = parseEmbeddingEnv(env, CORPUS_EMBEDDING_ENV);
    const id = embeddingProviderId(config);
    provider = id
      ? lazyEmbeddingProvider(
          id,
          () => embeddingProviderFromConfig(config),
          embeddingMaxInputTokens(config),
        )
      : undefined;
  } catch {
    provider = undefined;
  }
  configured = { key, provider };
  return provider;
}

/** What hybrid search would do for this configuration — for readiness. */
export function corpusEmbeddingStatus(env: Record<string, string | undefined> = process.env): {
  state: "off" | "configured" | "invalid";
  model?: string;
  error?: string;
} {
  try {
    const config = parseEmbeddingEnv(env, CORPUS_EMBEDDING_ENV);
    const id = embeddingProviderId(config);
    return id ? { state: "configured", model: id } : { state: "off" };
  } catch (error) {
    return { state: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}
