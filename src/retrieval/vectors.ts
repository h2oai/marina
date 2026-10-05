// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Exact vector search without a native extension — the one implementation
 * memory and local corpora share.
 *
 * Vectors are stored as BLOBs in SQLite (a corpus's `doc_vectors` table) in one
 * of two formats:
 *
 *   f32   4 bytes per dimension, little-endian float32;
 *   int8  a float32 scale followed by one signed byte per dimension
 *         (x ≈ scale · q, scale = max|x| / 127) — a quarter of the size, and
 *         on retrieval benchmarks within noise of f32 for normalized vectors.
 *
 * Every vector is L2-normalized when encoded, so a dot product is the cosine.
 * `dims` below the source length keeps a Matryoshka prefix (models trained
 * that way — Qwen3-Embedding, OpenAI text-embedding-3 — stay usable truncated)
 * and re-normalizes it; queries are truncated the same way.
 *
 * Search is a brute-force scan over one contiguous in-memory matrix with a
 * bounded top-k: 100k × 1,024 int8 is ~100 MB and scans in tens of
 * milliseconds. sqlite-vec / vec0 would also be a brute-force scan and needs a
 * per-platform native binary, so none is required.
 */

export type VectorFormat = "f32" | "int8";

export const VECTOR_FORMATS: readonly VectorFormat[] = ["f32", "int8"];

export function isVectorFormat(value: string): value is VectorFormat {
  return (VECTOR_FORMATS as readonly string[]).includes(value);
}

/** The first `dims` components (all when omitted), L2-normalized. Undefined for a zero or non-finite vector. */
export function normalizedPrefix(
  vector: ArrayLike<number>,
  dims = vector.length,
): Float32Array | undefined {
  if (dims <= 0 || dims > vector.length) return undefined;
  const out = new Float32Array(dims);
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    const x = Number(vector[i]);
    if (!Number.isFinite(x)) return undefined;
    out[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm);
  if (!norm || !Number.isFinite(norm)) return undefined;
  for (let i = 0; i < dims; i++) out[i] = out[i]! / norm;
  return out;
}

/** Bytes one stored vector takes. */
export function vectorBytes(format: VectorFormat, dims: number): number {
  return format === "f32" ? dims * 4 : 4 + dims;
}

/** Encode a vector (normalized, optionally truncated to `dims`). Throws on a zero / non-finite vector. */
export function encodeVector(
  vector: ArrayLike<number>,
  format: VectorFormat,
  dims = vector.length,
): Uint8Array {
  const v = normalizedPrefix(vector, dims);
  if (!v) throw new Error("vector is empty, zero or non-finite");
  const bytes = new Uint8Array(vectorBytes(format, dims));
  const view = new DataView(bytes.buffer);
  if (format === "f32") {
    for (let i = 0; i < dims; i++) view.setFloat32(i * 4, v[i]!, true);
    return bytes;
  }
  let max = 0;
  for (const x of v) max = Math.max(max, Math.abs(x));
  const scale = max / 127;
  view.setFloat32(0, scale, true);
  for (let i = 0; i < dims; i++) view.setInt8(4 + i, Math.round(v[i]! / scale));
  return bytes;
}

/** Decode a stored vector. Throws when the blob does not hold `dims` components. */
export function decodeVector(blob: Uint8Array, format: VectorFormat, dims: number): Float32Array {
  if (blob.byteLength !== vectorBytes(format, dims))
    throw new Error(
      `vector blob has ${blob.byteLength} bytes, expected ${vectorBytes(format, dims)}`,
    );
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Float32Array(dims);
  if (format === "f32") {
    for (let i = 0; i < dims; i++) out[i] = view.getFloat32(i * 4, true);
    return out;
  }
  const scale = view.getFloat32(0, true);
  for (let i = 0; i < dims; i++) out[i] = view.getInt8(4 + i) * scale;
  return out;
}

export interface ScoredIndex {
  index: number;
  score: number;
}

/**
 * Keeps the `k` highest-scoring items seen, in O(k) memory. Ties go to the
 * item `tieBefore` puts first (default: the smaller number, i.e. the earlier
 * row). O(log k) per offer; `sorted()` returns best first.
 */
export class TopK<T = number> {
  private readonly heap: Array<{ item: T; score: number }> = [];
  constructor(
    readonly k: number,
    private readonly tieBefore: (a: T, b: T) => boolean = (a, b) => (a as number) < (b as number),
  ) {}

  /** `a` ranks below `b` (a min-heap on score; on equal scores, by `tieBefore`). */
  private worse(a: { item: T; score: number }, b: { item: T; score: number }): boolean {
    return a.score < b.score || (a.score === b.score && this.tieBefore(b.item, a.item));
  }

  offer(item: T, score: number): void {
    if (this.k <= 0 || Number.isNaN(score)) return;
    const h = this.heap;
    const entry = { item, score };
    if (h.length < this.k) {
      h.push(entry);
      let i = h.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!this.worse(h[i]!, h[p]!)) break;
        [h[i], h[p]] = [h[p]!, h[i]!];
        i = p;
      }
      return;
    }
    if (!this.worse(h[0]!, entry)) return;
    h[0] = entry;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < h.length && this.worse(h[l]!, h[m]!)) m = l;
      if (r < h.length && this.worse(h[r]!, h[m]!)) m = r;
      if (m === i) break;
      [h[i], h[m]] = [h[m]!, h[i]!];
      i = m;
    }
  }

  get size(): number {
    return this.heap.length;
  }

  /** Best first. */
  sorted(): Array<{ item: T; score: number }> {
    return [...this.heap].sort(
      (a, b) => b.score - a.score || (this.tieBefore(a.item, b.item) ? -1 : 1),
    );
  }
}

