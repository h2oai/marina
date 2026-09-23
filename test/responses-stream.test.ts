// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `/v1/responses` with `stream: true` is incremental on both routes:
 *  - passthru: the upstream chat-completions SSE is re-encoded as it arrives
 *    (`delta.content` → `response.output_text.delta`, `delta.tool_calls` →
 *    `function_call` items with `response.function_call_arguments.delta`);
 *  - agents: each `model_response_chunk` from the routed agent is one delta.
 * The `response.completed` payload equals the stored (GET) body byte-for-byte.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { handleModelApi } from "../src/net/model-api";
import { setEndpointConfig } from "../src/net/model-endpoint";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
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
  dir = mkdtempSync(join(tmpdir(), "responses-stream-"));
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

async function call(path: string, method: string, body?: unknown) {
  const url = new URL(`http://localhost:3300${path}`);
  const req = new Request(url.toString(), {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return await handleModelApi(url, method, req, engine);
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

/** An upstream SSE body: each chunk becomes one `data:` frame, split across
 *  two network reads mid-frame so line reassembly is exercised. */
function sseBody(chunks: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const text = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
  const cut = Math.floor(text.length / 2);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(text.slice(0, cut)));
      controller.enqueue(enc.encode(text.slice(cut)));
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

function mockUpstream(chunks: unknown[]): { body: () => Record<string, unknown> } {
  let seen: Record<string, unknown> = {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    seen = (await req.json()) as Record<string, unknown>;
    return new Response(sseBody(chunks), {
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;
  return { body: () => seen };
}

describe("/v1/responses streaming — passthru", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-openai";
    setEndpointConfig(db, { mode: "passthru", passthruModel: "openai/gpt-4o" });
  });

  it("re-encodes upstream content deltas incrementally with a running sequence_number", async () => {
    const upstream = mockUpstream([
      chunk({ role: "assistant" }),
      chunk({ content: "Hello, " }),
      chunk({ content: "world" }),
      chunk({}, "stop"),
      {
        id: "chatcmpl-up",
        object: "chat.completion.chunk",
        model: "gpt-4o",
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      },
    ]);
    const resp = await call("/v1/responses", "POST", {
      model: "marina",
      input: "hello",
      stream: true,
    });
    expect(resp!.status).toBe(200);
    // The upstream was asked for a stream (with usage), not a buffered answer.
    expect(upstream.body().stream).toBe(true);
    expect(upstream.body().stream_options).toEqual({ include_usage: true });

    const got = await frames(resp!);
    const events = got.map((f) => f.event);
    expect(events.slice(0, 4)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
    ]);
    const deltas = got.filter((f) => f.event === "response.output_text.delta");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas.map((f) => f.data.delta).join("")).toBe("Hello, world");
    expect(events.slice(-4)).toEqual([
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(got.map((f) => f.data.sequence_number)).toEqual(got.map((_, i) => i));

    const completed = got.at(-1)!.data.response as Record<string, unknown>;
    expect(completed.status).toBe("completed");
    expect(completed.output_text).toBe("Hello, world");
    expect(completed.usage).toEqual({
      input_tokens: 12,
      output_tokens: 3,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
    });
    expect((got[0]!.data.response as Record<string, unknown>).status).toBe("in_progress");
    expect(got[0]!.data.response).not.toHaveProperty("usage");

    // The stored record IS the completed payload.
    const stored = await call(`/v1/responses/${completed.id}`, "GET");
    expect(stored!.status).toBe(200);
    expect(await stored!.json()).toEqual(completed);
  });

  it("turns tool-call deltas into function_call items with argument deltas", async () => {
    mockUpstream([
      chunk({ role: "assistant", content: "Sure." }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_abc",
            type: "function",
            function: { name: "lookup", arguments: "" },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] }),
      chunk({}, "tool_calls"),
    ]);
    const resp = await call("/v1/responses", "POST", {
      model: "marina",
      input: "weather?",
      stream: true,
    });
    const got = await frames(resp!);
    const events = got.map((f) => f.event);
    expect(events).toContain("response.function_call_arguments.delta");
    expect(events).toContain("response.function_call_arguments.done");
    const added = got.filter((f) => f.event === "response.output_item.added");
    expect(added.map((f) => (f.data.item as { type: string }).type)).toEqual([
      "message",
      "function_call",
    ]);
    expect(added[1]!.data.output_index).toBe(1);
    const argDeltas = got
      .filter((f) => f.event === "response.function_call_arguments.delta")
      .map((f) => f.data.delta as string)
      .join("");
    expect(argDeltas).toBe('{"city":"Oslo"}');
    const argsDone = got.find((f) => f.event === "response.function_call_arguments.done")!;
    expect(argsDone.data.arguments).toBe('{"city":"Oslo"}');

    const completed = got.at(-1)!.data.response as { output: Record<string, unknown>[] };
    expect(completed.output).toHaveLength(2);
    expect(completed.output[0]).toMatchObject({ type: "message", status: "completed" });
    expect(completed.output[1]).toMatchObject({
      type: "function_call",
      call_id: "call_abc",
      name: "lookup",
      arguments: '{"city":"Oslo"}',
      status: "completed",
    });
    // Item ids in the stream match the stored record's items.
    const doneItems = got
      .filter((f) => f.event === "response.output_item.done")
      .map((f) => (f.data.item as { id: string }).id);
    expect(doneItems).toEqual(completed.output.map((o) => o.id as string));
    const stored = await call(
      `/v1/responses/${(completed as unknown as { id: string }).id}`,
      "GET",
    );
    expect(await stored!.json()).toEqual(completed);
  });

  it("non-streaming passthru keeps the same body shape (message + function_call items)", async () => {
    globalThis.fetch = (async (_input: string | URL | Request) =>
      Response.json({
        id: "chatcmpl-up",
        object: "chat.completion",
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Sure.",
              tool_calls: [
                {
                  id: "call_abc",
                  type: "function",
                  function: { name: "lookup", arguments: '{"city":"Oslo"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      })) as typeof fetch;
    const resp = await call("/v1/responses", "POST", { model: "marina", input: "weather?" });
    expect(resp!.status).toBe(200);
    const body = (await resp!.json()) as { output: Record<string, unknown>[]; output_text: string };
    expect(body.output_text).toBe("Sure.");
    expect(body.output.map((o) => o.type)).toEqual(["message", "function_call"]);
    expect(body.output[1]).toMatchObject({ call_id: "call_abc", name: "lookup" });
  });

  it("an upstream stream that breaks mid-way ends with response.failed and stores nothing", async () => {
    const enc = new TextEncoder();
    globalThis.fetch = (async (_input: string | URL | Request) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              enc.encode(
                `data: ${JSON.stringify(chunk({ role: "assistant", content: "part" }))}\n\n`,
              ),
            );
            controller.error(new Error("socket reset"));
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      )) as typeof fetch;
    const resp = await call("/v1/responses", "POST", {
      model: "marina",
      input: "hi",
      stream: true,
    });
    expect(resp!.status).toBe(200);
    const got = await frames(resp!);
    expect(got.at(-1)!.event).toBe("response.failed");
    const failed = got.at(-1)!.data.response as {
      id: string;
      status: string;
      error: { code: string; message: string };
    };
    expect(failed.status).toBe("failed");
    expect(failed.error.code).toBe("upstream_error");
    expect(got.map((f) => f.data.sequence_number)).toEqual(got.map((_, i) => i));
    const stored = await call(`/v1/responses/${failed.id}`, "GET");
    expect(stored!.status).toBe(404);
  });
});

describe("/v1/responses streaming — agents mode", () => {
  it("streams each agent chunk as its own delta and stores the completed record", async () => {
    engine.processCommand(conn.entity!, "channel join model");
    const cm = engine.channelManager!;
    cm.onMessage((channelId, senderId, _senderName, content) => {
      if (senderId !== "__model_api__") return;
      const parsed = JSON.parse(content) as { type?: string; id?: string };
      if (parsed.type !== "model_request") return;
      for (const part of ["first ", "second ", "third"]) {
        cm.send(
          channelId,
          conn.entity!,
          "Agent1",
          JSON.stringify({ type: "model_response_chunk", id: parsed.id, content: part }),
        );
      }
      cm.send(
        channelId,
        conn.entity!,
        "Agent1",
        JSON.stringify({ type: "model_response_end", id: parsed.id }),
      );
    });
    const resp = await call("/v1/responses", "POST", {
      model: "marina",
      input: "go",
      stream: true,
    });
    expect(resp!.status).toBe(200);
    const got = await frames(resp!);
    const deltas = got.filter((f) => f.event === "response.output_text.delta");
    expect(deltas.map((f) => f.data.delta)).toEqual(["first ", "second ", "third"]);
    expect(got.at(-1)!.event).toBe("response.completed");
    const completed = got.at(-1)!.data.response as { id: string; output_text: string };
    expect(completed.output_text).toBe("first second third");
    const stored = await call(`/v1/responses/${completed.id}`, "GET");
    expect(await stored!.json()).toEqual(completed);
  });
});
