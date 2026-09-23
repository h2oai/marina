// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Marina's OWN agents are consumers of the upstream, never participants of
 * the agents/open/panel routes. A request authenticated with the internal
 * model token is proxied to the configured upstream in EVERY endpoint mode —
 * tools included — while an external caller in `agents` mode still gets the
 * structured `400 unsupported_parameter` for tools. Also covers the streamed
 * lifecycle `completed` event carrying tokens + cost from the final SSE usage
 * chunk, and the `x-marina-upstream-model` header on streams.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getInternalModelToken } from "../src/agent/agent-runtime";
import { Engine } from "../src/engine/engine";
import { handleModelApi } from "../src/net/model-api";
import { setEndpointConfig } from "../src/net/model-endpoint";
import { MarinaDB } from "../src/persistence/database";
import { type EngineEvent, roomId } from "../src/types";
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
] as const;

type LifecycleEvent = Extract<EngineEvent, { type: "model_request_lifecycle" }>;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "marina_command",
      description: "Run a world command",
      parameters: { type: "object", properties: { input: { type: "string" } } },
    },
  },
];

const TOOL_CALL_COMPLETION = () =>
  Response.json({
    id: "chatcmpl-up",
    object: "chat.completion",
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "marina_command", arguments: '{"input":"look"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  });

let saved: Map<string, string | undefined>;
let originalFetch: typeof fetch;
let dir: string;
let db: MarinaDB;
let engine: Engine;
let upstream: { url: string; body: Record<string, unknown> }[];
let reply: (body: Record<string, unknown>) => Response;

beforeEach(() => {
  saved = new Map(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.OPENAI_API_KEY = "sk-openai-test";
  originalFetch = globalThis.fetch;
  upstream = [];
  reply = () => TOOL_CALL_COMPLETION();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = (await req.json()) as Record<string, unknown>;
    upstream.push({ url: req.url, body });
    return reply(body);
  }) as typeof fetch;
  dir = mkdtempSync(join(tmpdir(), "internal-agent-routing-"));
  db = new MarinaDB(join(dir, "w.db"));
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  // The fresh-install default: coordinate to a `model`-channel agent.
  setEndpointConfig(db, { mode: "agents", fallback: true, passthruModel: "openai/gpt-4o" });
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

async function post(path: string, body: unknown, headers: Record<string, string>) {
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

const internalAuth = () => ({ Authorization: `Bearer ${getInternalModelToken()}` });

const lifecycle = () =>
  engine.getEventLog().filter((e): e is LifecycleEvent => e.type === "model_request_lifecycle");

async function collect(resp: Response): Promise<string> {
  return await resp.text();
}

const CHAT_WITH_TOOLS = {
  model: "marina/default",
  messages: [
    { role: "system", content: "You are a Marina agent." },
    { role: "user", content: "Look around." },
  ],
  tools: TOOLS,
  tool_choice: "auto",
};

describe("internal agents always proxy upstream", () => {
  it("agents mode + internal token + tools → 200 from the upstream with the tool call preserved", async () => {
    const resp = await post("/v1/chat/completions", CHAT_WITH_TOOLS, internalAuth());
    expect(resp.status).toBe(200);
    // The upstream saw the tool schema — nothing was routed to the `model` channel.
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url).toContain("api.openai.com");
    expect(upstream[0]!.body.model).toBe("gpt-4o");
    expect(upstream[0]!.body.tools).toHaveLength(1);
    const data = (await resp.json()) as {
      choices: { message: { tool_calls?: unknown[] }; finish_reason: string }[];
    };
    expect(data.choices[0]!.finish_reason).toBe("tool_calls");
    expect(data.choices[0]!.message.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "marina_command", arguments: '{"input":"look"}' },
      },
    ]);
    // The trace stays honest: a passthru route taken because the caller is internal.
    const phases = lifecycle().map((e) => e.phase);
    expect(phases).toEqual(["received", "routed", "completed"]);
    for (const event of lifecycle()) {
      expect(event.routeKind).toBe("passthru");
      expect(event.routeReason).toBe("internal");
    }
    expect(lifecycle()[1]!.target).toBe("openai/gpt-4o");
    expect(lifecycle()[2]).toMatchObject({ inputTokens: 20, outputTokens: 8 });
    expect(resp.headers.get("x-marina-upstream-model")).toBe("openai/gpt-4o");
    expect(Number(resp.headers.get("x-marina-cost-usd"))).toBeGreaterThan(0);
  });

  it("the same body with a normal API key in agents mode is still refused: 400 unsupported_parameter tools, no upstream call", async () => {
    process.env.MODEL_API_KEYS = "sk-normal";
    const resp = await post("/v1/chat/completions", CHAT_WITH_TOOLS, {
      Authorization: "Bearer sk-normal",
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({ code: "unsupported_parameter", param: "tools" });
    expect(upstream).toHaveLength(0);
    expect(lifecycle()).toHaveLength(0);
  });

  it("holds in open dev mode too (MARINA_OPEN_API) — only the internal token bypasses the agents route", async () => {
    process.env.MARINA_OPEN_API = "true";
    const refused = await post("/v1/chat/completions", CHAT_WITH_TOOLS, {});
    expect(refused.status).toBe(400);
    const proxied = await post("/v1/chat/completions", CHAT_WITH_TOOLS, internalAuth());
    expect(proxied.status).toBe(200);
    expect(upstream).toHaveLength(1);
  });

  it("holds for every non-passthru mode (open, panel)", async () => {
    for (const mode of ["open", "panel"] as const) {
      setEndpointConfig(db, { mode });
      const resp = await post("/v1/chat/completions", CHAT_WITH_TOOLS, internalAuth());
      expect(resp.status).toBe(200);
    }
    expect(upstream).toHaveLength(2);
  });

  it("/v1/responses with the internal token in agents mode is proxied with its tools", async () => {
    const resp = await post(
      "/v1/responses",
      {
        model: "marina/default",
        instructions: "You are a Marina agent.",
        input: "Look around.",
        tools: [
          {
            type: "function",
            name: "marina_command",
            parameters: { type: "object", properties: { input: { type: "string" } } },
          },
        ],
      },
      internalAuth(),
    );
    expect(resp.status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.body.tools).toHaveLength(1);
    const data = (await resp.json()) as { output: { type: string; name?: string }[] };
    expect(data.output.some((item) => item.type === "function_call")).toBe(true);
    expect(lifecycle().every((e) => e.routeReason === "internal")).toBe(true);
  });

  it("a streamed internal turn records tokens, cache counters and cost on the completed event from the final SSE usage chunk", async () => {
    const frames = [
      {
        id: "chatcmpl-s",
        object: "chat.completion.chunk",
        model: "gpt-4o",
        choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-s",
        object: "chat.completion.chunk",
        model: "gpt-4o",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
      {
        id: "chatcmpl-s",
        object: "chat.completion.chunk",
        model: "gpt-4o",
        choices: [],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          total_tokens: 1050,
          prompt_tokens_details: { cached_tokens: 600, cache_creation_tokens: 100 },
        },
      },
    ];
    reply = () =>
      new Response(
        `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")}data: [DONE]\n\n`,
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    const resp = await post(
      "/v1/chat/completions",
      {
        ...CHAT_WITH_TOOLS,
        stream: true,
        stream_options: { include_usage: true },
      },
      internalAuth(),
    );
    expect(resp.status).toBe(200);
    // The served model is known up front, so streams carry it too.
    expect(resp.headers.get("x-marina-upstream-model")).toBe("openai/gpt-4o");
    // Before the body is consumed the request is still open.
    expect(lifecycle().map((e) => e.phase)).toEqual(["received", "routed"]);
    expect(await collect(resp)).toContain('"content":"hi"');
    const completed = lifecycle().find((e) => e.phase === "completed")!;
    expect(completed).toMatchObject({
      routeKind: "passthru",
      routeReason: "internal",
      target: "openai/gpt-4o",
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 600,
      cacheWriteTokens: 100,
    });
    // gpt-4o list price: 300 uncached × $2.5/M + 50 out × $10/M + 600 cached × $1.25/M.
    expect(completed.costUsd).toBeCloseTo(0.00075 + 0.0005 + 0.00075, 8);
    expect(completed.ttftMs).toBeNumber();
  });
});
