// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Offline test for `benchmarks/memory/gateway.ts`.
 *
 * Boots a real HTTP server in-process (Bun.serve on an ephemeral port) that
 * routes `/v1/*` to `handleModelApi` and `/mem*` to `handleMemApi`, exactly
 * like `websocket-server.ts` does, with the model endpoint in passthru mode.
 * The upstream provider is a fetch stub that plays a "perfect reader": it
 * answers with the gold when the injected system content contains it, else
 * "I do not know". The harness itself talks to the server over the loopback
 * socket like any OpenAI-compatible client.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GATEWAY_RESULT_SCHEMA,
  GatewayPreflightError,
  runGatewayBenchmark,
  summarizeReceiptHeader,
  tokensFromBytes,
  validateGatewayResult,
} from "../benchmarks/memory/gateway";
import {
  estimateTokens,
  loadSyntheticItems,
  normalizeAnswer,
  splitParaphrases,
} from "../benchmarks/memory/genbench";
import { Engine } from "../src/engine/engine";
import { handleMemApi } from "../src/net/mem-api";
import { MEMORY_RECEIPT_HEADER } from "../src/net/memory-receipt";
import { handleModelApi } from "../src/net/model-api";
import { setEndpointConfig } from "../src/net/model-endpoint";
import { resetPassthruCaptureDedupForTests } from "../src/net/passthru-context";
import { MarinaDB } from "../src/persistence/database";
import { roomId } from "../src/types";
import { makeTestRoom } from "./helpers";

const SECRET = "sk-gateway-bench";
const ENTITY = "GatewayBench";
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
  "MEM_API_KEYS",
  "MARINA_OPEN_API",
  "MARINA_PASSTHRU_INJECT_BYTES",
  "MARINA_PASSTHRU_RESPONSE_CACHE",
] as const;

