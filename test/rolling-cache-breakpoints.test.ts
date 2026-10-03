// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Rolling cache breakpoints for multi-turn conversations. Under auto-cache the
 * proxy adds, besides the system/tool breakpoints, one on the last cacheable
 * block of the latest message, so each turn of a tool loop reads the growing
 * history from cache. Covers: placement, the four-breakpoint limit, client
 * markers respected, the minimum cacheable length, native bodies untouched,
 * OpenRouter `anthropic/*` keeping/placing markers on content parts, and every
 * other OpenAI-compatible upstream stripping them.
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
  minCacheableTokens,
  placeCacheBreakpoints,
} from "../src/net/anthropic-tools";
import { handleModelApi } from "../src/net/model-api";
import {
  honorsCacheControl,
  placeOpenAICacheBreakpoints,
  prepareUpstreamBody,
} from "../src/net/model-api/upstream";
import { setEndpointConfig } from "../src/net/model-endpoint";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { makeTestRoom } from "./helpers";
import { scopeProcessState } from "./process-state";

const EPHEMERAL = { type: "ephemeral" };
/** ~2.5k estimated tokens: above every model's minimum except the 4096 ones. */
const LONG = "policy line that keeps the prefix long enough to cache. ".repeat(180);

type Rec = Record<string, unknown>;

/** Count every `cache_control` in an Anthropic request (system, tools, message blocks). */
function countAnthropicMarkers(req: Rec): number {
  let n = 0;
  for (const b of (req.system as Rec[] | undefined) ?? []) if (b.cache_control) n++;
  for (const t of (req.tools as Rec[] | undefined) ?? []) if (t.cache_control) n++;
  for (const m of (req.messages as Rec[]) ?? []) {
    if (Array.isArray(m.content)) for (const b of m.content as Rec[]) if (b.cache_control) n++;
  }
  return n;
}

/** Count every `cache_control` in an OpenAI chat body (messages, parts, tools). */
function countOpenAIMarkers(body: Rec): number {
  let n = 0;
  for (const m of (body.messages as Rec[]) ?? []) {
    if (m.cache_control) n++;
    if (Array.isArray(m.content)) for (const p of m.content as Rec[]) if (p.cache_control) n++;
  }
  for (const t of (body.tools as Rec[] | undefined) ?? []) if (t.cache_control) n++;
  return n;
}

/** An OpenAI-shaped agentic tool loop two turns in. */
function toolLoop(system = LONG): Rec {
  return {
    model: "marina",
    messages: [
      { role: "system", content: system },
      { role: "user", content: "fetch batches 1 and 2" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "fetch", arguments: '{"n":1}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "batch 1: rows" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c2", type: "function", function: { name: "fetch", arguments: '{"n":2}' } },
        ],
      },
      { role: "tool", tool_call_id: "c2", content: "batch 2: rows" },
    ],
    tools: [{ type: "function", function: { name: "fetch", parameters: { type: "object" } } }],
  };
}

