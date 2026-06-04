import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ChannelManager } from "../src/coordination/channel-manager";
import { Engine } from "../src/engine/engine";
import { getActiveAliases } from "../src/net/compat-profiles";
import {
  handleModelApi,
  pendingRequests,
  roundRobinCounters,
  selectAgent,
} from "../src/net/model-api";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
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
    process.env.MARINA_OPEN_API = undefined;
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
      process.env[k] = undefined;
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
    expect(data.error.code).toBeNull();
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

  it("request payload includes target field for load balancing", async () => {
    engine.processCommand(conn1.entity!, "channel join model");

    let capturedTarget: string | undefined;
    cm.onMessage((channelId, senderId, _senderName, content) => {
      if (senderId === "__model_api__") {
        try {
          const parsed = JSON.parse(content);
          if (parsed.type === "model_request") {
            capturedTarget = parsed.target;
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

  describe("authentication", () => {
    const TEST_KEY = "sk-test-key-12345";

    afterEach(() => {
      process.env.MODEL_API_KEYS = undefined;
    });

    it("allows requests when MARINA_OPEN_API=true and MODEL_API_KEYS is unset", async () => {
      process.env.MODEL_API_KEYS = undefined;
      process.env.MARINA_OPEN_API = "true";
      const [url, method, req] = makeRequest("/v1/models", "GET");
      const resp = await handleModelApi(url, method, req, engine);
      expect(resp!.status).toBe(200);
    });

    it("rejects requests when neither MODEL_API_KEYS nor MARINA_OPEN_API is set", async () => {
      process.env.MODEL_API_KEYS = undefined;
      process.env.MARINA_OPEN_API = undefined;
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
