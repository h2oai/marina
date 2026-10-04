// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** First-move retrieval: clue decomposition, rank fusion and a listwise model reranker. */

import { describe, expect, it } from "bun:test";
import {
  type Candidate,
  decomposeQuestion,
  firstMove,
  fuseRankings,
  llmRerank,
} from "../src/arena/research/decompose";

const c = (id: string): Candidate => ({ id, text: `text of ${id}` });
const model = (reply: string | Error) => ({
  complete: async () => {
    if (reply instanceof Error) throw reply;
    return reply;
  },
});

describe("first move", () => {
  it("decomposes into distinct clues and fails open to none", async () => {
    expect(
      await decomposeQuestion("Q", model('{"clues": ["born 1870", "Galway", "Galway", 4]}')),
    ).toEqual(["born 1870", "Galway"]);
    expect(await decomposeQuestion("Q", model("no json"))).toEqual([]);
    expect(await decomposeQuestion("Q", model(new Error("down")))).toEqual([]);
  });

  it("fuses rankings by reciprocal rank", () => {
    const fused = fuseRankings([
      [c("a"), c("b"), c("c")],
      [c("b"), c("d")],
    ]);
    expect(fused.map((x) => x.id)).toEqual(["b", "a", "d", "c"]);
  });

  it("reranks by the model's list, keeping the rest in fused order, and ignores junk", async () => {
    const pool = [c("a"), c("b"), c("c")];
    const r = await llmRerank("Q", pool, model('{"ranking": ["c", "[a]", "zz"]}'));
    expect(r).toMatchObject({ ok: true });
    expect(r.ranked.map((x) => x.id)).toEqual(["c", "a", "b"]);
    const bad = await llmRerank("Q", pool, model('{"ranking": ["zz"]}'));
    expect(bad.ok).toBe(false);
    expect(bad.ranked).toEqual(pool);
  });

  it("searches the question and every clue, then reranks the union", async () => {
    const searched: string[] = [];
    const out = await firstMove("Who?", {
      search: async (q) => {
        searched.push(q);
        return q === "Who?" ? [c("a"), c("b")] : [c("gold"), c("b")];
      },
      decomposer: model('{"clues": ["clue one"]}'),
      reranker: model('{"ranking": ["gold"]}'),
      k: 2,
    });
    expect(searched).toEqual(["Who?", "clue one"]);
    expect(out).toMatchObject({ clues: ["clue one"], order: "reranked" });
    expect(out.candidates.map((x) => x.id)).toEqual(["gold", "b"]);
  });
});
