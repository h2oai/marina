// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Anthropic cache-breakpoint layout for the passthru proxy. The memory
 * addendum is appended as the LAST system block, so under auto-cache the
 * breakpoints go on the last STABLE block (the caller's prompt) AND the last
 * block, plus the last tool — within Anthropic's four-breakpoint limit and
 * never on top of a client's own markers. Measured before the fix: with one
 * breakpoint on the last block, every request whose relevance-gated memory
 * block toggled re-wrote the whole prefix (`cache_creation` on 2 of 6).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { resetTrustProfileForTests } from "../src/engine/trust-profile";
import {
  ANTHROPIC_CACHE_BREAKPOINT_LIMIT,
  buildAnthropicRequest,
  placeCacheBreakpoints,
} from "../src/net/anthropic-tools";
import { handleModelApi } from "../src/net/model-api";
import { setEndpointConfig } from "../src/net/model-endpoint";
import { INJECTION_MARKER } from "../src/net/passthru-context";
import { MarinaDB } from "../src/persistence/database";
import { type EngineEvent, roomId } from "../src/types";
import { FIXTURE_QUERY, seedUnifiedFixture } from "./fixtures/unified-memory-fixture";
import { makeTestRoom } from "./helpers";

const EPHEMERAL = { type: "ephemeral" };
const TOOL = {
  name: "get_weather",
  description: "Weather by city",
  input_schema: { type: "object", properties: { city: { type: "string" } } },
};

type Block = { type: string; text?: string; cache_control?: unknown };
const markers = (blocks: unknown) =>
  (blocks as Block[]).map((b) => (b.cache_control ? 1 : 0)) as number[];

describe("placeCacheBreakpoints", () => {
  it("no client markers + injected tail: last stable system block, last system block, last tool", () => {
    const out = placeCacheBreakpoints(
      {
        system: [
          { type: "text", text: "identity" },
          { type: "text", text: "caller prompt" },
          { type: "text", text: `${INJECTION_MARKER} memory` },
        ],
        tools: [TOOL, { ...TOOL, name: "b" }],
        messages: [{ role: "user", content: "hi" }],
      },
      { injectedSystemTail: true },
    );
    expect(markers(out.system)).toEqual([0, 1, 1]);
    expect(markers(out.tools)).toEqual([0, 1]);
  });

  it("no client markers, no injected tail: last system block + last tool", () => {
    const out = placeCacheBreakpoints({
      system: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
      tools: [TOOL],
    });
    expect(markers(out.system)).toEqual([0, 1]);
    expect(markers(out.tools)).toEqual([1]);
  });

  it("pi-ai markers (stable block + last tool) with an injected tail: preserved, nothing added", () => {
    const system = [
      { type: "text", text: "caller prompt", cache_control: EPHEMERAL },
      { type: "text", text: "memory" },
    ];
    const tools = [{ ...TOOL, cache_control: EPHEMERAL }];
    const out = placeCacheBreakpoints({ system, tools }, { injectedSystemTail: true });
    expect(out.system).toEqual(system);
    expect(out.tools).toEqual(tools);
  });

  it("client marker elsewhere + injected tail: only the stable-block breakpoint is added", () => {
    const out = placeCacheBreakpoints(
      {
        system: [
          { type: "text", text: "a", cache_control: EPHEMERAL },
          { type: "text", text: "caller prompt" },
          { type: "text", text: "memory" },
        ],
        tools: [TOOL],
      },
      { injectedSystemTail: true },
    );
    expect(markers(out.system)).toEqual([1, 1, 0]);
    // Tools keep the client's (absent) choice.
    expect(markers(out.tools)).toEqual([0]);
  });

  it("respects Anthropic's four-breakpoint limit counting the client's message markers", () => {
    const messages = Array.from({ length: ANTHROPIC_CACHE_BREAKPOINT_LIMIT }, (_, i) => ({
      role: "user",
      content: [{ type: "text", text: `t${i}`, cache_control: EPHEMERAL }],
    }));
    const system = [
      { type: "text", text: "caller prompt" },
      { type: "text", text: "memory" },
    ];
    const out = placeCacheBreakpoints(
      { system, tools: [TOOL], messages },
      { injectedSystemTail: true },
    );
    expect(out.system).toEqual(system);
    expect(out.tools).toEqual([TOOL]);
  });

  it("does not mutate its inputs and skips non-text blocks", () => {
    const system = [
      { type: "text", text: "a" },
      { type: "image", source: {} },
    ];
    const out = placeCacheBreakpoints({ system });
    expect(system[0]).toEqual({ type: "text", text: "a" });
    expect(out.system).toEqual(system);
  });

  it("buildAnthropicRequest (translated path) lays the breakpoints out from the OpenAI shape", () => {
    const req = buildAnthropicRequest(
      {
        model: "marina",
        messages: [
          { role: "system", content: "caller prompt" },
          { role: "system", content: `${INJECTION_MARKER} memory` },
          { role: "user", content: "hi" },
        ],
        tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
      },
      "claude-sonnet-5",
      false,
      { autoCache: true, injectedSystemTail: true },
    );
    expect(req.system).toEqual([
      { type: "text", text: "caller prompt", cache_control: EPHEMERAL },
      { type: "text", text: `${INJECTION_MARKER} memory`, cache_control: EPHEMERAL },
    ]);
    expect(markers(req.tools)).toEqual([1]);
  });
});

// ─── End to end through handleModelApi with a mocked Anthropic upstream ──────

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

type LifecycleEvent = Extract<EngineEvent, { type: "model_request_lifecycle" }>;

describe("Anthropic passthru: cache breakpoints end to end", () => {
  let saved: Map<string, string | undefined>;
  let originalFetch: typeof fetch;
  let dir: string;
  let db: MarinaDB;
  let engine: Engine;
  let fx: Awaited<ReturnType<typeof seedUnifiedFixture>>;
  let upstream: Record<string, unknown>[];
  let reply: () => Response;
  const QUESTION = `what is the ${FIXTURE_QUERY}?`;
  const AUTH = { Authorization: "Bearer sk-ada" };

  const message = () =>
    Response.json({
      id: "msg_up",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "7419" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 6,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 40,
      },
    });

  beforeEach(async () => {
    saved = new Map(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.MARINA_ANTHROPIC_AUTO_CACHE = "true";
    // Bound key confined to the fixture owner; she opts into injection via her property.
    process.env.MODEL_API_KEYS = "sk-ada:Ada";
    resetTrustProfileForTests();
    originalFetch = globalThis.fetch;
    upstream = [];
    reply = message;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      upstream.push((await new Request(input, init).json()) as Record<string, unknown>);
      return reply();
    }) as typeof fetch;
    dir = mkdtempSync(join(tmpdir(), "cache-breakpoints-"));
    db = new MarinaDB(join(dir, "w.db"));
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    setEndpointConfig(db, { mode: "passthru", passthruModel: "anthropic/claude-sonnet-5" });
    fx = await seedUnifiedFixture(engine, db);
    engine.entities.get(fx.ownerEntityId)!.properties.passthruContext = true;
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

  async function post(path: string, body: unknown, headers: Record<string, string> = AUTH) {
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

  it("injected request: two system blocks, both with cache_control, the FIRST on the caller's stable prompt", async () => {
    const resp = await post("/v1/chat/completions", {
      model: "marina",
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: QUESTION },
      ],
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-marina-memory-receipt")).toBeTruthy();
    const system = upstream[0]!.system as Block[];
    expect(system).toHaveLength(2);
    expect(system[0]).toEqual({ type: "text", text: "You are terse.", cache_control: EPHEMERAL });
    expect(system[1]!.text).toStartWith(INJECTION_MARKER);
    expect(system[1]!.cache_control).toEqual(EPHEMERAL);
  });

  it("same caller with injection off: exactly one breakpoint, on the (now last) stable block", async () => {
    const resp = await post(
      "/v1/chat/completions",
      {
        model: "marina",
        messages: [
          { role: "system", content: "You are terse." },
          { role: "user", content: QUESTION },
        ],
      },
      { ...AUTH, "X-Marina-Context": "off" },
    );
    expect(resp.status).toBe(200);
    expect(upstream[0]!.system).toEqual([
      { type: "text", text: "You are terse.", cache_control: EPHEMERAL },
    ]);
  });

  it("the stable block's marker is byte-identical whether or not memory was injected (prefix reuse)", async () => {
    const body = {
      model: "marina",
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: QUESTION },
      ],
    };
    await post("/v1/chat/completions", body);
    await post("/v1/chat/completions", body, { ...AUTH, "X-Marina-Context": "off" });
    const [injected, plain] = upstream.map((b) => b.system as Block[]);
    expect(injected![0]).toEqual(plain![0]);
    expect(plain).toHaveLength(1);
    expect(injected).toHaveLength(2);
  });

  it("/v1/messages native body with the caller's own markers is forwarded untouched", async () => {
    const native = {
      model: "marina",
      max_tokens: 100,
      system: [{ type: "text", text: "S", cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: QUESTION, cache_control: EPHEMERAL }],
        },
      ],
      tools: [TOOL],
    };
    const resp = await post("/v1/messages", native, { ...AUTH, "X-Marina-Context": "off" });
    expect(resp.status).toBe(200);
    expect(upstream[0]).toEqual({ ...native, model: "claude-sonnet-5", stream: false });
  });

  it("/v1/messages native body WITH injection: memory appended last, stable block marked first", async () => {
    const resp = await post("/v1/messages", {
      model: "marina",
      max_tokens: 100,
      system: "You are Claude.",
      messages: [{ role: "user", content: QUESTION }],
    });
    expect(resp.status).toBe(200);
    const system = upstream[0]!.system as Block[];
    expect(system).toHaveLength(2);
    expect(system[0]).toEqual({ type: "text", text: "You are Claude.", cache_control: EPHEMERAL });
    expect(system[1]!.text).toStartWith(INJECTION_MARKER);
    expect(system[1]!.cache_control).toEqual(EPHEMERAL);
  });

  it("a streamed Anthropic reply without include_usage still lands tokens + cost on the completed event", async () => {
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_s",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 800,
            cache_creation_input_tokens: 40,
          },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "7419" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } },
      { type: "message_stop" },
    ];
    reply = () =>
      new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      });
    const resp = await post(
      "/v1/chat/completions",
      { model: "marina", stream: true, messages: [{ role: "user", content: QUESTION }] },
      { ...AUTH, "X-Marina-Context": "off" },
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-marina-upstream-model")).toBe("anthropic/claude-sonnet-5");
    const text = await resp.text();
    // The client did not ask for usage, so the stream carries none…
    expect(text).not.toContain('"usage"');
    // …but the lifecycle event does, priced from the catalog.
    const completed = engine
      .getEventLog()
      .find(
        (e): e is LifecycleEvent => e.type === "model_request_lifecycle" && e.phase === "completed",
      )!;
    expect(completed).toMatchObject({
      target: "anthropic/claude-sonnet-5",
      inputTokens: 850,
      outputTokens: 6,
      cacheReadTokens: 800,
      cacheWriteTokens: 40,
    });
    expect(completed.costUsd).toBeCloseTo(0.00034, 8);
  });
});
