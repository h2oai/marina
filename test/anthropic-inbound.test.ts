// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  type AnthropicInboundDeps,
  anthropicRequestToOpenai,
  anthropicSystemToText,
  handleAnthropicMessages,
  mapStopReason,
  translateMessages,
  translateStreamToAnthropic,
  translateTools,
} from "../src/net/anthropic-inbound";

type AnthropicResult = {
  type?: string;
  role?: string;
  model?: string;
  id?: string;
  content?: Array<Record<string, unknown>>;
  stop_reason?: string;
  stop_sequence?: unknown;
  usage?: Record<string, number>;
  error?: { type?: string; message?: string };
};

function makeReq(body: unknown): Request {
  return new Request("http://localhost:3300/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A stub runInternal that captures the body it received and returns a fixed
 *  OpenAI-shaped non-streaming JSON response. */
function stubNonStreaming(
  response: unknown,
  status = 200,
): { deps: AnthropicInboundDeps; seen: () => Record<string, unknown> | null } {
  let captured: Record<string, unknown> | null = null;
  const deps: AnthropicInboundDeps = {
    async runInternal(openaiBody) {
      captured = openaiBody;
      return new Response(JSON.stringify(response), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
  return { deps, seen: () => captured };
}

/** Build an internal OpenAI SSE Response from an array of chunk objects. */
function sseResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

const OPENAI_COMPLETION = {
  id: "chatcmpl-abc",
  object: "chat.completion",
  choices: [
    { index: 0, message: { role: "assistant", content: "Hello there" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
};

describe("request translation (Anthropic → OpenAI)", () => {
  it("flattens a system string", () => {
    expect(anthropicSystemToText("be nice")).toBe("be nice");
  });

  it("flattens system content blocks to text", () => {
    const system = [
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
      { type: "other", text: "ignored" },
    ];
    expect(anthropicSystemToText(system)).toBe("line one\n\nline two");
  });

  it("puts system into an OpenAI system message and preserves max_tokens", () => {
    const openai = anthropicRequestToOpenai({
      model: "claude-x",
      system: "sys",
      max_tokens: 256,
      temperature: 0.5,
      messages: [{ role: "user", content: "hi" }],
    });
    const messages = openai.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: "system", content: "sys" });
    expect(messages[1]).toEqual({ role: "user", content: "hi" });
    expect(openai.max_tokens).toBe(256);
    expect(openai.temperature).toBe(0.5);
    expect(openai.model).toBe("claude-x");
  });

  it("translates multi-turn string messages", () => {
    const out = translateMessages([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ]);
    expect(out).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ]);
  });

  it("translates text content blocks", () => {
    const out = translateMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "part a" },
          { type: "text", text: "part b" },
        ],
      },
    ]);
    expect(out).toEqual([{ role: "user", content: "part a\n\npart b" }]);
  });

  it("translates assistant tool_use to OpenAI tool_calls", () => {
    const out = translateMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool_use", id: "toolu_1", name: "search", input: { q: "cats" } },
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe("assistant");
    expect(out[0]!.content).toBe("calling");
    expect(out[0]!.tool_calls).toEqual([
      {
        id: "toolu_1",
        type: "function",
        function: { name: "search", arguments: JSON.stringify({ q: "cats" }) },
      },
    ]);
  });

  it("translates user tool_result to an OpenAI tool message", () => {
    const out = translateMessages([
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "42 cats" }],
      },
    ]);
    expect(out).toEqual([{ role: "tool", tool_call_id: "toolu_1", content: "42 cats" }]);
  });

  it("translates Anthropic tools to OpenAI function tools", () => {
    const tools = translateTools([
      {
        name: "search",
        description: "search the web",
        input_schema: { type: "object", properties: { q: { type: "string" } } },
      },
    ]);
    expect(tools).toEqual([
      {
        type: "function",
        function: {
          name: "search",
          description: "search the web",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      },
    ]);
  });

  it("stop_sequences map to OpenAI stop", () => {
    const openai = anthropicRequestToOpenai({
      messages: [{ role: "user", content: "hi" }],
      stop_sequences: ["STOP"],
    });
    expect(openai.stop).toEqual(["STOP"]);
  });
});

describe("stop_reason mapping", () => {
  it("maps finish reasons", () => {
    expect(mapStopReason("stop")).toBe("end_turn");
    expect(mapStopReason("length")).toBe("max_tokens");
    expect(mapStopReason("tool_calls")).toBe("tool_use");
    expect(mapStopReason(null)).toBe("end_turn");
    expect(mapStopReason(undefined)).toBe("end_turn");
  });
});

