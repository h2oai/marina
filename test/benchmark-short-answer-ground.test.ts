// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, spyOn } from "bun:test";
import { groundingBarred, runShortAnswer } from "../benchmarks/adapters/short-answer";
import type { BenchmarkConfig, Message } from "../benchmarks/types";
import * as providers from "../src/engine/search-providers/index";

const result = (url: string, title = "", snippet = "") => ({ url, title, snippet, source: "test" });

describe("short-answer grounding bars the benchmark's own sources", () => {
  it("bars SimpleQA's dataset, repository and mirrors", () => {
    const barred = groundingBarred("simpleqa");
    expect(barred(result("https://huggingface.co/datasets/basicv8vc/SimpleQA"))).toBe(true);
    expect(barred(result("https://hf-mirror.com/datasets/someone/simpleqa-verified/viewer"))).toBe(
      true,
    );
    expect(
      barred(result("https://github.com/openai/simple-evals/blob/main/simpleqa_eval.py")),
    ).toBe(true);
    expect(barred(result("https://example.org/post", "SimpleQA answers, all 4326"))).toBe(true);
  });

  it("keeps ordinary sources", () => {
    const barred = groundingBarred("simpleqa");
    expect(barred(result("https://en.wikipedia.org/wiki/Ada_Lovelace", "Ada Lovelace"))).toBe(
      false,
    );
  });

  it("bars FRAMES' dataset but not Wikipedia", () => {
    const barred = groundingBarred("frames");
    expect(barred(result("https://huggingface.co/datasets/google/frames-benchmark"))).toBe(true);
    expect(barred(result("https://en.wikipedia.org/wiki/Picture_frame", "Picture frame"))).toBe(
      false,
    );
  });
});

describe("short-answer grounding execution", () => {
  it.each(["evidence", "empty", "failure", "off"] as const)(
    "records %s grounding without losing response attribution",
    async (mode) => {
      let messages: Message[] = [];
      const search = spyOn(providers, "search").mockImplementation(async () => {
        if (mode === "failure") throw new Error("fixture search outage");
        if (mode === "empty") return [];
        return [
          result("https://huggingface.co/datasets/test/simpleqa", "Answer key", "LEAK"),
          result("https://example.org/ada", "Biography", "Ada wrote the notes."),
        ];
      });
      const log = spyOn(console, "log").mockImplementation(() => {});
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          messages = ((await req.json()) as { messages: Message[] }).messages;
          return Response.json(
            {
              choices: [{ message: { content: "Ada" } }],
              usage: { prompt_tokens: 20, completion_tokens: 2 },
            },
            {
              headers: {
                "x-request-id": "grounding-trace",
                "x-marina-cost-usd": "0.01",
                "x-marina-verify": "approved",
              },
            },
          );
        },
      });
      try {
        const config: BenchmarkConfig = {
          name: "SimpleQA",
          dataset: "simpleqa",
          adapter: "short-answer",
          scoring: "accuracy",
          mode: "passthrough",
          model: "fixture",
          endpoint: server.url.origin,
          concurrency: 1,
          ...(mode === "off" ? {} : { ground: "search" }),
        };
        const [item] = await runShortAnswer(
          [{ id: "a", question: "Who wrote the notes?", answer: "Ada" }],
          config,
        );
        expect(item).toMatchObject({
          correct: true,
          traceId: "grounding-trace",
          verification: "passed",
          usage: { costUsd: 0.01, promptTokens: 20, completionTokens: 2 },
        });
        const prompt = JSON.stringify(messages);
        expect(prompt).not.toContain("LEAK");
        expect(prompt.includes("Ada wrote the notes.")).toBe(mode === "evidence");
        if (mode === "off") {
          expect(search).not.toHaveBeenCalled();
          expect(item?.evidence).toBeUndefined();
          expect(log).not.toHaveBeenCalled();
        } else {
          expect(search).toHaveBeenCalledTimes(1);
          expect(item?.evidence).toBe(mode === "evidence" ? 1 : 0);
          expect(log.mock.calls[0]?.[0]).toContain(
            mode === "evidence" ? "1/1 items had evidence" : "0/1 items had evidence",
          );
          if (mode === "failure") expect(log.mock.calls[0]?.[0]).toContain("1 search failures");
        }
      } finally {
        await server.stop(true);
        search.mockRestore();
        log.mockRestore();
      }
    },
  );

  it("never scores an empty answer as a substring of the expected answer", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ choices: [{ message: { content: "" } }] }),
    });
    try {
      const [item] = await runShortAnswer([{ id: "a", question: "Who?", answer: "Ada" }], {
        name: "SimpleQA",
        dataset: "simpleqa",
        adapter: "short-answer",
        scoring: "accuracy",
        mode: "passthrough",
        model: "fixture",
        endpoint: server.url.origin,
        concurrency: 1,
      });
      expect(item?.correct).toBe(false);
    } finally {
      await server.stop(true);
    }
  });
});
