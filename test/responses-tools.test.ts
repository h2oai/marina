// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `/v1/responses` passthru forwards tools both ways (`src/net/responses-tools.ts`):
 * flat Responses `tools`/`tool_choice`/`parallel_tool_calls` become chat-completions
 * fields upstream; `function_call` / `function_call_output` input items become
 * `assistant.tool_calls` / `role:"tool"` messages; upstream `tool_calls` come back
 * as `function_call` output items (non-stream and stream, OpenAI- and
 * Anthropic-shaped upstreams). Hosted tool types are refused with a structured
 * 400 before any upstream call; agents mode keeps refusing `tools` outright.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { handleModelApi } from "../src/net/model-api";
import { setEndpointConfig } from "../src/net/model-endpoint";
import { UnsupportedParameterError } from "../src/net/openai-errors";
import {
  chatToolCallsToResponses,
  ResponsesRequestError,
  responsesInputToMessages,
  restorePriorToolCalls,
  translateResponsesTools,
} from "../src/net/responses-tools";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

// ─── Unit: request translation ──────────────────────────────────────────────

const WEATHER = {
  type: "function",
  name: "get_weather",
  description: "Weather by city",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  strict: true,
};

describe("translateResponsesTools", () => {
  it("maps flat function tools to nested chat tools and keeps strict/description/parameters", () => {
    const out = translateResponsesTools({ tools: [WEATHER], parallel_tool_calls: false });
    expect(out.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Weather by city",
          parameters: WEATHER.parameters,
          strict: true,
        },
      },
    ]);
    expect(out.parallel_tool_calls).toBe(false);
    expect(out).not.toHaveProperty("tool_choice");
  });

  it("maps tool_choice strings verbatim and {type:function,name} to the nested chat form", () => {
    for (const choice of ["auto", "none", "required"]) {
      expect(translateResponsesTools({ tool_choice: choice }).tool_choice).toBe(choice);
    }
    expect(
      translateResponsesTools({ tool_choice: { type: "function", name: "get_weather" } })
        .tool_choice,
    ).toEqual({ type: "function", function: { name: "get_weather" } });
    // A client that already speaks the chat shape is not refused on a technicality.
    expect(
      translateResponsesTools({ tools: [{ type: "function", function: { name: "f" } }] }).tools,
    ).toEqual([{ type: "function", function: { name: "f" } }]);
  });

  it("returns {} when the request carries no tool fields", () => {
    expect(translateResponsesTools({ input: "hi" })).toEqual({});
  });

  it("refuses hosted tool types with unsupported_parameter on tools[i].type — never a silent drop", () => {
    for (const type of ["web_search", "file_search", "computer_use_preview", "code_interpreter"]) {
      let err: unknown;
      try {
        translateResponsesTools({ tools: [WEATHER, { type }] });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(UnsupportedParameterError);
      expect((err as UnsupportedParameterError).param).toBe("tools[1].type");
      expect((err as UnsupportedParameterError).toBody().error).toMatchObject({
        code: "unsupported_parameter",
        param: "tools[1].type",
      });
    }
    expect(() => translateResponsesTools({ tool_choice: { type: "allowed_tools" } })).toThrow(
      UnsupportedParameterError,
    );
  });

  it("refuses malformed values as an invalid request, not as unsupported", () => {
    expect(() => translateResponsesTools({ tools: [{ type: "function" }] })).toThrow(
      ResponsesRequestError,
    );
    expect(() => translateResponsesTools({ tool_choice: 42 })).toThrow(ResponsesRequestError);
  });
});

// ─── Unit: input items ⇄ chat messages ──────────────────────────────────────

