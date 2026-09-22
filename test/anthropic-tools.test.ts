// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAI ⇄ Anthropic translation, both directions, in isolation — the unit
 * under `proxyToAnthropic`. Before this module the proxy dropped tools,
 * tool_choice, functions, stop and response_format on the floor.
 */

import { describe, expect, test } from "bun:test";
import {
  AnthropicSseTranslator,
  anthropicFinishReason,
  anthropicMessageToOpenai,
  anthropicUsageToOpenai,
  applyAutoCache,
  buildAnthropicRequest,
  openaiMessagesToAnthropic,
  openaiToolChoiceToAnthropic,
  openaiToolsToAnthropic,
} from "../src/net/anthropic-tools";
import { UnsupportedParameterError } from "../src/net/openai-errors";

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Weather by city",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};

describe("openaiToolsToAnthropic", () => {
  test("maps function tools to name/description/input_schema and keeps cache_control", () => {
    const tools = openaiToolsToAnthropic([
      WEATHER_TOOL,
      {
        ...WEATHER_TOOL,
        function: { ...WEATHER_TOOL.function, name: "get_time" },
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(tools).toEqual([
      {
        name: "get_weather",
        description: "Weather by city",
        input_schema: WEATHER_TOOL.function.parameters,
      },
      {
        name: "get_time",
        description: "Weather by city",
        input_schema: WEATHER_TOOL.function.parameters,
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  test("accepts legacy `functions`, dedups by name, and defaults a missing schema", () => {
    const tools = openaiToolsToAnthropic(undefined, [
      { name: "a", description: "A" },
      { name: "a", description: "dup" },
    ]);
    expect(tools).toEqual([
      { name: "a", description: "A", input_schema: { type: "object", properties: {} } },
    ]);
  });

  test("refuses non-function tool types instead of dropping them", () => {
    expect(() => openaiToolsToAnthropic([{ type: "file_search" }])).toThrow(
      UnsupportedParameterError,
    );
  });
});

describe("openaiToolChoiceToAnthropic", () => {
  test("maps auto / none / required / named function", () => {
    expect(openaiToolChoiceToAnthropic("auto")).toEqual({ type: "auto" });
    expect(openaiToolChoiceToAnthropic("none")).toEqual({ type: "none" });
    expect(openaiToolChoiceToAnthropic("required")).toEqual({ type: "any" });
    expect(
      openaiToolChoiceToAnthropic({ type: "function", function: { name: "get_weather" } }),
    ).toEqual({ type: "tool", name: "get_weather" });
    // legacy function_call {name}
    expect(openaiToolChoiceToAnthropic({ name: "x" })).toEqual({ type: "tool", name: "x" });
    expect(openaiToolChoiceToAnthropic(undefined)).toBeUndefined();
  });

  test("parallel_tool_calls:false becomes disable_parallel_tool_use", () => {
    expect(openaiToolChoiceToAnthropic("auto", false)).toEqual({
      type: "auto",
      disable_parallel_tool_use: true,
    });
    expect(openaiToolChoiceToAnthropic(undefined, false)).toEqual({
      type: "auto",
      disable_parallel_tool_use: true,
    });
    expect(openaiToolChoiceToAnthropic("none", false)).toEqual({ type: "none" });
  });
});

describe("openaiMessagesToAnthropic", () => {
  test("system messages become system blocks; assistant tool_calls become tool_use; consecutive tool results collapse into ONE user message", () => {
    const { system, messages } = openaiMessagesToAnthropic([
      { role: "system", content: "Be brief." },
      {
        role: "system",
        content: [{ type: "text", text: "[memory]", cache_control: { type: "ephemeral" } }],
      },
      { role: "user", content: "Weather in Paris and Rome?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Rome"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "18C" },
      { role: "tool", tool_call_id: "call_2", content: [{ type: "text", text: "22C" }] },
      { role: "user", content: "Thanks" },
    ]);
    expect(system).toEqual([
      { type: "text", text: "Be brief." },
      { type: "text", text: "[memory]", cache_control: { type: "ephemeral" } },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "Weather in Paris and Rome?" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
          { type: "tool_use", id: "call_2", name: "get_weather", input: { city: "Rome" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "18C" },
          { type: "tool_result", tool_use_id: "call_2", content: [{ type: "text", text: "22C" }] },
        ],
      },
      { role: "user", content: "Thanks" },
    ]);
  });

  test("assistant text + tool_calls keep both blocks; unparsable arguments become {}", () => {
    const { messages } = openaiMessagesToAnthropic([
      {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "not json" } }],
      },
    ]);
    expect(messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "c", name: "f", input: {} },
        ],
      },
    ]);
  });

  test("user image_url parts become image blocks (data URL → base64, http → url) and cache markers survive", () => {
    const { messages } = openaiMessagesToAnthropic([
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?", cache_control: { type: "ephemeral" } },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          { type: "image_url", image_url: { url: "https://example.com/a.png" } },
        ],
      },
    ]);
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?", cache_control: { type: "ephemeral" } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
        ],
      },
    ]);
  });

  test("drops empty messages (Anthropic rejects empty text blocks) and treats developer as system", () => {
    const { system, messages } = openaiMessagesToAnthropic([
      { role: "developer", content: "dev rules" },
      { role: "assistant", content: "" },
      { role: "user", content: "hi" },
    ]);
    expect(system).toEqual([{ type: "text", text: "dev rules" }]);
    expect(messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("audio parts are refused, not dropped", () => {
    expect(() =>
      openaiMessagesToAnthropic([
        { role: "user", content: [{ type: "input_audio", input_audio: { data: "x" } }] },
      ]),
    ).toThrow(UnsupportedParameterError);
  });
});

describe("buildAnthropicRequest", () => {
  const base = {
    model: "marina",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
  };

  test("carries tools, tool_choice, stop → stop_sequences, max_completion_tokens, user → metadata", () => {
    const req = buildAnthropicRequest(
      {
        ...base,
        tools: [WEATHER_TOOL],
        tool_choice: "required",
        stop: ["END"],
        max_completion_tokens: 77,
        user: "u-1",
        temperature: 0.2,
        top_p: 0.9,
      },
      "claude-sonnet-5",
      false,
    );
    expect(req).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: 77,
      stream: false,
      temperature: 0.2,
      top_p: 0.9,
      stop_sequences: ["END"],
      metadata: { user_id: "u-1" },
      system: [{ type: "text", text: "sys" }],
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "get_weather" }],
      tool_choice: { type: "any" },
    });
    expect(req).not.toHaveProperty("stop");
    expect(req).not.toHaveProperty("response_format");
  });

  test("string stop and default max_tokens", () => {
    const req = buildAnthropicRequest({ ...base, stop: "X" }, "m", true);
    expect(req.stop_sequences).toEqual(["X"]);
    expect(req.max_tokens).toBe(4096);
    expect(req.stream).toBe(true);
  });

  test("tool_choice without tools is dropped (Anthropic rejects it)", () => {
    const req = buildAnthropicRequest({ ...base, tool_choice: "auto" }, "m", false);
    expect(req).not.toHaveProperty("tool_choice");
  });

  test("response_format json_schema → output_config; json_object → unsupported_parameter", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    const req = buildAnthropicRequest(
      { ...base, response_format: { type: "json_schema", json_schema: { name: "x", schema } } },
      "m",
      false,
    );
    expect(req.output_config).toEqual({ format: { type: "json_schema", schema } });
    let err: unknown;
    try {
      buildAnthropicRequest({ ...base, response_format: { type: "json_object" } }, "m", false);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnsupportedParameterError);
    expect((err as UnsupportedParameterError).toBody().error).toMatchObject({
      code: "unsupported_parameter",
      param: "response_format",
      type: "invalid_request_error",
    });
    // response_format text is a no-op
    expect(
      buildAnthropicRequest({ ...base, response_format: { type: "text" } }, "m", false),
    ).not.toHaveProperty("output_config");
  });

  test("n > 1 is refused", () => {
    expect(() => buildAnthropicRequest({ ...base, n: 2 }, "m", false)).toThrow(
      UnsupportedParameterError,
    );
    expect(() => buildAnthropicRequest({ ...base, n: 1 }, "m", false)).not.toThrow();
  });

  test("autoCache marks the LAST system block only when no marker exists", () => {
    const req = buildAnthropicRequest(
      {
        model: "marina",
        messages: [
          { role: "system", content: "a" },
          { role: "system", content: "b" },
          { role: "user", content: "hi" },
        ],
      },
      "m",
      false,
      { autoCache: true },
    );
    expect(req.system).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b", cache_control: { type: "ephemeral" } },
    ]);
    // A client marker wins: nothing is added.
    const explicit = [
      { type: "text", text: "a", cache_control: { type: "ephemeral" } },
      { type: "text", text: "b" },
    ];
    expect(applyAutoCache(explicit)).toEqual(explicit);
    expect(applyAutoCache([])).toEqual([]);
  });

  test("native Anthropic body is forwarded verbatim (cache_control, thinking, tools) with model/stream overridden", () => {
    const native = {
      model: "claude-x",
      stream: true,
      max_tokens: 10,
      system: [{ type: "text", text: "S", cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
        },
      ],
      tools: [
        { name: "t", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
      ],
      tool_choice: { type: "auto" },
      thinking: { type: "adaptive" },
      metadata: { user_id: "u" },
    };
    const req = buildAnthropicRequest({ model: "marina" }, "claude-sonnet-5", false, {
      native,
      autoCache: true,
    });
    expect(req).toEqual({ ...native, model: "claude-sonnet-5", stream: false });
    // Native string system → one block; autoCache applies when the client set none.
    const req2 = buildAnthropicRequest({ model: "marina" }, "m", false, {
      native: { system: "plain", messages: [] },
      autoCache: true,
    });
    expect(req2.system).toEqual([
      { type: "text", text: "plain", cache_control: { type: "ephemeral" } },
    ]);
    expect(req2.max_tokens).toBe(4096);
  });
});

