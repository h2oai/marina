// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Image content parts survive every passthru translation: chat image_url parts
 * reach Anthropic as image blocks (also inside tool results), Responses
 * `input_image` parts become chat `image_url` parts, and a non-text part that
 * cannot be forwarded is refused (400 unsupported_parameter), never dropped.
 */

import { describe, expect, it } from "bun:test";
import { openaiMessagesToAnthropic } from "../src/net/anthropic-tools";
import { UnsupportedParameterError } from "../src/net/openai-errors";
import { responsesInputToMessages } from "../src/net/responses-tools";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("Anthropic translation keeps images", () => {
  it("maps chat image_url (url and data:) and Responses-style input_image to image blocks", () => {
    const { messages } = openaiMessagesToAnthropic([
      {
        role: "user",
        content: [
          { type: "text", text: "What is shown?" },
          { type: "image_url", image_url: { url: "https://example.com/a.png" } },
          { type: "image_url", image_url: { url: PNG } },
          { type: "input_image", image_url: "https://example.com/b.png" },
        ],
      },
    ]);
    const blocks = messages[0]!.content as Array<Record<string, unknown>>;
    expect(blocks.map((b) => b.type)).toEqual(["text", "image", "image", "image"]);
    expect(blocks[1]!.source).toEqual({ type: "url", url: "https://example.com/a.png" });
    expect(blocks[2]!.source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: "iVBORw0KGgo=",
    });
    expect(blocks[3]!.source).toEqual({ type: "url", url: "https://example.com/b.png" });
  });

  it("keeps an image returned inside a tool result", () => {
    const { messages } = openaiMessagesToAnthropic([
      { role: "user", content: "take a screenshot" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "shot", arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: "c1",
        content: [
          { type: "text", text: "here" },
          { type: "image_url", image_url: { url: PNG } },
        ],
      },
    ]);
    const result = (messages.at(-1)!.content as Array<Record<string, unknown>>).find(
      (b) => b.type === "tool_result",
    )!;
    const inner = result.content as Array<Record<string, unknown>>;
    expect(inner.map((b) => b.type)).toEqual(["text", "image"]);
  });

  it("refuses a content part it cannot forward instead of dropping it", () => {
    expect(() =>
      openaiMessagesToAnthropic([
        { role: "user", content: [{ type: "video_url", video_url: { url: "https://x/v.mp4" } }] },
      ]),
    ).toThrow(UnsupportedParameterError);
    expect(() =>
      openaiMessagesToAnthropic([
        { role: "user", content: [{ type: "image_url", image_url: {} }] },
      ]),
    ).toThrow(UnsupportedParameterError);
  });
});

describe("Responses input keeps images", () => {
  it("turns input_image parts into chat image_url parts (detail kept)", () => {
    const turn = responsesInputToMessages([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Describe this" },
          { type: "input_image", image_url: PNG, detail: "high" },
        ],
      },
    ]);
    expect(turn.messages[0]!.content).toEqual([
      { type: "text", text: "Describe this" },
      { type: "image_url", image_url: { url: PNG, detail: "high" } },
    ]);
    expect(turn.text).toBe("Describe this\n[1 image]");
  });

  it("keeps text-only content a plain string", () => {
    const turn = responsesInputToMessages([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
    expect(turn.messages[0]!.content).toBe("hi");
  });

  it("refuses input_file, input_audio and file_id images instead of dropping them", () => {
    for (const part of [
      { type: "input_file", file_id: "f1" },
      { type: "input_audio", input_audio: { data: "x", format: "wav" } },
      { type: "input_image", file_id: "f2" },
    ]) {
      expect(() =>
        responsesInputToMessages([{ type: "message", role: "user", content: [part] }]),
      ).toThrow(UnsupportedParameterError);
    }
  });
});
