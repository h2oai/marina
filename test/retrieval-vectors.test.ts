// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Exact vector search (src/retrieval/vectors.ts) and reciprocal-rank fusion (fusion.ts). */

import { describe, expect, it } from "bun:test";
import { reciprocalRankFusion } from "../src/retrieval/fusion";
import {
  decodeVector,
  encodeVector,
  normalizedPrefix,
  TopK,
  VectorMatrix,
  vectorBytes,
} from "../src/retrieval/vectors";

/** Deterministic pseudo-random vectors. */
function vectors(n: number, dims: number, seed = 7): number[][] {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  };
  return Array.from({ length: n }, () => Array.from({ length: dims }, rand));
}

function exactTop(rows: number[][], q: number[], k: number, dims = q.length): number[] {
  const nq = normalizedPrefix(q, dims)!;
  return rows
    .map((r, i) => {
      const v = normalizedPrefix(r, dims)!;
      let s = 0;
      for (let d = 0; d < dims; d++) s += v[d]! * nq[d]!;
      return { i, s };
    })
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, k)
    .map((x) => x.i);
}

describe("vector encoding", () => {
  it("round-trips f32 exactly (normalized) and int8 within quantization error", () => {
    const [v] = vectors(1, 64);
    const unit = normalizedPrefix(v!)!;
    const f32 = decodeVector(encodeVector(v!, "f32"), "f32", 64);
    for (let d = 0; d < 64; d++) expect(f32[d]).toBeCloseTo(unit[d]!, 6);
    const i8 = decodeVector(encodeVector(v!, "int8"), "int8", 64);
    for (let d = 0; d < 64; d++) expect(Math.abs(i8[d]! - unit[d]!)).toBeLessThan(0.01);
    expect(encodeVector(v!, "int8").byteLength).toBe(vectorBytes("int8", 64));
  });

  it("keeps a re-normalized Matryoshka prefix", () => {
    const [v] = vectors(1, 32);
    const out = decodeVector(encodeVector(v!, "f32", 8), "f32", 8);
    expect(out.length).toBe(8);
    expect(Math.hypot(...out)).toBeCloseTo(1, 5);
  });

  it("refuses zero, non-finite and short vectors, and malformed blobs", () => {
    expect(() => encodeVector([0, 0, 0], "f32")).toThrow();
    expect(() => encodeVector([1, Number.NaN], "int8")).toThrow();
    expect(() => encodeVector([1, 2], "f32", 3)).toThrow();
    expect(() => decodeVector(new Uint8Array(7), "f32", 2)).toThrow(/bytes/);
  });
});

describe("TopK", () => {
  it("keeps the k best, earlier index first on ties", () => {
    const top = new TopK(3);
    for (const [i, s] of [0.1, 0.9, 0.5, 0.9, 0.2, 0.7].entries()) top.offer(i, s);
    expect(top.sorted().map((x) => x.item)).toEqual([1, 3, 5]);
    const none = new TopK(0);
    none.offer(0, 1);
    expect(none.size).toBe(0);
  });
});

describe("VectorMatrix", () => {
  const rows = vectors(300, 48, 11);
  const queries = vectors(20, 48, 99);

  it("f32 search equals an exact scan", () => {
    const m = VectorMatrix.fromBlobs(
      rows.map((r) => encodeVector(r, "f32")),
      "f32",
      48,
    );
    for (const q of queries)
      expect(m.search(q, 10).map((x) => x.index)).toEqual(exactTop(rows, q, 10));
  });

  it("int8 search keeps nearly all of the exact top 10", () => {
    const m = VectorMatrix.fromBlobs(
      rows.map((r) => encodeVector(r, "int8")),
      "int8",
      48,
    );
    let overlap = 0;
    for (const q of queries) {
      const exact = new Set(exactTop(rows, q, 10));
      overlap += m.search(q, 10).filter((x) => exact.has(x.index)).length;
    }
    expect(overlap / (queries.length * 10)).toBeGreaterThan(0.9);
  });

  it("searches a truncated index with a truncated query", () => {
    const m = VectorMatrix.fromBlobs(
      rows.map((r) => encodeVector(r, "f32", 16)),
      "f32",
      16,
    );
    expect(m.search(queries[0]!, 5).map((x) => x.index)).toEqual(
      exactTop(rows, queries[0]!, 5, 16),
    );
    expect(() => m.search([1, 2], 5)).toThrow(/at least 16/);
  });
});

describe("reciprocalRankFusion", () => {
  it("one list reproduces itself; weights and depth apply", () => {
    expect(reciprocalRankFusion([{ ids: ["a", "b", "c"] }]).map((f) => f.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    const fused = reciprocalRankFusion([
      { ids: ["a", "b", "c"] },
      { ids: ["c", "b", "a"], weight: 3 },
    ]);
    expect(fused[0]!.id).toBe("c");
    const shallow = reciprocalRankFusion([
      { ids: ["a", "b"], depth: 1 },
      { ids: ["b"], weight: 0 },
    ]);
    expect(shallow.map((f) => f.id)).toEqual(["a"]);
  });

  it("agrees between two lists that both rank an id highly", () => {
    const fused = reciprocalRankFusion([{ ids: ["x", "y", "z"] }, { ids: ["y", "q", "x"] }]);
    expect(fused.slice(0, 2).map((f) => f.id)).toEqual(["y", "x"]);
  });
});
