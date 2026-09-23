// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { ChannelManager } from "../src/coordination/channel-manager";
import { Engine } from "../src/engine/engine";
import { projectTraces } from "../src/engine/trace-projection";
import { getActiveAliases } from "../src/net/compat-profiles";
import { MEMORY_RECEIPT_HEADER, parseMemoryReceipt } from "../src/net/memory-receipt";
import {
  extractStrategy,
  handleModelApi,
  pendingRequests,
  prepareLlamaBody,
  prepareUpstreamBody,
  roundRobinCounters,
  scheduleRequestReminders,
  selectAgent,
  stripCacheControl,
  tryVerifiedArithmetic,
} from "../src/net/model-api";
import { setEndpointConfig } from "../src/net/model-endpoint";
import { INJECTION_MARKER, resetPassthruCaptureDedupForTests } from "../src/net/passthru-context";
import { MarinaDB } from "../src/persistence/database";
import { type EngineEvent, roomId } from "../src/types";
import { FIXTURE_QUERY, seedUnifiedFixture } from "./fixtures/unified-memory-fixture";
import { cleanupDb, MockConnection, makeTestRoom } from "./helpers";

const TEST_DB = "test_model_api.db";

function makeRequest(
  path: string,
  method: string,
  body?: unknown,
  headers?: Record<string, string>,
): [URL, string, Request] {
  const url = new URL(`http://localhost:3300${path}`);
  const req = new Request(url.toString(), {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return [url, method, req];
}

/** Helper to collect all text from a ReadableStream */
async function collectStream(resp: Response): Promise<string> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

/** Simulate an agent that responds to model_request with streaming chunks */
function setupStreamingAgent(
  cm: ChannelManager,
  entityId: string,
  entityName: string,
  chunks: string[],
): void {
  cm.onMessage((channelId, senderId, _senderName, content) => {
    if (senderId === "__model_api__") {
      try {
        const parsed = JSON.parse(content);
        if (parsed.type === "model_request") {
          for (const chunk of chunks) {
            cm.send(
              channelId,
              entityId,
              entityName,
              JSON.stringify({
                type: "model_response_chunk",
                id: parsed.id,
                content: chunk,
              }),
            );
          }
          cm.send(
            channelId,
            entityId,
            entityName,
            JSON.stringify({ type: "model_response_end", id: parsed.id }),
          );
        }
      } catch {}
    }
  });
}

/** Simulate an agent that responds to model_request with a single model_response */
function setupPhase1Agent(
  cm: ChannelManager,
  entityId: string,
  entityName: string,
  response: string,
): void {
  cm.onMessage((channelId, senderId, _senderName, content) => {
    if (senderId === "__model_api__") {
      try {
        const parsed = JSON.parse(content);
        if (parsed.type === "model_request") {
          cm.send(
            channelId,
            entityId,
            entityName,
            JSON.stringify({
              type: "model_response",
              id: parsed.id,
              content: response,
            }),
          );
        }
      } catch {}
    }
  });
}

describe("Model API", () => {
  let db: MarinaDB;
  let engine: Engine;
  let conn1: MockConnection;
  let cm: ChannelManager;

  beforeEach(() => {
    // Enable open API mode for tests (no auth required)
    process.env.MARINA_OPEN_API = "true";

    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));

    conn1 = new MockConnection("c1");
    engine.addConnection(conn1);
    engine.spawnEntity("c1", "Agent1");
    conn1.clear();

    cm = engine.channelManager!;

    // Clear load balancing state between tests
    roundRobinCounters.clear();
    pendingRequests.clear();
  });

  afterEach(() => {
    delete process.env.MARINA_OPEN_API;
    delete process.env.MODEL_API_KEYS;
    db.close();
    cleanupDb(TEST_DB);
  });

  it("GET /v1/models always lists the default marina model (with compat-profile aliases)", async () => {
    const [url, method, req] = makeRequest("/v1/models", "GET");
    const resp = await handleModelApi(url, method, req, engine);
    expect(resp).toBeDefined();
    const data = await resp!.json();
    expect(data.object).toBe("list");
    // Default model + every alias from active compat profiles
    const aliases = getActiveAliases();
    expect(data.data).toHaveLength(1 + aliases.length);
    const ids = data.data.map((m: { id: string }) => m.id);
    expect(ids).toContain("marina");
    for (const alias of aliases) expect(ids).toContain(alias);
    expect(data.data[0].owned_by).toBe("marina");
  });

  it("serves explicit binary arithmetic through the verified fast path", async () => {
    const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
      model: "marina:answerer",
      messages: [{ role: "user", content: "What is 19 multiplied by 37? Reply briefly." }],
    });
    const resp = await handleModelApi(url, method, req, engine);
    expect(resp?.status).toBe(200);
    const data = await resp!.json();
    expect(data.choices[0].message.content).toContain("703");
    const lifecycle = engine
      .getEventLog()
      .filter((event) => event.type === "model_request_lifecycle");
    expect(lifecycle.map((event) => event.phase)).toEqual(["received", "fast_path", "completed"]);
    expect(new Set(lifecycle.map((event) => event.runId)).size).toBe(1);
    expect(new Set(lifecycle.map((event) => event.traceId)).size).toBe(1);
    expect(new Set(lifecycle.map((event) => event.spanId)).size).toBe(1);
  });

  it("GET /v1/models lists channels matching model* pattern", async () => {
    engine.processCommand(conn1.entity!, "channel join model");
    const [url, method, req] = makeRequest("/v1/models", "GET");
    const resp = await handleModelApi(url, method, req, engine);
    const data = await resp!.json();
    expect(data.data.length).toBeGreaterThanOrEqual(1);
    expect(data.data[0].id).toBe("marina");
    expect(data.data[0].owned_by).toBe("marina");
  });

  it("GET /v1/models hides marina:<name> subroutes with no online agents", async () => {
    // Simulates the latent-capability case: a seed creates a model-council channel
    // but no agent subscribes. The endpoint would 503 on request, so it shouldn't
    // appear in the catalog. The default "model" channel always stays visible
    // because it has the direct upstream proxy fallback.
    cm.createChannel({ type: "model", name: "model-council", retentionHours: 24 });
    const [url, method, req] = makeRequest("/v1/models", "GET");
    const resp = await handleModelApi(url, method, req, engine);
    const data = await resp!.json();
    const ids = data.data.map((m: { id: string }) => m.id);
    expect(ids).toContain("marina");
    expect(ids).not.toContain("marina:council");
  });

  it("GET /api/tags returns Ollama format model list", async () => {
    engine.processCommand(conn1.entity!, "channel join model");
    const [url, method, req] = makeRequest("/api/tags", "GET");
    const resp = await handleModelApi(url, method, req, engine);
    const data = await resp!.json();
    expect(data.models).toBeDefined();
    expect(data.models[0].name).toBe("marina");
  });

  it("POST /v1/chat/completions returns 404 for unknown model variant", async () => {
    const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
      model: "marina:nonexistent",
      messages: [{ role: "user", content: "hello" }],
    });
    const resp = await handleModelApi(url, method, req, engine);
    expect(resp!.status).toBe(404);
  });

  it("POST /v1/chat/completions returns 503 when no agents online and no upstream keys", async () => {
    // Create channel but remove the agent's connection
    engine.processCommand(conn1.entity!, "channel join model");
    engine.removeConnection("c1");

    // Clear upstream API keys so proxy fallback also returns 503
    const savedKeys: Record<string, string | undefined> = {};
    for (const k of [
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "OPENROUTER_API_KEY",
      "GROQ_API_KEY",
      "ANTHROPIC_API_KEY",
    ]) {
      savedKeys[k] = process.env[k];
      delete process.env[k];
    }

    try {
      const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
        model: "marina",
        messages: [{ role: "user", content: "hello" }],
      });
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(503);
    } finally {
      // Restore keys
      for (const [k, v] of Object.entries(savedKeys)) {
        process.env[k] = v;
      }
    }
  });

  it("POST /v1/chat/completions routes through channel and gets JSON response", async () => {
    engine.processCommand(conn1.entity!, "channel join model");
    setupPhase1Agent(cm, conn1.entity!, "Agent1", "Hello from Marina!");

    const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
      model: "marina",
      messages: [{ role: "user", content: "hello" }],
    });
    const resp = await handleModelApi(url, method, req, engine);
    expect(resp!.status).toBe(200);
    const data = await resp!.json();
    expect(data.choices[0].message.content).toBe("Hello from Marina!");
    expect(data.model).toBe("marina");
  });

  it("POST /v1/chat/completions accepts plaintext bracket response", async () => {
    engine.processCommand(conn1.entity!, "channel join model");

    cm.onMessage((channelId, senderId, _senderName, content) => {
      if (senderId === "__model_api__") {
        try {
          const parsed = JSON.parse(content);
          if (parsed.type === "model_request") {
            // Human player responds with bracket format
            cm.send(channelId, conn1.entity!, "Agent1", `[${parsed.id}] Hi there!`);
          }
        } catch {}
      }
    });

    const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
      model: "marina",
      messages: [{ role: "user", content: "hello" }],
    });
    const resp = await handleModelApi(url, method, req, engine);
    expect(resp!.status).toBe(200);
    const data = await resp!.json();
    expect(data.choices[0].message.content).toBe("Hi there!");
  });

  it("POST /api/chat routes in Ollama format", async () => {
    engine.processCommand(conn1.entity!, "channel join model");
    setupPhase1Agent(cm, conn1.entity!, "Agent1", "Ollama response");

    const [url, method, req] = makeRequest("/api/chat", "POST", {
      model: "marina",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });
    const resp = await handleModelApi(url, method, req, engine);
    expect(resp!.status).toBe(200);
    const data = await resp!.json();
    expect(data.message.content).toBe("Ollama response");
    expect(data.done).toBe(true);
  });

  it("POST /api/generate routes single prompt in Ollama format", async () => {
    engine.processCommand(conn1.entity!, "channel join model");
    setupPhase1Agent(cm, conn1.entity!, "Agent1", "Generated text");

    const [url, method, req] = makeRequest("/api/generate", "POST", {
      model: "marina",
      prompt: "Tell me a story",
      stream: false,
    });
    const resp = await handleModelApi(url, method, req, engine);
    expect(resp!.status).toBe(200);
    const data = await resp!.json();
    expect(data.response).toBe("Generated text");
    expect(data.done).toBe(true);
  });

  it("model ID marina:scholar maps to channel model-scholar", async () => {
    engine.processCommand(conn1.entity!, "channel create model-scholar");
    setupPhase1Agent(cm, conn1.entity!, "Agent1", "Scholar response");

    const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
      model: "marina:scholar",
      messages: [{ role: "user", content: "hello" }],
    });
    const resp = await handleModelApi(url, method, req, engine);
    expect(resp!.status).toBe(200);
    const data = await resp!.json();
    expect(data.choices[0].message.content).toBe("Scholar response");
  });

  it("returns undefined for unmatched routes", async () => {
    const [url, method, req] = makeRequest("/v1/unknown", "GET");
    const resp = await handleModelApi(url, method, req, engine);
    expect(resp).toBeUndefined();
  });

  it("channel onMessage listener can be unsubscribed", () => {
    let callCount = 0;
    const unsub = cm.onMessage(() => {
      callCount++;
    });

    engine.processCommand(conn1.entity!, "channel create testchan");
    engine.processCommand(conn1.entity!, "channel send testchan hello");
    expect(callCount).toBe(1);

    unsub();
    engine.processCommand(conn1.entity!, "channel send testchan world");
    expect(callCount).toBe(1);
  });

  it("pending-request reminders re-post the request and cancel cleanly", async () => {
    engine.processCommand(conn1.entity!, "channel create remindchan");
    const channel = cm.getChannelByName("remindchan")!;
    const seen: { reminder?: boolean; id?: string; content?: string }[] = [];
    cm.onMessage((channelId, senderId, _n, content) => {
      if (channelId !== channel.id || senderId !== "__model_api__") return;
      try {
        seen.push(JSON.parse(content));
      } catch {}
    });

    // Fast timeout: reminders fire at 25% (50ms) and 60% (120ms) of 200ms.
    const cancel = scheduleRequestReminders(
      cm,
      channel.id,
      "req-test1234",
      "e_target",
      "What is 2+2?",
      200,
    );
    await new Promise((r) => setTimeout(r, 90));
    expect(seen.length).toBe(1);
    expect(seen[0]!.reminder).toBe(true);
    expect(seen[0]!.id).toBe("req-test1234");
    expect(seen[0]!.content).toContain("model_response");
    expect(seen[0]!.content).toContain("What is 2+2?");

    // Cancel before the second reminder — no further posts.
    cancel();
    await new Promise((r) => setTimeout(r, 120));
    expect(seen.length).toBe(1);
  });

  it("an agent that only reacts to the reminder still completes the request", async () => {
    engine.processCommand(conn1.entity!, "channel join model");
    // This agent ignores the original request and answers ONLY reminder posts —
    // the coordinator-drift scenario the backstop exists for.
    cm.onMessage((channelId, senderId, _senderName, content) => {
      if (senderId !== "__model_api__") return;
      try {
        const parsed = JSON.parse(content);
        if (parsed.type === "model_request" && parsed.reminder === true) {
          cm.send(
            channelId,
            conn1.entity!,
            "Agent1",
            JSON.stringify({ type: "model_response", id: parsed.id, content: "42 (late)" }),
          );
        }
      } catch {}
    });
    // Directly drive the reminder scheduler against the live model channel at
    // test speed; the routed waiter uses the module-level 600s timeout, so we
    // verify the reroute mechanics rather than wait minutes.
    const channel = cm.getChannelByName("model")!;
    let answered: string | undefined;
    cm.onMessage((channelId, senderId, _n, content) => {
      if (channelId !== channel.id || senderId === "__model_api__") return;
      try {
        const parsed = JSON.parse(content);
        if (parsed.type === "model_response" && parsed.id === "req-late42") {
          answered = parsed.content;
        }
      } catch {}
    });
    const cancel = scheduleRequestReminders(
      cm,
      channel.id,
      "req-late42",
      conn1.entity!,
      "meaning of everything?",
      100,
    );
    await new Promise((r) => setTimeout(r, 80));
    cancel();
    expect(answered).toBe("42 (late)");
  });

  // --- Compatibility tests ---

  it("error responses use OpenAI nested format", async () => {
    const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
      model: "marina:nonexistent",
      messages: [{ role: "user", content: "hello" }],
    });
    const resp = await handleModelApi(url, method, req, engine);
    expect(resp!.status).toBe(404);
    const data = await resp!.json();
    expect(data.error).toBeDefined();
    expect(data.error.message).toContain("not found");
    expect(data.error.type).toBe("not_found_error");
    expect(data.error.param).toBeNull();
    // `code` is a string OpenAI SDKs branch on (see src/net/openai-errors.ts).
    expect(data.error.code).toBe("model_not_found");
  });

  it("responses include x-request-id header", async () => {
    const [url, method, req] = makeRequest("/v1/models", "GET");
    const resp = await handleModelApi(url, method, req, engine);
    expect(resp!.headers.get("x-request-id")).toBeDefined();
    expect(resp!.headers.get("x-request-id")!.startsWith("req-")).toBe(true);
  });

  // --- Streaming tests ---

  it("streaming: OpenAI SSE format with model_response_chunk + model_response_end", async () => {
    engine.processCommand(conn1.entity!, "channel join model");
    setupStreamingAgent(cm, conn1.entity!, "Agent1", ["Hello", " world", "!"]);

    const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
      model: "marina",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    const resp = await handleModelApi(url, method, req, engine);
    expect(resp!.headers.get("Content-Type")).toBe("text/event-stream");
    const requestId = resp!.headers.get("x-request-id") ?? undefined;
    expect(requestId).toStartWith("req-");

    const text = await collectStream(resp!);
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
    // 1 role chunk + 3 content chunks + 1 stop + 1 [DONE]
    expect(dataLines.length).toBe(6);

    // Role-only first chunk (required by OpenAI SDK)
    const role = JSON.parse(dataLines[0]!.slice(6));
    expect(role.choices[0].delta.role).toBe("assistant");
    expect(role.object).toBe("chat.completion.chunk");

    // Content chunks
    const first = JSON.parse(dataLines[1]!.slice(6));
    expect(first.choices[0].delta.content).toBe("Hello");

    const second = JSON.parse(dataLines[2]!.slice(6));
    expect(second.choices[0].delta.content).toBe(" world");

    const third = JSON.parse(dataLines[3]!.slice(6));
    expect(third.choices[0].delta.content).toBe("!");

    // Stop chunk
    const stop = JSON.parse(dataLines[4]!.slice(6));
    expect(stop.choices[0].finish_reason).toBe("stop");
    expect(stop.choices[0].delta).toEqual({});

    // [DONE]
    expect(dataLines[5]).toBe("data: [DONE]");

    const lifecycle = engine
      .getEventLog()
      .filter((event) => event.type === "model_request_lifecycle");
    expect(lifecycle.map((event) => event.phase)).toEqual(["received", "routed", "completed"]);
    expect(new Set(lifecycle.map((event) => event.traceId)).size).toBe(1);
    expect(lifecycle[0]?.traceId).toBe(lifecycle[0]?.requestId);
    expect(lifecycle[0]?.requestId).toBe(requestId);
    expect(lifecycle.find((event) => event.phase === "routed")).toMatchObject({
      routeStrategy: "round-robin",
      candidateCount: 1,
    });
  });

  it("streaming: Ollama chunked JSON lines format", async () => {
    engine.processCommand(conn1.entity!, "channel join model");
    setupStreamingAgent(cm, conn1.entity!, "Agent1", ["Hello", " world"]);

    const [url, method, req] = makeRequest("/api/chat", "POST", {
      model: "marina",
      messages: [{ role: "user", content: "hello" }],
    });
    const resp = await handleModelApi(url, method, req, engine);
    expect(resp!.headers.get("Content-Type")).toBe("application/x-ndjson");
    const requestId = resp!.headers.get("x-request-id");
    expect(requestId).toStartWith("req-");

    const text = await collectStream(resp!);
    const lines = text.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(3); // 2 chunks + 1 done

    const chunk1 = JSON.parse(lines[0]!);
    expect(chunk1.message.content).toBe("Hello");
    expect(chunk1.done).toBe(false);

    const chunk2 = JSON.parse(lines[1]!);
    expect(chunk2.message.content).toBe(" world");
    expect(chunk2.done).toBe(false);

    const end = JSON.parse(lines[2]!);
    expect(end.done).toBe(true);

    // The streaming Ollama path returns the traced request identity, same as
    // the non-streaming routes — the id for `trace show <id>`.
    const lifecycle = engine
      .getEventLog()
      .filter((event) => event.type === "model_request_lifecycle");
    expect(lifecycle.map((event) => event.phase)).toEqual(["received", "routed", "completed"]);
    expect(lifecycle[0]?.traceId).toBe(requestId!);
    expect(lifecycle[0]?.requestId).toBe(requestId!);
  });

  it("streaming: fallback when agent sends single model_response (Phase 1 compat)", async () => {
    engine.processCommand(conn1.entity!, "channel join model");
    // Phase 1 agent: responds with model_response, not chunks
    setupPhase1Agent(cm, conn1.entity!, "Agent1", "Complete response");

    const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
      model: "marina",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    const resp = await handleModelApi(url, method, req, engine);
    expect(resp!.headers.get("Content-Type")).toBe("text/event-stream");

    const text = await collectStream(resp!);
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
    // 1 role chunk + 1 content chunk + 1 stop chunk + [DONE]
    expect(dataLines.length).toBe(4);

    // Role chunk
    const role = JSON.parse(dataLines[0]!.slice(6));
    expect(role.choices[0].delta.role).toBe("assistant");

    const chunk = JSON.parse(dataLines[1]!.slice(6));
    expect(chunk.choices[0].delta.content).toBe("Complete response");

    const stop = JSON.parse(dataLines[2]!.slice(6));
    expect(stop.choices[0].finish_reason).toBe("stop");

    expect(dataLines[3]).toBe("data: [DONE]");
  });

  it.each(["chunks", "single", "dispatch-error"] as const)(
    "streaming: synchronous %s settles without leaving pending request timers",
    async (mode) => {
      engine.processCommand(conn1.entity!, "channel join model");
      if (mode === "chunks") setupStreamingAgent(cm, conn1.entity!, "Agent1", ["done"]);
      else setupPhase1Agent(cm, conn1.entity!, "Agent1", "done");
      const dispatch =
        mode === "dispatch-error"
          ? spyOn(cm, "send").mockImplementation(() => {
              throw new Error("Dispatch unavailable");
            })
          : undefined;
      const scheduled = spyOn(globalThis, "setTimeout");
      const cancelled = spyOn(globalThis, "clearTimeout");
      try {
        const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
          model: "marina",
          messages: [{ role: "user", content: "finish immediately" }],
          stream: true,
        });
        const response = await handleModelApi(url, method, req, engine);
        if (mode === "dispatch-error") expect(response!.status).toBe(500);
        else expect(await collectStream(response!)).toContain("done");
        expect(pendingRequests.get(conn1.entity!)).toBeUndefined();
        const handles = scheduled.mock.results.map((result) => result.value);
        expect(handles.length).toBeGreaterThan(0);
        for (const handle of handles) expect(cancelled).toHaveBeenCalledWith(handle);
      } finally {
        // Keep a failing regression from leaking its long-lived timers too.
        for (const result of scheduled.mock.results)
          if (result.type === "return") clearTimeout(result.value as ReturnType<typeof setTimeout>);
        scheduled.mockRestore();
        cancelled.mockRestore();
        dispatch?.mockRestore();
      }
    },
  );

  it("streaming: cancellation closes the trace exactly once", async () => {
    engine.processCommand(conn1.entity!, "channel join model");

    const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
      model: "marina",
      messages: [{ role: "user", content: "wait for cancellation" }],
      stream: true,
    });
    const resp = await handleModelApi(url, method, req, engine);
    const requestId = resp!.headers.get("x-request-id") ?? undefined;
    await resp!.body!.cancel();

    const lifecycle = engine
      .getEventLog()
      .filter((event) => event.type === "model_request_lifecycle")
      .filter((event) => event.requestId === requestId);
    expect(lifecycle.map((event) => event.phase)).toEqual(["received", "routed", "failed"]);
    expect(lifecycle.filter((event) => event.phase === "failed")).toHaveLength(1);
    expect(lifecycle.at(-1)?.detail).toBe("Client disconnected");
  });

  // --- Multi-turn conversation tests ---

  it("multi-turn: first request creates conversation channel", async () => {
    engine.processCommand(conn1.entity!, "channel join model");
    setupPhase1Agent(cm, conn1.entity!, "Agent1", "Response 1");

    const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
      model: "marina",
      messages: [{ role: "user", content: "hello" }],
      conversation_id: "test-conv-1",
    });
    const resp = await handleModelApi(url, method, req, engine);
    expect(resp!.status).toBe(200);
    expect(resp!.headers.get("X-Conversation-Id")).toBe("test-conv-1");

    // Verify conversation channel was created
    const convCh = cm.getChannelByName("model-conv-test-conv-1");
    expect(convCh).toBeDefined();
    expect(convCh!.retentionHours).toBe(24);
  });

  it("multi-turn: second request includes history from first exchange", async () => {
    engine.processCommand(conn1.entity!, "channel join model");

    let capturedPayload: string | undefined;

    // First response
    const unsub1 = cm.onMessage((channelId, senderId, _senderName, content) => {
      if (senderId === "__model_api__") {
        try {
          const parsed = JSON.parse(content);
          if (parsed.type === "model_request") {
            cm.send(
              channelId,
              conn1.entity!,
              "Agent1",
              JSON.stringify({
                type: "model_response",
                id: parsed.id,
                content: "I am Agent1",
              }),
            );
          }
        } catch {}
      }
    });

    const [url1, method1, req1] = makeRequest("/v1/chat/completions", "POST", {
      model: "marina",
      messages: [{ role: "user", content: "Who are you?" }],
      conversation_id: "conv-history",
    });
    await handleModelApi(url1, method1, req1, engine);
    unsub1();

    // Second request — capture the payload to check history
    const unsub2 = cm.onMessage((channelId, senderId, _senderName, content) => {
      if (senderId === "__model_api__") {
        try {
          const parsed = JSON.parse(content);
          if (parsed.type === "model_request" && channelId.includes("model")) {
            capturedPayload = content;
            cm.send(
              channelId,
              conn1.entity!,
              "Agent1",
              JSON.stringify({
                type: "model_response",
                id: parsed.id,
                content: "I already told you",
              }),
            );
          }
        } catch {}
      }
    });

    const [url2, method2, req2] = makeRequest("/v1/chat/completions", "POST", {
      model: "marina",
      messages: [{ role: "user", content: "Tell me again" }],
      conversation_id: "conv-history",
    });
    await handleModelApi(url2, method2, req2, engine);
    unsub2();

    // The second request payload should include history
    expect(capturedPayload).toBeDefined();
    const payload = JSON.parse(capturedPayload!);
    expect(payload.history).toBeDefined();
    expect(payload.history.length).toBeGreaterThanOrEqual(2);
    expect(payload.history[0].role).toBe("user");
    expect(payload.history[1].role).toBe("assistant");
    expect(payload.history[1].content).toBe("I am Agent1");
  });

  it("multi-turn: X-Conversation-Id header returned and reusable", async () => {
    engine.processCommand(conn1.entity!, "channel join model");
    setupPhase1Agent(cm, conn1.entity!, "Agent1", "Response");

    const [url, method, req] = makeRequest(
      "/v1/chat/completions",
      "POST",
      {
        model: "marina",
        messages: [{ role: "user", content: "hello" }],
      },
      { "X-Conversation-Id": "header-conv-1" },
    );
    const resp = await handleModelApi(url, method, req, engine);
    expect(resp!.headers.get("X-Conversation-Id")).toBe("header-conv-1");

    // Verify channel was created
    const convCh = cm.getChannelByName("model-conv-header-conv-1");
    expect(convCh).toBeDefined();
  });

  // --- Load balancing tests ---

  it("load balancing: round-robin alternates between two agents", async () => {
    engine.processCommand(conn1.entity!, "channel join model");

    // Add a second agent
    const conn2 = new MockConnection("c2");
    engine.addConnection(conn2);
    engine.spawnEntity("c2", "Agent2");
    engine.processCommand(conn2.entity!, "channel join model");

    // Track which agents receive requests
    const targets: string[] = [];
    cm.onMessage((channelId, senderId, _senderName, content) => {
      if (senderId === "__model_api__") {
        try {
          const parsed = JSON.parse(content);
          if (parsed.type === "model_request") {
            targets.push(parsed.target);
            cm.send(
              channelId,
              parsed.target,
              "Agent",
              JSON.stringify({
                type: "model_response",
                id: parsed.id,
                content: "ok",
              }),
            );
          }
        } catch {}
      }
    });

    for (let i = 0; i < 4; i++) {
      const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
        model: "marina",
        messages: [{ role: "user", content: `msg ${i}` }],
      });
      await handleModelApi(url, method, req, engine);
    }

    // Should alternate between the two agents
    expect(targets.length).toBe(4);
    expect(targets[0]).not.toBe(targets[1]);
    expect(targets[0]).toBe(targets[2]);
    expect(targets[1]).toBe(targets[3]);
  });

  it("load balancing: least-busy picks agent with fewer pending requests", () => {
    const members = ["agent-a", "agent-b"];
    pendingRequests.set("agent-a", 3);
    pendingRequests.set("agent-b", 1);

    const selected = selectAgent(members, "ch:test", "least-busy");
    expect(selected).toBe("agent-b");
  });

  it("load balancing: single agent always selected", () => {
    const members = ["agent-only"];
    const result1 = selectAgent(members, "ch:test", "round-robin");
    const result2 = selectAgent(members, "ch:test", "least-busy");
    expect(result1).toBe("agent-only");
    expect(result2).toBe("agent-only");
  });

  it("load balancing: adaptive is explicit and records its transparent fallback", async () => {
    engine.processCommand(conn1.entity!, "channel join model");
    cm.onMessage((channelId, senderId, _senderName, content) => {
      if (senderId !== "__model_api__") return;
      const parsed = JSON.parse(content);
      cm.send(
        channelId,
        parsed.target,
        "Agent1",
        JSON.stringify({ type: "model_response", id: parsed.id, content: "ok" }),
      );
    });
    const [url, method, req] = makeRequest(
      "/v1/chat/completions",
      "POST",
      { model: "marina", messages: [{ role: "user", content: "adaptive request" }] },
      { "X-Load-Balance": "adaptive" },
    );
    expect(extractStrategy(req)).toBe("adaptive");
    const response = await handleModelApi(url, method, req, engine);
    expect(response?.status).toBe(200);
    const routed = engine
      .getEventLog()
      .filter((event) => event.type === "model_request_lifecycle" && event.phase === "routed")
      .at(-1);
    expect(routed).toMatchObject({
      routeStrategy: "adaptive",
      routeAdviceMode: "insufficient",
    });
    expect(routed && "routeReason" in routed ? routed.routeReason : "").toContain(
      "fell back to least-busy",
    );
  });

  it("load balancing: adaptive applies pareto advice from observed trace cohorts", async () => {
    engine.processCommand(conn1.entity!, "channel join model");
    const conn2 = new MockConnection("c2");
    engine.addConnection(conn2);
    engine.spawnEntity("c2", "Agent2");
    engine.processCommand(conn2.entity!, "channel join model");

    // Seed two route cohorts into the durable event log (selectRouteTarget
    // reads engine.db.getRecentTraceEvents, which engine.logEvent feeds).
    // Agent2's cohort is nondominated on both terminal success and p50
    // latency, so shadow advice must be pareto with Agent2 as sole candidate.
    const seedTrace = (requestId: string, target: string, durationMs: number, failed = false) => {
      const trace = { runId: requestId, traceId: requestId, spanId: `span-${requestId}` };
      const startedAt = Date.now() - 60_000;
      engine.logEvent({
        type: "model_request_lifecycle",
        phase: "received",
        requestId,
        ...trace,
        model: "marina",
        timestamp: startedAt,
      });
      engine.logEvent({
        type: "model_request_lifecycle",
        phase: failed ? "failed" : "completed",
        requestId,
        ...trace,
        model: "marina",
        target,
        durationMs,
        timestamp: startedAt + durationMs,
      });
    };
    seedTrace("req-slow-01", conn1.entity!, 900);
    seedTrace("req-slow-02", conn1.entity!, 900, true);
    seedTrace("req-fast-01", conn2.entity!, 40);
    seedTrace("req-fast-02", conn2.entity!, 40);

    const targets: string[] = [];
    cm.onMessage((channelId, senderId, _senderName, content) => {
      if (senderId !== "__model_api__") return;
      const parsed = JSON.parse(content);
      if (parsed.type !== "model_request") return;
      targets.push(parsed.target);
      cm.send(
        channelId,
        parsed.target,
        "Agent",
        JSON.stringify({ type: "model_response", id: parsed.id, content: "ok" }),
      );
    });

    const [url, method, req] = makeRequest(
      "/v1/chat/completions",
      "POST",
      { model: "marina", messages: [{ role: "user", content: "route me adaptively" }] },
      { "X-Load-Balance": "adaptive" },
    );
    const resp = await handleModelApi(url, method, req, engine);
    expect(resp?.status).toBe(200);

    // The dominant cohort's agent got the request, not the round-robin pick.
    expect(targets).toEqual([conn2.entity!]);
    const routed = engine
      .getEventLog()
      .filter((event) => event.type === "model_request_lifecycle" && event.phase === "routed")
      .at(-1);
    expect(routed).toMatchObject({
      routeStrategy: "adaptive",
      routeAdviceMode: "pareto",
      target: conn2.entity!,
    });
    expect(routed && "routeReason" in routed ? routed.routeReason : "").toContain(
      "pareto candidate selected from the already-eligible set",
    );
  });

  it("model-conv channels excluded from model listing", async () => {
    engine.processCommand(conn1.entity!, "channel join model");
    // Create a conversation channel manually
    cm.createChannel({ type: "model", name: "model-conv-test123", retentionHours: 24 });

    const [url, method, req] = makeRequest("/v1/models", "GET");
    const resp = await handleModelApi(url, method, req, engine);
    const data = await resp!.json();
    // "marina" + active compat-profile aliases; conversation channel excluded.
    const ids = data.data.map((m: { id: string }) => m.id);
    expect(ids).toContain("marina");
    for (const alias of getActiveAliases()) expect(ids).toContain(alias);
    expect(ids.some((id: string) => id.startsWith("marina:model-conv"))).toBe(false);
  });

  it("request payload includes target and explicit trace context", async () => {
    engine.processCommand(conn1.entity!, "channel join model");

    let capturedTarget: string | undefined;
    let capturedTrace:
      | { runId?: string; traceId?: string; spanId?: string; requestId?: string }
      | undefined;
    cm.onMessage((channelId, senderId, _senderName, content) => {
      if (senderId === "__model_api__") {
        try {
          const parsed = JSON.parse(content);
          if (parsed.type === "model_request") {
            capturedTarget = parsed.target;
            capturedTrace = { ...parsed.trace, requestId: parsed.id };
            cm.send(
              channelId,
              conn1.entity!,
              "Agent1",
              JSON.stringify({
                type: "model_response",
                id: parsed.id,
                content: "ok",
              }),
            );
          }
        } catch {}
      }
    });

    const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
      model: "marina",
      messages: [{ role: "user", content: "hello" }],
    });
    await handleModelApi(url, method, req, engine);

    expect(capturedTarget).toBe(conn1.entity!);
    const capturedRequestId = capturedTrace?.requestId;
    expect(capturedRequestId).toStartWith("req-");
    expect(capturedTrace).toEqual({
      requestId: capturedRequestId,
      runId: capturedRequestId,
      traceId: capturedRequestId,
      spanId: `span-${capturedRequestId}`,
    });
  });

  it("orchestration boundary: non-target sender responses are ignored", async () => {
    // A specialist sharing the channel with the orchestrator must not race
    // the orchestrator with a reply. selectAgent picks the target; whichever
    // agent is NOT the target plays the specialist role in this test.
    engine.processCommand(conn1.entity!, "channel join model");
    const conn2 = new MockConnection("c2");
    engine.addConnection(conn2);
    engine.spawnEntity("c2", "Agent2");
    engine.processCommand(conn2.entity!, "channel join model");

    let nonTargetResponded = false;
    cm.onMessage((channelId, senderId, _senderName, content) => {
      if (senderId !== "__model_api__") return;
      try {
        const parsed = JSON.parse(content);
        if (parsed.type !== "model_request") return;
        const target: string = parsed.target;
        const nonTarget = target === conn1.entity! ? conn2.entity! : conn1.entity!;
        // Non-target fires first with the wrong answer.
        cm.send(
          channelId,
          nonTarget,
          "NonTarget",
          JSON.stringify({
            type: "model_response",
            id: parsed.id,
            content: "non-target-hijack",
          }),
        );
        nonTargetResponded = true;
        // Target fires the authoritative answer.
        cm.send(
          channelId,
          target,
          "Target",
          JSON.stringify({
            type: "model_response",
            id: parsed.id,
            content: "target-answer",
          }),
        );
      } catch {}
    });

    const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
      model: "marina",
      messages: [{ role: "user", content: "hello" }],
    });
    const resp = await handleModelApi(url, method, req, engine);
    expect(resp!.status).toBe(200);
    const data = await resp!.json();
    expect(nonTargetResponded).toBe(true);
    expect(data.choices[0].message.content).toBe("target-answer");
  });

  describe("execution tracing", () => {
    type LifecycleEvent = Extract<EngineEvent, { type: "model_request_lifecycle" }>;
    const lifecycleEvents = (): LifecycleEvent[] =>
      engine.getEventLog().filter((e): e is LifecycleEvent => e.type === "model_request_lifecycle");

    const upstreamCompletion = () =>
      Response.json({
        id: "chatcmpl-upstream",
        object: "chat.completion",
        model: "gpt-4o",
        choices: [{ index: 0, message: { role: "assistant", content: "upstream answer" } }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      });

    async function withOpenAiUpstream<T>(
      fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
      run: () => Promise<T>,
    ): Promise<T> {
      const originalFetch = globalThis.fetch;
      const providerEnvKeys = [
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
      const originalValues = new Map(
        providerEnvKeys.map((key) => [key, process.env[key]] as const),
      );
      for (const key of providerEnvKeys) delete process.env[key];
      process.env.OPENAI_API_KEY = "test-key";
      globalThis.fetch = fetchImpl as typeof fetch;
      try {
        return await run();
      } finally {
        globalThis.fetch = originalFetch;
        for (const [key, value] of originalValues) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }

    it("uses Luna for the default OpenAI route while preserving explicit model overrides", async () => {
      const previous = process.env.MARINA_DEFAULT_OPENAI_MODEL;
      delete process.env.MARINA_DEFAULT_OPENAI_MODEL;
      setEndpointConfig(db, { mode: "passthru" });
      const forwarded: Record<string, unknown>[] = [];
      try {
        await withOpenAiUpstream(
          async (input, init) => {
            forwarded.push(await new Request(input, init).json());
            return upstreamCompletion();
          },
          async () => {
            const send = async () => {
              const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
                model: "marina/default",
                messages: [{ role: "user", content: "Return a short greeting." }],
                max_tokens: 500,
              });
              expect((await handleModelApi(url, method, req, engine))?.status).toBe(200);
            };
            await send();
            process.env.MARINA_DEFAULT_OPENAI_MODEL = "gpt-4o-mini-2024-07-18";
            await send();
            db.setSetting("default_model", "openai/gpt-4.1-mini-2025-04-14");
            await send();
          },
        );
        expect(forwarded[0]).toMatchObject({
          model: "gpt-5.6-luna",
          max_completion_tokens: 500,
          reasoning_effort: "none",
        });
        expect(forwarded[0]).not.toHaveProperty("max_tokens");
        expect(forwarded[1]).toMatchObject({ model: "gpt-4o-mini-2024-07-18", max_tokens: 500 });
        expect(forwarded[1]).not.toHaveProperty("reasoning_effort");
        expect(forwarded[2]).toMatchObject({ model: "gpt-4.1-mini-2025-04-14", max_tokens: 500 });
      } finally {
        if (previous === undefined) delete process.env.MARINA_DEFAULT_OPENAI_MODEL;
        else process.env.MARINA_DEFAULT_OPENAI_MODEL = previous;
      }
    });

    it("non-streaming chat completion x-request-id equals the traced traceId", async () => {
      engine.processCommand(conn1.entity!, "channel join model");
      setupPhase1Agent(cm, conn1.entity!, "Agent1", "traced answer");

      const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
        model: "marina",
        messages: [{ role: "user", content: "hello" }],
      });
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(200);

      const headerId = resp!.headers.get("x-request-id");
      const completed = lifecycleEvents().find((e) => e.phase === "completed");
      expect(completed).toBeDefined();
      expect(headerId).toBe(completed!.traceId!);
      expect(headerId).toBe(completed!.requestId);
    });

    it("traces a successful passthru request with its selected upstream target", async () => {
      setEndpointConfig(db, { mode: "passthru", passthruModel: "openai/gpt-4o" });
      const resp = await withOpenAiUpstream(
        async () => upstreamCompletion(),
        async () => {
          const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
            model: "marina",
            messages: [{ role: "user", content: "hello upstream" }],
          });
          return (await handleModelApi(url, method, req, engine))!;
        },
      );

      expect(resp.status).toBe(200);
      const requestId = resp.headers.get("x-request-id");
      const lifecycle = lifecycleEvents();
      expect(lifecycle.map((event) => event.phase)).toEqual(["received", "routed", "completed"]);
      expect(new Set(lifecycle.map((event) => event.traceId))).toEqual(new Set([requestId!]));
      expect(lifecycle[1]).toMatchObject({
        routeKind: "passthru",
        target: "openai/gpt-4o",
      });
      expect(lifecycle[2]).toMatchObject({ inputTokens: 12, outputTokens: 4 });
    });

    it("keeps a passthru stream running until the caller consumes the upstream stream", async () => {
      setEndpointConfig(db, { mode: "passthru", passthruModel: "openai/gpt-4o" });
      const resp = await withOpenAiUpstream(
        async () =>
          new Response(
            'data: {"id":"chatcmpl-stream","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
            { headers: { "Content-Type": "text/event-stream" } },
          ),
        async () => {
          const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
            model: "marina",
            stream: true,
            messages: [{ role: "user", content: "stream" }],
          });
          return (await handleModelApi(url, method, req, engine))!;
        },
      );

      expect(lifecycleEvents().map((event) => event.phase)).toEqual(["received", "routed"]);
      expect(await collectStream(resp)).toContain("hello");
      expect(lifecycleEvents().map((event) => event.phase)).toEqual([
        "received",
        "routed",
        "completed",
      ]);
      expect(lifecycleEvents().at(-1)?.ttftMs).toBeNumber();
    });

    it("labels an agent-unavailable upstream recovery as fallback", async () => {
      setEndpointConfig(db, {
        mode: "agents",
        fallback: true,
        passthruModel: "openai/gpt-4o",
      });
      const resp = await withOpenAiUpstream(
        async () => upstreamCompletion(),
        async () => {
          const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
            model: "marina",
            messages: [{ role: "user", content: "recover" }],
          });
          return (await handleModelApi(url, method, req, engine))!;
        },
      );

      expect(resp.status).toBe(200);
      expect(lifecycleEvents().find((event) => event.phase === "routed")).toMatchObject({
        routeKind: "fallback",
        target: "openai/gpt-4o",
      });
    });

    it("terminates a rejected passthru trace as failed", async () => {
      setEndpointConfig(db, { mode: "passthru", passthruModel: "openai/gpt-4o" });
      const resp = await withOpenAiUpstream(
        async () => new Response("quota", { status: 429 }),
        async () => {
          const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
            model: "marina",
            messages: [{ role: "user", content: "fail visibly" }],
          });
          return (await handleModelApi(url, method, req, engine))!;
        },
      );

      expect(resp.status).toBe(502);
      const lifecycle = lifecycleEvents();
      expect(lifecycle.at(-1)).toMatchObject({
        phase: "failed",
        routeKind: "passthru",
        target: "openai/gpt-5.6-luna",
        errorKind: "rate_limit",
      });
      expect(resp.headers.get("x-request-id")).toBe(lifecycle.at(-1)?.traceId ?? null);
    });

    it("Ollama non-streaming x-request-id equals the traced traceId", async () => {
      engine.processCommand(conn1.entity!, "channel join model");
      setupPhase1Agent(cm, conn1.entity!, "Agent1", "generated");

      const [url, method, req] = makeRequest("/api/generate", "POST", {
        model: "marina",
        prompt: "story",
        stream: false,
      });
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(200);

      const headerId = resp!.headers.get("x-request-id");
      const completed = lifecycleEvents().find((e) => e.phase === "completed");
      expect(headerId).toBe(completed!.traceId!);
    });

    it("/v1/responses x-request-id equals the traced traceId and honors X-Load-Balance", async () => {
      engine.processCommand(conn1.entity!, "channel join model");
      setupPhase1Agent(cm, conn1.entity!, "Agent1", "responses api answer");

      const [url, method, req] = makeRequest(
        "/v1/responses",
        "POST",
        { model: "marina", input: "hello" },
        { "X-Load-Balance": "least-busy" },
      );
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(200);

      const headerId = resp!.headers.get("x-request-id");
      const completed = lifecycleEvents().find((e) => e.phase === "completed");
      expect(headerId).toBe(completed!.traceId!);
      const routed = lifecycleEvents().find((e) => e.phase === "routed");
      expect(routed!.routeStrategy).toBe("least-busy");
    });

    it("Ollama routes use the operator-configured strategy when no header is sent", async () => {
      setEndpointConfig(db, { strategy: "least-busy" });
      engine.processCommand(conn1.entity!, "channel join model");
      setupPhase1Agent(cm, conn1.entity!, "Agent1", "ok");

      const [url, method, req] = makeRequest("/api/chat", "POST", {
        model: "marina",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(200);

      const routed = lifecycleEvents().find((e) => e.phase === "routed");
      expect(routed!.routeStrategy).toBe("least-busy");
    });

    it("panel fan-out emits per-target lifecycle spans under one shared trace", async () => {
      setEndpointConfig(db, { mode: "panel", panelSize: 2 });
      engine.processCommand(conn1.entity!, "channel join model");
      const conn2 = new MockConnection("c2");
      engine.addConnection(conn2);
      engine.spawnEntity("c2", "Agent2");
      engine.processCommand(conn2.entity!, "channel join model");

      const captured: {
        id: string;
        target: string;
        trace: { runId: string; traceId: string; spanId: string };
      }[] = [];
      cm.onMessage((channelId, senderId, _name, content) => {
        if (senderId !== "__model_api__") return;
        try {
          const parsed = JSON.parse(content);
          if (parsed.type !== "model_request") return;
          captured.push({ id: parsed.id, target: parsed.target, trace: parsed.trace });
          // Reply asynchronously so both fan-out requests dispatch before any
          // response settles the collection.
          setTimeout(() => {
            cm.send(
              channelId,
              parsed.target,
              "Agent",
              JSON.stringify({
                type: "model_response",
                id: parsed.id,
                content: `answer from ${parsed.target}`,
              }),
            );
          }, 0);
        } catch {}
      });

      const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
        model: "marina",
        messages: [{ role: "user", content: "panel question" }],
      });
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(200);
      const data = await resp!.json();
      expect(data.choices[0].message.content).toContain("### Answer 1");
      expect(data.choices[0].message.content).toContain("### Answer 2");

      // Every target got its own model_request span in the same trace.
      expect(captured.length).toBe(2);
      const traceIds = new Set(captured.map((c) => c.trace.traceId));
      expect(traceIds.size).toBe(1);
      const spanIds = new Set(captured.map((c) => c.trace.spanId));
      expect(spanIds.size).toBe(2);

      // The response header carries the shared fan-out trace identity.
      const sharedTraceId = captured[0]!.trace.traceId;
      expect(resp!.headers.get("x-request-id")).toBe(sharedTraceId);

      // Each per-target request completed its received → routed → completed chain.
      const traced = lifecycleEvents().filter((e) => e.traceId === sharedTraceId);
      for (const c of captured) {
        const phases = traced.filter((e) => e.requestId === c.id).map((e) => e.phase);
        expect(phases).toEqual(["received", "routed", "completed"]);
        const routedEvent = traced.find((e) => e.requestId === c.id && e.phase === "routed");
        expect(routedEvent!.target).toBe(c.target);
        expect(routedEvent!.spanId).toBe(c.trace.spanId);
      }
    });

    it("open fan-out records the winning target and header equals the shared trace id", async () => {
      setEndpointConfig(db, { mode: "open" });
      engine.processCommand(conn1.entity!, "channel join model");
      setupPhase1Agent(cm, conn1.entity!, "Agent1", "first answer wins");

      const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
        model: "marina",
        messages: [{ role: "user", content: "open question" }],
      });
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(200);
      const data = await resp!.json();
      expect(data.choices[0].message.content).toBe("first answer wins");

      const headerId = resp!.headers.get("x-request-id");
      const completed = lifecycleEvents().find((e) => e.phase === "completed");
      expect(completed).toBeDefined();
      expect(completed!.traceId).toBe(headerId!);
      expect(completed!.target).toBe(conn1.entity!);
    });
  });

  describe("authentication", () => {
    const TEST_KEY = "sk-test-key-12345";

    afterEach(() => {
      delete process.env.MODEL_API_KEYS;
    });

    it("allows requests when MARINA_OPEN_API=true and MODEL_API_KEYS is unset", async () => {
      delete process.env.MODEL_API_KEYS;
      process.env.MARINA_OPEN_API = "true";
      const [url, method, req] = makeRequest("/v1/models", "GET");
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(200);
    });

    it("rejects requests when neither MODEL_API_KEYS nor MARINA_OPEN_API is set", async () => {
      delete process.env.MODEL_API_KEYS;
      delete process.env.MARINA_OPEN_API;
      const [url, method, req] = makeRequest("/v1/models", "GET");
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(401);
      const data = await resp!.json();
      expect(data.error.message).toContain("MARINA_OPEN_API");
    });

    it("rejects requests without Authorization header when keys are configured", async () => {
      process.env.MODEL_API_KEYS = TEST_KEY;
      const [url, method, req] = makeRequest("/v1/models", "GET");
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(401);
      const data = await resp!.json();
      expect(data.error.type).toBe("authentication_error");
    });

    it("rejects requests with invalid bearer token", async () => {
      process.env.MODEL_API_KEYS = TEST_KEY;
      const [url, method, req] = makeRequest("/v1/models", "GET", undefined, {
        Authorization: "Bearer wrong-key",
      });
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(401);
    });

    it("accepts requests with valid bearer token", async () => {
      process.env.MODEL_API_KEYS = TEST_KEY;
      const [url, method, req] = makeRequest("/v1/models", "GET", undefined, {
        Authorization: `Bearer ${TEST_KEY}`,
      });
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(200);
    });

    it("supports multiple comma-separated keys", async () => {
      process.env.MODEL_API_KEYS = `${TEST_KEY},sk-second-key`;
      const [url, method, req] = makeRequest("/v1/models", "GET", undefined, {
        Authorization: "Bearer sk-second-key",
      });
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(200);
    });

    it("allows OPTIONS requests without auth (CORS preflight)", async () => {
      process.env.MODEL_API_KEYS = TEST_KEY;
      const [url, , req] = makeRequest("/v1/models", "OPTIONS");
      const resp = await handleModelApi(url, "OPTIONS", req, engine);
      // OPTIONS returns undefined (handled by CORS in websocket-server), not 401
      expect(resp).toBeUndefined();
    });
  });

  // ─── Compat profile aliases (passthru) ─────────────────────────────────────
  // The assistant alias here exercises the registry path; any registered
  // alias from src/net/compat-profiles.ts would behave identically.
  describe("Compat profile aliases", () => {
    it("accepts model=assistant on /v1/chat/completions", async () => {
      engine.processCommand(conn1.entity!, "channel join model");
      setupPhase1Agent(cm, conn1.entity!, "Agent1", "via assistant alias");

      const [url, method, req] = makeRequest("/v1/chat/completions", "POST", {
        model: "assistant",
        messages: [{ role: "user", content: "ping" }],
      });
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(200);
      const data = await resp!.json();
      expect(data.choices[0].message.content).toBe("via assistant alias");
    });

    it("GET /v1/health returns ok", async () => {
      const [url, method, req] = makeRequest("/v1/health", "GET");
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(200);
      const data = await resp!.json();
      expect(data.status).toBe("ok");
      expect(data.engine).toBe("marina");
    });

    it("POST /v1/responses creates a response and returns it", async () => {
      engine.processCommand(conn1.entity!, "channel join model");
      setupPhase1Agent(cm, conn1.entity!, "Agent1", "Hello there");

      const [url, method, req] = makeRequest("/v1/responses", "POST", {
        model: "assistant",
        input: "say hi",
      });
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(200);
      const data = await resp!.json();
      expect(data.id).toMatch(/^resp_/);
      expect(data.object).toBe("response");
      expect(data.status).toBe("completed");
      expect(data.output_text).toBe("Hello there");
      expect(data.output[0].role).toBe("assistant");
      expect(data.output[0].content[0].type).toBe("output_text");
      expect(data.output[0].content[0].text).toBe("Hello there");
    });

    it("POST /v1/responses accepts input as an array of content objects", async () => {
      engine.processCommand(conn1.entity!, "channel join model");
      setupPhase1Agent(cm, conn1.entity!, "Agent1", "ok");

      const [url, method, req] = makeRequest("/v1/responses", "POST", {
        model: "assistant",
        input: [{ role: "user", content: [{ type: "input_text", text: "hey" }] }],
      });
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(200);
    });

    it("GET /v1/responses/{id} returns a stored response", async () => {
      engine.processCommand(conn1.entity!, "channel join model");
      setupPhase1Agent(cm, conn1.entity!, "Agent1", "stored");

      const [createUrl, createMethod, createReq] = makeRequest("/v1/responses", "POST", {
        model: "assistant",
        input: "store me",
      });
      const createResp = await handleModelApi(createUrl, createMethod, createReq, engine);
      const created = await createResp!.json();

      const [getUrl, getMethod, getReq] = makeRequest(`/v1/responses/${created.id}`, "GET");
      const getResp = await handleModelApi(getUrl, getMethod, getReq, engine);
      expect(getResp!.status).toBe(200);
      const fetched = await getResp!.json();
      expect(fetched.id).toBe(created.id);
      expect(fetched.output_text).toBe("stored");
    });

    it("GET /v1/responses/{unknown} returns 404", async () => {
      const [url, method, req] = makeRequest("/v1/responses/resp_missing", "GET");
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(404);
    });

    it("DELETE /v1/responses/{id} removes the response", async () => {
      engine.processCommand(conn1.entity!, "channel join model");
      setupPhase1Agent(cm, conn1.entity!, "Agent1", "to be deleted");

      const [cUrl, cMethod, cReq] = makeRequest("/v1/responses", "POST", {
        model: "assistant",
        input: "temp",
      });
      const cResp = await handleModelApi(cUrl, cMethod, cReq, engine);
      const created = await cResp!.json();

      const [dUrl, dMethod, dReq] = makeRequest(`/v1/responses/${created.id}`, "DELETE");
      const dResp = await handleModelApi(dUrl, dMethod, dReq, engine);
      expect(dResp!.status).toBe(200);
      const deleted = await dResp!.json();
      expect(deleted.deleted).toBe(true);
      expect(deleted.id).toBe(created.id);

      // Subsequent GET should 404
      const [gUrl, gMethod, gReq] = makeRequest(`/v1/responses/${created.id}`, "GET");
      const gResp = await handleModelApi(gUrl, gMethod, gReq, engine);
      expect(gResp!.status).toBe(404);
    });

    it("POST /v1/responses threads via previous_response_id onto the same conversation", async () => {
      engine.processCommand(conn1.entity!, "channel join model");
      setupPhase1Agent(cm, conn1.entity!, "Agent1", "first");

      const [u1, m1, r1] = makeRequest("/v1/responses", "POST", {
        model: "assistant",
        input: "first",
      });
      const resp1 = await handleModelApi(u1, m1, r1, engine);
      const first = await resp1!.json();
      const conv1 = resp1!.headers.get("X-Conversation-Id");
      expect(conv1).toBeTruthy();

      const [u2, m2, r2] = makeRequest("/v1/responses", "POST", {
        model: "assistant",
        input: "follow up",
        previous_response_id: first.id,
      });
      const resp2 = await handleModelApi(u2, m2, r2, engine);
      const second = await resp2!.json();
      const conv2 = resp2!.headers.get("X-Conversation-Id");
      expect(conv2).toBe(conv1);
      expect(second.previous_response_id).toBe(first.id);
    });

    it("POST /v1/responses with unknown previous_response_id returns 404", async () => {
      engine.processCommand(conn1.entity!, "channel join model");
      setupPhase1Agent(cm, conn1.entity!, "Agent1", "ok");

      const [url, method, req] = makeRequest("/v1/responses", "POST", {
        model: "assistant",
        input: "continue",
        previous_response_id: "resp_never_created",
      });
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(404);
    });

    it("Responses records are owner-scoped: another key cannot GET/DELETE or thread onto them", async () => {
      // Two distinct credentials; disable open mode so each bearer is a distinct owner.
      process.env.MODEL_API_KEYS = "keyA,keyB";
      delete process.env.MARINA_OPEN_API;
      const keyA = { Authorization: "Bearer keyA" };
      const keyB = { Authorization: "Bearer keyB" };

      engine.processCommand(conn1.entity!, "channel join model");
      setupPhase1Agent(cm, conn1.entity!, "Agent1", "owned");

      const [cU, cM, cR] = makeRequest(
        "/v1/responses",
        "POST",
        { model: "assistant", input: "mine" },
        keyA,
      );
      const created = await (await handleModelApi(cU, cM, cR, engine))!.json();
      expect(created.id).toMatch(/^resp_/);

      // keyB cannot read keyA's response (404 — existence not revealed).
      const [gU, gM, gR] = makeRequest(`/v1/responses/${created.id}`, "GET", undefined, keyB);
      expect((await handleModelApi(gU, gM, gR, engine))!.status).toBe(404);

      // keyB cannot delete it either.
      const [dU, dM, dR] = makeRequest(`/v1/responses/${created.id}`, "DELETE", undefined, keyB);
      expect((await handleModelApi(dU, dM, dR, engine))!.status).toBe(404);

      // keyB cannot thread a new response onto keyA's conversation.
      const [pU, pM, pR] = makeRequest(
        "/v1/responses",
        "POST",
        { model: "assistant", input: "hijack", previous_response_id: created.id },
        keyB,
      );
      expect((await handleModelApi(pU, pM, pR, engine))!.status).toBe(404);

      // The owner (keyA) still reads it — the record was never deleted.
      const [oU, oM, oR] = makeRequest(`/v1/responses/${created.id}`, "GET", undefined, keyA);
      expect((await handleModelApi(oU, oM, oR, engine))!.status).toBe(200);
    });

    it("POST /v1/responses rejects empty input", async () => {
      const [url, method, req] = makeRequest("/v1/responses", "POST", {
        model: "assistant",
        input: "",
      });
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(400);
    });
  });
});

