// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Optional hybrid corpus search (src/engine/search-providers/corpus-vectors.ts):
 * with no embedder or no matching vectors, search is exactly BM25; with both,
 * BM25 and dense rankings are fused, and every failure falls back to BM25 with
 * a label instead of an error.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCorpus,
  closeCorpora,
  corpusProvider,
  corpusVectors,
  searchCorpusHybridPage,
  searchCorpusPage,
} from "../src/engine/search-providers/corpus";
import {
  corpusEmbedder,
  corpusEmbeddingStatus,
  dropCorpusVectors,
  embedCorpus,
  embeddingText,
  hybridWeightFromEnv,
  importCorpusVectors,
} from "../src/engine/search-providers/corpus-vectors";
import type { SearchHttp } from "../src/engine/search-providers/index";
import { CORPUS_EMBEDDING_ENV } from "../src/memory/embedding-config";
import type { EmbeddingProvider } from "../src/memory/embeddings";

const DOCS = [
  {
    docid: "d1",
    title: "Lighthouses",
    text: "The lighthouse at Ar-Men stands on a rock off Brittany.",
  },
  { docid: "d2", title: "Bread", text: "A sourdough starter ferments flour and water." },
  {
    docid: "d3",
    title: "Tides",
    text: "The Rance tidal power station in Brittany opened in 1966.",
  },
  // Shares no word with the query below, but its "meaning" (the fake vector) matches.
  { docid: "d4", title: "Beacons", text: "Maritime beacons guided sailors along the coast." },
];

/** A fake semantic space: topic axes. "lighthouse" and "beacon" share the maritime axis. */
const AXES = [
  ["lighthouse", "beacon", "maritime", "coast", "sailor"],
  ["bread", "sourdough", "flour"],
  ["tide", "tidal", "power"],
];
function fakeVector(text: string): number[] {
  const t = text.toLowerCase();
  return AXES.map((words) => words.filter((w) => t.includes(w)).length + 0.01);
}
function fakeProvider(id = "fake:topics@1:raw-v1", fail = false): EmbeddingProvider {
  return {
    id,
    async embed(text) {
      if (fail) throw new Error("down");
      return fakeVector(text);
    },
  };
}

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "marina-corpus-hybrid-"));
  await buildCorpus("sea", DOCS, { dir });
});
afterAll(() => {
  closeCorpora();
  rmSync(dir, { recursive: true, force: true });
});

