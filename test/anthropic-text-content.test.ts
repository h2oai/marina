// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { anthropicSystemPrompt, anthropicTextContent } from "../src/net/model-api";

describe("anthropicTextContent", () => {
  test("joins every text block and skips thinking / tool blocks (Claude 5 shape)", () => {
    expect(
      anthropicTextContent([
        { type: "thinking", text: "" },
        { type: "text", text: "72" },
        { type: "tool_use" },
        { type: "text", text: "\n(final)" },
      ]),
    ).toBe("72\n(final)");
  });

  test("tolerates legacy blocks without a type and empty responses", () => {
    expect(anthropicTextContent([{ text: "hello" }])).toBe("hello");
    expect(anthropicTextContent([{ type: "thinking" }])).toBe("");
    expect(anthropicTextContent(undefined)).toBe("");
    expect(anthropicTextContent([])).toBe("");
  });
});

describe("anthropicSystemPrompt", () => {
  test("concatenates every system message in order, including memory injected as a second one", () => {
    expect(
      anthropicSystemPrompt([
        { role: "system", content: "Answer concisely." },
        { role: "user", content: "hi" },
        { role: "system", content: "[Relevant Notes]\nQ: mirror | A: 4.7 meters" },
      ]),
    ).toBe("Answer concisely.\n\n[Relevant Notes]\nQ: mirror | A: 4.7 meters");
  });

  test("accepts OpenAI content-part arrays and ignores blanks", () => {
    expect(
      anthropicSystemPrompt([
        { role: "system", content: [{ type: "text", text: "A" }, { type: "image_url" }] },
        { role: "system", content: "   " },
        { role: "system", content: [{ text: "B" }] },
      ]),
    ).toBe("A\n\nB");
    expect(anthropicSystemPrompt([{ role: "user", content: "x" }])).toBe("");
  });
});