describe("prepareLlamaBody (llama upstream prep)", () => {
  // Simulate a large-context reasoning server (Qwen3.5-27B @ 262K) so the
  // budget isn't clamped down by the small-server default (16K → 4096).
  let prevCtx: string | undefined;
  beforeEach(() => {
    prevCtx = process.env.LLAMA_CONTEXT_WINDOW;
    process.env.LLAMA_CONTEXT_WINDOW = "262144";
  });
  afterEach(() => {
    if (prevCtx === undefined) delete process.env.LLAMA_CONTEXT_WINDOW;
    else process.env.LLAMA_CONTEXT_WINDOW = prevCtx;
  });

  it("leaves non-llama provider bodies untouched", () => {
    const body = { model: "gpt-4", messages: [], max_tokens: 100 };
    expect(prepareLlamaBody(body, "openai")).toBe(body);
  });

  it("suppresses Qwen3 thinking for the llama provider", () => {
    const out = prepareLlamaBody({ model: "qwen", messages: [] }, "llama");
    expect(out.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("injects a generous output budget when the caller sends none", () => {
    // marina/default agents send no max_tokens; without a floor a reasoning
    // model spends the server default on <think> and emits no tool call.
    const out = prepareLlamaBody({ model: "qwen", messages: [] }, "llama");
    expect(typeof out.max_tokens).toBe("number");
    expect(out.max_tokens as number).toBeGreaterThan(4096);
  });

  it("raises a too-small caller budget but preserves a larger one", () => {
    const bumped = prepareLlamaBody({ messages: [], max_tokens: 4096 }, "llama");
    expect(bumped.max_tokens as number).toBeGreaterThan(4096);

    const huge = prepareLlamaBody({ messages: [], max_tokens: 999_999 }, "llama");
    expect(huge.max_tokens).toBe(999_999);
  });

  it("scales the budget to a quarter of a small server's context window", () => {
    // Budget tracks the context window so a small server isn't starved of
    // prompt space: LOCAL_OUTPUT_BUDGET_FRACTION defaults to 0.25 so a 16k
    // model keeps ~12k for the fixed prefix + history (was 0.5 → 8k input).
    process.env.LLAMA_CONTEXT_WINDOW = "16384";
    const out = prepareLlamaBody({ messages: [] }, "llama");
    expect(out.max_tokens).toBe(4096); // 16384 / 4
  });
});

describe("stripCacheControl (OpenAI-compatible upstreams)", () => {
  it("removes cache_control from message parts and tools and collapses a pure-text system array", () => {
    const body = {
      model: "gpt-x",
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "You are Marina.", cache_control: { type: "ephemeral" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
            { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
          ],
        },
      ],
      tools: [
        { type: "function", function: { name: "a", parameters: {} } },
        {
          type: "function",
          function: { name: "b", parameters: {} },
          cache_control: { type: "ephemeral" },
        },
      ],
    };
    const out = stripCacheControl(body) as {
      messages: Array<{ role: string; content: unknown }>;
      tools: unknown[];
    };
    expect(JSON.stringify(out)).not.toContain("cache_control");
    expect(out.messages[0]!.content).toBe("You are Marina.");
    expect(Array.isArray(out.messages[1]!.content)).toBe(true);
    expect((out.messages[1]!.content as unknown[]).length).toBe(2);
    expect(out.tools.length).toBe(2);
    // Caller's body is untouched.
    expect(JSON.stringify(body)).toContain("cache_control");
  });

  it("returns the same object when nothing needs stripping and keeps markers for anthropic", () => {
    const clean = { model: "m", messages: [{ role: "user", content: "hi" }] };
    expect(stripCacheControl(clean)).toBe(clean);
    const marked = {
      model: "m",
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
        },
      ],
    };
    expect(JSON.stringify(prepareUpstreamBody(marked, "anthropic"))).toContain("cache_control");
    expect(JSON.stringify(prepareUpstreamBody(marked, "openai"))).not.toContain("cache_control");
    expect(JSON.stringify(prepareUpstreamBody(marked, "llama"))).not.toContain("cache_control");
  });
});

