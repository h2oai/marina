// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Engine } from "../src/engine/engine";
import { residentMemoryOperation } from "../src/memory/resident-service";
import { finalizeMemoryReceipt, type MemoryReceipt } from "../src/net/memory-receipt";
import { handleModelApi } from "../src/net/model-api";
import { setEndpointConfig } from "../src/net/model-endpoint";
import { resetPassthruCaptureDedupForTests } from "../src/net/passthru-context";
import {
  cacheableCompletion,
  canonicalJson,
  lookupResponseCache,
  RESPONSE_CACHE_HEADER,
  responseCacheEnabled,
  responseCacheKey,
  storeResponseCache,
} from "../src/net/response-cache";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { FIXTURE_QUERY, seedUnifiedFixture } from "./fixtures/unified-memory-fixture";
import { cleanupDb, makeTestRoom } from "./helpers";

const TEST_DB = "test_response_cache.db";
const MODEL = "openai/gpt-4o";
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
  "MARINA_PASSTHRU_RESPONSE_CACHE",
] as const;

function completion(text: string, extra: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "gpt-4o",
    choices: [
      { index: 0, message: { role: "assistant", content: text, ...extra }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function receiptFor(entity: string, pins: { id: string; version?: number; hash?: string }[]) {
  return finalizeMemoryReceipt(
    {
      schema: "marina.memory.receipt.v1",
      entity,
      tiers: [{ tier: "evidence", ids: pins, bytes: 10 }],
      budgetBytes: 2048,
      usedBytes: 100,
      truncated: false,
      degraded: [],
    },
    "req-test",
  );
}

describe("response cache", () => {
  let db: MarinaDB;
  let engine: Engine;
  let fx: Awaited<ReturnType<typeof seedUnifiedFixture>>;
  const originalEnv = new Map<string, string | undefined>();
  const originalFetch = globalThis.fetch;
  let upstreamCalls: Record<string, unknown>[];
  let upstreamText = "upstream answer";
  let upstreamStream = false;

  beforeEach(async () => {
    for (const key of PROVIDER_ENV) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.OPENAI_API_KEY = "test-key";
    process.env.MODEL_API_KEYS = "sk-ada:Ada,sk-bea:Bea";
    resetPassthruCaptureDedupForTests();
    upstreamCalls = [];
    upstreamText = "upstream answer";
    upstreamStream = false;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      upstreamCalls.push(await new Request(input, init).json());
      if (upstreamStream) {
        return new Response(
          `data: ${JSON.stringify({
            id: "chatcmpl-s",
            model: "gpt-4o",
            choices: [{ index: 0, delta: { content: upstreamText }, finish_reason: null }],
          })}\n\ndata: [DONE]\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return Response.json(completion(upstreamText));
    }) as typeof fetch;

    cleanupDb(TEST_DB);
    db = new MarinaDB(TEST_DB);
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    setEndpointConfig(db, { mode: "passthru", passthruModel: MODEL });
    fx = await seedUnifiedFixture(engine, db);
    for (const id of [fx.ownerEntityId, fx.workerEntityId]) {
      const entity = engine.entities.get(id)!;
      entity.properties.passthruContext = true;
      entity.properties.passthruResponseCache = true;
    }
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
    cleanupDb(TEST_DB);
  });

  // ─── Key + eligibility primitives ──────────────────────────────────────────

  it("canonicalizes JSON (sorted keys, stable arrays, undefined dropped)", () => {
    expect(canonicalJson({ b: 1, a: [3, { z: 1, y: 2 }], c: undefined })).toBe(
      '{"a":[3,{"y":2,"z":1}],"b":1}',
    );
  });

  it("keys on the effective request — model, messages, tools, sampling — not on stream/user", () => {
    const base = {
      model: "marina",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.2,
      tools: [{ type: "function", function: { name: "f" } }],
    };
    const key = responseCacheKey(base, MODEL);
    expect(responseCacheKey({ ...base, stream: true, user: "x" }, MODEL)).toBe(key);
    expect(responseCacheKey({ ...base, temperature: 0.3 }, MODEL)).not.toBe(key);
    expect(responseCacheKey({ ...base, tools: [] }, MODEL)).not.toBe(key);
    expect(
      responseCacheKey({ ...base, messages: [{ role: "user", content: "hi!" }] }, MODEL),
    ).not.toBe(key);
    expect(responseCacheKey(base, "openai/gpt-4o-mini")).not.toBe(key);
  });

  it("refuses tool-call completions", () => {
    expect(cacheableCompletion(completion("ok"))).toBe(true);
    expect(
      cacheableCompletion(
        completion("", {
          tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }],
        }),
      ),
    ).toBe(false);
    const finished = completion("x");
    finished.choices[0]!.finish_reason = "tool_calls";
    expect(cacheableCompletion(finished)).toBe(false);
    expect(cacheableCompletion({ choices: [] })).toBe(false);
  });

  it("is opt-in: entity property, or env under the LOCAL profile only", () => {
    const entity = engine.entities.get(fx.ownerEntityId)!;
    delete entity.properties.passthruResponseCache;
    expect(responseCacheEnabled(entity, {})).toBe(false);
    // Shared (default in-process) profile ignores the env switch.
    expect(responseCacheEnabled(entity, { MARINA_PASSTHRU_RESPONSE_CACHE: "on" })).toBe(false);
    expect(
      responseCacheEnabled(entity, {
        MARINA_PASSTHRU_RESPONSE_CACHE: "on",
        MARINA_PROFILE: "local",
      }),
    ).toBe(true);
    entity.properties.passthruResponseCache = "on";
    expect(responseCacheEnabled(entity, {})).toBe(true);
    entity.properties.passthruResponseCache = false;
    expect(
      responseCacheEnabled(entity, {
        MARINA_PASSTHRU_RESPONSE_CACHE: "on",
        MARINA_PROFILE: "local",
      }),
    ).toBe(false);
  });

  // ─── Durable store semantics (pins, invalidation, isolation) ───────────────

  it("stores only with ≥1 durable pin, hits for the same identity, and misses for another", async () => {
    const body = { model: "marina", messages: [{ role: "user", content: "pinned q" }] };
    const noPins = receiptFor(fx.owner, []);
    expect(
      await storeResponseCache(db, fx.owner, body, MODEL, Response.json(completion("a")), noPins),
    ).toEqual({ stored: false, reason: "no_pins" });

    const receipt = receiptFor(fx.owner, [{ id: fx.recordId, version: 1 }]);
    const stored = await storeResponseCache(
      db,
      fx.owner,
      body,
      MODEL,
      Response.json(completion("a")),
      receipt,
    );
    expect(stored.stored).toBe(true);

    const hit = await lookupResponseCache(db, fx.owner, body, MODEL);
    expect(hit.hit).toBe(true);
    if (hit.hit) {
      expect(
        (hit.value.body as { choices: { message: { content: string } }[] }).choices[0]!.message
          .content,
      ).toBe("a");
      expect(hit.value.receipt).toEqual(receipt);
    }
    // Identity isolation: Bea never sees Ada's cached answer (her own space).
    const other = await lookupResponseCache(db, fx.worker, body, MODEL);
    expect(other.hit).toBe(false);
    // A different effective request is a different key.
    const different = await lookupResponseCache(
      db,
      fx.owner,
      { ...body, messages: [{ role: "user", content: "pinned q2" }] },
      MODEL,
    );
    expect(different.hit).toBe(false);
  });

  it("invalidates when a pinned record is revised", async () => {
    const body = { model: "marina", messages: [{ role: "user", content: "revise q" }] };
    const receipt = receiptFor(fx.owner, [{ id: fx.recordId, version: 1 }]);
    await storeResponseCache(db, fx.owner, body, MODEL, Response.json(completion("v1")), receipt);
    expect((await lookupResponseCache(db, fx.owner, body, MODEL)).hit).toBe(true);

    await residentMemoryOperation(db, fx.owner, {
      operation: "revise",
      id: fx.recordId,
      key: "revise-amber-1",
      input: {
        content: "Amber deployment uses port 7420",
        subject: "amber",
        source_ids: [fx.sourceId],
        expected_version: 1,
      },
    });
    const after = await lookupResponseCache(db, fx.owner, body, MODEL);
    expect(after.hit).toBe(false);
  });

  it("clears when the pinned record is forgotten", async () => {
    const body = { model: "marina", messages: [{ role: "user", content: "forget q" }] };
    const receipt = receiptFor(fx.owner, [{ id: fx.recordId, version: 1 }]);
    await storeResponseCache(db, fx.owner, body, MODEL, Response.json(completion("v1")), receipt);
    expect((await lookupResponseCache(db, fx.owner, body, MODEL)).hit).toBe(true);
    await residentMemoryOperation(db, fx.owner, {
      operation: "forget",
      key: "forget-amber-1",
      input: { record_ids: [fx.recordId] },
    });
    expect((await lookupResponseCache(db, fx.owner, body, MODEL)).hit).toBe(false);
  });

  it("rejects streaming, non-2xx and tool-call responses at the store", async () => {
    const body = { model: "marina", messages: [{ role: "user", content: "store q" }] };
    const receipt = receiptFor(fx.owner, [{ id: fx.recordId, version: 1 }]);
    expect(
      await storeResponseCache(
        db,
        fx.owner,
        body,
        MODEL,
        new Response("data: {}\n\n", { headers: { "Content-Type": "text/event-stream" } }),
        receipt,
      ),
    ).toEqual({ stored: false, reason: "streaming" });
    expect(
      await storeResponseCache(
        db,
        fx.owner,
        body,
        MODEL,
        Response.json({ error: "x" }, { status: 502 }),
        receipt,
      ),
    ).toEqual({ stored: false, reason: "not_ok" });
    expect(
      await storeResponseCache(
        db,
        fx.owner,
        body,
        MODEL,
        Response.json(
          completion("", {
            tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }],
          }),
        ),
        receipt,
      ),
    ).toEqual({ stored: false, reason: "tool_calls" });
    expect((await lookupResponseCache(db, fx.owner, body, MODEL)).hit).toBe(false);
  });

  it("misses (never throws) for an identity without a durable world account", async () => {
    const body = { model: "marina", messages: [{ role: "user", content: "ghost q" }] };
    const miss = await lookupResponseCache(db, "NoSuchUser", body, MODEL);
    expect(miss.hit).toBe(false);
    if (!miss.hit) expect(miss.reason).toBe("world_identity_required");
    const receipt: MemoryReceipt = receiptFor("NoSuchUser", [{ id: fx.recordId, version: 1 }]);
    const stored = await storeResponseCache(
      db,
      "NoSuchUser",
      body,
      MODEL,
      Response.json(completion("a")),
      receipt,
    );
    expect(stored).toEqual({ stored: false, reason: "world_identity_required" });
  });

  // ─── End-to-end through the passthru surface ───────────────────────────────

  async function chat(
    token: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const url = new URL("http://localhost:3300/v1/chat/completions");
    const req = new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const resp = await handleModelApi(url, "POST", req, engine);
    expect(resp).toBeDefined();
    return resp!;
  }

  /** Repeat until the fire-and-forget store lands (bounded). Returns the hit. */
  async function untilHit(send: () => Promise<Response>): Promise<Response> {
    let last: Response | undefined;
    for (let i = 0; i < 40; i++) {
      last = await send();
      if (last.headers.get(RESPONSE_CACHE_HEADER) === "hit") return last;
      await Bun.sleep(15);
    }
    return last!;
  }

  it("serves an exact repeat from the cache with x-marina-cache: hit and the original receipt", async () => {
    const body = {
      model: "marina",
      messages: [{ role: "user", content: `what is the ${FIXTURE_QUERY}?` }],
    };
    const first = await chat("sk-ada", body);
    expect(first.status).toBe(200);
    expect(first.headers.get(RESPONSE_CACHE_HEADER)).toBeNull();
    const firstReceipt = first.headers.get("x-marina-memory-receipt");
    expect(firstReceipt).not.toBeNull();
    // The first exchange is captured into memory, so the very next identical
    // request injects one more [unverified] line (a different effective body);
    // from then on the injected context is stable and repeats hit.
    const hit = await untilHit(() => chat("sk-ada", body));
    expect(hit.headers.get(RESPONSE_CACHE_HEADER)).toBe("hit");
    const callsAtHit = upstreamCalls.length;
    const hitBody = await hit.json();
    expect(hitBody.choices[0].message.content).toBe("upstream answer");
    expect(hit.headers.get("x-request-id")).not.toBeNull();
    const hitReceipt = JSON.parse(hit.headers.get("x-marina-memory-receipt")!);
    expect(hitReceipt.schema).toBe("marina.memory.receipt.v1");
    expect(hitReceipt.entity).toBe(fx.owner);
    // The receipt is the ORIGINAL one (its requestId is the request that produced the answer).
    expect(hitReceipt.requestId).not.toBe(hit.headers.get("x-request-id"));

    // Another hit costs no upstream call.
    const again = await chat("sk-ada", body);
    expect(again.headers.get(RESPONSE_CACHE_HEADER)).toBe("hit");
    expect(upstreamCalls.length).toBe(callsAtHit);

    // Identity isolation end-to-end: Bea's identical prompt is never Ada's answer.
    const bea = await chat("sk-bea", body);
    expect(bea.status).toBe(200);
    expect(bea.headers.get(RESPONSE_CACHE_HEADER)).toBeNull();
    expect(upstreamCalls.length).toBe(callsAtHit + 1);
  });

  it("misses after a pinned record is revised (evidence changed)", async () => {
    const body = {
      model: "marina",
      messages: [{ role: "user", content: `what is the ${FIXTURE_QUERY}?` }],
    };
    await chat("sk-ada", body);
    const hit = await untilHit(() => chat("sk-ada", body));
    expect(hit.headers.get(RESPONSE_CACHE_HEADER)).toBe("hit");
    await residentMemoryOperation(db, fx.owner, {
      operation: "revise",
      id: fx.recordId,
      key: "revise-amber-e2e",
      input: {
        content: "Amber deployment uses port 7420",
        subject: "amber",
        source_ids: [fx.sourceId],
        expected_version: 1,
      },
    });
    const before = upstreamCalls.length;
    const after = await chat("sk-ada", body);
    expect(after.headers.get(RESPONSE_CACHE_HEADER)).toBeNull();
    expect(upstreamCalls.length).toBe(before + 1);
  });

  it("bypasses the cache for streaming requests", async () => {
    upstreamStream = true;
    const body = {
      model: "marina",
      stream: true,
      messages: [{ role: "user", content: `what is the ${FIXTURE_QUERY}?` }],
    };
    for (let i = 0; i < 3; i++) {
      const resp = await chat("sk-ada", body);
      expect(resp.status).toBe(200);
      expect(resp.headers.get("Content-Type")).toContain("text/event-stream");
      expect(resp.headers.get(RESPONSE_CACHE_HEADER)).toBeNull();
      await resp.text();
    }
    expect(upstreamCalls.length).toBe(3);
  });

  it("never caches for the shared anonymous identity", async () => {
    process.env.MODEL_API_KEYS = "sk-plain";
    process.env.MARINA_PASSTHRU_RESPONSE_CACHE = "on";
    const body = {
      model: "marina",
      messages: [{ role: "user", content: `what is the ${FIXTURE_QUERY}?` }],
    };
    for (let i = 0; i < 3; i++) {
      const resp = await chat("sk-plain", body, { "X-Marina-Context": "on" });
      expect(resp.status).toBe(200);
      expect(resp.headers.get(RESPONSE_CACHE_HEADER)).toBeNull();
      expect(resp.headers.get("x-marina-memory-receipt")).toBeNull();
    }
    expect(upstreamCalls.length).toBe(3);
  });
});