describe("responsesInputToMessages", () => {
  it("keeps the text/input_text mapping for strings and message items", () => {
    expect(responsesInputToMessages("hello")).toEqual({
      messages: [{ role: "user", content: "hello" }],
      text: "hello",
    });
    const turn = responsesInputToMessages([
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "input_text", text: "Weather?" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Sure." }] },
    ]);
    expect(turn.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Weather?" },
      { role: "assistant", content: "Sure." },
    ]);
    expect(turn.text).toBe("system: Be brief.\nWeather?\nassistant: Sure.");
  });

  it("turns function_call / function_call_output items into assistant.tool_calls and role:tool", () => {
    const turn = responsesInputToMessages([
      { role: "user", content: "Weather in Oslo and Paris?" },
      {
        type: "function_call",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"Oslo"}',
      },
      {
        type: "function_call",
        call_id: "call_2",
        name: "get_weather",
        arguments: { city: "Paris" },
      },
      { type: "function_call_output", call_id: "call_1", output: "12°C" },
      { type: "function_call_output", call_id: "call_2", output: { temp: 18 } },
    ]);
    expect(turn.messages).toEqual([
      { role: "user", content: "Weather in Oslo and Paris?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "12°C" },
      { role: "tool", tool_call_id: "call_2", content: '{"temp":18}' },
    ]);
    expect(turn.text).toContain("[tool result call_1] 12°C");
  });

  it("refuses items it cannot forward instead of flattening them", () => {
    expect(() => responsesInputToMessages([{ type: "function_call_output", output: "x" }])).toThrow(
      ResponsesRequestError,
    );
    expect(() => responsesInputToMessages([{ type: "computer_call_output" }])).toThrow(
      UnsupportedParameterError,
    );
  });
});

describe("restorePriorToolCalls", () => {
  const prior = [{ callId: "call_1", name: "get_weather", arguments: '{"city":"Oslo"}' }];
  const result = [{ role: "tool", tool_call_id: "call_1", content: "12°C" }];

  it("attaches the stored calls to the trailing assistant history turn", () => {
    const history = [
      { role: "user", content: "Weather?" },
      { role: "assistant", content: "" },
    ];
    expect(restorePriorToolCalls(history, prior, result)).toEqual([
      { role: "user", content: "Weather?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
          },
        ],
      },
    ]);
  });

  it("adds a fresh assistant message when the history ends on the user, and is a no-op otherwise", () => {
    const history = [{ role: "user", content: "Weather?" }];
    expect(restorePriorToolCalls(history, prior, result)).toHaveLength(2);
    expect(restorePriorToolCalls(history, prior, [{ role: "user", content: "hi" }])).toBe(history);
    expect(restorePriorToolCalls(history, undefined, result)).toBe(history);
    // The client restated the call itself → nothing to restore.
    const restated = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: {} }],
      },
      ...result,
    ];
    expect(restorePriorToolCalls(history, prior, restated)).toBe(history);
  });
});

describe("chatToolCallsToResponses", () => {
  it("keeps the upstream id as call_id and stringifies object arguments", () => {
    expect(
      chatToolCallsToResponses([
        { id: "call_up", type: "function", function: { name: "f", arguments: { a: 1 } } },
      ]),
    ).toEqual([{ callId: "call_up", name: "f", arguments: '{"a":1}' }]);
    expect(chatToolCallsToResponses([])).toBeUndefined();
    expect(chatToolCallsToResponses("nope")).toBeUndefined();
  });
});

// ─── Integration: /v1/responses through handleModelApi with a mocked upstream ──

const ENV = [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "LLAMA_API_KEY",
  "LLAMA_BASE_URL",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "MODEL_API_KEYS",
  "MARINA_OPEN_API",
  "MARINA_ANTHROPIC_AUTO_CACHE",
] as const;

let saved: Map<string, string | undefined>;
let originalFetch: typeof fetch;
let dir: string;
let db: MarinaDB;
let engine: Engine;
/** Every upstream request the mock saw. */
let upstream: { url: string; body: Record<string, unknown> }[];
let reply: () => Response;

