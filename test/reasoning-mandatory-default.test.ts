// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A default model whose reasoning is mandatory (OpenRouter's default
 * google/gemini-3.1-pro-preview, or anthropic/claude-opus-5.5 pinned by an
 * operator): a short default-route completion asks for the lowest
 * effort, the provider probe passes, an explicit cap is never raised, and a
 * reply whose cap went to reasoning is a coded error, never an empty 200.
 * Fetch is mocked; no provider is called.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelSourceEnvKeys } from "../src/agent/available-models";
import { proposerModel } from "../src/arena/discovery/loop";
import {
  DEFAULT_OPENROUTER_SEARCH_MODEL,
  openRouterSearchCarrier,
} from "../src/arena/research/web-search";
import { defaultClassifierModel } from "../src/decisions/config";
import { Engine } from "../src/engine/engine";
import { resetTrustProfileForTests } from "../src/engine/trust-profile";
import { DEFAULT_ANALYSTS, defaultAnalystSpecs } from "../src/forecast/service";
import { getDefaultUpstreamModel, vendorModelSpec } from "../src/net/model/default-models";
import {
  handleModelApi,
  PROVIDER_PROBE_MAX_TOKENS,
  prepareUpstreamBody,
  probeConfiguredProviders,
} from "../src/net/model/model-api";
import { setEndpointConfig } from "../src/net/model/model-endpoint";
import {
  defaultRouteReasoningEffort,
  lowestReasoningEffort,
  REASONING_EXHAUSTED_CODE,
  reasoningExhausted,
  SMALL_OUTPUT_CAP_TOKENS,
} from "../src/net/model/reasoning-effort";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";
import { scopeProcessState } from "./process-state";

const ENV = [
  ...modelSourceEnvKeys(),
  "CEREBRAS_API_KEY",
  "MODEL_API_KEYS",
  "MARINA_OPEN_API",
  "MARINA_DAILY_SPEND_CAP_USD",
  "MARINA_DEFAULT_OPENROUTER_MODEL",
] as const;

let processState: DisposableStack | undefined;
let saved: Map<string, string | undefined>;
let originalFetch: typeof fetch;
let dir: string;
let db: MarinaDB;
let engine: Engine;
let sent: Record<string, unknown>[];

/** OpenRouter serving a reasoning-mandatory model: reasoning spends the cap first. */
const REASONING_TOKENS = 37;
function mandatoryReasoningUpstream(body: Record<string, unknown>): Response {
  const cap = Number(body.max_tokens ?? body.max_completion_tokens ?? 128_000);
  // Effort "low" reasons briefly; the default (high) effort reasons at length.
  const reasoning = body.reasoning_effort === "low" ? REASONING_TOKENS : 4_000;
  const text = String(
    (body.messages as { content?: unknown }[])
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join(" ")
      .match(/probe-[0-9a-f]{8}/)?.[0] ?? "answer",
  );
  const exhausted = cap <= reasoning;
  const usage = {
    prompt_tokens: 67,
    completion_tokens: exhausted ? cap : reasoning + 5,
    total_tokens: 67 + (exhausted ? cap : reasoning + 5),
    completion_tokens_details: { reasoning_tokens: exhausted ? cap : reasoning },
    cost: 0.0009,
  };
  if (body.stream === true) {
    const frames = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
      { choices: [{ index: 0, delta: { content: null, reasoning: "thinking…" } }] },
      ...(exhausted ? [] : [{ choices: [{ index: 0, delta: { content: text } }] }]),
      { choices: [{ index: 0, delta: {}, finish_reason: exhausted ? "length" : "stop" }] },
      { choices: [], usage },
    ];
    const sse = `${frames.map((f) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", ...f })}\n\n`).join("")}data: [DONE]\n\n`;
    return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
  }
  return Response.json({
    id: "c1",
    object: "chat.completion",
    model: body.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: exhausted ? null : text, reasoning: "thinking…" },
        finish_reason: exhausted ? "length" : "stop",
      },
    ],
    usage,
  });
}

beforeEach(() => {
  using pending = scopeProcessState();
  saved = new Map(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.MARINA_OPEN_API = "true";
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  resetTrustProfileForTests();
  sent = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("openrouter.ai")) throw new Error(`unexpected ${url}`);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push(body);
    return mandatoryReasoningUpstream(body);
  }) as typeof fetch;
  dir = mkdtempSync(join(tmpdir(), "reasoning-mandatory-"));
  db = new MarinaDB(join(dir, "w.db"));
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  engine.addConnection(new MockConnection("c1"));
  engine.spawnEntity("c1", "Agent1");
  setEndpointConfig(db, { mode: "passthru" });
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

async function post(path: string, body: unknown): Promise<Response> {
  const url = new URL(`http://localhost:3300${path}`);
  const req = new Request(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const resp = await handleModelApi(url, "POST", req, engine);
  if (!resp) throw new Error(`no handler for ${path}`);
  return resp;
}