describe("prepareUpstreamBody (cloud fallback prep)", () => {
  it("adapts Luna token limits without mutating requests or overwriting reasoning choices", () => {
    const body = { model: "gpt-5.6-luna", max_tokens: 500, messages: [] };
    const prepared = prepareUpstreamBody(body, "openai", true);
    expect(prepared).toEqual({
      model: body.model,
      max_completion_tokens: 500,
      messages: [],
      reasoning_effort: "none",
    });
    expect(body).toEqual({ model: "gpt-5.6-luna", max_tokens: 500, messages: [] });
    expect(prepareUpstreamBody(body, "openai")).not.toHaveProperty("reasoning_effort");
    expect(
      prepareUpstreamBody({ ...body, reasoning_effort: "high" }, "openai", true).reasoning_effort,
    ).toBe("high");
    expect(
      prepareUpstreamBody(
        { ...body, max_tokens: undefined, max_completion_tokens: 1000 },
        "openai",
        true,
      ).max_completion_tokens,
    ).toBe(1000);
    const openrouter = { model: "openai/gpt-5.6-luna", reasoning: { effort: "high" } };
    expect(prepareUpstreamBody(openrouter, "openrouter", true)).toEqual(openrouter);
    expect(
      prepareUpstreamBody({ model: openrouter.model }, "openrouter", true).reasoning_effort,
    ).toBe("none");
  });

  it("clamps completion budgets when falling back to OpenAI", () => {
    expect(prepareUpstreamBody({ max_tokens: 32_000 }, "openai").max_tokens).toBe(16_384);
    expect(
      prepareUpstreamBody({ max_completion_tokens: 32_000 }, "openai").max_completion_tokens,
    ).toBe(16_384);
  });

  it("preserves valid OpenAI and non-OpenAI budgets", () => {
    expect(prepareUpstreamBody({ max_tokens: 4_096 }, "openai").max_tokens).toBe(4_096);
    expect(prepareUpstreamBody({ max_tokens: 32_000 }, "google").max_tokens).toBe(32_000);
  });
});

