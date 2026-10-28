// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

// Images on the inbound compatibility surfaces: Anthropic `/v1/messages`
// image blocks and Ollama `images` become OpenAI `image_url` parts; what a
// route cannot carry (documents, unknown sources, non-images) is a 400, never
// a silent drop.

import { describe, expect, it } from "bun:test";
import {
  type AnthropicInboundDeps,
  AnthropicTranslationError,
  handleAnthropicMessages,
  translateMessages,
} from "../src/net/adapters/anthropic-inbound";
import {
  ollamaImageParts,
  ollamaImagesProblem,
  ollamaMessageToOpenai,
  validateOllamaRequest,
} from "../src/net/model-api/ollama";
import { scopeProcessState } from "./process-state";

// 1×1 PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("Anthropic inbound images", () => {
  it("translates base64 and url image blocks into image_url parts", () => {
    const out = translateMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
          { type: "image", source: { type: "url", url: "https://example.com/a.jpg" } },
        ],
      },
    ]);
    expect(out).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } },
          { type: "image_url", image_url: { url: "https://example.com/a.jpg" } },
        ],
      },
    ]);
  });

  it("keeps a text-only message a plain string", () => {
    expect(translateMessages([{ role: "user", content: [{ type: "text", text: "hi" }] }])).toEqual([
      { role: "user", content: "hi" },
    ]);
  });

  it("moves tool_result images into a following user message", () => {
    const out = translateMessages([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
            ],
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: [{ type: "text", text: "done" }],
          },
          { type: "text", text: "and now?" },
        ],
      },
    ]);
    expect(out).toEqual([
      { role: "tool", tool_call_id: "toolu_1", content: "(see attached image)" },
      { role: "tool", tool_call_id: "toolu_2", content: "done" },
      {
        role: "user",
        content: [
          { type: "text", text: "Attached image(s) from tool result:" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } },
          { type: "text", text: "and now?" },
        ],
      },
    ]);
  });

  it("refuses document blocks and unsupported image sources", () => {
    expect(() =>
      translateMessages([
        { role: "user", content: "a" },
        {
          role: "user",
          content: [
            { type: "text", text: "read" },
            { type: "document", source: { type: "base64", media_type: "application/pdf" } },
          ],
        },
      ]),
    ).toThrow("messages[1].content[1]: document blocks are not supported");
    expect(() =>
      translateMessages([
        { role: "user", content: [{ type: "image", source: { type: "file", file_id: "f" } }] },
      ]),
    ).toThrow(AnthropicTranslationError);
    expect(() =>
      translateMessages([
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t",
              content: [{ type: "document", source: { type: "text", data: "x" } }],
            },
          ],
        },
      ]),
    ).toThrow("messages[0].content[0].content[0]");
    expect(() =>
      translateMessages([
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "x" } },
          ],
        },
      ]),
    ).toThrow("media_type");
  });

  it("answers 400 invalid_request_error instead of forwarding a document", async () => {
    let called = false;
    const deps: AnthropicInboundDeps = {
      async runInternal() {
        called = true;
        return Response.json({});
      },
    };
    const resp = await handleAnthropicMessages(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "m",
          max_tokens: 10,
          messages: [{ role: "user", content: [{ type: "document", source: { type: "base64" } }] }],
        }),
      }),
      deps,
    );
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("messages[0].content[0]");
    expect(called).toBe(false);
  });

  it("forwards image parts to the internal chat body", async () => {
    let seen: Record<string, unknown> | undefined;
    const deps: AnthropicInboundDeps = {
      async runInternal(body) {
        seen = body;
        return Response.json({
          choices: [{ finish_reason: "stop", message: { content: "a dot" } }],
        });
      },
    };
    const resp = await handleAnthropicMessages(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "m",
          max_tokens: 10,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: PNG_B64 },
                },
              ],
            },
          ],
        }),
      }),
      deps,
    );
    expect(resp.status).toBe(200);
    const messages = seen?.messages as Array<{ content: unknown }>;
    expect(messages[0]!.content).toEqual([
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } },
    ]);
  });
});

describe("Ollama inbound images", () => {
  it("translates base64 images into data-URL image_url parts", () => {
    expect(ollamaImagesProblem([PNG_B64])).toBeUndefined();
    expect(ollamaImageParts([PNG_B64])).toEqual([
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } },
    ]);
    expect(ollamaMessageToOpenai({ role: "user", content: "what?", images: [PNG_B64] })).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what?" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } },
      ],
    });
  });

  it("passes a message without images through unchanged", () => {
    const m = { role: "assistant", content: "x", tool_calls: [] };
    expect(ollamaMessageToOpenai(m)).toBe(m);
  });

  it("refuses non-images, non-base64 and oversized images with unsupported_parameter", async () => {
    const err = async (resp: Response | undefined) =>
      ((await resp!.json()) as { error: { code: string; param: string; message: string } }).error;
    const notImage = await err(
      validateOllamaRequest("chat", {
        messages: [
          { role: "user", content: "x", images: [Buffer.from("hello").toString("base64")] },
        ],
      }),
    );
    expect(notImage).toMatchObject({ code: "unsupported_parameter", param: "messages[].images" });
    expect(
      await err(validateOllamaRequest("generate", { prompt: "x", images: ["***"] })),
    ).toMatchObject({ code: "unsupported_parameter", param: "images" });
    using _state = scopeProcessState({ env: { MARINA_VISION_MAX_BYTES: "10" } });
    expect(
      (await err(validateOllamaRequest("generate", { prompt: "x", images: [PNG_B64] }))).message,
    ).toContain("exceeds 10");
  });

  it("accepts valid images on both routes", () => {
    expect(
      validateOllamaRequest("chat", {
        messages: [{ role: "user", content: "x", images: [PNG_B64] }],
      }),
    ).toBeUndefined();
    expect(validateOllamaRequest("generate", { prompt: "x", images: [PNG_B64] })).toBeUndefined();
  });
});