describe("rolling breakpoint (Anthropic translated path)", () => {
  it("marks the last block of the latest message, plus system and last tool", () => {
    const req = buildAnthropicRequest(toolLoop(), "claude-sonnet-5", false, { autoCache: true });
    const messages = req.messages as { role: string; content: Rec[] }[];
    const last = messages[messages.length - 1]!;
    expect(last.content[last.content.length - 1]!.type).toBe("tool_result");
    expect(last.content[last.content.length - 1]!.cache_control).toEqual(EPHEMERAL);
    // Only the latest message carries a message breakpoint.
    const marked = messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content.filter((b) => b.cache_control) : [],
    );
    expect(marked).toHaveLength(1);
    expect((req.system as Rec[])[0]!.cache_control).toEqual(EPHEMERAL);
    expect((req.tools as Rec[])[0]!.cache_control).toEqual(EPHEMERAL);
    expect(countAnthropicMarkers(req)).toBe(3);
  });

  it("with an injected memory tail uses exactly the four-breakpoint limit, never more", () => {
    const body = toolLoop();
    (body.messages as Rec[]).splice(1, 0, { role: "system", content: "memory addendum" });
    const req = buildAnthropicRequest(body, "claude-sonnet-5", false, {
      autoCache: true,
      injectedSystemTail: true,
    });
    expect(countAnthropicMarkers(req)).toBe(ANTHROPIC_CACHE_BREAKPOINT_LIMIT);
    const messages = req.messages as { content: Rec[] }[];
    expect(messages[messages.length - 1]!.content.at(-1)!.cache_control).toEqual(EPHEMERAL);
  });

  it("never exceeds the limit when the client's markers already fill it", () => {
    const messages = Array.from({ length: ANTHROPIC_CACHE_BREAKPOINT_LIMIT }, (_, i) => ({
      role: "user",
      content: [{ type: "text", text: `${LONG}${i}`, cache_control: EPHEMERAL }],
    }));
    const out = placeCacheBreakpoints(
      { system: [{ type: "text", text: "s" }], messages },
      { rollingMessages: true, model: "claude-sonnet-5" },
    );
    expect(out.messages).toBeUndefined();
    expect(out.system).toEqual([{ type: "text", text: "s" }]);
  });

  it("a client that placed its own markers gets no rolling breakpoint", () => {
    const body = toolLoop();
    // pi-ai-style marker on the latest user text part.
    (body.messages as Rec[]).push({
      role: "user",
      content: [{ type: "text", text: "continue", cache_control: EPHEMERAL }],
    });
    (body.messages as Rec[]).push({ role: "assistant", content: "ok" });
    const req = buildAnthropicRequest(body, "claude-sonnet-5", false, { autoCache: true });
    const messages = req.messages as { content: string | Rec[] }[];
    // The latest (assistant) message is untouched; the client's own marker stays.
    expect(messages[messages.length - 1]!.content).toEqual([{ type: "text", text: "ok" }]);
    expect(countAnthropicMarkers(req)).toBe(2); // client's marker + the stable system block
  });

  it("skips the rolling breakpoint on a prompt below the model's minimum cacheable length", () => {
    const req = buildAnthropicRequest(toolLoop("short"), "claude-sonnet-5", false, {
      autoCache: true,
    });
    const messages = req.messages as { content: string | Rec[] }[];
    for (const m of messages) {
      if (Array.isArray(m.content))
        for (const b of m.content) expect(b.cache_control).toBeUndefined();
    }
  });

  it("uses the model's minimum: a 4096-token model skips a ~2.5k prompt that Sonnet caches", () => {
    expect(minCacheableTokens("claude-haiku-4-5")).toBe(4096);
    expect(minCacheableTokens("anthropic/claude-opus-4.6")).toBe(4096);
    expect(minCacheableTokens("claude-opus-4-7")).toBe(2048);
    expect(minCacheableTokens("claude-opus-5")).toBe(512);
    expect(minCacheableTokens("claude-fable-5-1")).toBe(512);
    expect(minCacheableTokens("claude-sonnet-5")).toBe(1024);
    expect(minCacheableTokens(undefined)).toBe(1024);
    const haiku = buildAnthropicRequest(toolLoop(), "claude-haiku-4-5", false, { autoCache: true });
    const lastHaiku = (haiku.messages as { content: Rec[] }[]).at(-1)!;
    expect(lastHaiku.content.at(-1)!.cache_control).toBeUndefined();
  });

  it("a string user message becomes one marked text block; empty text blocks are skipped", () => {
    const out = placeCacheBreakpoints(
      {
        messages: [
          { role: "user", content: LONG },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "", signature: "s" },
              { type: "text", text: "" },
            ],
          },
        ],
      },
      { rollingMessages: true, model: "claude-sonnet-5" },
    );
    // The assistant message has no markable block, so the user message carries it.
    expect(out.messages![0]).toEqual({
      role: "user",
      content: [{ type: "text", text: LONG, cache_control: EPHEMERAL }],
    });
  });

  it("auto-cache off adds no markers anywhere", () => {
    const req = buildAnthropicRequest(toolLoop(), "claude-sonnet-5", false, { autoCache: false });
    expect(countAnthropicMarkers(req)).toBe(0);
  });

  it("native /v1/messages bodies keep their messages untouched", () => {
    const native = {
      model: "claude-sonnet-5",
      max_tokens: 100,
      system: LONG,
      messages: [{ role: "user", content: [{ type: "text", text: LONG }] }],
    };
    const req = buildAnthropicRequest({}, "claude-sonnet-5", false, { autoCache: true, native });
    expect(req.messages).toEqual(native.messages);
  });
});

