// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Corpus ranking beyond FTS5's fixed bm25(): candidates rescored with chosen
 * k1 / b, quoted phrases as a boost, a cached ranking paged by offset, the
 * matching window instead of the document's opening, document paging, and
 * the Porter stemmer agreeing with FTS5's own.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bm25FromEnv,
  buildCorpus,
  closeCorpora,
  DEFAULT_CORPUS_BM25,
  explicitBm25FromEnv,
  ftsQuery,
  getCorpusDocument,
  matchWindow,
  queryParts,
  searchCorpus,
  searchCorpusPage,
} from "../src/engine/search-providers/corpus";
import { porterStem } from "../src/engine/search-providers/porter";

const filler = (n: number) => "Unrelated filler about weather and gardens. ".repeat(n);
const DOCS = [
  // Long, mentions the terms once each far apart.
  {
    docid: "long",
    title: "Almanac",
    text: `${filler(200)} lighthouse ${filler(200)} keeper ${filler(50)}`,
  },
  // Short and dense.
  { docid: "short", title: "Keepers", text: "The lighthouse keeper kept the lighthouse lamp lit." },
  // Holds the exact phrase.
  {
    docid: "phrase",
    title: "Night",
    text: `${filler(5)} the red lighthouse keeper of Ar-Men ${filler(5)}`,
  },
  { docid: "other", title: "Bread", text: "Soda bread needs buttermilk." },
];

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "marina-corpus-rank-"));
  await buildCorpus("rank", DOCS, { dir });
});
afterAll(() => {
  closeCorpora();
  rmSync(dir, { recursive: true, force: true });
});

describe("corpus ranking", () => {
  it("keeps FTS5's ranking by default and rescores with explicit k1 / b", () => {
    const native = searchCorpus("rank", "lighthouse keeper", { dir, k: 3, bm25: null });
    expect(native.map((h) => h.docid)).toContain("short");
    const rescored = searchCorpus("rank", "lighthouse keeper", {
      dir,
      k: 3,
      bm25: { k1: 16, b: 1 },
    });
    // Full length normalisation pushes the long, sparse almanac to the bottom.
    expect(rescored.at(-1)?.docid).toBe("long");
    expect(rescored[0]?.score).toBeGreaterThan(rescored.at(-1)!.score);
  });

  it("counts a quoted phrase as a boost, never dropping documents with only its words", () => {
    expect(queryParts('who was the "red lighthouse keeper" there')).toEqual({
      terms: ["who", "red", "lighthouse", "keeper"],
      phrases: [["red", "lighthouse", "keeper"]],
    });
    expect(ftsQuery('"red lighthouse keeper"')).toBe(
      '"red lighthouse keeper" OR "red" OR "lighthouse" OR "keeper"',
    );
    const hits = searchCorpus("rank", '"red lighthouse keeper"', {
      dir,
      k: 5,
      bm25: { k1: 1.2, b: 0.75 },
    });
    expect(hits[0]?.docid).toBe("phrase");
    expect(hits.map((h) => h.docid)).toContain("short");
  });

  it("pages through one cached ranking", () => {
    const all = searchCorpusPage("rank", "lighthouse keeper", {
      dir,
      k: 3,
      bm25: { k1: 10, b: 1 },
    });
    const second = searchCorpusPage("rank", "lighthouse keeper", {
      dir,
      k: 1,
      offset: 1,
      bm25: { k1: 10, b: 1 },
    });
    expect(all.total).toBe(3);
    expect(second.hits[0]?.docid).toBe(all.hits[1]?.docid);
  });

  it("returns the window that matches, not the document's opening", () => {
    const hit = searchCorpus("rank", "lighthouse", { dir, k: 5, leadChars: 120, bm25: null }).find(
      (h) => h.docid === "long",
    );
    expect(hit?.lead.startsWith("Unrelated filler")).toBe(true);
    expect(hit?.window).toContain("lighthouse");
    expect(matchWindow("short text", "anything", 100)).toBe("short text");
  });

  it("pages a document past its cap and reports its length", () => {
    const doc = getCorpusDocument("rank", "long", { dir, maxChars: 100, offset: 50 });
    expect(doc?.text).toBe(DOCS[0]!.text.slice(50, 150));
    expect(doc?.totalChars).toBe(DOCS[0]!.text.length);
  });

  it("rescores by default, takes explicit parameters only when both are valid, and opts out to FTS5", () => {
    expect(bm25FromEnv({ MARINA_CORPUS_BM25_K1: "16", MARINA_CORPUS_BM25_B: "1" })).toEqual({
      k1: 16,
      b: 1,
    });
    expect(bm25FromEnv({})).toEqual(DEFAULT_CORPUS_BM25);
    expect(bm25FromEnv({ MARINA_CORPUS_BM25_K1: "16" })).toEqual(DEFAULT_CORPUS_BM25);
    expect(bm25FromEnv({ MARINA_CORPUS_BM25_K1: "16", MARINA_CORPUS_BM25_B: "2" })).toEqual(
      DEFAULT_CORPUS_BM25,
    );
    expect(
      bm25FromEnv({
        MARINA_CORPUS_RANKING: "fts5",
        MARINA_CORPUS_BM25_K1: "3",
        MARINA_CORPUS_BM25_B: "1",
      }),
    ).toBeUndefined();
    expect(explicitBm25FromEnv({})).toBeUndefined();
    expect(explicitBm25FromEnv({ MARINA_CORPUS_BM25_K1: "3", MARINA_CORPUS_BM25_B: "1" })).toEqual({
      k1: 3,
      b: 1,
    });
  });
});

describe("Porter stemmer", () => {
  it("stems as SQLite FTS5's porter tokenizer does", () => {
    const words =
      "caresses ponies ties caress cats feed agreed plastered bled motoring sing conflated troubled sized hopping tanned falling hissing fizzed failing filing happy sky relational conditional rational valenci hesitanci digitizer conformabli radicalli differentli vileli analogousli vietnamization predication operator feudalism decisiveness hopefulness callousness formaliti sensitiviti sensibiliti triplicate formative formalize electriciti electrical hopeful goodness revival allowance inference airliner gyroscopic adjustable defensible irritant replacement adjustment dependent adoption homologou communism activate angulariti homologous effective bowdlerize probate rate cease controll roll generalizations lighthouses keepers".split(
        " ",
      );
    const db = new Database(":memory:");
    db.exec(
      "CREATE VIRTUAL TABLE f USING fts5(t, tokenize='porter unicode61'); CREATE VIRTUAL TABLE v USING fts5vocab(f, 'row');",
    );
    const insert = db.prepare("INSERT INTO f(t) VALUES (?)");
    for (const w of words) {
      db.exec("DELETE FROM f");
      insert.run(w);
      const term = (db.query("SELECT term FROM v").get() as { term: string }).term;
      expect(`${w}→${porterStem(w)}`).toBe(`${w}→${term}`);
    }
    db.close();
  });
});