describe("tryVerifiedArithmetic", () => {
  it("handles one explicit operation and rejects ambiguous work", () => {
    expect(tryVerifiedArithmetic("compute 12 plus 8")).toContain("20");
    expect(tryVerifiedArithmetic("What is 19 multiplied by 37? Reply briefly.")).toContain("703");
    expect(tryVerifiedArithmetic("compute 2 + 3 * 4")).toBeUndefined();
    expect(tryVerifiedArithmetic("Explain whether 2 + 2 is always 4")).toBeUndefined();
    expect(tryVerifiedArithmetic("calculate 1 divided by 0")).toBeUndefined();
  });
});

// ─── Passthru memory gateway — injection on all four proxy surfaces ──────────

describe("passthru memory gateway", () => {
  const GATEWAY_DB = "test_model_api_gateway.db";
  const PROVIDER_ENV = [
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
    "MARINA_PASSTHRU_INJECT_BYTES",
  ] as const;
  const originalEnv = new Map<string, string | undefined>();
  const originalFetch = globalThis.fetch;
  let db: MarinaDB;
  let engine: Engine;
  let fx: Awaited<ReturnType<typeof seedUnifiedFixture>>;
  /** Every body the stub upstream received, in order. */
  let forwarded: Record<string, unknown>[];
  const QUESTION = `what is the ${FIXTURE_QUERY}?`;
  const AUTH = { Authorization: "Bearer sk-ada" };

  const upstreamCompletion = () =>
    Response.json({
      id: "chatcmpl-upstream",
      object: "chat.completion",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "upstream answer" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    });

  beforeEach(async () => {
    for (const key of PROVIDER_ENV) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.OPENAI_API_KEY = "test-key";
    // Bound key: `sk-ada` is confined to the fixture owner (an existing entity).
    process.env.MODEL_API_KEYS = "sk-ada:Ada";
    resetPassthruCaptureDedupForTests();
    forwarded = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      forwarded.push(await new Request(input, init).json());
      return upstreamCompletion();
    }) as typeof fetch;

    cleanupDb(GATEWAY_DB);
    db = new MarinaDB(GATEWAY_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    setEndpointConfig(db, { mode: "passthru", passthruModel: "openai/gpt-4o" });
    fx = await seedUnifiedFixture(engine, db);
    // Shared trust profile in-process: the identity opts in via its property.
    engine.entities.get(fx.ownerEntityId)!.properties.passthruContext = true;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of PROVIDER_ENV) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    engine.shutdown();
    db.close();
    cleanupDb(GATEWAY_DB);
  });

  function systemOf(body: Record<string, unknown> | undefined): string {
    const messages = (body?.messages ?? []) as { role: string; content: unknown }[];
    const system = messages.find((m) => m.role === "system");
    return typeof system?.content === "string" ? system.content : "";
  }
  /** The injected addendum is everything before the client's own system text. */
  const addendumOf = (system: string) => system.split("\n\n")[0] ?? "";

  async function send(path: string, body: unknown, headers: Record<string, string> = AUTH) {
    const [url, method, req] = makeRequest(path, "POST", body, headers);
    const resp = await handleModelApi(url, method, req, engine);
    expect(resp).toBeDefined();
    return resp!;
  }

  /** Warm the caller's memory: the first exchange is captured as a `[passthru]`
   *  note (dedup keeps identical repeats from adding more), after which the
   *  injected context for QUESTION is stable across calls and surfaces. */
  async function warm(): Promise<void> {
    const resp = await send("/v1/chat/completions", {
      model: "marina",
      messages: [{ role: "user", content: QUESTION }],
    });
    expect(resp.status).toBe(200);
    for (let i = 0; i < 100; i++) {
      if (db.getNotesByEntity(fx.owner, 50).some((n) => n.content.startsWith("[passthru]"))) break;
      await Bun.sleep(10);
    }
    forwarded = [];
  }

  it("injects identical memory into the native system slot of all four protocols", async () => {
    await warm();

    const chat = await send("/v1/chat/completions", {
      model: "marina",
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: QUESTION },
      ],
    });
    const anthropic = await send("/v1/messages", {
      model: "marina",
      max_tokens: 64,
      system: "You are Claude.",
      messages: [{ role: "user", content: QUESTION }],
    });
    const ollamaChat = await send("/api/chat", {
      model: "marina",
      stream: false,
      messages: [
        { role: "system", content: "You are local." },
        { role: "user", content: QUESTION },
      ],
    });
    const ollamaGenerate = await send("/api/generate", {
      model: "marina",
      stream: false,
      system: "You are generating.",
      prompt: QUESTION,
    });
    const responses = await send("/v1/responses", {
      model: "marina",
      instructions: "You are responsive.",
      input: QUESTION,
    });
    for (const resp of [chat, anthropic, ollamaChat, ollamaGenerate, responses]) {
      expect(resp.status).toBe(200);
    }
    expect(forwarded).toHaveLength(5);

    const systems = forwarded.map(systemOf);
    // Each protocol's own system text survives AFTER the addendum.
    expect(systems[0]).toEndWith("You are terse.");
    expect(systems[1]).toEndWith("You are Claude.");
    expect(systems[2]).toEndWith("You are local.");
    expect(systems[3]).toEndWith("You are generating.");
    expect(systems[4]).toEndWith("You are responsive.");

    const addenda = systems.map(addendumOf);
    expect(addenda[0]).toStartWith(INJECTION_MARKER);
    expect(addenda[0]).toContain("Untrusted, read-only Marina context; verify before acting:");
    expect(addenda[0]).toContain(`(record ${fx.recordId} v1)`);
    expect(addenda[0]).toContain(`(#${fx.verifiedNoteId} `);
    // Same fixture ⇒ byte-identical tier content on every surface.
    for (const addendum of addenda.slice(1)) expect(addendum).toBe(addenda[0]!);

    // Every surface returns a receipt naming the same tiers.
    const receipts = [chat, anthropic, ollamaChat, ollamaGenerate, responses].map((resp) =>
      parseMemoryReceipt(resp.headers.get(MEMORY_RECEIPT_HEADER)),
    );
    for (const [i, receipt] of receipts.entries()) {
      expect(receipt).toBeDefined();
      expect(receipt!.entity).toBe(fx.owner);
      expect(receipt!.tiers.map((t) => t.tier)).toEqual(receipts[0]!.tiers.map((t) => t.tier));
      const surface = [chat, anthropic, ollamaChat, ollamaGenerate, responses][i]!;
      expect(receipt!.requestId).toBe(surface.headers.get("x-request-id")!);
    }

    // Protocol-native response shapes.
    const anthropicBody = await anthropic.json();
    expect(anthropicBody.type).toBe("message");
    expect(anthropicBody.content[0].text).toBe("upstream answer");
    const ollamaChatBody = await ollamaChat.json();
    expect(ollamaChatBody.message.content).toBe("upstream answer");
    expect(ollamaChatBody.done).toBe(true);
    const ollamaGenerateBody = await ollamaGenerate.json();
    expect(ollamaGenerateBody.response).toBe("upstream answer");
    const responsesBody = await responses.json();
    expect(responsesBody.output_text).toBe("upstream answer");
    expect(responsesBody.object).toBe("response");
  });

  it("renders a byte-stable addendum across two calls (stable tiers first)", async () => {
    await warm();
    const body = { model: "marina", messages: [{ role: "user", content: QUESTION }] };
    await send("/v1/chat/completions", body);
    await send("/v1/chat/completions", body);
    expect(forwarded).toHaveLength(2);
    const [a, b] = forwarded.map(systemOf);
    expect(a).toBe(b!);
    const lines = a!.split("\n");
    const index = (label: string) =>
      lines.findIndex((line) => line.startsWith(`Own memory ${label} (`));
    expect(index("[trusted]")).toBeGreaterThan(0);
    expect(index("[evidence]")).toBeGreaterThan(index("[trusted]"));
    expect(index("[proposal]")).toBeGreaterThan(index("[evidence]"));
    expect(index("[unverified — own notes, verify before relying]")).toBeGreaterThan(
      index("[proposal]"),
    );
  });

  it("caps injection at the per-key budget (passthruInjectBytes) and reports it in the receipt", async () => {
    engine.entities.get(fx.ownerEntityId)!.properties.passthruInjectBytes = 400;
    const resp = await send("/v1/chat/completions", {
      model: "marina",
      messages: [{ role: "user", content: QUESTION }],
    });
    expect(resp.status).toBe(200);
    const system = systemOf(forwarded[0]);
    expect(new TextEncoder().encode(system).length).toBeLessThanOrEqual(400);
    const receipt = parseMemoryReceipt(resp.headers.get(MEMORY_RECEIPT_HEADER))!;
    expect(receipt.budgetBytes).toBe(400);
    expect(receipt.usedBytes).toBeLessThanOrEqual(400);
    expect(receipt.truncated).toBe(true);
  });

  it("honors X-Marina-Context: off for a bound key — no injection, no receipt", async () => {
    const resp = await send(
      "/v1/chat/completions",
      { model: "marina", messages: [{ role: "user", content: QUESTION }] },
      { ...AUTH, "X-Marina-Context": "off" },
    );
    expect(resp.status).toBe(200);
    expect(systemOf(forwarded[0])).toBe("");
    expect(resp.headers.get(MEMORY_RECEIPT_HEADER)).toBeNull();
    expect(forwarded[0]!.messages).toEqual([{ role: "user", content: QUESTION }]);
  });

  it("never injects for the shared anonymous identity (plain key, no binding)", async () => {
    process.env.MODEL_API_KEYS = "sk-plain";
    const resp = await send(
      "/v1/chat/completions",
      { model: "marina", messages: [{ role: "user", content: QUESTION }] },
      { Authorization: "Bearer sk-plain", "X-Marina-Context": "on" },
    );
    expect(resp.status).toBe(200);
    expect(systemOf(forwarded[0])).toBe("");
    expect(resp.headers.get(MEMORY_RECEIPT_HEADER)).toBeNull();
  });

  it("emits the receipt on the model_request_lifecycle span so traces keep it", async () => {
    const resp = await send("/v1/chat/completions", {
      model: "marina",
      messages: [{ role: "user", content: QUESTION }],
    });
    const requestId = resp.headers.get("x-request-id")!;
    const headerReceipt = parseMemoryReceipt(resp.headers.get(MEMORY_RECEIPT_HEADER))!;
    expect(headerReceipt.requestId).toBe(requestId);

    const lifecycle = engine
      .getEventLog()
      .filter(
        (e): e is Extract<EngineEvent, { type: "model_request_lifecycle" }> =>
          e.type === "model_request_lifecycle" && e.requestId === requestId,
      );
    expect(lifecycle.map((e) => e.phase)).toEqual(["received", "routed", "completed"]);
    expect(parseMemoryReceipt(lifecycle[0]!.memoryReceipt)).toEqual(headerReceipt);
    expect(parseMemoryReceipt(lifecycle[2]!.memoryReceipt)).toEqual(headerReceipt);
    expect(lifecycle[2]!.entityId).toBe(fx.ownerEntityId);

    const trace = projectTraces(engine.getEventLog()).find((t) => t.traceId === requestId)!;
    const span = trace.spans.find((s) => s.kind === "model_request")!;
    expect(parseMemoryReceipt(span.attributes.memoryReceipt)).toEqual(headerReceipt);
  });

  it("streams Ollama passthru as buffered ndjson with the receipt header", async () => {
    const resp = await send("/api/chat", {
      model: "marina",
      messages: [{ role: "user", content: QUESTION }],
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(resp.headers.get(MEMORY_RECEIPT_HEADER)).not.toBeNull();
    const lines = (await collectStream(resp))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].message.content).toBe("upstream answer");
    expect(lines[lines.length - 1].done).toBe(true);
    // Upstream was asked for a completed (non-streaming) answer.
    expect(forwarded[0]!.stream).toBe(false);
  });
});