describe("gateway benchmark harness", () => {
  const originalEnv = new Map<string, string | undefined>();
  const originalFetch = globalThis.fetch;
  let dir: string;
  let db: MarinaDB;
  let engine: Engine;
  let server: ReturnType<typeof Bun.serve>;
  let endpoint: string;
  /** question → gold, over every paraphrase, for the stub upstream. */
  const gold = new Map<string, string>();
  /** Every body the stub upstream received. */
  let forwarded: { messages: { role: string; content: unknown }[] }[] = [];

  function systemText(body: { messages: { role: string; content: unknown }[] }): string {
    return body.messages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
  }

  beforeAll(async () => {
    for (const key of PROVIDER_ENV) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.OPENAI_API_KEY = "test-upstream-key";
    process.env.MODEL_API_KEYS = `${SECRET}:${ENTITY}`;
    // MEM_API_KEYS is parsed once and cached by mem-api — set before the first /mem call.
    process.env.MEM_API_KEYS = `${SECRET}:${ENTITY}`;

    for (const item of loadSyntheticItems()) gold.set(item.question, item.answer);

    dir = mkdtempSync(join(tmpdir(), "gateway-bench-"));
    db = new MarinaDB(join(dir, "marina.db"));
    engine = new Engine({ startRoom: roomId("test/start"), tickInterval: 60_000, db });
    engine.registerRoom(roomId("test/start"), makeTestRoom({ short: "Start" }));
    setEndpointConfig(db, { mode: "passthru", passthruModel: "openai/gpt-4o" });

    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/mem" || url.pathname.startsWith("/mem/")) {
          return (
            (await handleMemApi(url, req.method, req, db)) ?? new Response("nf", { status: 404 })
          );
        }
        if (url.pathname.startsWith("/v1/")) {
          return (
            (await handleModelApi(url, req.method, req, engine)) ??
            new Response("nf", { status: 404 })
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    endpoint = `http://127.0.0.1:${server.port}`;

    // Upstream stub: perfect reader over the injected system content; the
    // harness's own requests to the local server pass through to the real fetch.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const target = input instanceof Request ? input.url : String(input);
      if (!target.includes("api.openai.com")) return originalFetch(input as string, init);
      const body = (await new Request(input, init).json()) as {
        messages: { role: string; content: unknown }[];
      };
      forwarded.push(body);
      const user = [...body.messages].reverse().find((m) => m.role === "user");
      const question = typeof user?.content === "string" ? user.content : "";
      const answer = gold.get(question);
      const system = normalizeAnswer(systemText(body));
      const knows = answer !== undefined && ` ${system} `.includes(` ${normalizeAnswer(answer)} `);
      const content = knows ? answer : "I do not know";
      const promptText = body.messages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n");
      return Response.json({
        id: "chatcmpl-stub",
        object: "chat.completion",
        model: "gpt-4o-stub",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: estimateTokens(promptText),
          completion_tokens: estimateTokens(content),
          total_tokens: estimateTokens(promptText) + estimateTokens(content),
        },
      });
    }) as typeof fetch;
  });

  beforeEach(() => {
    forwarded = [];
    resetPassthruCaptureDedupForTests();
    process.env.MODEL_API_KEYS = `${SECRET}:${ENTITY}`;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    server?.stop(true);
    engine?.shutdown();
    db?.close();
    for (const key of PROVIDER_ENV) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("measures lift per injected token against an in-process Marina gateway", async () => {
    const resultsDir = join(dir, "results");
    const { result, jsonPath, markdownPath } = await runGatewayBenchmark({
      endpoint,
      apiKey: SECRET,
      entity: ENTITY,
      seeds: 2,
      limit: 40,
      resultsDir,
      quiet: true,
      fetchImpl: originalFetch,
    });

    // Control: byte-identical proxy — the perfect reader has nothing to read.
    const off = result.arms.off;
    expect(off.n).toBe(40); // 20 eval items × 2 seeds
    expect(off.errors).toBe(0);
    expect(off.accuracy.pooled).toBe(0);
    expect(off.receipts).toEqual({ full: 0, stub: 0, missing: 40 });
    expect(off.injectedTokens).toBeNull();

    // Treatment: every eval item is a held-out paraphrase whose sibling was seeded.
    const injected = result.arms.injected;
    expect(injected.n).toBe(40);
    expect(injected.errors).toBe(0);
    expect(result.perSeed.every((s) => s.reachable === 1)).toBe(true);
    expect(injected.receipts.missing).toBe(0);
    expect(injected.receipts.full).toBe(40);
    expect(injected.accuracy.pooled).toBe(1);
    expect(injected.injectedTokens!.mean).toBeGreaterThan(0);
    expect(injected.injectedBytes!.max).toBeLessThanOrEqual(2048);

    // Headline.
    expect(result.lift.liftPerRequest).toBe(1);
    expect(result.lift.liftPerKilotoken).toBeGreaterThan(0);
    expect(result.lift.liftPerKilotoken).toBeCloseTo(
      1 / (injected.injectedTokens!.mean / 1000),
      10,
    );
    // Provider-reported prompt tokens grew by the injected context.
    expect(result.lift.providerPromptTokenDelta).toBeGreaterThan(0);
    expect(result.lift.liftPerProviderKilotoken).toBeGreaterThan(0);

    // The upstream saw the injected marker only for the injected arm.
    const withMarker = forwarded.filter((b) =>
      systemText(b).includes("[marina:shared-world-context]"),
    ).length;
    expect(withMarker).toBe(40);
    expect(forwarded.length).toBe(80);

    // Config block + receipts parsed.
    expect(result.config.entityResolved).toBe(ENTITY);
    expect(result.config.serverModels).toContain("marina");
    expect(result.config.responseModel).toBe("gpt-4o-stub");
    expect(result.config.budgetBytes.observed).toBe(2048);
    expect(result.config.apiKeyFingerprint).not.toContain(SECRET);
    expect(result.warnings).toEqual([]);
    for (const record of result.items.filter((r) => r.arm === "injected")) {
      expect(record.receipt?.present).toBe(true);
      expect(record.receipt?.entity).toBe(ENTITY);
      expect(record.receipt?.requestId).toBe(record.requestId);
      expect(record.receipt?.tiers.length).toBeGreaterThan(0);
    }

    // Files: schema-valid JSON + markdown, named per convention, never overwritten.
    expect(validateGatewayResult(result)).toEqual([]);
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(markdownPath)).toBe(true);
    expect(jsonPath).toMatch(/\d{8}T\d{6}Z-gateway-gpt-4o-stub\.json$/);
    const reloaded = JSON.parse(readFileSync(jsonPath, "utf-8"));
    expect(reloaded.schema).toBe(GATEWAY_RESULT_SCHEMA);
    expect(validateGatewayResult(reloaded)).toEqual([]);
    expect(readFileSync(markdownPath, "utf-8")).toContain("Lift per injected kilotoken");

    // The namespace is left clean.
    const stats = await originalFetch(`${endpoint}/mem/stats`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(((await stats.json()) as { notes: number }).notes).toBe(0);
  }, 60_000);

  it("X-Marina-Context: off yields no receipt header and an unmodified body", async () => {
    const resp = await originalFetch(`${endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET}`,
        "X-Marina-Context": "off",
      },
      body: JSON.stringify({
        model: "marina",
        messages: [
          {
            role: "user",
            content: "What is the diameter of the Verlaine Observatory's primary mirror?",
          },
        ],
      }),
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get(MEMORY_RECEIPT_HEADER)).toBeNull();
    expect(summarizeReceiptHeader(resp.headers.get(MEMORY_RECEIPT_HEADER))).toBeNull();
    expect(forwarded).toHaveLength(1);
    expect(systemText(forwarded[0]!)).toBe("");
  });

  it("fails fast with the binding checklist when the key is not bound", async () => {
    process.env.MODEL_API_KEYS = SECRET; // plain key → anonymous shared identity
    let error: unknown;
    try {
      await runGatewayBenchmark({
        endpoint,
        apiKey: SECRET,
        entity: ENTITY,
        seeds: 1,
        limit: 8,
        resultsDir: join(dir, "results-unbound"),
        quiet: true,
        fetchImpl: originalFetch,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GatewayPreflightError);
    expect(String((error as Error).message)).toContain("MODEL_API_KEYS=<secret>:<entity>");
    expect(String((error as Error).message)).toContain("passthru");
    expect(existsSync(join(dir, "results-unbound"))).toBe(false);
  }, 30_000);

  it("refuses a non-canonical entity name and a wrong model key", async () => {
    await expect(
      runGatewayBenchmark({
        endpoint,
        apiKey: SECRET,
        entity: "gateway-bench",
        seeds: 1,
        quiet: true,
        fetchImpl: originalFetch,
      }),
    ).rejects.toThrow(/canonical entity name/);
    await expect(
      runGatewayBenchmark({
        endpoint,
        apiKey: "sk-wrong",
        memApiKey: SECRET,
        entity: ENTITY,
        seeds: 1,
        quiet: true,
        fetchImpl: originalFetch,
      }),
    ).rejects.toThrow(/rejected the key/);
  });

  it("refuses to wipe a namespace that already holds notes unless forced", async () => {
    const created = await originalFetch(`${endpoint}/mem/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ content: "operator note that must not be wiped silently" }),
    });
    expect(created.status).toBe(201);
    try {
      await expect(
        runGatewayBenchmark({
          endpoint,
          apiKey: SECRET,
          entity: ENTITY,
          seeds: 1,
          limit: 4,
          quiet: true,
          fetchImpl: originalFetch,
        }),
      ).rejects.toThrow(/already holds 1 note/);
    } finally {
      const { id } = (await created.json()) as { id: number };
      await originalFetch(`${endpoint}/mem/notes/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${SECRET}` },
      });
    }
  });

  it("parses full and stub receipt headers", () => {
    const full = summarizeReceiptHeader(
      JSON.stringify({
        schema: "marina.memory.receipt.v1",
        requestId: "req-1",
        entity: ENTITY,
        tiers: [{ tier: "unverified", ids: [{ id: "7" }], bytes: 120 }],
        budgetBytes: 2048,
        usedBytes: 300,
        truncated: false,
        degraded: ["evidence:world_identity_required"],
      }),
    );
    expect(full).toMatchObject({ present: true, stub: false, usedBytes: 300, budgetBytes: 2048 });
    expect(full?.tiers).toEqual([{ tier: "unverified", items: 1, bytes: 120 }]);
    const stub = summarizeReceiptHeader(
      JSON.stringify({
        schema: "marina.memory.receipt.v1",
        requestId: "req-2",
        truncatedHeader: true,
      }),
    );
    expect(stub).toMatchObject({ present: false, stub: true, requestId: "req-2", usedBytes: null });
    expect(summarizeReceiptHeader("not json")).toMatchObject({ present: false, stub: false });
    expect(summarizeReceiptHeader(null)).toBeNull();
    expect(tokensFromBytes(300)).toBe(75);
    expect(tokensFromBytes(0)).toBe(0);
  });

  it("splits deterministically with a 100 % transfer ceiling", () => {
    const items = loadSyntheticItems();
    const a = splitParaphrases(items, 3, "v1", 0.5);
    const b = splitParaphrases(items, 3, "v1", 0.5);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.evalSet.map((i) => i.id)).toEqual(b.evalSet.map((i) => i.id));
    expect(a.reachable).toBe(1);
    expect(a.seedSet.length).toBe(50);
    expect(a.evalSet.length).toBe(50);
    const c = splitParaphrases(items, 4, "v1", 0.5);
    expect(c.fingerprint).not.toBe(a.fingerprint);
  });
});
