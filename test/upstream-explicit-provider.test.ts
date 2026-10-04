// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Non-default model routing in `proxyToUpstream`: an explicit provider prefix
 * (`openrouter/…`) goes to that provider with the prefix stripped, and an
 * Anthropic "model not found" for a non-default id falls through to the next
 * keyed provider instead of ending the request. The routed target names the
 * provider that actually answered.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { proxyToUpstream } from "../src/net/model-api/upstream";
import { MarinaDB } from "../src/persistence/database";
import { type EngineEvent, roomId } from "../src/types";
import { makeTestRoom } from "./helpers";
import { scopeProcessState } from "./process-state";

const ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "HUGGINGFACE_API_KEY",
  "HF_TOKEN",
  "LLAMA_API_KEY",
  "LLAMA_BASE_URL",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
  "MARINA_DAILY_SPEND_CAP_USD",
] as const;

let processState: DisposableStack | undefined;
let saved: Map<string, string | undefined>;
let originalFetch: typeof fetch;
let dir: string;
let db: MarinaDB;
let engine: Engine;
let calls: { host: string; model: unknown }[];
let events: EngineEvent[];
/** Per-host reply override; unset hosts answer as before. */
let replies: Record<string, () => Response>;

/** OpenRouter relaying a provider's rejection of `logprobs` on a reasoning model. */
const OPENROUTER_WRAPPED_400 = () =>
  new Response(
    JSON.stringify({
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: {
          raw: JSON.stringify({
            error: {
              message: "logprobs are not supported with reasoning models.",
              type: "invalid_request_error",
              param: "include",
              code: "unsupported_parameter",
            },
          }),
          provider_name: "OpenAI",
          provider_error_code: "unsupported_parameter",
        },
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );

const OPENAI_OK = (model: string) =>
  Response.json({
    id: "chatcmpl-1",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

const ANTHROPIC_404 = () =>
  new Response(
    JSON.stringify({ type: "error", error: { type: "not_found_error", message: "model: x" } }),
    { status: 404, headers: { "Content-Type": "application/json" } },
  );

beforeEach(() => {
  using pending = scopeProcessState();
  saved = new Map(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.OPENROUTER_API_KEY = "sk-or-test";
  originalFetch = globalThis.fetch;
  calls = [];
  replies = {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = (await req.json()) as { model?: unknown };
    const host = new URL(req.url).host;
    calls.push({ host, model: body.model });
    const reply = replies[host];
    if (reply) return reply();
    if (host === "api.anthropic.com") return ANTHROPIC_404();
    return OPENAI_OK(String(body.model));
  }) as typeof fetch;
  dir = mkdtempSync(join(tmpdir(), "upstream-explicit-"));
  db = new MarinaDB(join(dir, "w.db"));
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  events = [];
  engine.addEventListener((e) => events.push(e));
  processState = pending.move();
});

afterEach(() => {
  using _state = processState;
  processState = undefined;
  globalThis.fetch = originalFetch;
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  engine.shutdown();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const routedTarget = () =>
  events.find(
    (e): e is Extract<EngineEvent, { type: "model_request_lifecycle" }> =>
      e.type === "model_request_lifecycle" && e.phase === "routed",
  )?.target;

const ask = (model: string) =>
  proxyToUpstream(engine, { model, messages: [{ role: "user", content: "hi" }] }, undefined, {
    routeKind: "passthru",
  });

describe("proxyToUpstream: explicit provider prefix", () => {
  it("sends openrouter/<id> to OpenRouter with the prefix stripped, never to Anthropic", async () => {
    const resp = await ask("openrouter/z-ai/glm-test");
    expect(resp.status).toBe(200);
    expect(calls).toEqual([{ host: "openrouter.ai", model: "z-ai/glm-test" }]);
    expect(routedTarget()).toBe("openrouter/z-ai/glm-test");
  });

  it("falls through an Anthropic 404 to the next keyed provider and credits the one that answered", async () => {
    const resp = await ask("vendor/some-model");
    expect(resp.status).toBe(200);
    expect(calls.map((c) => c.host)).toEqual(["api.anthropic.com", "openrouter.ai"]);
    expect(calls[1]!.model).toBe("vendor/some-model");
    expect(routedTarget()).toBe("openrouter/vendor/some-model");
  });

  it("returns the Anthropic 404 when no other provider serves the id", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const resp = await ask("vendor/some-model");
    expect(resp.status).toBe(404);
    expect(calls.map((c) => c.host)).toEqual(["api.anthropic.com"]);
  });

  it("returns the named provider's own 400 with its body, never retrying elsewhere", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";
    replies["openrouter.ai"] = OPENROUTER_WRAPPED_400;
    const resp = await ask("openrouter/openai/gpt-reasoner");
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: { metadata: { raw: string } } };
    expect(body.error.metadata.raw).toContain("logprobs are not supported");
    expect(calls).toEqual([{ host: "openrouter.ai", model: "openai/gpt-reasoner" }]);
    expect(routedTarget()).toBe("openrouter/openai/gpt-reasoner");
  });

  it("after the named provider fails, sends the full id only to an aggregator", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";
    replies["api.openai.com"] = () => new Response("{}", { status: 503 });
    const resp = await ask("openai/gpt-x");
    expect(resp.status).toBe(200);
    expect(calls.map((c) => c.host)).toEqual(["api.openai.com", "openrouter.ai"]);
    expect(calls[1]!.model).toBe("openai/gpt-x");
    expect(routedTarget()).toBe("openrouter/openai/gpt-x");
  });

  it("an aggregator outage on a prefixed id is not retried on first-party APIs", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";
    replies["openrouter.ai"] = () => new Response("{}", { status: 503 });
    const resp = await ask("openrouter/openai/gpt-x");
    expect(resp.status).toBe(502);
    expect(calls.map((c) => c.host)).toEqual(["openrouter.ai"]);
  });
});

describe("configured default remains pinned on failure", () => {
  it("returns the selected provider's rejection without trying another provider", async () => {
    db.setSetting("default_model", "openrouter/example/model");
    replies["openrouter.ai"] = () =>
      Response.json({ error: { message: "Request is too large" } }, { status: 413 });
    const response = await ask("marina/default");
    expect(response.status).toBe(413);
    expect(await response.text()).toContain("Request is too large");
    expect(calls).toEqual([{ host: "openrouter.ai", model: "example/model" }]);
    expect(routedTarget()).toBe("openrouter/example/model");
  });

  it("does not switch models after a network failure or missing forced-provider credentials", async () => {
    replies["openrouter.ai"] = () => {
      throw new Error("offline");
    };
    const response = await proxyToUpstream(
      engine,
      { model: "default" },
      "openrouter/example/model",
    );
    expect(response.status).toBe(502);
    expect(calls).toHaveLength(1);
    const missing = await proxyToUpstream(engine, { model: "default" }, "openai/example");
    expect(missing.status).toBe(503);
    expect(calls).toHaveLength(1);
  });
});