const ask = (extra: Record<string, unknown> = {}) => ({
  model: "marina/default",
  messages: [{ role: "user", content: "Classify: yes or no?" }],
  ...extra,
});

describe("reasoning capability table", () => {
  it("knows the lowest effort of Luna and the reasoning-mandatory Claude 5 family", () => {
    expect(lowestReasoningEffort("openrouter", "anthropic/claude-opus-5.5")).toBe("low");
    expect(lowestReasoningEffort("openrouter", "google/gemini-3.1-pro-preview")).toBe("low");
    expect(lowestReasoningEffort("google", "gemini-3.1-pro-preview")).toBe("low");
    expect(lowestReasoningEffort("openrouter", "google/gemini-3.1-flash-lite")).toBeUndefined();
    expect(lowestReasoningEffort("openrouter", "anthropic/claude-sonnet-5.5")).toBe("low");
    expect(lowestReasoningEffort("openrouter", "anthropic/claude-fable-5.1")).toBe("low");
    expect(lowestReasoningEffort("openrouter", "openai/gpt-6-luna")).toBe("none");
    expect(lowestReasoningEffort("openai", "gpt-6-luna")).toBe("none");
    // Reasoning can be disabled (or is unknown): no directive is invented.
    expect(lowestReasoningEffort("openrouter", "anthropic/claude-opus-5")).toBeUndefined();
    expect(lowestReasoningEffort("openrouter", "anthropic/claude-haiku-5.5")).toBeUndefined();
    expect(lowestReasoningEffort("anthropic", "claude-opus-5-5")).toBeUndefined();
    expect(lowestReasoningEffort("openai", "gpt-6.1-sol")).toBeUndefined();
  });

  it("asks a mandatory reasoner for its lowest effort only on the default route under a small explicit cap", () => {
    const model = "anthropic/claude-opus-5.5";
    expect(defaultRouteReasoningEffort({ model, max_tokens: 32 }, "openrouter", true)).toBe("low");
    expect(
      defaultRouteReasoningEffort({ model, max_completion_tokens: 200 }, "openrouter", true),
    ).toBe("low");
    // No cap, a large cap, a direct request, or the caller's own directive: untouched.
    expect(defaultRouteReasoningEffort({ model }, "openrouter", true)).toBeUndefined();
    expect(
      defaultRouteReasoningEffort(
        { model, max_tokens: SMALL_OUTPUT_CAP_TOKENS },
        "openrouter",
        true,
      ),
    ).toBeUndefined();
    expect(
      defaultRouteReasoningEffort({ model, max_tokens: 32 }, "openrouter", false),
    ).toBeUndefined();
    expect(
      defaultRouteReasoningEffort(
        { model, max_tokens: 32, reasoning: { effort: "high" } },
        "openrouter",
        true,
      ),
    ).toBeUndefined();
  });

  it("prepareUpstreamBody adds the effort and never touches an explicit cap", () => {
    const prepared = prepareUpstreamBody(
      { model: "anthropic/claude-opus-5.5", max_tokens: 32, messages: [] },
      "openrouter",
      true,
    );
    expect(prepared).toMatchObject({ reasoning_effort: "low", max_tokens: 32 });
    expect(
      prepareUpstreamBody({ model: "anthropic/claude-opus-5.5", max_tokens: 32 }, "openrouter"),
    ).not.toHaveProperty("reasoning_effort");
  });

  it("recognizes a reply whose cap went to reasoning", () => {
    const reply = (message: Record<string, unknown>, finish_reason = "length") => ({
      choices: [{ message, finish_reason }],
    });
    expect(reasoningExhausted(reply({ content: null, reasoning: "…" }))).toBe(true);
    expect(reasoningExhausted(reply({ content: "  " }))).toBe(true);
    expect(reasoningExhausted(reply({ content: "partial" }))).toBe(false);
    expect(reasoningExhausted(reply({ content: null }, "stop"))).toBe(false);
    expect(
      reasoningExhausted(reply({ content: null, tool_calls: [{ id: "t", type: "function" }] })),
    ).toBe(false);
  });
});

