// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Anthropic-backed passthru, end to end through `handleModelApi` with a
 * mocked `fetch`: tool schemas and tool results reach Anthropic, `tool_use`
 * comes back as `tool_calls`, cache_control markers are forwarded (and added
 * under auto-cache), cache counters surface in usage and on the lifecycle
 * event, unsupported parameters are refused with a structured 400, and a
 * `/v1/messages` client's native body is forwarded verbatim.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { resetTrustProfileForTests, setTrustProfile } from "../src/engine/trust-profile";
import { anthropicAutoCacheEnabled, handleModelApi } from "../src/net/model-api";
import { setEndpointConfig } from "../src/net/model-endpoint";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { makeTestRoom } from "./helpers";

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
  "MARINA_PROFILE",
] as const;

let saved: Map<string, string | undefined>;
let originalFetch: typeof fetch;
let dir: string;
let db: MarinaDB;
let engine: Engine;
/** Every upstream request the mock saw: URL, headers, parsed body. */
let upstream: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[];
let reply: () => Response;

const ANTHROPIC_MESSAGE = (overrides: Record<string, unknown> = {}) =>
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
    usage: {
      input_tokens: 10,
      output_tokens: 6,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 40,
    },
    ...overrides,
  });

beforeEach(() => {
  saved = new Map(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.MARINA_OPEN_API = "true";
  process.env.MARINA_ANTHROPIC_AUTO_CACHE = "false";
  resetTrustProfileForTests();
  originalFetch = globalThis.fetch;
  upstream = [];
  reply = () => ANTHROPIC_MESSAGE();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    upstream.push({ url: req.url, headers, body: (await req.json()) as Record<string, unknown> });
    return reply();
  }) as typeof fetch;
  dir = mkdtempSync(join(tmpdir(), "anthropic-passthru-"));
  db = new MarinaDB(join(dir, "w.db"));
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  setEndpointConfig(db, { mode: "passthru", passthruModel: "anthropic/claude-sonnet-5" });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetTrustProfileForTests();
  engine.shutdown();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const url = new URL(`http://localhost:3300${path}`);
  const req = new Request(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const resp = await handleModelApi(url, "POST", req, engine);
  expect(resp).toBeDefined();
  return resp!;
}

async function readSse(resp: Response): Promise<Record<string, unknown>[]> {
  const text = await resp.text();
  return text
    .split("\n\n")
    .filter((f) => f.startsWith("data: ") && f !== "data: [DONE]")
    .map((f) => JSON.parse(f.slice(6)) as Record<string, unknown>);
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Weather by city",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  },
];

describe("Anthropic passthru: tool calling", () => {
  it("forwards tools/tool_choice/stop and returns tool_use as tool_calls with finish_reason tool_calls", async () => {
    const resp = await post("/v1/chat/completions", {
      model: "marina",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Weather in Paris?" },
      ],
      tools: TOOLS,
      tool_choice: "auto",
      stop: ["END"],
      max_tokens: 200,
    });
    expect(resp.status).toBe(200);
    expect(upstream).toHaveLength(1);
    const sent = upstream[0]!;
    expect(sent.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent.headers["x-api-key"]).toBe("sk-ant-test");
    expect(sent.body).toMatchObject({
      model: "claude-sonnet-5",
      max_tokens: 200,
      stop_sequences: ["END"],
      system: [{ type: "text", text: "Be brief." }],
      tools: [{ name: "get_weather", description: "Weather by city" }],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: "Weather in Paris?" }],
    });
    expect((sent.body.tools as { input_schema: unknown }[])[0]!.input_schema).toEqual(
      TOOLS[0]!.function.parameters,
    );
    expect(sent.body).not.toHaveProperty("stop");

    const data = (await resp.json()) as {
      choices: { message: Record<string, unknown>; finish_reason: string }[];
      usage: Record<string, unknown>;
    };
    expect(data.choices[0]!.finish_reason).toBe("tool_calls");
    expect(data.choices[0]!.message).toEqual({
      role: "assistant",
      content: "Checking the weather.",
      tool_calls: [
        {
          id: "toolu_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Paris"}' },
        },
      ],
    });
  });

  it("translates a tool round-trip (assistant tool_calls + role:tool results) into tool_use / grouped tool_result blocks", async () => {
    reply = () =>
      ANTHROPIC_MESSAGE({
        content: [{ type: "text", text: "18C in Paris, 22C in Rome." }],
        stop_reason: "end_turn",
      });
    const resp = await post("/v1/chat/completions", {
      model: "marina",
      messages: [
        { role: "user", content: "Weather in Paris and Rome?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
            {
              id: "c2",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Rome"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "18C" },
        { role: "tool", tool_call_id: "c2", content: "22C" },
      ],
      tools: TOOLS,
    });
    expect(resp.status).toBe(200);
    expect(upstream[0]!.body.messages).toEqual([
      { role: "user", content: "Weather in Paris and Rome?" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "c1", name: "get_weather", input: { city: "Paris" } },
          { type: "tool_use", id: "c2", name: "get_weather", input: { city: "Rome" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: "18C" },
          { type: "tool_result", tool_use_id: "c2", content: "22C" },
        ],
      },
    ]);
    const data = (await resp.json()) as {
      choices: { message: { content: string }; finish_reason: string }[];
    };
    expect(data.choices[0]!.message.content).toBe("18C in Paris, 22C in Rome.");
    expect(data.choices[0]!.finish_reason).toBe("stop");
  });

  it("streams tool_use as delta.tool_calls chunks and finishes with tool_calls", async () => {
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
    const resp = await post("/v1/chat/completions", {
      model: "marina",
      stream: true,
      messages: [{ role: "user", content: "Weather in Paris?" }],
      tools: TOOLS,
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");
    expect(upstream[0]!.body.stream).toBe(true);
    expect(upstream[0]!.body.tools).toHaveLength(1);
    const chunks = await readSse(resp);
    const deltas = chunks.map((c) => (c.choices as { delta: unknown }[])[0]!.delta);
    expect(deltas).toEqual([
      { role: "assistant" },
      { content: "Checking" },
      {
        tool_calls: [
          {
            index: 0,
            id: "toolu_s",
            type: "function",
            function: { name: "get_weather", arguments: "" },
          },
        ],
      },
      { tool_calls: [{ index: 0, function: { arguments: '{"city":"Paris"}' } }] },
      {},
    ]);
    expect(
      (chunks[chunks.length - 1]!.choices as { finish_reason: string }[])[0]!.finish_reason,
    ).toBe("tool_calls");
  });

  it("refuses response_format json_object and n>1 with a structured unsupported_parameter 400 (no upstream call)", async () => {
    const rf = await post("/v1/chat/completions", {
      model: "marina",
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_object" },
    });
    expect(rf.status).toBe(400);
    expect((await rf.json()).error).toMatchObject({
      type: "invalid_request_error",
      code: "unsupported_parameter",
      param: "response_format",
    });
    const n = await post("/v1/chat/completions", {
      model: "marina",
      messages: [{ role: "user", content: "hi" }],
      n: 3,
    });
    expect(n.status).toBe(400);
    expect((await n.json()).error).toMatchObject({ code: "unsupported_parameter", param: "n" });
    expect(upstream).toHaveLength(0);
  });

  it("translates response_format json_schema into output_config", async () => {
    const schema = { type: "object", properties: { answer: { type: "string" } } };
    reply = () =>
      ANTHROPIC_MESSAGE({
        content: [{ type: "text", text: '{"answer":"x"}' }],
        stop_reason: "end_turn",
      });
    const resp = await post("/v1/chat/completions", {
      model: "marina",
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_schema", json_schema: { name: "a", schema } },
    });
    expect(resp.status).toBe(200);
    expect(upstream[0]!.body.output_config).toEqual({ format: { type: "json_schema", schema } });
  });
});

describe("Anthropic passthru: prompt caching", () => {
  it("forwards pi-ai style cache_control on system parts and the last tool; surfaces cache counters in usage and on the trace", async () => {
    const resp = await post("/v1/chat/completions", {
      model: "marina",
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "Long stable prompt", cache_control: { type: "ephemeral" } },
          ],
        },
        { role: "user", content: "Weather in Paris?" },
      ],
      tools: [{ ...TOOLS[0], cache_control: { type: "ephemeral" } }],
    });
    expect(resp.status).toBe(200);
    const sent = upstream[0]!.body;
    expect(sent.system).toEqual([
      { type: "text", text: "Long stable prompt", cache_control: { type: "ephemeral" } },
    ]);
    expect((sent.tools as { cache_control?: unknown }[])[0]!.cache_control).toEqual({
      type: "ephemeral",
    });

    const data = (await resp.json()) as { usage: Record<string, unknown> };
    expect(data.usage).toEqual({
      prompt_tokens: 850,
      completion_tokens: 6,
      total_tokens: 856,
      // Cache WRITES ride along under Marina's extension name and the name
      // pi-ai's openai-completions client reads, so agent-side cacheWriteTokens
      // is no longer always 0.
      prompt_tokens_details: {
        cached_tokens: 800,
        cache_creation_tokens: 40,
        cache_write_tokens: 40,
      },
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 40,
    });
    // claude-sonnet-5 list price: 10 uncached input × $2/M + 6 output × $10/M
    // + 800 cache-read × $0.2/M + 40 cache-write × $2.5/M = $0.00034.
    expect(resp.headers.get("x-marina-upstream-model")).toBe("anthropic/claude-sonnet-5");
    expect(resp.headers.get("x-marina-cache-read-tokens")).toBe("800");
    expect(resp.headers.get("x-marina-cache-write-tokens")).toBe("40");
    expect(Number(resp.headers.get("x-marina-cost-usd"))).toBeCloseTo(0.00034, 8);
    const completed = engine
      .getEventLog()
      .find((e) => e.type === "model_request_lifecycle" && e.phase === "completed");
    expect(completed).toMatchObject({
      routeKind: "passthru",
      target: "anthropic/claude-sonnet-5",
      cacheReadTokens: 800,
      cacheWriteTokens: 40,
      inputTokens: 850,
      outputTokens: 6,
    });
    expect((completed as { costUsd?: number }).costUsd).toBeCloseTo(0.00034, 8);
  });

  it("MARINA_ANTHROPIC_AUTO_CACHE=true marks the last system block; with client markers only the last stable block is added when absent", async () => {
    process.env.MARINA_ANTHROPIC_AUTO_CACHE = "true";
    await post("/v1/chat/completions", {
      model: "marina",
      messages: [
        { role: "system", content: "A" },
        { role: "system", content: "B" },
        { role: "user", content: "hi" },
      ],
    });
    expect(upstream[0]!.body.system).toEqual([
      { type: "text", text: "A" },
      { type: "text", text: "B", cache_control: { type: "ephemeral" } },
    ]);
    // Client markers are preserved; the proxy adds ONLY the last-stable-block
    // breakpoint (B — no injection, so the last block IS the stable one).
    await post("/v1/chat/completions", {
      model: "marina",
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "A", cache_control: { type: "ephemeral" } }],
        },
        { role: "system", content: "B" },
        { role: "user", content: "hi" },
      ],
    });
    expect(upstream[1]!.body.system).toEqual([
      { type: "text", text: "A", cache_control: { type: "ephemeral" } },
      { type: "text", text: "B", cache_control: { type: "ephemeral" } },
    ]);
    // A client marker already on the last stable block → nothing added at all.
    await post("/v1/chat/completions", {
      model: "marina",
      messages: [
        { role: "system", content: "A" },
        {
          role: "system",
          content: [{ type: "text", text: "B", cache_control: { type: "ephemeral", ttl: "1h" } }],
        },
        { role: "user", content: "hi" },
      ],
      tools: TOOLS,
    });
    expect(upstream[2]!.body.system).toEqual([
      { type: "text", text: "A" },
      { type: "text", text: "B", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
    expect((upstream[2]!.body.tools as Record<string, unknown>[])[0]).not.toHaveProperty(
      "cache_control",
    );
  });

  it("auto-cache defaults on under the local trust profile and off otherwise", () => {
    expect(anthropicAutoCacheEnabled({ MARINA_PROFILE: "shared" })).toBe(false);
    expect(anthropicAutoCacheEnabled({ MARINA_PROFILE: "public" })).toBe(false);
    setTrustProfile("local");
    expect(anthropicAutoCacheEnabled({})).toBe(true);
    expect(anthropicAutoCacheEnabled({ MARINA_ANTHROPIC_AUTO_CACHE: "false" })).toBe(false);
    resetTrustProfileForTests();
    expect(
      anthropicAutoCacheEnabled({ MARINA_ANTHROPIC_AUTO_CACHE: "true", MARINA_PROFILE: "public" }),
    ).toBe(true);
  });
});