beforeEach(() => {
  saved = new Map(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.MARINA_OPEN_API = "true";
  process.env.MARINA_ANTHROPIC_AUTO_CACHE = "false";
  originalFetch = globalThis.fetch;
  upstream = [];
  reply = () => Response.json({});
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    upstream.push({ url: req.url, body: (await req.json()) as Record<string, unknown> });
    return reply();
  }) as typeof fetch;
  dir = mkdtempSync(join(tmpdir(), "responses-tools-"));
  db = new MarinaDB(join(dir, "w.db"));
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  engine.shutdown();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(path: string, method: string, body?: unknown) {
  const url = new URL(`http://localhost:3300${path}`);
  const req = new Request(url.toString(), {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const resp = await handleModelApi(url, method, req, engine);
  expect(resp).toBeDefined();
  return resp!;
}

interface Frame {
  event: string;
  data: Record<string, unknown> & { sequence_number: number };
}

async function frames(resp: Response): Promise<Frame[]> {
  expect(resp.headers.get("content-type")).toContain("text/event-stream");
  return (await resp.text())
    .split("\n\n")
    .filter(Boolean)
    .map((f) => {
      const [eventLine, dataLine] = f.split("\n");
      return { event: eventLine!.slice(7), data: JSON.parse(dataLine!.slice(6)) };
    });
}

function openaiCompletion(
  message: Record<string, unknown>,
  finish = "tool_calls",
): Record<string, unknown> {
  return {
    id: "chatcmpl-up",
    object: "chat.completion",
    model: "gpt-4o",
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  };
}

function sseBody(chunks: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const text = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(text));
      controller.close();
    },
  });
}

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id: "chatcmpl-up",
    object: "chat.completion.chunk",
    model: "gpt-4o",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

const UPSTREAM_CALL = {
  id: "call_abc",
  type: "function",
  function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
};