/**
 * A dense matrix of normalized vectors (one format, one dimension), searched by
 * exact dot product. Rows are addressed by position; callers keep their own ids.
 */
export class VectorMatrix {
  private constructor(
    readonly format: VectorFormat,
    readonly dims: number,
    readonly rows: number,
    private readonly f32: Float32Array | undefined,
    private readonly i8: Int8Array | undefined,
    private readonly scales: Float32Array | undefined,
  ) {}

  /** Build from stored blobs (each `vectorBytes(format, dims)` long); a malformed blob throws. */
  static fromBlobs(blobs: readonly Uint8Array[], format: VectorFormat, dims: number): VectorMatrix {
    const n = blobs.length;
    const size = vectorBytes(format, dims);
    if (format === "f32") {
      const data = new Float32Array(n * dims);
      blobs.forEach((b, r) => {
        if (b.byteLength !== size)
          throw new Error(`row ${r}: ${b.byteLength} bytes, expected ${size}`);
        const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
        for (let d = 0; d < dims; d++) data[r * dims + d] = view.getFloat32(d * 4, true);
      });
      return new VectorMatrix(format, dims, n, data, undefined, undefined);
    }
    const data = new Int8Array(n * dims);
    const scales = new Float32Array(n);
    blobs.forEach((b, r) => {
      if (b.byteLength !== size)
        throw new Error(`row ${r}: ${b.byteLength} bytes, expected ${size}`);
      const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
      scales[r] = view.getFloat32(0, true);
      data.set(new Int8Array(b.buffer, b.byteOffset + 4, dims), r * dims);
    });
    return new VectorMatrix(format, dims, n, undefined, data, scales);
  }

  /** Approximate resident bytes. */
  get bytes(): number {
    return (
      (this.f32?.byteLength ?? 0) + (this.i8?.byteLength ?? 0) + (this.scales?.byteLength ?? 0)
    );
  }

  /** The `k` rows with the highest dot product with `query` (normalized to `dims` first). */
  search(query: ArrayLike<number>, k: number): ScoredIndex[] {
    const q = normalizedPrefix(query, this.dims);
    if (!q) throw new Error(`query vector must have at least ${this.dims} finite components`);
    const top = new TopK<number>(Math.min(k, this.rows));
    const D = this.dims;
    if (this.f32) {
      const data = this.f32;
      for (let r = 0; r < this.rows; r++) {
        let s = 0;
        const base = r * D;
        for (let d = 0; d < D; d++) s += q[d]! * data[base + d]!;
        top.offer(r, s);
      }
    } else {
      const data = this.i8!;
      const scales = this.scales!;
      for (let r = 0; r < this.rows; r++) {
        let s = 0;
        const base = r * D;
        for (let d = 0; d < D; d++) s += q[d]! * data[base + d]!;
        top.offer(r, s * scales[r]!);
      }
    }
    return top.sorted().map((x) => ({ index: x.item, score: x.score }));
  }
}