describe("anthropicMessageToOpenai", () => {
  test("tool_use blocks → tool_calls with finish_reason tool_calls; text joined across blocks", () => {
    const out = anthropicMessageToOpenai(
      {
        id: "msg_1",
        content: [
          { type: "thinking", text: "" },
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      "claude-sonnet-5",
    ) as { choices: { message: Record<string, unknown>; finish_reason: string }[]; usage: unknown };
    expect(out.choices[0]!.finish_reason).toBe("tool_calls");
    expect(out.choices[0]!.message).toEqual({
      role: "assistant",
      content: "Checking.",
      tool_calls: [
        {
          id: "toolu_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Paris"}' },
        },
      ],
    });
  });

  test("content is null when only tool calls came back; stop reasons map", () => {
    const out = anthropicMessageToOpenai(
      { content: [{ type: "tool_use", id: "t", name: "f", input: {} }], stop_reason: "tool_use" },
      "m",
    ) as { choices: { message: { content: unknown } }[] };
    expect(out.choices[0]!.message.content).toBeNull();
    expect(anthropicFinishReason("end_turn", false)).toBe("stop");
    expect(anthropicFinishReason("stop_sequence", false)).toBe("stop");
    expect(anthropicFinishReason("max_tokens", false)).toBe("length");
    expect(anthropicFinishReason("refusal", false)).toBe("content_filter");
    expect(anthropicFinishReason("end_turn", true)).toBe("tool_calls");
  });

  test("usage: cache counters roll into prompt_tokens and prompt_tokens_details.cached_tokens", () => {
    expect(
      anthropicUsageToOpenai({
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 50,
      }),
    ).toEqual({
      prompt_tokens: 960,
      completion_tokens: 4,
      total_tokens: 964,
      prompt_tokens_details: { cached_tokens: 900 },
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 50,
    });
    expect(anthropicUsageToOpenai({ input_tokens: 3, output_tokens: 1 })).toEqual({
      prompt_tokens: 3,
      completion_tokens: 1,
      total_tokens: 4,
      prompt_tokens_details: { cached_tokens: 0 },
    });
  });
});

describe("AnthropicSseTranslator", () => {
  const sse = (events: unknown[]) =>
    events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const parse = (frames: string[]) =>
    frames
      .filter((f) => f !== "data: [DONE]\n\n")
      .map((f) => JSON.parse(f.slice("data: ".length)) as Record<string, unknown>);

  test("streams text and tool_use blocks as OpenAI chunks and finishes with tool_calls", () => {
    const t = new AnthropicSseTranslator("claude-sonnet-5", true);
    const frames = t.push(
      sse([
        {
          type: "message_start",
          message: { id: "msg_9", usage: { input_tokens: 7, cache_read_input_tokens: 100 } },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"city":' },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '"Paris"}' },
        },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
        { type: "message_stop" },
      ]),
    );
    expect(frames[frames.length - 1]).toBe("data: [DONE]\n\n");
    const chunks = parse(frames);
    const deltas = chunks.map((c) => (c.choices as { delta: unknown }[])[0]!.delta);
    expect(deltas).toEqual([
      { role: "assistant" },
      { content: "Hel" },
      { content: "lo" },
      {
        tool_calls: [
          {
            index: 0,
            id: "toolu_1",
            type: "function",
            function: { name: "get_weather", arguments: "" },
          },
        ],
      },
      { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] },
      {},
    ]);
    const last = chunks[chunks.length - 1]!;
    expect((last.choices as { finish_reason: string }[])[0]!.finish_reason).toBe("tool_calls");
    expect(last.id).toBe("msg_9");
    expect(last.usage).toEqual({
      prompt_tokens: 107,
      completion_tokens: 12,
      total_tokens: 119,
      prompt_tokens_details: { cached_tokens: 100 },
      cache_read_input_tokens: 100,
    });
    expect(t.done).toBe(true);
    // Nothing after the finish is emitted.
    expect(
      t.push(
        sse([{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }]),
      ),
    ).toEqual([]);
  });

  test("handles a split frame across pushes and finishes on flush without message_stop", () => {
    const t = new AnthropicSseTranslator("m");
    const whole = sse([
      { type: "message_start", message: { id: "msg_2", usage: { input_tokens: 1 } } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 1 } },
    ]);
    const cut = Math.floor(whole.length / 2);
    const frames = [...t.push(whole.slice(0, cut)), ...t.push(whole.slice(cut)), ...t.flush()];
    const chunks = parse(frames);
    expect(chunks.map((c) => (c.choices as { delta: unknown }[])[0]!.delta)).toEqual([
      { role: "assistant" },
      { content: "ok" },
      {},
    ]);
    expect((chunks[2]!.choices as { finish_reason: string }[])[0]!.finish_reason).toBe("length");
    // include_usage was not requested: no usage on the finish chunk.
    expect(chunks[2]).not.toHaveProperty("usage");
    expect(frames[frames.length - 1]).toBe("data: [DONE]\n\n");
  });

  test("an upstream error event is surfaced as an OpenAI error frame before DONE", () => {
    const t = new AnthropicSseTranslator("m");
    const frames = t.push(
      sse([
        { type: "message_start", message: { id: "msg_3" } },
        { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      ]),
    );
    const errFrame = frames.find((f) => f.includes('"error"'));
    expect(errFrame).toBeDefined();
    expect(JSON.parse(errFrame!.slice(6)).error).toMatchObject({
      message: "Overloaded",
      code: "upstream_error",
    });
    expect(frames[frames.length - 1]).toBe("data: [DONE]\n\n");
  });
});