describe("/v1/responses passthru — OpenAI-shaped upstream", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-openai";
    setEndpointConfig(db, { mode: "passthru", passthruModel: "openai/gpt-4o" });
  });

  it("forwards tools/tool_choice/parallel_tool_calls as chat fields and renders tool_calls as function_call items (non-stream)", async () => {
    reply = () => Response.json(openaiCompletion({ content: null, tool_calls: [UPSTREAM_CALL] }));
    const resp = await call("/v1/responses", "POST", {
      model: "marina",
      input: "Weather in Oslo?",
      tools: [WEATHER],
      tool_choice: { type: "function", name: "get_weather" },
      parallel_tool_calls: false,
    });
    expect(resp.status).toBe(200);
    expect(upstream).toHaveLength(1);
    const sent = upstream[0]!.body;
    expect(sent.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Weather by city",
          parameters: WEATHER.parameters,
          strict: true,
        },
      },
    ]);
    expect(sent.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
    expect(sent.parallel_tool_calls).toBe(false);
    expect(sent.messages).toEqual([{ role: "user", content: "Weather in Oslo?" }]);

    const body = (await resp.json()) as {
      id: string;
      output: Record<string, unknown>[];
      output_text: string;
    };
    expect(body.output_text).toBe("");
    expect(body.output).toEqual([
      {
        type: "function_call",
        id: `fc_${body.id.slice(5)}_0`,
        call_id: "call_abc",
        name: "get_weather",
        arguments: '{"city":"Oslo"}',
        status: "completed",
      },
    ]);
    // Stored body is the same object.
    const stored = await call(`/v1/responses/${body.id}`, "GET");
    expect(await stored.json()).toEqual(body);
  });

  it("streams forwarded tool calls as function_call items with argument deltas", async () => {
    reply = () =>
      new Response(
        sseBody([
          chunk({ role: "assistant", content: "" }),
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call_s",
                type: "function",
                function: { name: "get_weather", arguments: "" },
              },
            ],
          }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] }),
          chunk({}, "tool_calls"),
        ]),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    const resp = await call("/v1/responses", "POST", {
      model: "marina",
      input: "Weather in Oslo?",
      stream: true,
      tools: [WEATHER],
      tool_choice: "required",
    });
    expect(resp.status).toBe(200);
    const sent = upstream[0]!.body;
    expect(sent.stream).toBe(true);
    expect(sent.tool_choice).toBe("required");
    expect((sent.tools as unknown[]).length).toBe(1);

    const got = await frames(resp);
    const events = got.map((f) => f.event);
    expect(events).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(got.map((f) => f.data.sequence_number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(got[2]!.data.item).toMatchObject({
      type: "function_call",
      call_id: "call_s",
      name: "get_weather",
      status: "in_progress",
    });
    expect(got[5]!.data.arguments).toBe('{"city":"Oslo"}');
    const completed = got.at(-1)!.data.response as { output: Record<string, unknown>[] };
    expect(completed.output).toEqual([
      expect.objectContaining({
        type: "function_call",
        call_id: "call_s",
        name: "get_weather",
        arguments: '{"city":"Oslo"}',
        status: "completed",
      }),
    ]);
  });

  it("continues a tool loop from explicit function_call + function_call_output items", async () => {
    reply = () => Response.json(openaiCompletion({ content: "It is 12°C in Oslo." }, "stop"));
    const resp = await call("/v1/responses", "POST", {
      model: "marina",
      input: [
        { role: "user", content: [{ type: "input_text", text: "Weather in Oslo?" }] },
        {
          type: "function_call",
          call_id: "call_abc",
          name: "get_weather",
          arguments: '{"city":"Oslo"}',
        },
        { type: "function_call_output", call_id: "call_abc", output: "12°C" },
      ],
      tools: [WEATHER],
    });
    expect(resp.status).toBe(200);
    expect(upstream[0]!.body.messages).toEqual([
      { role: "user", content: "Weather in Oslo?" },
      { role: "assistant", content: "", tool_calls: [UPSTREAM_CALL] },
      { role: "tool", tool_call_id: "call_abc", content: "12°C" },
    ]);
    const body = (await resp.json()) as { output: Record<string, unknown>[]; output_text: string };
    expect(body.output_text).toBe("It is 12°C in Oslo.");
    expect(body.output.map((o) => o.type)).toEqual(["message"]);
  });

  it("continues a tool loop over previous_response_id: the stored calls are restored before the role:tool result", async () => {
    reply = () => Response.json(openaiCompletion({ content: null, tool_calls: [UPSTREAM_CALL] }));
    const first = await call("/v1/responses", "POST", {
      model: "marina",
      input: "Weather in Oslo?",
      tools: [WEATHER],
    });
    const { id } = (await first.json()) as { id: string };

    reply = () => Response.json(openaiCompletion({ content: "12°C in Oslo." }, "stop"));
    const second = await call("/v1/responses", "POST", {
      model: "marina",
      previous_response_id: id,
      input: [{ type: "function_call_output", call_id: "call_abc", output: "12°C" }],
      tools: [WEATHER],
    });
    expect(second.status).toBe(200);
    expect(upstream).toHaveLength(2);
    expect(upstream[1]!.body.messages).toEqual([
      { role: "user", content: "Weather in Oslo?" },
      { role: "assistant", content: "", tool_calls: [UPSTREAM_CALL] },
      { role: "tool", tool_call_id: "call_abc", content: "12°C" },
    ]);
    const body = (await second.json()) as { output_text: string; previous_response_id: string };
    expect(body.output_text).toBe("12°C in Oslo.");
    expect(body.previous_response_id).toBe(id);
  });

  it("refuses hosted tool types with 400 unsupported_parameter on tools[i].type before any upstream call", async () => {
    const resp = await call("/v1/responses", "POST", {
      model: "marina",
      input: "Search the web",
      tools: [WEATHER, { type: "web_search" }],
    });
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toMatchObject({
      code: "unsupported_parameter",
      param: "tools[1].type",
    });
    expect(upstream).toHaveLength(0);
  });

  it("refuses a function tool without a name as an invalid request (param tools[0].name)", async () => {
    const resp = await call("/v1/responses", "POST", {
      model: "marina",
      input: "hi",
      tools: [{ type: "function", parameters: {} }],
    });
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toMatchObject({ param: "tools[0].name" });
    expect(upstream).toHaveLength(0);
  });
});

