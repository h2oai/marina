// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local corpora (src/engine/search-providers/corpus.ts): build an offline BM25
 * index from synthetic documents, rank by relevance, read documents back,
 * sanitize free-text queries into FTS5, and reach the corpus through every
 * surface — the search orchestrator (`engines:corpus:<name>`, registered
 * lazily), `web fetch corpus://…`, the search tool room, and the
 * `corpus:<name>` research retriever.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retrieverFromSpec } from "../src/arena/research/retrieve";
import {
  buildCorpus,
  closeCorpora,
  corpusDir,
  corpusUrl,
  ftsQuery,
  getCorpusDocument,
  isCorpusName,
  isUnderTempDir,
  listCorpora,
  parseCorpusUrl,
  searchCorpus,
} from "../src/engine/search-providers/corpus";
import {
  initProvidersSync,
  type SearchHttp,
  search,
  splitEnginesAndProviders,
} from "../src/engine/search-providers/index";
import type { CommandInput, EntityId, KeyValueStore, RoomContext, RoomId } from "../src/types";
import { searchRoom } from "../src/world/rooms/search-room";
import { scopeProcessState } from "./process-state";

const DOCS = [
  {
    docid: "d1",
    title: "Lighthouse keepers of Brittany",
    url: "https://example.org/lighthouse",
    text: "The lighthouse at Ar-Men was built between 1867 and 1881 on a rock off the Breton coast.",
  },
  {
    docid: "d2",
    title: "Sourdough baking",
    url: "https://example.org/bread",
    text: "A sourdough starter is a fermented mixture of flour and water.",
  },
  {
    docid: "d3",
    title: "Tidal power",
    text: "The Rance tidal power station in Brittany opened in 1966.",
  },
];

let dir: string;
let scope: DisposableStack;
const noHttp = {} as SearchHttp;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "marina-corpus-test-"));
  scope = scopeProcessState({ env: { MARINA_CORPUS_DIR: dir } });
  await buildCorpus("demo", DOCS, { dir, source: "synthetic" });
});

afterAll(() => {
  closeCorpora();
  scope.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("corpus index", () => {
  it("builds, lists and ranks by relevance", () => {
    const listed = listCorpora(dir);
    expect(listed.map((c) => [c.name, c.docs, c.source])).toEqual([["demo", 3, "synthetic"]]);
    const hits = searchCorpus("demo", "lighthouse Brittany rock", { dir, k: 3 });
    expect(hits[0]!.docid).toBe("d1");
    expect(hits.map((h) => h.docid)).toContain("d3"); // shares "Brittany"
    expect(hits.map((h) => h.docid)).not.toContain("d2");
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    expect(hits[0]!.passage).toContain("[");
    expect(searchCorpus("demo", "lighthouse", { dir, leadChars: 10 })[0]!.lead).toHaveLength(10);
  });

  it("stems, ignores FTS5 syntax and matches nothing for an empty query", () => {
    expect(searchCorpus("demo", "starters", { dir })[0]?.docid).toBe("d2");
    expect(ftsQuery('lighthouse OR "keepers" NEAR(rock) -coast* a')).toBe(
      '"lighthouse" OR "keepers" OR "near" OR "rock" OR "coast"', // "or" is a stopword
    );
    expect(searchCorpus("demo", '"); DROP TABLE docs; --', { dir })).toEqual([]);
    expect(searchCorpus("demo", "  ", { dir })).toEqual([]);
  });

  it("reads documents back and refuses a rebuild without replace", async () => {
    expect(getCorpusDocument("demo", "d3", { dir })?.title).toBe("Tidal power");
    expect(getCorpusDocument("demo", "nope", { dir })).toBeUndefined();
    expect(getCorpusDocument("demo", "d1", { dir, maxChars: 3 })?.text).toBe("The");
    await expect(buildCorpus("demo", DOCS, { dir })).rejects.toThrow("already exists");
  });

  it("validates names and URLs and never defaults under the temp dir", () => {
    expect(isCorpusName("browsecomp-plus")).toBe(true);
    expect(isCorpusName("../etc")).toBe(false);
    expect(() => searchCorpus("../x", "q", { dir })).toThrow("invalid corpus name");
    expect(parseCorpusUrl(corpusUrl("demo", "a/b c"))).toEqual({ name: "demo", docid: "a/b c" });
    expect(parseCorpusUrl("https://example.org")).toBeUndefined();
    expect(isUnderTempDir(corpusDir({}))).toBe(false);
    expect(isUnderTempDir("/tmp/x")).toBe(true);
  });
});

describe("corpus surfaces", () => {
  it("is a named provider in the search orchestrator, registered lazily", async () => {
    initProvidersSync();
    expect(splitEnginesAndProviders(["corpus:demo", "web"])).toEqual({
      engines: ["web"],
      providers: ["corpus:demo"],
    });
    const results = await search("sourdough flour", { providers: ["corpus:demo"] }, noHttp);
    expect(results[0]!.url).toBe("corpus://demo/d2");
    expect(results[0]!.source).toBe("corpus:demo");
    // Not part of open searches, and never answers a date-bounded one.
    const bounded = await search(
      "sourdough",
      { providers: ["corpus:demo"], before: "2026-01-01T00:00:00Z" },
      noHttp,
    );
    expect(bounded).toEqual([]);
  });

  it("serves search and fetch corpus:// in the search room", async () => {
    let t = 1_000_000;
    const room = searchRoom({ http: noHttp, now: () => t });
    const data = new Map<string, unknown>();
    const store: KeyValueStore = {
      get: <T>(k: string) => data.get(k) as T | undefined,
      set: <T>(k: string, v: T) => void data.set(k, v),
      delete: (k: string) => data.delete(k),
      keys: () => [...data.keys()],
    };
    const sent: string[] = [];
    const ctx = {
      store,
      send: (_e: EntityId, m: string) => void sent.push(m),
    } as unknown as RoomContext;
    const input = (args: string): CommandInput => ({
      raw: args,
      verb: "x",
      args,
      tokens: args.split(/\s+/),
      entity: "e_1" as EntityId,
      room: "lab/search" as RoomId,
    });
    await room.commands!.search!(ctx, input("engine:corpus:demo tidal power station"));
    expect(sent.at(-1)).toContain("corpus://demo/d3");
    t += 10_000;
    await room.commands!.fetch!(ctx, input("corpus://demo/d3"));
    expect(sent.at(-1)).toContain("Rance tidal power station");
    t += 10_000;
    await room.commands!.fetch!(ctx, input("corpus://demo/missing"));
    expect(sent.at(-1)).toContain("No document missing");
  });

  it("researches a brief through the corpus:<name> retriever", async () => {
    const r = retrieverFromSpec("corpus:demo", {});
    const report = await r({
      roundId: "q",
      since: "2020-01-01",
      request: "When did the Rance tidal power station open?",
      queries: ["Rance tidal power station"],
    });
    expect(report.retriever).toBe("corpus:demo");
    expect(report.report).toContain("(corpus://demo/d3)");
    expect(report.sources[0]).toMatchObject({ url: "corpus://demo/d3", title: "Tidal power" });
    expect(report.sources[0]!.text).toContain("1966");
    expect(report.costUsd).toBe(0);
    expect(() => retrieverFromSpec("corpus:../x", {})).toThrow("invalid corpus name");
  });
});
