// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * An explicit upstream id (`openrouter/<vendor>/<model>`, `anthropic/<model>`, …)
 * reaches that upstream in every endpoint mode — the mirror of the rule that an
 * explicit `marina:<crew>` id reaches its agents in every mode. In the
 * agent-routing modes such an id used to look for a `model-<id>` channel and
 * answer 404 `model_not_found` without asking anyone, so an external caller
 * (a benchmark judge) could not use a model Marina itself serves to its agents.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine";
import { handleModelApi } from "../src/net/model-api";
import { explicitUpstreamModel, passthruForceModel } from "../src/net/model-api/upstream";
import { setEndpointConfig } from "../src/net/model-endpoint";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { MockConnection, makeTestRoom } from "./helpers";

const ENV = [
  "ANTHROPIC_API_KEY",
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
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "MODEL_API_KEYS",
  "MARINA_OPEN_API",
  "MARINA_DAILY_SPEND_CAP_USD",
] as const;

let saved: Map<string, string | undefined>;
let originalFetch: typeof fetch;
let dir: string;
let db: MarinaDB;
let engine: Engine;
let calls: { host: string; model: unknown }[];

beforeEach(() => {
  saved = new Map(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.MARINA_OPEN_API = "true";
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  calls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ host: url.host, model: body.model });
    return Response.json({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: body.model,
      choices: [
        { index: 0, message: { role: "assistant", content: "CORRECT" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    });
  }) as typeof fetch;
  dir = mkdtempSync(join(tmpdir(), "explicit-upstream-"));
  db = new MarinaDB(join(dir, "w.db"));
  engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
  engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
  // A connected entity brings up the channel system, as on a live server.
  engine.addConnection(new MockConnection("c1"));
  engine.spawnEntity("c1", "Agent1");
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

async function post(path: string, body: unknown) {
  const url = new URL(`http://localhost:3300${path}`);
  const req = new Request(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await handleModelApi(url, "POST", req, engine);
}

const judgeBody = (model: string) => ({
  model,
  messages: [
    { role: "system", content: "Reply CORRECT or INCORRECT." },
    { role: "user", content: "Reference: 4. Response: four." },
  ],
});

describe("explicitUpstreamModel", () => {
  it("is true for a reachable provider prefix and false otherwise", () => {
    expect(explicitUpstreamModel(engine, "openrouter/openai/gpt-6.1-sol")).toBe(true);
    // No key for that provider: the id names nothing this instance can reach.
    expect(explicitUpstreamModel(engine, "anthropic/claude-opus-5.5")).toBe(false);
    for (const id of ["marina", "marina/default", "marina:answerer", "default", "gpt-6.1-sol"]) {
      expect(explicitUpstreamModel(engine, id)).toBe(false);
    }
    expect(explicitUpstreamModel(engine, "openrouter/")).toBe(false);
    expect(explicitUpstreamModel(engine, undefined)).toBe(false);
  });

  it("never lets the agent-mode fallback model replace an explicit id", () => {
    const agents = { mode: "agents", passthruModel: "openai/gpt-6-luna" };
    expect(passthruForceModel(engine, agents, "openrouter/openai/gpt-6.1-sol")).toBe("");
    expect(passthruForceModel(engine, agents, "marina")).toBe("openai/gpt-6-luna");
    // Passthru mode: the operator's pinned model wins, as documented.
    const passthru = { mode: "passthru", passthruModel: "openai/gpt-6-luna" };
    expect(passthruForceModel(engine, passthru, "openrouter/openai/gpt-6.1-sol")).toBe(
      "openai/gpt-6-luna",
    );
  });
});

describe("agent-routing endpoint modes", () => {
  it("serves an explicit upstream id on /v1/chat/completions instead of 404", async () => {
    // Default endpoint mode is `agents`, with no `model-openrouter/...` channel.
    const resp = await post("/v1/chat/completions", judgeBody("openrouter/openai/gpt-6.1-sol"));
    expect(resp?.status).toBe(200);
    const json = (await resp!.json()) as { choices: { message: { content: string } }[] };
    expect(json.choices[0]!.message.content).toBe("CORRECT");
    expect(calls).toEqual([{ host: "openrouter.ai", model: "openai/gpt-6.1-sol" }]);
  });

  it("serves the id as named even when an agent-mode fallback model is configured", async () => {
    setEndpointConfig(db, { mode: "agents", passthruModel: "openrouter/openai/gpt-6-luna" });
    const resp = await post("/v1/chat/completions", judgeBody("openrouter/openai/gpt-6.1-sol"));
    expect(resp?.status).toBe(200);
    expect(calls.map((c) => c.model)).toEqual(["openai/gpt-6.1-sol"]);
  });

  it("covers the open and panel modes too", async () => {
    for (const mode of ["open", "panel"] as const) {
      setEndpointConfig(db, { mode });
      calls = [];
      const resp = await post("/v1/chat/completions", judgeBody("openrouter/openai/gpt-6.1-sol"));
      expect(resp?.status).toBe(200);
      expect(calls).toHaveLength(1);
    }
  });

  it("leaves an id that names nothing reachable on the agent route", async () => {
    const routes: unknown[] = [];
    engine.addEventListener((e) => {
      const ev = e as { type: string; phase?: string; routeKind?: unknown };
      if (ev.type === "model_request_lifecycle" && ev.routeKind !== undefined) {
        routes.push(ev.routeKind);
      }
    });
    for (const model of ["anthropic/claude-opus-5.5", "no-such-model"]) {
      await post("/v1/chat/completions", judgeBody(model));
    }
    // With no agent online the agent route takes its configured fallback, as
    // before; neither id is mistaken for an explicit upstream.
    expect(routes.length).toBeGreaterThan(0);
    expect(routes).not.toContain("passthru");
  });

  it("serves an explicit upstream id on /v1/responses", async () => {
    const resp = await post("/v1/responses", {
      model: "openrouter/openai/gpt-6.1-sol",
      input: "Reference: 4. Response: four.",
    });
    expect(resp?.status).toBe(200);
    expect(calls).toEqual([{ host: "openrouter.ai", model: "openai/gpt-6.1-sol" }]);
  });
});

describe("passthru endpoint mode", () => {
  it("keeps the operator's pinned model", async () => {
    setEndpointConfig(db, { mode: "passthru", passthruModel: "openrouter/openai/gpt-6-luna" });
    const resp = await post("/v1/chat/completions", judgeBody("openrouter/openai/gpt-6.1-sol"));
    expect(resp?.status).toBe(200);
    expect(calls.map((c) => c.model)).toEqual(["openai/gpt-6-luna"]);
  });
});
