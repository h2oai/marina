// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Read swarm: reader evidence, mechanical quote checks, aggregation and the read budget. */

import { describe, expect, it } from "bun:test";
import {
  type ReadSwarmBriefStats,
  readSwarmRetriever,
} from "../src/arena/research/read-swarm-retriever";
import { isDateStrict } from "../src/arena/research/retrieve";
import { foldForQuote } from "../src/arena/research/verify";
import type { Candidate } from "../src/retrieval/first-move";
import {
  aggregateCandidates,
  answerKey,
  type DocReading,
  parseReaderReply,
  quoteVerified,
  ReadSwarm,
  readingSummary,
  renderCandidateTable,
} from "../src/retrieval/read-swarm";

const DOCS: Record<string, string> = {
  a: "Jane Roe was born in Galway in 1870. She later founded the Atlantic Rowing Club in Boston.",
  b: "The Atlantic Rowing Club was founded by Jane Roe, an emigrant from Ireland, in 1899.",
  c: "A history of rowing on the Charles River, with no founders named.",
  d: "John Doe, born 1870 in Cork, was a shipwright.",
};

const cand = (id: string): Candidate => ({ id, text: DOCS[id] ?? "" });

/** A reader that answers from a per-document script and counts its calls. */
function scriptedReader(script: Record<string, object | string | Error>) {
  const calls: string[] = [];
  return {
    calls,
    complete: async (_system: string, user: string) => {
      const id = /Document \[(\w+)\]/.exec(user)?.[1] ?? "?";
      calls.push(id);
      const reply = script[id] ?? { relevant: false };
      if (reply instanceof Error) throw reply;
      return typeof reply === "string" ? reply : JSON.stringify(reply);
    },
  };
}

const reading = (over: Partial<DocReading>): DocReading => ({
  id: "x",
  charsRead: 10,
  chunks: 1,
  relevant: true,
  candidateInText: true,
  clues: [],
  quotes: [],
  confidence: 0.5,
  ...over,
});

describe("read swarm: quotes and replies", () => {
  it("verifies quotes verbatim up to folding, across ellipses, and rejects paraphrase", () => {
    const folded = foldForQuote(DOCS.a!);
    expect(quoteVerified("Jane Roe was born in Galway in 1870.", folded)).toBe(true);
    expect(
      quoteVerified("“Jane Roe was born in Galway” … founded the Atlantic Rowing Club", folded),
    ).toBe(true);
    expect(quoteVerified("Jane Roe, born in Galway around 1870", folded)).toBe(false);
    expect(quoteVerified("Galway", folded)).toBe(false); // too short to mean anything
  });

  it("parses a reader reply, keeping only clues in range and scaling percent confidence", () => {
    const p = parseReaderReply(
      'sure: {"relevant": true, "candidate": "Jane Roe", "evidence": [{"clue": 1, "quote": "born in Galway"}, {"clue": 9, "quote": "x y z"}], "confidence": 80, "more": true}',
      2,
    );
    expect(p?.candidate).toBe("Jane Roe");
    expect(p?.quotes).toEqual([{ text: "born in Galway", clue: 1 }, { text: "x y z" }]);
    expect(p?.confidence).toBe(0.8);
    expect(p?.more).toBe(true);
    expect(parseReaderReply("no json here", 2)).toBeUndefined();
    expect(parseReaderReply('{"candidate": "none"}', 2)?.candidate).toBeUndefined();
  });
});