describe("OpenAI-compatible upstreams", () => {
  let processState: DisposableStack | undefined;
  beforeEach(() => {
    using pending = scopeProcessState({ env: { MARINA_ANTHROPIC_AUTO_CACHE: "true" } });
    processState = pending.move();
  });
  afterEach(() => {
    using _state = processState;
    processState = undefined;
  });

  it("honorsCacheControl: only OpenRouter serving anthropic/*", () => {
    expect(honorsCacheControl("openrouter", "anthropic/claude-sonnet-5")).toBe(true);
    expect(honorsCacheControl("openrouter", "openai/gpt-6-luna")).toBe(false);
    expect(honorsCacheControl("openrouter", "google/gemini-3.8-flash")).toBe(false);
    expect(honorsCacheControl("openai", "anthropic/claude-sonnet-5")).toBe(false);
  });

  it("OpenRouter anthropic/*: places system + rolling markers on content parts", () => {
    const body: Rec = { ...toolLoop(), model: "anthropic/claude-sonnet-5" };
    const out = prepareUpstreamBody(body, "openrouter");
    const messages = out.messages as Rec[];
    expect(messages[0]!.content).toEqual([{ type: "text", text: LONG, cache_control: EPHEMERAL }]);
    expect(messages.at(-1)!.content).toEqual([
      { type: "text", text: "batch 2: rows", cache_control: EPHEMERAL },
    ]);
    expect(countOpenAIMarkers(out)).toBe(2);
    // Input untouched.
    expect((body.messages as Rec[])[0]!.content).toBe(LONG);
  });

  it("OpenRouter anthropic/*: the memory addendum and the stable block before it are both marked", () => {
    const body: Rec = { ...toolLoop(), model: "anthropic/claude-sonnet-5" };
    (body.messages as Rec[]).splice(1, 0, { role: "system", content: "memory" });
    const out = placeOpenAICacheBreakpoints(body, { injectedSystemTail: true });
    const messages = out.messages as Rec[];
    expect((messages[0]!.content as Rec[])[0]!.cache_control).toEqual(EPHEMERAL);
    expect((messages[1]!.content as Rec[])[0]!.cache_control).toEqual(EPHEMERAL);
    expect(countOpenAIMarkers(out)).toBe(3);
    expect(countOpenAIMarkers(out)).toBeLessThanOrEqual(ANTHROPIC_CACHE_BREAKPOINT_LIMIT);
  });

  it("OpenRouter anthropic/*: a client's own markers are kept and nothing is added", () => {
    const body = {
      model: "anthropic/claude-sonnet-5",
      messages: [
        { role: "system", content: [{ type: "text", text: LONG, cache_control: EPHEMERAL }] },
        { role: "user", content: "hi" },
      ],
    };
    const out = prepareUpstreamBody(body, "openrouter");
    expect(out.messages).toEqual(body.messages);
  });

  it("OpenRouter anthropic/* with auto-cache off forwards client markers but adds none", () => {
    using _off = scopeProcessState({ env: { MARINA_ANTHROPIC_AUTO_CACHE: "false" } });
    const plain = prepareUpstreamBody(
      { ...toolLoop(), model: "anthropic/claude-sonnet-5" },
      "openrouter",
    );
    expect(countOpenAIMarkers(plain)).toBe(0);
    const marked = {
      model: "anthropic/claude-sonnet-5",
      messages: [
        { role: "user", content: [{ type: "text", text: "x", cache_control: EPHEMERAL }] },
      ],
    };
    expect(prepareUpstreamBody(marked, "openrouter").messages).toEqual(marked.messages);
  });

  it("OpenAI (direct or via OpenRouter) strips every marker and gets none added", () => {
    const marked = {
      model: "gpt-6-luna",
      messages: [
        { role: "system", content: [{ type: "text", text: LONG, cache_control: EPHEMERAL }] },
        { role: "user", content: [{ type: "text", text: "hi", cache_control: EPHEMERAL }] },
      ],
      tools: [{ type: "function", function: { name: "f" }, cache_control: EPHEMERAL }],
    };
    expect(countOpenAIMarkers(prepareUpstreamBody(marked, "openai"))).toBe(0);
    const viaRouter = prepareUpstreamBody({ ...marked, model: "openai/gpt-6-luna" }, "openrouter");
    expect(countOpenAIMarkers(viaRouter)).toBe(0);
    const gemini = prepareUpstreamBody(
      { ...toolLoop(), model: "google/gemini-3.8-flash" },
      "openrouter",
    );
    expect(countOpenAIMarkers(gemini)).toBe(0);
  });
});