describe("default route on a reasoning-mandatory model", () => {
  it("a small explicit cap gets the lowest effort and an answer; the cap is not raised", async () => {
    const resp = await post("/v1/chat/completions", ask({ max_tokens: 200 }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { choices: { message: { content: string } }[] };
    expect(data.choices[0]!.message.content).toBe("answer");
    expect(sent).toHaveLength(1);
    // OpenRouter's built-in default is Gemini 3.1 Pro (reasoning-mandatory).
    expect(sent[0]).toMatchObject({
      model: "google/gemini-3.1-pro-preview",
      max_tokens: 200,
      reasoning_effort: "low",
    });
  });

  it("an operator-pinned Claude 5.5 on OpenRouter gets the same treatment", async () => {
    process.env.MARINA_DEFAULT_OPENROUTER_MODEL = "anthropic/claude-opus-5.5";
    const resp = await post("/v1/chat/completions", ask({ max_tokens: 200 }));
    expect(resp.status).toBe(200);
    expect(sent[0]).toMatchObject({
      model: "anthropic/claude-opus-5.5",
      max_tokens: 200,
      reasoning_effort: "low",
    });
  });

  it("no cap: the model keeps its default effort", async () => {
    const resp = await post("/v1/chat/completions", ask());
    expect(resp.status).toBe(200);
    expect(sent[0]).not.toHaveProperty("reasoning_effort");
    expect(sent[0]).not.toHaveProperty("max_tokens");
  });

  it("a cap reasoning fills is a coded 400, never an empty 200", async () => {
    const resp = await post("/v1/chat/completions", ask({ max_tokens: 16 }));
    expect(sent[0]).toMatchObject({ max_tokens: 16, reasoning_effort: "low" });
    expect(resp.status).toBe(400);
    const data = (await resp.json()) as {
      error: { code: string; param: string; message: string };
      usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
    };
    expect(data.error.code).toBe(REASONING_EXHAUSTED_CODE);
    expect(data.error.param).toBe("max_tokens");
    expect(data.error.message).toContain("Raise max_tokens");
    // What the caller was billed for still comes back.
    expect(data.usage?.completion_tokens_details?.reasoning_tokens).toBe(16);
  });

  it("an explicitly named model is not reshaped, and its exhausted reply is still coded", async () => {
    const resp = await post(
      "/v1/chat/completions",
      ask({ model: "openrouter/anthropic/claude-opus-5.5", max_completion_tokens: 64 }),
    );
    expect(sent[0]).not.toHaveProperty("reasoning_effort");
    expect(sent[0]).toMatchObject({ max_completion_tokens: 64 });
    expect(resp.status).toBe(400);
    const data = (await resp.json()) as { error: { code: string; param: string } };
    expect(data.error).toMatchObject({
      code: REASONING_EXHAUSTED_CODE,
      param: "max_completion_tokens",
    });
  });

  it("a streamed reply that reasoning exhausted ends with a coded error frame before [DONE]", async () => {
    const resp = await post("/v1/chat/completions", ask({ max_tokens: 16, stream: true }));
    expect(resp.status).toBe(200);
    const text = await resp.text();
    const frames = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    expect(frames.at(-1)).toBe("[DONE]");
    const error = JSON.parse(frames.at(-2)!) as { error?: { code?: string } };
    expect(error.error?.code).toBe(REASONING_EXHAUSTED_CODE);
  });

  it("a streamed reply with an answer passes through unchanged", async () => {
    const resp = await post("/v1/chat/completions", ask({ max_tokens: 200, stream: true }));
    const text = await resp.text();
    expect(text).toContain('"content":"answer"');
    expect(text).not.toContain(REASONING_EXHAUSTED_CODE);
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("/v1/responses keeps the code, named by its own cap field", async () => {
    const resp = await post("/v1/responses", {
      model: "marina/default",
      input: "Classify: yes or no?",
      max_output_tokens: 16,
    });
    expect(resp.status).toBe(400);
    const data = (await resp.json()) as { error: { code: string; param: string; message: string } };
    expect(data.error.code).toBe(REASONING_EXHAUSTED_CODE);
    expect(data.error.param).toBe("max_output_tokens");
    expect(data.error.message).toContain("max_output_tokens");
  });

  it("/v1/responses streaming ends in response.failed with the code", async () => {
    const resp = await post("/v1/responses", {
      model: "marina/default",
      input: "Classify: yes or no?",
      max_output_tokens: 16,
      stream: true,
    });
    const text = await resp.text();
    expect(text).toContain("response.failed");
    expect(text).toContain(REASONING_EXHAUSTED_CODE);
    expect(text).not.toContain("response.completed");
  });
});

describe("Anthropic and OpenAI models go through their own keys", () => {
  const opus = { direct: "claude-opus-5-5", openrouter: "anthropic/claude-opus-5.5" };

  it("OpenRouter's built-in default is not an Anthropic or OpenAI model", () => {
    const model = getDefaultUpstreamModel("OPENROUTER_API_KEY", {});
    expect(model).toBe("google/gemini-3.1-pro-preview");
    expect(model).not.toMatch(/^(anthropic|openai)\//);
  });

  it("vendorModelSpec: direct key first, OpenRouter only as the fallback", () => {
    expect(
      vendorModelSpec("anthropic", opus, { ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "o" }),
    ).toBe("anthropic/claude-opus-5-5");
    expect(vendorModelSpec("anthropic", opus, { OPENROUTER_API_KEY: "o" })).toBe(
      "openrouter/anthropic/claude-opus-5.5",
    );
    expect(vendorModelSpec("anthropic", opus, { OPENAI_API_KEY: "x" })).toBeUndefined();
  });

  it("forecast analysts, the arena proposer and the classifier follow the rule", () => {
    expect(defaultAnalystSpecs({ OPENROUTER_API_KEY: "o" })).toEqual(DEFAULT_ANALYSTS);
    expect(
      defaultAnalystSpecs({ OPENROUTER_API_KEY: "o", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "x" }),
    ).toEqual([
      "anthropic/claude-fable-5-1",
      "openai/gpt-6-astra",
      "openrouter/google/gemini-3.1-pro-preview",
    ]);
    expect(proposerModel({ ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "o" })).toBe(
      "anthropic/claude-opus-5-5",
    );
    expect(proposerModel({ OPENROUTER_API_KEY: "o" })).toBe("openrouter/anthropic/claude-opus-5.5");
    expect(defaultClassifierModel("https://openrouter.ai/api/v1")).toBe(
      "google/gemini-3.1-pro-preview",
    );
    expect(DEFAULT_OPENROUTER_SEARCH_MODEL).toBe("google/gemini-3.1-pro-preview");
    // The search carrier fits a mandatory reasoner's lowest effort.
    expect(openRouterSearchCarrier(DEFAULT_OPENROUTER_SEARCH_MODEL)).toEqual({
      max_tokens: 1024,
      reasoning: { effort: "low" },
    });
    expect(openRouterSearchCarrier("google/gemini-3.1-flash-lite")).toEqual({
      max_tokens: 16,
      reasoning: { effort: "minimal" },
    });
  });
});

describe("provider probe on a reasoning-mandatory default", () => {
  it("passes: the probe's cap fits the reasoning and asks for the lowest effort", async () => {
    const [result] = await probeConfiguredProviders(engine, { timeoutMs: 5_000 });
    expect(result).toMatchObject({
      provider: "openrouter",
      model: "google/gemini-3.1-pro-preview",
      ok: true,
      textOk: true,
      systemHonored: true,
    });
    expect(sent[0]).toMatchObject({
      max_tokens: PROVIDER_PROBE_MAX_TOKENS,
      reasoning_effort: "low",
    });
  });

  it("reports an exhausted reply as a failure with the reason, not an empty pass/fail", async () => {
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return mandatoryReasoningUpstream({ ...body, max_tokens: 8 });
    }) as typeof fetch;
    const [result] = await probeConfiguredProviders(engine, { timeoutMs: 5_000 });
    expect(result!.ok).toBe(false);
    expect(result!.status).toBe(400);
    expect(result!.error).toContain("reasoning");
  });
});
