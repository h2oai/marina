// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Integration tests for the coordination-proxy bridge wired into the model API:
//   - POST /v1/messages (Anthropic Messages inbound) — auth + Anthropic shape
//   - passthru identity + shared-world context injection (opt-in, NO-OP by default)
//   - MODEL_API_KEYS "secret:entity" binding → per-identity trace attribution

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { handleModelApi } from "../src/net/model-api";
import { setEndpointConfig } from "../src/net/model-endpoint";
import { MarinaDB } from "../src/persistence/database";
import { type EngineEvent, roomId } from "../src/types";
import { cleanupDb, makeTestRoom } from "./helpers";

const TEST_DB = "test_proxy_bridge.db";

const PROVIDER_ENV_KEYS = [
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
] as const;

function makeRequest(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): [URL, string, Request] {
  const url = new URL(`http://localhost:3300${path}`);
  const req = new Request(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return [url, "POST", req];
}

const OPENAI_COMPLETION = {
  id: "chatcmpl-xyz",
  object: "chat.completion",
  model: "gpt-4o",
  choices: [
    { index: 0, message: { role: "assistant", content: "upstream answer" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
};

describe("proxy bridge (model API integration)", () => {
  let db: MarinaDB;
  let engine: Engine;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    // Snapshot & clear env that steers auth + upstream selection.
    for (const k of [...PROVIDER_ENV_KEYS, "MODEL_API_KEYS", "MARINA_OPEN_API"]) {
      savedEnv.set(k, process.env[k]);
      delete process.env[k];
    }
  });

  afterEach(() => {
    db.close();
    cleanupDb(TEST_DB);
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    savedEnv.clear();
  });

  /** Run `fn` with a stubbed OpenAI upstream; records each forwarded request body. */
  async function withUpstream<T>(
    responder: () => Response,
    fn: (forwarded: () => Record<string, unknown>[]) => Promise<T>,
  ): Promise<T> {
    const originalFetch = globalThis.fetch;
    process.env.OPENAI_API_KEY = "test-key";
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      if (init?.body) {
        try {
          bodies.push(JSON.parse(init.body as string));
        } catch {
          /* non-JSON body — ignore */
        }
      }
      return responder();
    }) as typeof fetch;
    try {
      return await fn(() => bodies);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  function completionResponse(): Response {
    return new Response(JSON.stringify(OPENAI_COMPLETION), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  function lifecycleEvents(): Extract<EngineEvent, { type: "model_request_lifecycle" }>[] {
    return engine
      .getEventLog()
      .filter(
        (e): e is Extract<EngineEvent, { type: "model_request_lifecycle" }> =>
          e.type === "model_request_lifecycle",
      );
  }

  // ─── Auth: /v1/messages fails closed ────────────────────────────────────────

  it("POST /v1/messages returns 401 without a valid key (secure-by-default)", async () => {
    process.env.MODEL_API_KEYS = "sk-secret";
    const [url, method, req] = makeRequest("/v1/messages", {
      model: "claude-x",
      messages: [{ role: "user", content: "hi" }],
    });
    const resp = await handleModelApi(url, method, req, engine);
    expect(resp!.status).toBe(401);
  });

  it("POST /v1/messages accepts a valid key and returns an Anthropic-shaped message", async () => {
    process.env.MODEL_API_KEYS = "sk-secret";
    setEndpointConfig(db, { mode: "passthru", passthruModel: "openai/gpt-4o" });
    const resp = await withUpstream(completionResponse, async () => {
      const [url, method, req] = makeRequest(
        "/v1/messages",
        { model: "claude-x", messages: [{ role: "user", content: "hi" }] },
        { Authorization: "Bearer sk-secret" },
      );
      return (await handleModelApi(url, method, req, engine))!;
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      type: string;
      role: string;
      content: { type: string; text: string }[];
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content[0]).toEqual({ type: "text", text: "upstream answer" });
    expect(body.usage).toEqual({ input_tokens: 9, output_tokens: 2 });
  });

  // ─── Injection is a strict NO-OP by default ─────────────────────────────────

  it("passthru with X-Marina-Context off is byte-identical (no injection, no memory writes)", async () => {
    process.env.MARINA_OPEN_API = "true";
    setEndpointConfig(db, { mode: "passthru", passthruModel: "openai/gpt-4o" });

    const inputMessages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "quantum widget calibration status" },
    ];
    const forwarded = await withUpstream(completionResponse, async (getBodies) => {
      const [url, method, req] = makeRequest(
        "/v1/chat/completions",
        { model: "marina", messages: inputMessages },
        { "X-Marina-Context": "off" },
      );
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(200);
      return getBodies();
    });

    // Forwarded body carries exactly the caller's messages — no injected system.
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.messages).toEqual(inputMessages);

    // No passthru identity was resolved, so no entity and no notes were created.
    expect(engine.entities.findAgentByName("passthru")).toBeUndefined();
    const traces = lifecycleEvents();
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.every((t) => t.entityId === undefined)).toBe(true);
  });

  // ─── Opt-in: bound key + context on → injected shared-world context ──────────

  it("bound key + X-Marina-Context on injects the caller's own shared context", async () => {
    process.env.MODEL_API_KEYS = "sk-alice:Alice";
    setEndpointConfig(db, { mode: "passthru", passthruModel: "openai/gpt-4o" });

    // Establish the bound entity, then seed a note it owns.
    engine.entities.create({
      kind: "agent",
      name: "Alice",
      short: "Alice",
      long: "bound caller",
      room: engine.config.startRoom,
      properties: {},
    });
    db.createNote("Alice", "quantum widget calibration is my ongoing project", undefined, {
      importance: 6,
    });

    const forwarded = await withUpstream(completionResponse, async (getBodies) => {
      const [url, method, req] = makeRequest(
        "/v1/chat/completions",
        {
          model: "marina",
          messages: [{ role: "user", content: "tell me about the quantum widget" }],
        },
        { Authorization: "Bearer sk-alice", "X-Marina-Context": "on" },
      );
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(200);
      return getBodies();
    });

    expect(forwarded).toHaveLength(1);
    const messages = forwarded[0]!.messages as { role: string; content: string }[];
    const system = messages.find((m) => m.role === "system");
    expect(system).toBeDefined();
    // Shared-world context marker + the entity's own note surface in the system message.
    expect(system!.content).toContain("[marina:shared-world-context]");
    expect(system!.content).toContain("calibration");

    // The request is attributed to Alice in the trace.
    const alice = engine.entities.findAgentByName("Alice")!;
    const completed = lifecycleEvents().find((t) => t.phase === "completed");
    expect(completed?.entityId).toBe(alice.id);
  });

  // ─── "secret:entity" parsing maps to the entity ─────────────────────────────

  it("a secret:entity MODEL_API_KEYS entry authenticates and maps the caller to that entity", async () => {
    process.env.MODEL_API_KEYS = "sk-bob:Bob";
    setEndpointConfig(db, { mode: "passthru", passthruModel: "openai/gpt-4o" });

    await withUpstream(completionResponse, async () => {
      const [url, method, req] = makeRequest(
        "/v1/chat/completions",
        { model: "marina", messages: [{ role: "user", content: "ping" }] },
        // Context on ensures identity resolution runs (and stays write-safe otherwise).
        { Authorization: "Bearer sk-bob", "X-Marina-Context": "on" },
      );
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(200);
    });

    // The bound entity was resolved/created and tagged onto the trace.
    const bob = engine.entities.findAgentByName("Bob");
    expect(bob).toBeDefined();
    const completed = lifecycleEvents().find((t) => t.phase === "completed");
    expect(completed?.entityId).toBe(bob!.id);
  });
});