describe("hybrid corpus search", () => {
  it("is exactly BM25 with no embedder, and with an embedder but no vectors", async () => {
    const bm25 = searchCorpusPage("sea", "lighthouse beacon", { dir, k: 4, bm25: null });
    const none = await searchCorpusHybridPage("sea", "lighthouse beacon", {
      dir,
      k: 4,
      bm25: null,
      embedder: null,
    });
    expect(none.mode).toBe("lexical");
    expect(none.hits).toEqual(bm25.hits);
    const noVectors = await searchCorpusHybridPage("sea", "lighthouse beacon", {
      dir,
      k: 4,
      bm25: null,
      embedder: fakeProvider(),
    });
    expect(noVectors).toMatchObject({ mode: "lexical" });
    expect(noVectors.degraded).toBeUndefined();
    expect(noVectors.hits).toEqual(bm25.hits);
  });

  it("embeds the corpus (resumably) and fuses dense hits, hydrating ones with no query term", async () => {
    const path = join(dir, "sea.db");
    const first = await embedCorpus(path, fakeProvider(), { format: "f32", limit: 2 });
    expect(first.embedded).toBe(2);
    const rest = await embedCorpus(path, fakeProvider(), { format: "f32", queryPrefix: "q: " });
    expect(rest.embedded).toBe(2);
    expect(rest.total).toBe(4);
    expect(corpusVectors("sea", dir)).toEqual([
      expect.objectContaining({ model: "fake:topics@1:raw-v1", count: 4, dims: 3, format: "f32" }),
    ]);
    const page = await searchCorpusHybridPage("sea", "lighthouse", {
      dir,
      k: 4,
      bm25: null,
      embedder: fakeProvider(),
    });
    expect(page.mode).toBe("hybrid");
    expect(page.model).toBe("fake:topics@1:raw-v1");
    const ids = page.hits.map((h) => h.docid);
    expect(ids[0]).toBe("d1");
    // d4 never says "lighthouse": only the dense list can bring it in.
    expect(ids).toContain("d4");
    const d4 = page.hits.find((h) => h.docid === "d4")!;
    expect(d4.passage).toBe("");
    expect(d4.title).toBe("Beacons");
  });

  it("falls back to BM25 with a label on a model mismatch or an embedding failure", async () => {
    const bm25 = searchCorpusPage("sea", "tidal power", { dir, k: 3, bm25: null });
    const other = await searchCorpusHybridPage("sea", "tidal power", {
      dir,
      k: 3,
      bm25: null,
      embedder: fakeProvider("other:model@1:raw-v1"),
    });
    expect(other).toMatchObject({ mode: "lexical", degraded: "embedding_model_mismatch" });
    expect(other.hits).toEqual(bm25.hits);
    const down = await searchCorpusHybridPage("sea", "tidal power", {
      dir,
      k: 3,
      bm25: null,
      embedder: fakeProvider("fake:topics@1:raw-v1", true),
    });
    expect(down).toMatchObject({ mode: "lexical", degraded: "embedding_unavailable" });
    expect(down.hits).toEqual(bm25.hits);
  });

  it("refuses to mix vector spaces under one model id, and drops a set", async () => {
    const path = join(dir, "sea.db");
    const f32 = join(dir, "v.f32");
    const ids = join(dir, "v.ids");
    writeFileSync(f32, Buffer.from(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]).buffer));
    writeFileSync(ids, "d1\nd2\nnope\n");
    expect(() =>
      importCorpusVectors(path, f32, ids, {
        model: "fake:topics@1:raw-v1",
        sourceDims: 3,
        format: "int8",
      }),
    ).toThrow(/refusing int8/);
    const imported = importCorpusVectors(path, f32, ids, {
      model: "imported:m@1:raw-v1",
      sourceDims: 3,
      dims: 2,
    });
    expect(imported).toMatchObject({ imported: 2, unknown: 1 });
    expect(imported.info).toMatchObject({ dims: 2, format: "int8", count: 2 });
    expect(() =>
      importCorpusVectors(path, f32, ids, { model: "x:y@1:raw-v1", sourceDims: 4 }),
    ).toThrow(/bytes/);
    expect(dropCorpusVectors(path, "imported:m@1:raw-v1")).toBe(2);
    expect(corpusVectors("sea", dir).map((v) => v.model)).toEqual(["fake:topics@1:raw-v1"]);
  });

  it("the search provider uses BM25 unless an embedder is configured", async () => {
    const env = Object.fromEntries(
      Object.values(CORPUS_EMBEDDING_ENV).map((k) => [k, process.env[k]]),
    );
    try {
      for (const k of Object.values(CORPUS_EMBEDDING_ENV)) delete process.env[k];
      expect(corpusEmbedder()).toBeUndefined();
      expect(corpusEmbeddingStatus()).toEqual({ state: "off" });
      const results = await corpusProvider("sea", dir).search(
        "lighthouse",
        { maxResults: 4 },
        {} as SearchHttp,
      );
      expect(results.map((r) => r.url)).not.toContain("corpus://sea/d4");
      process.env[CORPUS_EMBEDDING_ENV.kind] = "openai";
      // Invalid (no URL/model): readiness says why; search still serves BM25.
      expect(corpusEmbeddingStatus().state).toBe("invalid");
      expect(corpusEmbedder()).toBeUndefined();
      process.env[CORPUS_EMBEDDING_ENV.url] = "http://127.0.0.1:9/v1";
      process.env[CORPUS_EMBEDDING_ENV.model] = "m";
      process.env[CORPUS_EMBEDDING_ENV.revision] = "1";
      expect(corpusEmbeddingStatus()).toEqual({ state: "configured", model: "openai:m@1:raw-v1" });
      expect(corpusEmbedder()?.id).toBe("openai:m@1:raw-v1");
    } finally {
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("embeds the title only when the text does not already carry it; weight env is bounded", () => {
    expect(embeddingText("T", "body", 100)).toBe("T\nbody");
    expect(embeddingText("T", "---\ntitle: T\nbody", 100)).toBe("---\ntitle: T\nbody");
    expect(embeddingText("", "abcdef", 3)).toBe("abc");
    expect(hybridWeightFromEnv({})).toBe(2);
    expect(hybridWeightFromEnv({ MARINA_CORPUS_HYBRID_WEIGHT: "0.5" })).toBe(0.5);
    expect(hybridWeightFromEnv({ MARINA_CORPUS_HYBRID_WEIGHT: "junk" })).toBe(2);
  });
});