describe("/v1/responses passthru — Anthropic-shaped upstream", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    setEndpointConfig(db, { mode: "passthru", passthruModel: "anthropic/claude-sonnet-5" });
  });

  it("Responses tools reach Anthropic as tools/input_schema and tool_use comes back as a function_call item", async () => {
    reply = () =>
      Response.json({
        id: "msg_up",
        type: "message",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "…" },
          { type: "text", text: "Checking the weather." },
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 6 },
      });
    const resp = await call("/v1/responses", "POST", {
      model: "marina",
      instructions: "Be brief.",
      input: "Weather in Paris?",
      tools: [WEATHER],
      tool_choice: "auto",
      parallel_tool_calls: false,
    });
    expect(resp.status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(upstream[0]!.body).toMatchObject({
      model: "claude-sonnet-5",
      system: [{ type: "text", text: expect.stringContaining("Be brief.") }],
      tools: [
        { name: "get_weather", description: "Weather by city", input_schema: WEATHER.parameters },
      ],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: "Weather in Paris?" }],
    });

    const body = (await resp.json()) as {
      output: Record<string, unknown>[];
      output_text: string;
      usage: Record<string, unknown>;
    };
    expect(body.output_text).toBe("Checking the weather.");
    expect(body.output.map((o) => o.type)).toEqual(["message", "function_call"]);
    expect(body.output[1]).toMatchObject({
      type: "function_call",
      call_id: "toolu_1",
      name: "get_weather",
      arguments: '{"city":"Paris"}',
      status: "completed",
    });
    expect(body.usage).toMatchObject({ input_tokens: 10, output_tokens: 6 });
  });

  it("streams Anthropic tool_use as function_call events and pairs a tool result back as tool_result", async () => {
    const events = [
      { type: "message_start", message: { id: "msg_s", usage: { input_tokens: 5 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking" } },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_s", name: "get_weather", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' },
      },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    reply = () =>
      new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      });
    const resp = await call("/v1/responses", "POST", {
      model: "marina",
      input: "Weather in Paris?",
      stream: true,
      tools: [WEATHER],
    });
    expect(resp.status).toBe(200);
    expect(upstream[0]!.body.stream).toBe(true);
    expect(upstream[0]!.body.tools).toHaveLength(1);
    const got = await frames(resp);
    const added = got
      .filter((f) => f.event === "response.output_item.added")
      .map((f) => (f.data.item as { type: string }).type);
    expect(added).toEqual(["message", "function_call"]);
    const args = got.find((f) => f.event === "response.function_call_arguments.done")!;
    expect(args.data.arguments).toBe('{"city":"Paris"}');
    const completed = got.at(-1)!.data.response as {
      output: Record<string, unknown>[];
      output_text: string;
    };
    expect(completed.output_text).toBe("Checking");
    expect(completed.output[1]).toMatchObject({ type: "function_call", call_id: "toolu_s" });

    // Tool-loop continuation: the result travels as an Anthropic tool_result block.
    reply = () =>
      Response.json({
        id: "msg_2",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "18°C in Paris." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 4 },
      });
    const follow = await call("/v1/responses", "POST", {
      model: "marina",
      input: [
        { role: "user", content: "Weather in Paris?" },
        {
          type: "function_call",
          call_id: "toolu_s",
          name: "get_weather",
          arguments: '{"city":"Paris"}',
        },
        { type: "function_call_output", call_id: "toolu_s", output: "18°C" },
      ],
      tools: [WEATHER],
    });
    expect(follow.status).toBe(200);
    expect(upstream[1]!.body.messages).toEqual([
      { role: "user", content: "Weather in Paris?" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_s", name: "get_weather", input: { city: "Paris" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_s", content: "18°C" }] },
    ]);
    expect(((await follow.json()) as { output_text: string }).output_text).toBe("18°C in Paris.");
  });
});

describe("/v1/responses agents mode", () => {
  it("keeps refusing tools with unsupported_parameter on `tools`", async () => {
    setEndpointConfig(db, { mode: "agents" });
    const conn = new MockConnection("c1");
    engine.addConnection(conn);
    engine.spawnEntity("c1", "Agent1");
    const resp = await call("/v1/responses", "POST", {
      model: "marina",
      input: "hello",
      tools: [WEATHER],
    });
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toMatchObject({
      code: "unsupported_parameter",
      param: "tools",
    });
    expect(upstream).toHaveLength(0);
  });
});