describe("non-streaming response translation", () => {
  it("produces Anthropic message shape with content, usage, stop_reason", async () => {
    const { deps, seen } = stubNonStreaming(OPENAI_COMPLETION);
    const res = await handleAnthropicMessages(
      makeReq({ model: "claude-x", messages: [{ role: "user", content: "hi" }] }),
      deps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnthropicResult;
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.model).toBe("claude-x");
    expect(body.content).toEqual([{ type: "text", text: "Hello there" }]);
    expect(body.stop_reason).toBe("end_turn");
    expect(body.stop_sequence).toBeNull();
    expect(body.usage).toEqual({ input_tokens: 11, output_tokens: 3 });
    expect(typeof body.id).toBe("string");
    // stub received an OpenAI-shaped body
    expect(seen()?.stream).toBe(false);
  });

  it("maps length finish_reason to max_tokens", async () => {
    const { deps } = stubNonStreaming({
      choices: [{ message: { content: "cut" }, finish_reason: "length" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const res = await handleAnthropicMessages(
      makeReq({ messages: [{ role: "user", content: "hi" }] }),
      deps,
    );
    const body = (await res.json()) as AnthropicResult;
    expect(body.stop_reason).toBe("max_tokens");
  });

  it("translates OpenAI tool_calls in the response to tool_use blocks", async () => {
    const { deps } = stubNonStreaming({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "call_1", function: { name: "lookup", arguments: '{"x":1}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    const res = await handleAnthropicMessages(
      makeReq({ messages: [{ role: "user", content: "hi" }] }),
      deps,
    );
    const body = (await res.json()) as AnthropicResult;
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content).toEqual([
      { type: "tool_use", id: "call_1", name: "lookup", input: { x: 1 } },
    ]);
  });

  it("rejects a request with no messages", async () => {
    const { deps } = stubNonStreaming(OPENAI_COMPLETION);
    const res = await handleAnthropicMessages(makeReq({ model: "claude-x", messages: [] }), deps);
    expect(res.status).toBe(400);
    const body = (await res.json()) as AnthropicResult;
    expect(body.type).toBe("error");
    expect(body.error?.type).toBe("invalid_request_error");
  });

  it("translates an internal error response to an Anthropic error", async () => {
    const deps: AnthropicInboundDeps = {
      async runInternal() {
        return new Response(JSON.stringify({ error: { message: "no key" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      },
    };
    const res = await handleAnthropicMessages(
      makeReq({ messages: [{ role: "user", content: "hi" }] }),
      deps,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as AnthropicResult;
    expect(body.type).toBe("error");
    expect(body.error?.type).toBe("authentication_error");
    expect(body.error?.message).toBe("no key");
  });
});

describe("streaming response translation", () => {
  it("emits the Anthropic SSE event sequence from an internal OpenAI SSE stream", async () => {
    const deps: AnthropicInboundDeps = {
      async runInternal(_body, opts) {
        expect(opts.stream).toBe(true);
        return sseResponse([
          { choices: [{ delta: { role: "assistant" }, finish_reason: null }] },
          { choices: [{ delta: { content: "Hel" }, finish_reason: null }] },
          { choices: [{ delta: { content: "lo" }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]);
      },
    };
    const res = await handleAnthropicMessages(
      makeReq({ model: "claude-x", stream: true, messages: [{ role: "user", content: "hi" }] }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const text = await readAll(res.body!);

    // Ordered event sequence.
    const order = [
      "event: message_start",
      "event: content_block_start",
      "event: content_block_delta",
      "event: content_block_stop",
      "event: message_delta",
      "event: message_stop",
    ];
    let cursor = 0;
    for (const marker of order) {
      const idx = text.indexOf(marker, cursor);
      expect(idx).toBeGreaterThanOrEqual(0);
      cursor = idx + marker.length;
    }

    // Text deltas carry the streamed content.
    expect(text).toContain('"text_delta"');
    expect(text).toContain('"text":"Hel"');
    expect(text).toContain('"text":"lo"');

    // message_start carries the assistant message envelope.
    expect(text).toContain('"type":"message_start"');
    expect(text).toContain('"role":"assistant"');
    expect(text).toContain('"model":"claude-x"');

    // message_delta maps stop_reason.
    expect(text).toContain('"stop_reason":"end_turn"');
  });

  it("standalone stream translator emits a well-formed single text block", async () => {
    const internal = sseResponse([
      { choices: [{ delta: { content: "x" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "length" }] },
    ]);
    const out = translateStreamToAnthropic(internal.body!, "m", "msg_1");
    const text = await readAll(out);
    expect(text).toContain("event: message_start");
    expect(text).toContain('"stop_reason":"max_tokens"');
    expect(text.indexOf("event: content_block_start")).toBeLessThan(
      text.indexOf("event: content_block_stop"),
    );
  });
});