describe("read swarm: aggregation", () => {
  it("groups by answer, merges a multi-word subset, and ranks by verified clues", () => {
    const q = (clue: number) => ({ text: `quote ${clue}`, clue, verified: true });
    const rows = aggregateCandidates([
      reading({ id: "1", candidate: "Jane Roe", clues: [1], quotes: [q(1)] }),
      reading({ id: "2", candidate: "jane  roe.", clues: [2, 3], quotes: [q(2), q(3)] }),
      reading({ id: "3", candidate: "Jane Q. Roe", clues: [4], quotes: [q(4)] }),
      reading({
        id: "4",
        candidate: "John Doe",
        clues: [1, 2],
        quotes: [q(1), q(2)],
        confidence: 0.9,
      }),
      reading({ id: "5", candidate: undefined, clues: [1] }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["jane q roe", "john doe"]);
    expect(rows[0]!.clues).toEqual([1, 2, 3, 4]);
    expect(rows[0]!.docs.sort()).toEqual(["1", "2", "3"]);
    expect(answerKey("The Atlantic Rowing Club")).toBe("atlantic rowing club");
  });

  it("renders a table with bracketed docids and verified quotes only", () => {
    const table = renderCandidateTable(
      ["born 1870", "founded a rowing club"],
      [
        reading({
          id: "a",
          candidate: "Jane Roe",
          clues: [1],
          quotes: [
            { text: "born in Galway in 1870", clue: 1, verified: true },
            { text: "made up", clue: 2, verified: false },
          ],
        }),
        reading({ id: "c", clues: [2], note: "rowing history" }),
      ],
    );
    expect(table).toContain("1. Jane Roe — clues 1 of 2 — docs [a]");
    expect(table).toContain('[a] clue 1: "born in Galway in 1870"');
    expect(table).not.toContain("made up");
    expect(table).toContain("- [c] clues 2 — rowing history");
    expect(readingSummary(reading({ relevant: false, candidate: undefined }))).toEqual({
      relevant: false,
    });
  });
});

describe("read swarm: session", () => {
  const searchOf = (rank: Record<string, string[]>) => async (q: string) =>
    (rank[q] ?? []).map(cand);

  it("reads each clue's best documents first, verifies quotes and builds candidates", async () => {
    const reader = scriptedReader({
      a: {
        relevant: true,
        candidate: "Jane Roe",
        evidence: [
          { clue: 1, quote: "Jane Roe was born in Galway in 1870." },
          { clue: 2, quote: "founded a rowing club in Boston" }, // paraphrase: rejected
        ],
        confidence: 0.7,
      },
      b: {
        relevant: true,
        candidate: "Jane Roe",
        evidence: [{ clue: 2, quote: "The Atlantic Rowing Club was founded by Jane Roe" }],
        confidence: 0.6,
      },
      d: {
        relevant: true,
        candidate: "John Doe",
        evidence: [{ clue: 1, quote: "born 1870 in Cork" }],
      },
    });
    const swarm = new ReadSwarm("Who?", {
      search: searchOf({ Who: ["c"], "born 1870": ["d", "a"], "rowing club": ["b", "c"] }),
      reader,
      clues: ["born 1870", "rowing club"],
      openDocs: 3,
      perClue: 1,
    });
    const opening = await swarm.open();
    // perClue = 1: "d" (clue 1) and "b" (clue 2) first, then the fused order fills the third slot.
    expect(opening.read.slice(0, 2)).toEqual(["d", "b"]);
    expect(opening.read).toHaveLength(3);
    const a = await swarm.readDoc(cand("a"));
    expect(a?.clues).toEqual([1]);
    expect(a?.quotes.map((q) => q.verified)).toEqual([true, false]);
    const rows = swarm.candidates();
    expect(rows[0]!.answer).toBe("Jane Roe");
    expect(rows[0]!.clues).toEqual([1, 2]);
    // Cached: reading "a" again costs no reader call.
    const before = reader.calls.length;
    await swarm.search("born 1870", 2);
    expect(reader.calls.length).toBe(before);
  });

  it("keeps to the document budget and fails open on a reader failure", async () => {
    const reader = scriptedReader({ a: new Error("upstream down"), b: "not json" });
    const swarm = new ReadSwarm("Q", {
      search: searchOf({ Q: ["a", "b", "c", "d"] }),
      reader,
      maxDocs: 3,
      openDocs: 10,
    });
    const opening = await swarm.open();
    expect(opening.read).toHaveLength(3);
    expect(swarm.exhausted()).toBe(true);
    expect(await swarm.readDoc(cand("d"))).toBeUndefined();
    const st = swarm.stats();
    expect(st.readerFailures).toBe(2);
    expect(swarm.readings().find((r) => r.id === "a")?.error).toContain("upstream down");
  });

  it("propagates fatal errors (a spend stop)", async () => {
    class Stop extends Error {}
    const swarm = new ReadSwarm("Q", {
      search: searchOf({ Q: ["a"] }),
      reader: { complete: async () => Promise.reject(new Stop("budget")) },
      isFatal: (e) => e instanceof Stop,
    });
    await expect(swarm.open()).rejects.toBeInstanceOf(Stop);
  });

  it("reads the next chunk only when the reader asks for more", async () => {
    const long = `${"filler text. ".repeat(200)}The founder was Jane Roe of Galway.`;
    const reads: number[] = [];
    let call = 0;
    const swarm = new ReadSwarm("Q", {
      search: async () => [{ id: "L", text: "" }],
      read: async (id, offset, max) => {
        reads.push(offset);
        return { id, text: long.slice(offset, offset + max), totalChars: long.length };
      },
      reader: {
        complete: async () =>
          ++call === 1
            ? JSON.stringify({ relevant: true, more: true })
            : JSON.stringify({
                relevant: true,
                candidate: "Jane Roe",
                evidence: [{ clue: 1, quote: "The founder was Jane Roe of Galway." }],
              }),
      },
      chunkChars: 2000,
      maxChunks: 3,
    });
    await swarm.open();
    expect(reads).toEqual([0, 2000]);
    const r = swarm.readings()[0]!;
    expect(r.chunks).toBe(2);
    expect(r.candidateInText).toBe(true);
    expect(r.clues).toEqual([1]);
  });
});

describe("read swarm: research retriever", () => {
  it("leads the report with verified quotes cited to their pages and keeps date-strictness", async () => {
    const page =
      "Officials said on Monday that turnout reached 64 percent, the highest in two decades of records.";
    const inner = Object.assign(
      async () => ({
        report: "- turnout high [Paper](https://example.com/a)",
        sources: [{ url: "https://example.com/a", title: "Paper", text: page }],
        costUsd: 0.01,
        searches: 1,
        retriever: "inner",
      }),
      { dateStrict: true as const },
    );
    let spent = 0;
    const r = readSwarmRetriever(inner, {
      reader: {
        complete: async () => {
          spent += 0.002;
          return JSON.stringify({
            relevant: true,
            evidence: [
              { clue: 1, quote: "turnout reached 64 percent, the highest in two decades" },
              { clue: 1, quote: "turnout was a record 64%" },
            ],
          });
        },
      },
      spent: () => spent,
      pageText: async () => undefined,
    });
    expect(isDateStrict(r)).toBe(true);
    const out = await r({
      roundId: "t",
      since: "2026-01-01",
      request: "Turnout?",
      queries: ["turnout"],
    });
    expect(out.report).toContain(
      '- "turnout reached 64 percent, the highest in two decades" [Paper](https://example.com/a)',
    );
    expect(out.report).not.toContain("record 64%");
    expect(out.report).toContain("- turnout high [Paper](https://example.com/a)");
    expect(out.costUsd).toBeCloseTo(0.012, 6);
    expect(out.retriever).toBe("inner+read-swarm");
  });

  it("reads the judged pages first under a read budget and reports counts per brief", async () => {
    const pages = ["a", "b", "c"].map((id) => ({
      url: `https://example.com/${id}`,
      title: id,
      text: `Page ${id}: the founder was Jane Roe of Galway, according to the archive.`,
    }));
    const inner = async () => ({
      report: "",
      sources: pages,
      costUsd: 0,
      searches: 1,
      retriever: "inner",
    });
    const read: string[] = [];
    const relevance: Record<string, number> = { a: 0.1, b: 0.2, c: 0.9 };
    const stats: ReadSwarmBriefStats[] = [];
    const r = readSwarmRetriever(inner, {
      reader: {
        complete: async (_system, user) => {
          const id = ["a", "b", "c"].find((x) => user.includes(`Page ${x}:`)) ?? "?";
          read.push(id);
          return JSON.stringify({
            relevant: true,
            evidence: [{ clue: 1, quote: "the founder was Jane Roe of Galway" }],
          });
        },
      },
      maxDocs: 1,
      judge: {
        kind: "test",
        model: "test/judge",
        ask: async (request) => {
          const docs = (request.state as { documents: Record<string, string> }).documents;
          const answers = Object.fromEntries(
            Object.entries(docs).map(([key, text]) => [
              key,
              {
                type: "noul" as const,
                noul: relevance[text.match(/Page (\w):/)?.[1] ?? ""] ?? 0,
              },
            ]),
          );
          return { answers, model: "test/judge", provider: "test", latencyMs: 1 };
        },
      },
      onStats: (s) => stats.push(s),
      pageText: async () => undefined,
    });
    const out = await r({ roundId: "j", since: "2026-01-01", request: "Founder?", queries: ["x"] });
    expect(read).toEqual(["c"]);
    expect(out.retriever).toBe("inner+read-swarm+judged");
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ roundId: "j", pages: 3, docsRead: 1, order: "judged" });
  });

  it("keeps the retriever's order when the judge fails", async () => {
    const inner = async () => ({
      report: "",
      sources: [
        { url: "https://example.com/a", text: "Page a: text about rowing clubs in Boston." },
        { url: "https://example.com/b", text: "Page b: text about rowing clubs in Galway." },
      ],
      costUsd: 0,
      searches: 1,
      retriever: "inner",
    });
    const read: string[] = [];
    const stats: ReadSwarmBriefStats[] = [];
    const r = readSwarmRetriever(inner, {
      reader: {
        complete: async (_system, user) => {
          read.push(user.includes("Page a:") ? "a" : "b");
          return JSON.stringify({ relevant: false, evidence: [] });
        },
      },
      maxDocs: 1,
      judge: {
        kind: "test",
        model: "test/judge",
        ask: async () => {
          throw new Error("judge down");
        },
      },
      onStats: (s) => stats.push(s),
      pageText: async () => undefined,
    });
    const out = await r({ roundId: "k", since: "2026-01-01", request: "Club?", queries: ["x"] });
    expect(read).toEqual(["a"]);
    expect(out.retriever).toBe("inner+read-swarm");
    expect(stats[0]?.order).toBe("retriever");
    expect(stats[0]?.judgeError).toContain("judge down");
  });
});