// ─── End to end: explicit `anthropic/<id>` reaches Anthropic with a bare id ──

describe("explicit anthropic/<id> through handleModelApi", () => {
  let processState: DisposableStack | undefined;
  let originalFetch: typeof fetch;
  let dir: string;
  let db: MarinaDB;
  let engine: Engine;
  let calls: { url: string; body: Rec }[];

  beforeEach(() => {
    using pending = scopeProcessState({
      env: {
        ANTHROPIC_API_KEY: "sk-ant-test",
        OPENROUTER_API_KEY: "sk-or-test",
        OPENAI_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
        GOOGLE_API_KEY: undefined,
        GROQ_API_KEY: undefined,
        LLAMA_API_KEY: undefined,
        LLAMA_BASE_URL: undefined,
        OLLAMA_API_KEY: undefined,
        OLLAMA_BASE_URL: undefined,
        MODEL_API_KEYS: "sk-test",
        MARINA_OPEN_API: undefined,
        MARINA_ANTHROPIC_AUTO_CACHE: "true",
        MARINA_PROFILE: undefined,
      },
    });
    resetTrustProfileForTests();
    originalFetch = globalThis.fetch;
    calls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      calls.push({ url: req.url, body: (await req.json()) as Rec });
      if (req.url.includes("anthropic.com")) {
        return Response.json({
          id: "msg_up",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 900 },
        });
      }
      return Response.json({
        id: "or",
        object: "chat.completion",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      });
    }) as typeof fetch;
    dir = mkdtempSync(join(tmpdir(), "rolling-cache-"));
    db = new MarinaDB(join(dir, "w.db"));
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    setEndpointConfig(db, { mode: "passthru", passthruModel: "" });
    processState = pending.move();
  });

  afterEach(() => {
    using _state = processState;
    processState = undefined;
    globalThis.fetch = originalFetch;
    engine.shutdown();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function post(body: unknown) {
    const url = new URL("http://localhost:3300/v1/chat/completions");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
      body: JSON.stringify(body),
    });
    return (await handleModelApi(url, "POST", req, engine))!;
  }

  it("anthropic/claude-x is served by Anthropic with the bare id and a rolling breakpoint", async () => {
    const resp = await post({ ...toolLoop(), model: "anthropic/claude-sonnet-5" });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("x-marina-upstream-model")).toBe("anthropic/claude-sonnet-5");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("api.anthropic.com");
    expect(calls[0]!.body.model).toBe("claude-sonnet-5");
    const messages = calls[0]!.body.messages as { content: Rec[] }[];
    expect(messages.at(-1)!.content.at(-1)!.cache_control).toEqual(EPHEMERAL);
  });

  it("openrouter/anthropic/claude-x keeps the markers on the OpenRouter body", async () => {
    const resp = await post({ ...toolLoop(), model: "openrouter/anthropic/claude-sonnet-5" });
    expect(resp.status).toBe(200);
    expect(calls[0]!.url).toContain("openrouter.ai");
    expect(calls[0]!.body.model).toBe("anthropic/claude-sonnet-5");
    expect(countOpenAIMarkers(calls[0]!.body)).toBe(2);
  });
});
