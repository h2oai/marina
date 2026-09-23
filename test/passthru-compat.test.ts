// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compat-surface contracts that are independent of the Anthropic translation:
 * string error codes, agents-mode refusal of tools / n / response_format,
 * usage derived from the trace (never zero-filled), Responses streaming,
 * the Ollama discovery routes and the explicit 404s for unserved paths.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version as MARINA_VERSION } from "../package.json";
import { Engine } from "../src/engine/engine";
import { handleModelApi, isModelApiPath, OLLAMA_API_PATHS } from "../src/net/model-api";
import { setEndpointConfig } from "../src/net/model-endpoint";
import {
  inferOpenAIErrorCode,
  openaiErrorBody,
  unsupportedParameterBody,
} from "../src/net/openai-errors";
import { MarinaDB } from "../src/persistence/database";
import { type EngineEvent, roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

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
] as const;

let saved: Map<string, string | undefined>;
let originalFetch: typeof fetch;
let dir: string;
let db: MarinaDB;
let engine: Engine;
let conn: MockConnection;

beforeEach(() => {
  saved = new Map(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.MARINA_OPEN_API = "true";
  originalFetch = globalThis.fetch;
  dir = mkdtempSync(join(tmpdir(), "passthru-compat-"));
  db = new MarinaDB(join(dir, "w.db"));
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  conn = new MockConnection("c1");
  engine.addConnection(conn);
  engine.spawnEntity("c1", "Agent1");
  conn.clear();
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

async function call(
  path: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const url = new URL(`http://localhost:3300${path}`);
  const req = new Request(url.toString(), {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return await handleModelApi(url, method, req, engine);
}

/** An agent on the `model` channel that answers every request with `answer`
 *  and reports token usage on its turn span, like a real LLM-backed agent. */
function answeringAgent(answer: string, tokens?: { input: number; output: number }) {
  engine.processCommand(conn.entity!, "channel join model");
  const cm = engine.channelManager!;
  cm.onMessage((channelId, senderId, _senderName, content) => {
    if (senderId !== "__model_api__") return;
    let parsed: { type?: string; id?: string; trace?: { traceId?: string; spanId?: string } };
    try {
      parsed = JSON.parse(content);
    } catch {
      return;
    }
    if (parsed.type !== "model_request") return;
    if (tokens) {
      engine.logEvent({
        type: "agent_turn_end",
        name: "Agent1",
        runId: parsed.trace?.traceId,
        traceId: parsed.trace?.traceId,
        spanId: `turn-${parsed.id}`,
        parentSpanId: parsed.trace?.spanId,
        origin: "request",
        hadToolCalls: false,
        toolCount: 0,
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        timestamp: Date.now(),
      } as EngineEvent);
    }
    cm.send(
      channelId,
      conn.entity!,
      "Agent1",
      JSON.stringify({ type: "model_response", id: parsed.id, content: answer }),
    );
  });
}

describe("openai-errors", () => {
  it("infers string codes from status + message", () => {
    expect(inferOpenAIErrorCode(401, "Invalid API key")).toBe("invalid_api_key");
    expect(inferOpenAIErrorCode(404, 'Model "x" not found')).toBe("model_not_found");
    expect(inferOpenAIErrorCode(404, "Response not found")).toBe("not_found");
    expect(inferOpenAIErrorCode(429, "slow down")).toBe("rate_limit_exceeded");
    expect(inferOpenAIErrorCode(400, "maximum context length is 8192 tokens")).toBe(
      "context_length_exceeded",
    );
    expect(inferOpenAIErrorCode(400, "No user message found")).toBe("invalid_request_error");
    expect(inferOpenAIErrorCode(502, "upstream rejected")).toBe("upstream_error");
    expect(inferOpenAIErrorCode(503, "no providers")).toBe("upstream_error");
    expect(inferOpenAIErrorCode(500, "boom")).toBe("server_error");
  });

  it("builds the nested envelope with param and explicit code", () => {
    expect(openaiErrorBody(404, "nope", { code: "not_found" })).toEqual({
      error: { message: "nope", type: "not_found_error", param: null, code: "not_found" },
    });
    expect(unsupportedParameterBody("n", "one choice only").error).toEqual({
      message: "Unsupported parameter: 'n'. one choice only",
      type: "invalid_request_error",
      param: "n",
      code: "unsupported_parameter",
    });
  });
});

describe("error envelope on the wire", () => {
  it("unknown model → 404 model_not_found; missing key → 401 invalid_api_key", async () => {
    const notFound = await call("/v1/chat/completions", "POST", {
      model: "marina:nonexistent",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(notFound!.status).toBe(404);
    expect((await notFound!.json()).error).toMatchObject({
      type: "not_found_error",
      code: "model_not_found",
    });

    delete process.env.MARINA_OPEN_API;
    process.env.MODEL_API_KEYS = "sk-real";
    const unauthorized = await call("/v1/models", "GET", undefined, {
      Authorization: "Bearer wrong",
    });
    expect(unauthorized!.status).toBe(401);
    expect((await unauthorized!.json()).error).toMatchObject({
      type: "authentication_error",
      code: "invalid_api_key",
    });
  });

  it("unserved endpoints answer an explicit OpenAI-shaped 404 with code not_found", async () => {
    for (const path of ["/v1/embeddings", "/v1/completions", "/api/embed", "/api/embeddings"]) {
      const resp = await call(path, "POST", { input: "x" });
      expect(resp).toBeDefined();
      expect(resp!.status).toBe(404);
      const body = await resp!.json();
      expect(body.error).toMatchObject({ type: "not_found_error", code: "not_found" });
      expect(body.error.message).toContain(path);
    }
    expect(OLLAMA_API_PATHS).toContain("/api/embed");
    expect(isModelApiPath("/api/version")).toBe(true);
    expect(isModelApiPath("/v1/anything")).toBe(true);
    expect(isModelApiPath("/api/dashboard")).toBe(false);
  });
});

describe("agents mode", () => {
  it("refuses tools / n / response_format with unsupported_parameter instead of ignoring them", async () => {
    answeringAgent("plain text");
    const cases: [Record<string, unknown>, string][] = [
      [{ tools: [{ type: "function", function: { name: "f", parameters: {} } }] }, "tools"],
      [{ n: 2 }, "n"],
      [{ response_format: { type: "json_object" } }, "response_format"],
      [{ functions: [{ name: "f" }] }, "functions"],
    ];
    for (const [extra, param] of cases) {
      const resp = await call("/v1/chat/completions", "POST", {
        model: "marina",
        messages: [{ role: "user", content: "hi" }],
        ...extra,
      });
      expect(resp!.status).toBe(400);
      expect((await resp!.json()).error).toMatchObject({ code: "unsupported_parameter", param });
    }
    // Harmless values pass: empty tools, n=1, text format.
    const ok = await call("/v1/chat/completions", "POST", {
      model: "marina",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      n: 1,
      response_format: { type: "text" },
    });
    expect(ok!.status).toBe(200);
  });

  it("populates usage from the agent's traced turn, and omits it (never zeros) when no turn reported tokens", async () => {
    answeringAgent("42", { input: 120, output: 7 });
    const traced = await call("/v1/chat/completions", "POST", {
      model: "marina",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(traced!.status).toBe(200);
    const withUsage = await traced!.json();
    expect(withUsage.usage).toEqual({
      prompt_tokens: 120,
      completion_tokens: 7,
      total_tokens: 127,
    });

    // A fresh engine without a token-reporting agent.
    engine.shutdown();
    db.close();
    db = new MarinaDB(join(dir, "w2.db"));
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    conn = new MockConnection("c2");
    engine.addConnection(conn);
    engine.spawnEntity("c2", "Agent2");
    answeringAgent("42");
    const untraced = await call("/v1/chat/completions", "POST", {
      model: "marina",
      messages: [{ role: "user", content: "hi" }],
    });
    const noUsage = await untraced!.json();
    expect(noUsage.choices[0].message.content).toBe("42");
    expect(noUsage).not.toHaveProperty("usage");
  });
});

describe("/v1/responses streaming", () => {
  it("emits the Responses SSE event sequence instead of a 400", async () => {
    answeringAgent("streamed answer", { input: 9, output: 2 });
    const resp = await call("/v1/responses", "POST", {
      model: "marina",
      input: "hello",
      stream: true,
    });
    expect(resp!.status).toBe(200);
    expect(resp!.headers.get("content-type")).toContain("text/event-stream");
    const frames = (await resp!.text())
      .split("\n\n")
      .filter(Boolean)
      .map((f) => {
        const [eventLine, dataLine] = f.split("\n");
        return { event: eventLine!.slice(7), data: JSON.parse(dataLine!.slice(6)) };
      });
    expect(frames.map((f) => f.event)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(frames.map((f) => f.data.sequence_number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(frames[4]!.data.delta).toBe("streamed answer");
    const completed = frames[8]!.data.response;
    expect(completed.status).toBe("completed");
    expect(completed.output_text).toBe("streamed answer");
    expect(completed.usage).toEqual({
      input_tokens: 9,
      output_tokens: 2,
      total_tokens: 11,
      input_tokens_details: { cached_tokens: 0 },
    });
    expect(frames[0]!.data.response.status).toBe("in_progress");
    expect(frames[0]!.data.response).not.toHaveProperty("usage");
  });

  it("non-streaming records omit usage when unknown and refuse tools for agent routing", async () => {
    answeringAgent("plain");
    const resp = await call("/v1/responses", "POST", { model: "marina", input: "hello" });
    expect(resp!.status).toBe(200);
    const body = await resp!.json();
    expect(body.output_text).toBe("plain");
    expect(body).not.toHaveProperty("usage");
    const rejected = await call("/v1/responses", "POST", {
      model: "marina",
      input: "hello",
      tools: [{ type: "function", name: "f", parameters: {} }],
    });
    expect(rejected!.status).toBe(400);
    expect((await rejected!.json()).error).toMatchObject({
      code: "unsupported_parameter",
      param: "tools",
    });
  });
});

describe("Ollama discovery surface", () => {
  it("/api/tags records carry model, digest, size and details; the digest is stable", async () => {
    engine.processCommand(conn.entity!, "channel join model");
    const first = await (await call("/api/tags", "GET"))!.json();
    const second = await (await call("/api/tags", "GET"))!.json();
    const marina = first.models.find((m: { name: string }) => m.name === "marina");
    expect(marina).toMatchObject({
      name: "marina",
      model: "marina",
      size: 0,
      details: { format: "marina", family: "marina", families: ["marina"] },
    });
    expect(marina.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.models.find((m: { name: string }) => m.name === "marina").digest).toBe(
      marina.digest,
    );
    const alias = first.models.find((m: { name: string }) => m.name === "assistant");
    expect(alias?.details.parent_model).toBe("marina");
    expect(alias?.details.family).toBe("marina-compat-openai");
  });

  it("/api/version reports the package version", async () => {
    const resp = await call("/api/version", "GET");
    expect(await resp!.json()).toEqual({ version: MARINA_VERSION });
  });

  it("/api/show returns route details (empty modelfile/parameters/template) and 404s unknown models", async () => {
    engine.processCommand(conn.entity!, "channel join model");
    const shown = await call("/api/show", "POST", { model: "marina:latest" });
    expect(shown!.status).toBe(200);
    const body = await shown!.json();
    expect(body).toMatchObject({
      modelfile: "",
      parameters: "",
      template: "",
      details: { family: "marina" },
      model_info: {
        "general.architecture": "marina",
        "general.name": "marina",
        "marina.version": MARINA_VERSION,
      },
      capabilities: ["completion", "tools"],
    });
    const missing = await call("/api/show", "POST", { name: "llama3" });
    expect(missing!.status).toBe(404);
    expect((await missing!.json()).error).toMatchObject({
      code: "model_not_found",
      param: "model",
    });
  });

  it("/api/ps lists the configured default route as the running model", async () => {
    engine.processCommand(conn.entity!, "channel join model");
    const body = await (await call("/api/ps", "GET"))!.json();
    expect(body.models).toHaveLength(1);
    expect(body.models[0]).toMatchObject({ name: "marina", model: "marina", size_vram: 0 });
    expect(typeof body.models[0].expires_at).toBe("string");
  });
});

describe("OpenAI upstream passthru correlation", () => {
  it("forwards x-request-id to the upstream, leaves prompt_cache_key in the body, and traces cached_tokens", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    setEndpointConfig(db, { mode: "passthru", passthruModel: "openai/gpt-4o" });
    let seenHeaders: Record<string, string> = {};
    let seenBody: Record<string, unknown> = {};
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      seenHeaders = {};
      req.headers.forEach((v, k) => {
        seenHeaders[k] = v;
      });
      seenBody = (await req.json()) as Record<string, unknown>;
      return Response.json({
        id: "chatcmpl-up",
        object: "chat.completion",
        model: "gpt-4o",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 3,
          total_tokens: 1003,
          prompt_tokens_details: { cached_tokens: 896 },
        },
      });
    }) as typeof fetch;
    const resp = await call("/v1/chat/completions", "POST", {
      model: "marina",
      messages: [{ role: "user", content: "hi" }],
      prompt_cache_key: "session-7",
    });
    expect(resp!.status).toBe(200);
    const requestId = resp!.headers.get("x-request-id");
    expect(requestId).toMatch(/^req-/);
    expect(seenHeaders["x-request-id"]).toBe(requestId!);
    expect(seenHeaders.authorization).toBe("Bearer sk-openai");
    expect(seenBody.prompt_cache_key).toBe("session-7");
    const completed = engine
      .getEventLog()
      .find((e) => e.type === "model_request_lifecycle" && e.phase === "completed");
    expect(completed).toMatchObject({ requestId, cacheReadTokens: 896, inputTokens: 1000 });
  });
});
