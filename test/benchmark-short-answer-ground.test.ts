// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { groundingBarred } from "../benchmarks/adapters/short-answer";

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
