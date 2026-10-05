// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** First-move retrieval: clue decomposition, rank fusion and a listwise model reranker. */

import { describe, expect, it } from "bun:test";
import type { DecisionProvider } from "../src/decisions/types";
import {
  type Candidate,
  decomposeQuestion,
  firstMove,
  fuseRankings,
  judgeRerank,
  llmRerank,
} from "../src/retrieval/first-move";

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

describe("first move with a decision judge", () => {
  const judge = (scores: Record<string, number> | Error): DecisionProvider => ({
    kind: "test",
    model: "test-judge",
    calibrated: false,
    async ask(request) {
      if (scores instanceof Error) throw scores;
      const docs = (request.state as { documents: Record<string, string> }).documents;
      return {
        answers: Object.fromEntries(
          Object.entries(docs).map(([key, text]) => [
            key,
            { type: "noul" as const, noul: scores[text.replace("text of ", "")] ?? 0 },
          ]),
        ),
        model: "test-judge",
        provider: "test",
        latencyMs: 1,
      };
    },
  });

  it("orders by P(yes), ties in incoming order, batching past ten", async () => {
    const pool = Array.from({ length: 12 }, (_, i) => c(`d${i}`));
    const r = await judgeRerank("Q", pool, judge({ d11: 0.9, d3: 0.9, d5: 0.4 }));
    expect(r.ok).toBe(true);
    expect(r.ranked.slice(0, 4).map((x) => x.id)).toEqual(["d3", "d11", "d5", "d0"]);
  });

  it("fails open to the incoming order", async () => {
    const pool = [c("a"), c("b")];
    const r = await judgeRerank("Q", pool, judge(new Error("outage")));
    expect(r).toMatchObject({ ok: false, error: "outage" });
    expect(r.ranked).toEqual(pool);
  });

  it("replaces the listwise reranker inside firstMove", async () => {
    const move = await firstMove("Q", {
      search: async () => [c("a"), c("b"), c("z")],
      judge: judge({ z: 1 }),
      k: 2,
    });
    expect(move.order).toBe("judged");
    expect(move.candidates.map((x) => x.id)).toEqual(["z", "a"]);
  });
});