describe("Anthropic passthru: /v1/messages native forwarding", () => {
  it("forwards the client's Anthropic body verbatim — system/tool/message cache_control, thinking, tool_choice — and translates tool_use back", async () => {
    const native = {
      model: "marina",
      max_tokens: 300,
      system: [{ type: "text", text: "S", cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Weather in Paris?", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
      tools: [
        {
          name: "get_weather",
          description: "Weather by city",
          input_schema: { type: "object", properties: { city: { type: "string" } } },
          cache_control: { type: "ephemeral" },
        },
      ],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      thinking: { type: "adaptive" },
      metadata: { user_id: "u-9" },
    };
    const resp = await post("/v1/messages", native, {
      "x-api-key": "client-key",
      "anthropic-version": "2023-06-01",
    });
    expect(resp.status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.body).toEqual({
      ...native,
      model: "claude-sonnet-5",
      stream: false,
    });
    const data = (await resp.json()) as {
      content: Record<string, unknown>[];
      stop_reason: string;
      usage: Record<string, number>;
    };
    expect(data.stop_reason).toBe("tool_use");
    expect(data.content).toEqual([
      { type: "text", text: "Checking the weather." },
      { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
    ]);
    expect(data.usage.input_tokens).toBe(850);
    expect(data.usage.output_tokens).toBe(6);
  });
});

describe("Anthropic passthru: error envelope", () => {
  it("maps an upstream 401 to invalid_api_key and a 429 to rate_limit_exceeded, with the upstream reason", async () => {
    reply = () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        }),
        {
          status: 401,
          statusText: "Unauthorized",
          headers: { "Content-Type": "application/json" },
        },
      );
    const unauthorized = await post("/v1/chat/completions", {
      model: "marina",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(unauthorized.status).toBe(401);
    const body = await unauthorized.json();
    expect(body.error.code).toBe("invalid_api_key");
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.message).toContain("invalid x-api-key");

    reply = () =>
      new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    const limited = await post("/v1/chat/completions", {
      model: "marina",
      messages: [{ role: "user", content: "hi" }],
    });
    expect((await limited.json()).error.code).toBe("rate_limit_exceeded");
  });

  it("maps a context-length 400 to context_length_exceeded", async () => {
    reply = () =>
      new Response(
        JSON.stringify({
          error: { message: "prompt is too long: 250000 tokens > 200000 maximum" },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    const resp = await post("/v1/chat/completions", {
      model: "marina",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(resp.status).toBe(400);
    expect((await resp.json()).error.code).toBe("context_length_exceeded");
  });
});
