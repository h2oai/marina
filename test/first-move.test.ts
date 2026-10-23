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
  rerankPool,
} from "../src/retrieval/first-move";
import {
  type CrossEncoder,
  crossEncoderFor,
  crossEncoderFromEnv,
  parseScores,
  rerankEndpoint,
} from "../src/retrieval/rerank-client";

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

describe("cross-encoder reranking", () => {
  const encoder = (scores: number[] | Error): CrossEncoder & { calls: string[][] } => {
    const calls: string[][] = [];
    return {
      name: "rerank:test",
      calls,
      async score(_q, docs) {
        calls.push([...docs]);
        if (scores instanceof Error) throw scores;
        return scores;
      },
    };
  };

  it("orders by score in one call, ties keeping their order, and takes precedence", async () => {
    const enc = encoder([0.1, 0.9, 0.5, 0.9]);
    const judge = {
      kind: "x",
      ask: async () => {
        throw new Error("judge must not run");
      },
    } as unknown as DecisionProvider;
    const r = await rerankPool("Q", [c("a"), c("b"), c("c"), c("d")], {
      crossEncoder: enc,
      judge,
      reranker: model("never"),
    });
    expect(r.order).toBe("cross-encoded");
    expect(r.ranked.map((x) => x.id)).toEqual(["b", "d", "c", "a"]);
    expect(enc.calls).toHaveLength(1);
    expect(enc.calls[0]![0]).toBe("text of a");
  });

  it("fails open to the incoming order, and firstMove reports it", async () => {
    const r = await rerankPool("Q", [c("a"), c("b")], { crossEncoder: encoder(new Error("503")) });
    expect(r).toMatchObject({ order: "fused", error: "503" });
    expect(r.ranked.map((x) => x.id)).toEqual(["a", "b"]);
    const moved = await firstMove("Q", {
      search: async () => [c("x"), c("y")],
      crossEncoder: encoder([0, 1]),
      k: 2,
    });
    expect(moved.order).toBe("cross-encoded");
    expect(moved.candidates.map((x) => x.id)).toEqual(["y", "x"]);
  });

  it("speaks the /rerank and NVIDIA shapes, refuses at the cap, records cost", async () => {
    const sent: unknown[] = [];
    const costs: number[] = [];
    let refuse: string | undefined;
    const reply = (body: unknown) =>
      (async (_url: string | URL, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(body));
      }) as typeof fetch;
    const cohere = rerankEndpoint({
      url: "http://127.0.0.1:9/v1/rerank",
      model: "m",
      refuse: () => refuse,
      onCost: (usd) => costs.push(usd),
      fetch: reply({
        results: [
          { index: 1, relevance_score: 0.8 },
          { index: 0, relevance_score: 0.2 },
        ],
        usage: { cost: 0.0001 },
      }),
    });
    expect(await cohere.score("q", ["d0", "d1"])).toEqual([0.2, 0.8]);
    expect(sent[0]).toEqual({ model: "m", query: "q", documents: ["d0", "d1"] });
    expect(costs).toEqual([0.0001]);
    const nvidia = rerankEndpoint({
      url: "http://127.0.0.1:9/reranking",
      model: "nvidia/nemotron-3.5-rerank-8b",
      format: "nvidia",
      refuse: () => undefined,
      onCost: () => {},
      fetch: reply({
        rankings: [
          { index: 0, logit: -1.5 },
          { index: 1, logit: 3 },
        ],
      }),
    });
    expect(await nvidia.score("q", ["d0", "d1"])).toEqual([-1.5, 3]);
    expect(sent[1]).toEqual({
      model: "nvidia/nemotron-3.5-rerank-8b",
      query: { text: "q" },
      passages: [{ text: "d0" }, { text: "d1" }],
    });
    refuse = "daily spend cap reached";
    await expect(cohere.score("q", ["d0"])).rejects.toThrow("daily spend cap");
    expect(sent).toHaveLength(2);
  });

  it("rejects replies that skip or invent documents, and misconfiguration", () => {
    expect(() => parseScores({ results: [{ index: 0, relevance_score: 1 }] }, "rerank", 2)).toThrow(
      "unscored",
    );
    expect(() => parseScores({ results: [{ index: 5, score: 1 }] }, "rerank", 2)).toThrow(
      "invalid",
    );
    expect(parseScores({ data: [{ index: 0, score: 2 }] }, "rerank", 1)).toEqual([2]);
    expect(crossEncoderFromEnv({})).toBeUndefined();
    expect(() => crossEncoderFromEnv({ MARINA_RERANK_URL: "http://x/rerank" })).toThrow(
      "MARINA_RERANK_MODEL is not",
    );
    expect(() =>
      crossEncoderFromEnv({
        MARINA_RERANK_URL: "http://x/rerank",
        MARINA_RERANK_MODEL: "m",
        MARINA_RERANK_FORMAT: "cohere",
      }),
    ).toThrow("rerank or nvidia");
    expect(
      crossEncoderFromEnv({ MARINA_RERANK_URL: "http://x/rerank", MARINA_RERANK_MODEL: "m" })?.name,
    ).toBe("rerank:m");
  });
});

describe("switching rerankers", () => {
  it("defaults to OpenRouter with its own key, sends a vendor key only to that vendor, and takes any model per call", async () => {
    const seen: { url: string; auth?: string; model: string }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      seen.push({
        url: String(url),
        auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
        model: JSON.parse(String(init?.body)).model,
      });
      return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 1 }] }));
    }) as typeof fetch;
    try {
      const env = { MARINA_RERANK_MODEL: "cohere/rerank-4-pro", OPENROUTER_API_KEY: "or" };
      await crossEncoderFromEnv(env)!.score("q", ["d"]);
      await crossEncoderFor("voyageai/rerank-2.5", env).score("q", ["d"]);
      // A self-hosted endpoint never receives a vendor's key.
      await crossEncoderFor("m", { ...env, MARINA_RERANK_URL: "http://127.0.0.1:9/rerank" }).score(
        "q",
        ["d"],
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen).toEqual([
      {
        url: "https://openrouter.ai/api/v1/rerank",
        auth: "Bearer or",
        model: "cohere/rerank-4-pro",
      },
      {
        url: "https://openrouter.ai/api/v1/rerank",
        auth: "Bearer or",
        model: "voyageai/rerank-2.5",
      },
      { url: "http://127.0.0.1:9/rerank", auth: undefined, model: "m" },
    ]);
  });
});
